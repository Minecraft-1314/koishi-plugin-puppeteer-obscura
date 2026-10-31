"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CdpClient = void 0;
const ws_1 = __importDefault(require("ws"));
const DEFAULT_REQUEST_TIMEOUT = 120000;
const DEFAULT_CONNECT_TIMEOUT = 30000;
class CdpClient {
    #socket;
    #nextId = 1;
    #requestTimeout;
    #connectTimeout;
    #debugLog;
    #pending = new Map();
    #handlers = new Map();
    #closeCallbacks = new Set();
    #closed = false;
    constructor(endpoint, options = {}) {
        this.#requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
        this.#connectTimeout = options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT;
        this.#debugLog = options.debugLog ?? null;
        this.#socket = new ws_1.default(endpoint, { perMessageDeflate: false, maxPayload: 268435456 });
        this.#socket.on('message', this.#onMessage);
        this.#socket.on('error', this.#onError);
        this.#socket.on('close', this.#onClose);
    }
    #debug(message) {
        try {
            this.#debugLog?.(message);
        }
        catch { }
    }
    #onMessage = (raw) => {
        let message;
        try {
            message = JSON.parse(String(raw));
        }
        catch {
            return;
        }
        if (message.id !== undefined) {
            const entry = this.#pending.get(message.id);
            if (!entry)
                return;
            clearTimeout(entry.timer);
            this.#pending.delete(message.id);
            if (message.error) {
                this.#debug('<< ' + message.id + ' ERROR ' + JSON.stringify(message.error).slice(0, 200));
                entry.reject(new Error(message.error.message));
            }
            else {
                this.#debug('<< ' + message.id + ' OK ' + JSON.stringify(message.result ?? {}).slice(0, 200));
                entry.resolve(message.result ?? {});
            }
            return;
        }
        if (message.method) {
            this.#debug('<< ' + message.method + ' (' + (message.sessionId ?? '').slice(0, 12) + ') ' + JSON.stringify(message.params ?? {}).slice(0, 300));
            const set = this.#handlers.get(message.method);
            if (!set || !set.size)
                return;
            const params = message.params ?? {};
            for (const handler of [...set]) {
                try {
                    handler(params, message.sessionId);
                }
                catch { }
            }
        }
    };
    #onError = (error) => {
        this.#failAll(error);
    };
    #onClose = () => {
        this.#closed = true;
        this.#failAll(new Error('CDP connection closed'));
        for (const callback of [...this.#closeCallbacks]) {
            try {
                callback();
            }
            catch { }
        }
    };
    #failAll(error) {
        for (const entry of this.#pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.#pending.clear();
    }
    get closed() {
        return this.#closed;
    }
    async ready() {
        if (this.#closed)
            throw new Error('CDP connection closed');
        if (this.#socket.readyState === ws_1.default.OPEN)
            return;
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                this.#socket.off('open', onOpen);
                this.#socket.off('error', onErr);
            };
            const timer = setTimeout(() => {
                cleanup();
                try {
                    this.#socket.terminate();
                }
                catch { }
                reject(new Error('CDP connection timed out after ' + this.#connectTimeout + 'ms'));
            }, this.#connectTimeout);
            const onOpen = () => {
                cleanup();
                resolve();
            };
            const onErr = (error) => {
                cleanup();
                reject(error);
            };
            this.#socket.once('open', onOpen);
            this.#socket.once('error', onErr);
        });
    }
    send(method, params = {}, sessionId) {
        if (this.#closed)
            return Promise.reject(new Error('CDP connection closed'));
        const id = this.#nextId++;
        const payload = { id, method, params };
        if (sessionId)
            payload.sessionId = sessionId;
        this.#debug('>> ' + id + ' ' + method + ' (' + (sessionId ?? '').slice(0, 12) + ') ' + JSON.stringify(params).slice(0, 300));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error('CDP request timed out after ' + this.#requestTimeout + 'ms: ' + method));
            }, this.#requestTimeout);
            const onSendError = (error) => {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(error);
            };
            this.#pending.set(id, { resolve, reject, timer });
            try {
                this.#socket.send(JSON.stringify(payload), (error) => {
                    if (error)
                        onSendError(error instanceof Error ? error : new Error(String(error)));
                });
            }
            catch (error) {
                onSendError(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    on(method, handler) {
        let set = this.#handlers.get(method);
        if (!set) {
            set = new Set();
            this.#handlers.set(method, set);
        }
        set.add(handler);
        return () => {
            const current = this.#handlers.get(method);
            if (!current)
                return;
            current.delete(handler);
            if (!current.size)
                this.#handlers.delete(method);
        };
    }
    onClose(callback) {
        this.#closeCallbacks.add(callback);
        if (this.#closed) {
            try {
                callback();
            }
            catch { }
            return () => { };
        }
        return () => {
            this.#closeCallbacks.delete(callback);
        };
    }
    once(method, predicate) {
        return new Promise((resolve) => {
            const dispose = this.on(method, (params) => {
                if (predicate && !predicate(params))
                    return;
                dispose();
                resolve(params);
            });
        });
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#failAll(new Error('CDP connection closed'));
        this.#handlers.clear();
        const socket = this.#socket;
        try {
            socket.removeAllListeners();
            socket.close();
        }
        catch { }
        const guard = setTimeout(() => {
            try {
                if (socket.readyState !== ws_1.default.CLOSED)
                    socket.terminate();
            }
            catch { }
        }, 1000);
        guard.unref?.();
    }
}
exports.CdpClient = CdpClient;
