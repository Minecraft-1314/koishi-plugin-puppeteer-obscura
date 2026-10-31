import WebSocket from 'ws'

export interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

type EventHandler = (params: any, sessionId?: string) => void;

export interface CdpClientOptions {
  requestTimeout?: number;
  connectTimeout?: number;
  debugLog?: (message: string) => void;
}

const DEFAULT_REQUEST_TIMEOUT = 120000;
const DEFAULT_CONNECT_TIMEOUT = 30000;

export class CdpClient {
  #socket: WebSocket;
  #nextId = 1;
  #requestTimeout: number;
  #connectTimeout: number;
  #debugLog: ((message: string) => void) | null;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #handlers = new Map<string, Set<EventHandler>>();
  #closeCallbacks = new Set<() => void>();
  #closed = false;

  constructor(endpoint: string, options: CdpClientOptions = {}) {
    this.#requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.#connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
    this.#debugLog = options.debugLog ?? null;
    this.#socket = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 268435456 });
    this.#socket.on('message', this.#onMessage);
    this.#socket.on('error', this.#onError);
    this.#socket.on('close', this.#onClose);
  }

  #debug(message: string): void {
    try {
      this.#debugLog?.(message);
    } catch {}
  }

  #onMessage = (raw: WebSocket.RawData): void => {
    let message: CdpMessage;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        this.#debug('<< ' + message.id + ' ERROR ' + JSON.stringify(message.error).slice(0, 200));
        entry.reject(new Error(message.error.message));
      } else {
        this.#debug('<< ' + message.id + ' OK ' + JSON.stringify(message.result ?? {}).slice(0, 200));
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) {
      this.#debug('<< ' + message.method + ' (' + (message.sessionId ?? '').slice(0, 12) + ') ' + JSON.stringify(message.params ?? {}).slice(0, 300));
      const set = this.#handlers.get(message.method);
      if (!set || !set.size) return;
      const params = message.params ?? {};
      for (const handler of [...set]) {
        try {
          handler(params, message.sessionId);
        } catch {}
      }
    }
  };

  #onError = (error: Error): void => {
    this.#failAll(error);
  };

  #onClose = (): void => {
    this.#closed = true;
    this.#failAll(new Error('CDP connection closed'));
    for (const callback of [...this.#closeCallbacks]) {
      try {
        callback();
      } catch {}
    }
  };

  #failAll(error: Error): void {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async ready(): Promise<void> {
    if (this.#closed) throw new Error('CDP connection closed');
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#socket.off('open', onOpen);
        this.#socket.off('error', onErr);
      };
      const timer = setTimeout(() => {
        cleanup();
        try { this.#socket.terminate(); } catch {}
        reject(new Error('CDP connection timed out after ' + this.#connectTimeout + 'ms'));
      }, this.#connectTimeout);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onErr = (error: Error): void => {
        cleanup();
        reject(error);
      };
      this.#socket.once('open', onOpen);
      this.#socket.once('error', onErr);
    });
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.#nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#debug('>> ' + id + ' ' + method + ' (' + (sessionId ?? '').slice(0, 12) + ') ' + JSON.stringify(params).slice(0, 300));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('CDP request timed out after ' + this.#requestTimeout + 'ms: ' + method));
      }, this.#requestTimeout);
      const onSendError = (error: Error): void => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      };
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify(payload), (error) => {
          if (error) onSendError(error instanceof Error ? error : new Error(String(error)));
        });
      } catch (error) {
        onSendError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method: string, handler: EventHandler): () => void {
    let set = this.#handlers.get(method);
    if (!set) {
      set = new Set();
      this.#handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      const current = this.#handlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (!current.size) this.#handlers.delete(method);
    };
  }

  onClose(callback: () => void): () => void {
    this.#closeCallbacks.add(callback);
    if (this.#closed) {
      try {
        callback();
      } catch {}
      return () => {};
    }
    return () => {
      this.#closeCallbacks.delete(callback);
    };
  }

  once(method: string, predicate?: (params: any) => boolean): Promise<any> {
    return new Promise((resolve) => {
      const dispose = this.on(method, (params) => {
        if (predicate && !predicate(params)) return;
        dispose();
        resolve(params);
      });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error('CDP connection closed'));
    this.#handlers.clear();
    const socket = this.#socket;
    try {
      socket.removeAllListeners();
      socket.close();
    } catch {}
    const guard = setTimeout(() => {
      try { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); } catch {}
    }, 1000);
    guard.unref?.();
  }
}
