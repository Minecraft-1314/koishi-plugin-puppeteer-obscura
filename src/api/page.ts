import { writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { CdpClient } from '../cdp';
import { ElementHandle } from './element';
import { FrameHandle, type FrameInfo } from './frame';

export interface InterceptResponse {
  status: number;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | Uint8Array;
}

export interface InterceptRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType?: string;
  requestId: string;
  continue(): Promise<void>;
  fulfill(response: InterceptResponse): Promise<void>;
  respond(response: InterceptResponse): Promise<void>;
  abort(): Promise<void>;
}

export interface DownloadEvent {
  url: string;
  filename: string;
  path?: string;
  size?: number;
  error?: string;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface ScreenshotOptions {
  type?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  omitBackground?: boolean;
  encoding?: 'base64' | 'binary';
  path?: string;
}

export interface PdfOptions {
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  format?: string;
  width?: number;
  height?: number;
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
  path?: string;
}

export interface WaitOptions {
  timeout?: number;
  visible?: boolean;
  hidden?: boolean;
}

export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

const PDF_FORMATS: Record<string, { width: number; height: number }> = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  ledger: { width: 17, height: 11 },
  a0: { width: 33.1, height: 46.8 },
  a1: { width: 23.4, height: 33.1 },
  a2: { width: 16.5, height: 23.4 },
  a3: { width: 11.7, height: 16.5 },
  a4: { width: 8.27, height: 11.69 },
  a5: { width: 5.83, height: 8.27 },
  a6: { width: 4.13, height: 5.83 }
};

export class ObscuraPage {
  #client: CdpClient;
  #sessionId: string;
  #targetId: string;
  #viewport: Viewport;
  #closed = false;
  #onClose: (() => void) | null;
  #localHandlers = new Map<string, Set<(payload: any) => void>>();
  #interceptDisposers: (() => void) | null = null;
  #downloadDisposers: (() => void)[] | null = null;
  #downloadPending = new Map<string, { url: string; filename: string }>();

  constructor(client: CdpClient, targetId: string, sessionId: string, viewport: Viewport, onClose?: () => void) {
    this.#client = client;
    this.#targetId = targetId;
    this.#sessionId = sessionId;
    this.#viewport = viewport;
    this.#onClose = onClose ?? null;
  }

  static async create(client: CdpClient, viewport: Viewport, onClose?: () => void): Promise<ObscuraPage> {
    let targetId: string | null = null;
    try {
      const created = await client.send('Target.createTarget', { url: 'about:blank' });
      targetId = created?.targetId ?? null;
      if (!targetId) throw new Error('Target.createTarget returned no targetId');
      const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
      if (!attached?.sessionId) throw new Error('Target.attachToTarget returned no sessionId');
      const page = new ObscuraPage(client, targetId, attached.sessionId, viewport, onClose);
      await page.setViewport(viewport);
      return page;
    } catch (error) {
      if (targetId) {
        try { await client.send('Target.closeTarget', { targetId }); } catch {}
      }
      throw error;
    }
  }

  get targetId(): string { return this.#targetId; }
  get sessionId(): string { return this.#sessionId; }
  get viewport(): Viewport { return this.#viewport; }
  get closed(): boolean { return this.#closed; }

  get keyboard(): {
    type: (text: string, options?: { delay?: number }) => Promise<void>;
    press: (key: string, options?: { delay?: number }) => Promise<void>;
    down: (key: string) => Promise<void>;
    up: (key: string) => Promise<void>;
    sendCharacter: (char: string) => Promise<void>;
  } {
    return {
      type: async (text, options) => {
        for (const char of text) {
          await this.keyboardType(char);
          if (options?.delay) await this.waitForTimeout(options.delay);
        }
      },
      press: async (key, options) => {
        await this.keyboardPress(key);
        if (options?.delay) await this.waitForTimeout(options.delay);
      },
      down: (key) => this.#dispatchKey(key, 'keyDown'),
      up: (key) => this.#dispatchKey(key, 'keyUp'),
      sendCharacter: (char) => this.keyboardType(char)
    };
  }

  get mouse(): {
    click: (x: number, y: number, options?: { button?: string; clickCount?: number }) => Promise<void>;
    move: (x: number, y: number, options?: { steps?: number }) => Promise<void>;
    down: (options?: { button?: string; clickCount?: number; x?: number; y?: number }) => Promise<void>;
    up: (options?: { button?: string; clickCount?: number; x?: number; y?: number }) => Promise<void>;
    wheel: (options?: { deltaX?: number; deltaY?: number }) => Promise<void>;
  } {
    return {
      click: (x, y, options) => this.mouseClick(x, y, options),
      move: async (x, y, options) => {
        const steps = Math.max(1, options?.steps ?? 1);
        for (let i = 1; i <= steps; i++) {
          await this.mouseMove(x, y);
        }
      },
      down: (options) => this.#dispatchMouseButton(options?.x ?? 0, options?.y ?? 0, options?.button ?? 'left', options?.clickCount ?? 1, 'mousePressed'),
      up: (options) => this.#dispatchMouseButton(options?.x ?? 0, options?.y ?? 0, options?.button ?? 'left', options?.clickCount ?? 1, 'mouseReleased'),
      wheel: (options) => this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 0,
        y: 0,
        deltaX: options?.deltaX ?? 0,
        deltaY: options?.deltaY ?? 0
      })
    };
  }

  async #dispatchKey(key: string, type: 'keyDown' | 'keyUp'): Promise<void> {
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    await this.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    });
  }

  async #dispatchMouseButton(x: number, y: number, button: string, clickCount: number, type: 'mousePressed' | 'mouseReleased'): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount });
  }

  async mainFrame(): Promise<any> {
    const frames = await this.frames();
    return frames[0] ?? null;
  }

  send(method: string, params: any = {}): Promise<any> {
    return this.#client.send(method, params, this.#sessionId);
  }

  on(method: string, handler: (params: any) => void): () => void {
    if (method === 'download') {
      let set = this.#localHandlers.get('download');
      if (!set) {
        set = new Set();
        this.#localHandlers.set('download', set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (!set.size) this.#localHandlers.delete('download');
      };
    }
    return this.#client.on(method, (params, sessionId) => {
      if (sessionId && sessionId !== this.#sessionId) return;
      handler(params);
    });
  }

  #emitLocal(event: string, payload: any): void {
    const set = this.#localHandlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {}
    }
  }

  async setViewport(viewport: Viewport): Promise<void> {
    this.#viewport = viewport;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: false
    });
  }

  async setUserAgent(userAgent: string): Promise<void> {
    await this.send('Network.setUserAgentOverride', { userAgent });
  }

  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    await this.send('Network.setExtraHTTPHeaders', { headers });
  }

  async setOffline(offline: boolean): Promise<void> {
    await this.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1
    }).catch(() => {});
  }

  async goto(url: string, options: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'networkidle0' | 'networkidle2'; timeout?: number } = {}): Promise<any> {
    const waitUntil = options.waitUntil === 'networkidle0' || options.waitUntil === 'networkidle2' ? 'networkidle' : options.waitUntil;
    const result = await this.send('Page.navigate', { url });
    if (waitUntil && waitUntil !== 'load') {
      await this.waitForLoadState(waitUntil, options.timeout);
    }
    return result;
  }

  async reload(options: { ignoreCache?: boolean } = {}): Promise<any> {
    return await this.send('Page.reload', { ignoreCache: options.ignoreCache ?? false });
  }

  async goBack(): Promise<any> {
    const history = await this.send('Page.getNavigationHistory');
    const index = history.currentIndex ?? 0;
    if (index <= 0) return null;
    const entry = history.entries?.[index - 1];
    if (!entry) return null;
    await this.goto(entry.url);
    return entry;
  }

  async goForward(): Promise<any> {
    const history = await this.send('Page.getNavigationHistory');
    const index = history.currentIndex ?? 0;
    if (index + 1 >= (history.entries?.length ?? 0)) return null;
    const entry = history.entries[index + 1];
    await this.goto(entry.url);
    return entry;
  }

  async setContent(html: string): Promise<void> {
    try {
      await this.#setContentViaDataUrl(html);
      return;
    } catch {}
    await this.send('Page.navigate', { url: 'about:blank' });
    const CHUNK = 64 * 1024;
    try {
      for (let offset = 0; offset < html.length; offset += CHUNK) {
        const part = html.slice(offset, offset + CHUNK);
        await this.evaluate('document.write(' + JSON.stringify(part) + ')');
      }
      await this.evaluate('document.close()');
      return;
    } catch (chunkError) {
      try { await this.evaluate('document.close()'); } catch {}
      await this.send('Page.navigate', { url: 'about:blank' });
      const expression = 'document.open(); document.write(' + JSON.stringify(html) + '); document.close();';
      for (let attempt = 0; ; attempt++) {
        try {
          await this.evaluate(expression);
          return;
        } catch (error) {
          if (attempt >= 2) throw error;
          await this.waitForTimeout(60);
        }
      }
    }
  }

  async #setContentViaDataUrl(html: string): Promise<void> {
    if (html.length > 2 * 1024 * 1024) throw new Error('content exceeds data URL limit');
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    await this.send('Page.navigate', { url });
    await this.waitForLoadState('load', 10000);
  }

  async evaluate<R = any>(pageFunction: string | ((...args: any[]) => any), ...args: any[]): Promise<R> {
    const expression = typeof pageFunction === 'function'
      ? '(' + pageFunction.toString() + ')(' + args.map((arg) => JSON.stringify(arg)).join(', ') + ')'
      : pageFunction;
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(String(text ?? 'evaluate failed'));
    }
    return result?.result?.value as R;
  }

  async evaluateHandle(pageFunction: string | ((...args: any[]) => any), ...args: any[]): Promise<any> {
    const expression = typeof pageFunction === 'function'
      ? '(' + pageFunction.toString() + ')(' + args.map((arg) => JSON.stringify(arg)).join(', ') + ')'
      : pageFunction;
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: false,
      awaitPromise: true
    });
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(String(text ?? 'evaluateHandle failed'));
    }
    return result?.result?.objectId ?? null;
  }

  async addStyleTag(options: { content?: string; url?: string }): Promise<null> {
    const expression = options.url
      ? '(function(){var l=document.createElement("link");l.rel="stylesheet";l.href=' + JSON.stringify(options.url) + ';document.head.appendChild(l);return null})()'
      : '(function(){var s=document.createElement("style");s.textContent=' + JSON.stringify(options.content ?? '') + ';document.head.appendChild(s);return null})()';
    await this.evaluate(expression);
    return null;
  }

  async addScriptTag(options: { content?: string; url?: string }): Promise<null> {
    const expression = options.url
      ? '(function(){var s=document.createElement("script");s.src=' + JSON.stringify(options.url) + ';document.head.appendChild(s);return null})()'
      : '(function(){var s=document.createElement("script");s.textContent=' + JSON.stringify(options.content ?? '') + ';document.head.appendChild(s);return null})()';
    await this.evaluate(expression);
    return null;
  }

  async waitForNavigation(options: { timeout?: number } = {}): Promise<null> {
    const timeout = options.timeout ?? 30000;
    return await new Promise<null>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dispose();
        resolve(null);
      };
      const dispose = this.on('Page.frameNavigated', (params) => {
        if (!params?.frame?.parentId) finish();
      });
      const timer = setTimeout(finish, timeout);
    });
  }

  async waitForNetworkIdle(timeout = 30000, idleTime = 500): Promise<boolean> {
    let pending = 0;
    let idle = false;
    let lastActivity = Date.now();
    const bump = () => {
      pending++;
      lastActivity = Date.now();
    };
    const settle = () => {
      pending = Math.max(0, pending - 1);
      lastActivity = Date.now();
    };
    const disposers = [
      this.on('Network.requestWillBeSent', bump),
      this.on('Network.loadingFinished', settle),
      this.on('Network.loadingFailed', settle)
    ];
    try {
      await this.send('Network.enable').catch(() => {});
      const deadline = Date.now() + timeout;
      for (;;) {
        if (this.#closed) return false;
        if (pending === 0 && Date.now() - lastActivity >= idleTime) {
          idle = true;
          return idle;
        }
        if (Date.now() >= deadline) return idle;
        await this.waitForTimeout(100);
      }
    } finally {
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
    }
  }

  async title(): Promise<string> { return await this.evaluate<string>('document.title'); }
  async url(): Promise<string> { return await this.evaluate<string>('location.href'); }
  async content(): Promise<string> { return await this.evaluate<string>('document.documentElement.outerHTML'); }

  async #documentNodeId(): Promise<number> {
    const doc = await this.send('DOM.getDocument', { depth: 0 });
    const nodeId = doc?.root?.nodeId;
    if (nodeId === undefined || nodeId === null) throw new Error('Cannot obtain document root node');
    return nodeId;
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const nodeId = await this.#documentNodeId();
    const result = await this.send('DOM.querySelector', { nodeId, selector });
    if (!result?.nodeId) return null;
    return new ElementHandle(this.#client, this.#sessionId, result.nodeId);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const nodeId = await this.#documentNodeId();
    const result = await this.send('DOM.querySelectorAll', { nodeId, selector });
    return (result?.nodeIds ?? []).map((id: number) => new ElementHandle(this.#client, this.#sessionId, id));
  }

  async $eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R> {
    const handle = await this.$(selector);
    if (!handle) throw new Error('failed to find element matching selector ' + selector);
    try {
      return await handle.evaluate<R>(pageFunction, ...args);
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  async $$eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R> {
    const handles = await this.$$(selector);
    if (!handles.length) throw new Error('failed to find element matching selector ' + selector);
    try {
      const list = args.map((arg) => JSON.stringify(arg)).join(', ');
      const source = pageFunction.toString();
      const expression = 'function () { var elements = Array.prototype.slice.call(document.querySelectorAll(' + JSON.stringify(selector) + ')); return (' + source + ')(elements' + (list ? ', ' + list : '') + ') }';
      return await this.evaluate<R>(expression);
    } finally {
      for (const handle of handles) await handle.dispose().catch(() => {});
    }
  }

  async waitForSelector(selector: string, options: WaitOptions = {}): Promise<ElementHandle | null> {
    const timeout = options.timeout ?? 30000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.#closed) return null;
      const handle = await this.$(selector).catch(() => null);
      if (handle) {
        const rect = await handle.boundingBox();
        const visible = !!rect && rect.width > 0 && rect.height > 0;
        if (options.hidden) {
          if (!visible) return handle;
        } else if (options.visible === true) {
          if (visible) return handle;
        } else {
          return handle;
        }
        await handle.dispose().catch(() => {});
      } else if (options.hidden) {
        return null;
      }
      if (Date.now() >= deadline) return null;
      await this.waitForTimeout(50);
    }
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, ms) });
  }

  async waitForFunction(expression: string, options: WaitOptions = {}): Promise<boolean> {
    const timeout = options.timeout ?? 30000;
    const deadline = Date.now() + timeout;
    for (;;) {
      if (this.#closed) throw new Error('Waiting failed: page is closed');
      try {
        if (await this.evaluate<boolean>(expression)) return true;
      } catch {}
      if (Date.now() >= deadline) break;
      await this.waitForTimeout(50);
    }
    throw new Error('Waiting failed: ' + expression);
  }

  async mouseClick(x: number, y: number, options: { button?: string; clickCount?: number } = {}): Promise<void> {
    const button = options.button ?? 'left';
    const count = options.clickCount ?? 1;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: count });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: count });
  }

  async select(selector: string, ...values: string[]): Promise<string[]> {
    const expression = '(function () { var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) throw new Error("Element not found"); if (el.tagName !== "SELECT") throw new Error("Element is not a SELECT element"); var vals = ' + JSON.stringify(values) + '; Array.prototype.forEach.call(el.options, function (opt) { opt.selected = vals.indexOf(opt.value) !== -1 || vals.indexOf(opt.label) !== -1 }); if (vals.length) { el.value = vals[0] } el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return Array.prototype.filter.call(el.options, function (o) { return o.selected }).map(function (o) { return o.value }) })()';
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(String(text ?? 'select failed'));
    }
    return (result?.result?.value ?? []) as string[];
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  }

  async keyboardType(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
  }

  async keyboardPress(key: string): Promise<void> {
    const code = key.length === 1 ? 'Key' + key.toUpperCase() : key;
    const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    const common = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common, text: key.length === 1 ? key : undefined });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  async touchStart(x: number, y: number): Promise<void> {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  }

  async touchEnd(): Promise<void> {
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async cookies(): Promise<CookieParam[]> {
    const result = await this.send('Network.getAllCookies');
    return result?.cookies ?? [];
  }

  async setCookie(...cookies: CookieParam[]): Promise<void> {
    const params = cookies.map((cookie) => {
      const item: any = { name: cookie.name, value: cookie.value };
      if (cookie.url) {
        item.url = cookie.url;
      } else {
        item.domain = cookie.domain ?? '';
        item.path = cookie.path ?? '/';
      }
      if (cookie.expires !== undefined) item.expires = cookie.expires;
      if (cookie.httpOnly !== undefined) item.httpOnly = cookie.httpOnly;
      if (cookie.secure !== undefined) item.secure = cookie.secure;
      if (cookie.sameSite) item.sameSite = cookie.sameSite;
      return item;
    });
    await this.send('Network.setCookies', { cookies: params });
  }

  async deleteCookie(...cookies: CookieParam[]): Promise<void> {
    for (const cookie of cookies) {
      const item: any = { name: cookie.name };
      if (cookie.url) {
        item.url = cookie.url;
      } else {
        item.domain = cookie.domain ?? '';
        item.path = cookie.path ?? '/';
      }
      await this.send('Network.deleteCookies', item);
    }
  }

  async #applyBackgroundCompat(): Promise<string | null> {
    try {
      const cleanup = await this.evaluate(`(function () {
        return new Promise(function (resolve) {
          var body = document.body;
          if (!body) return resolve(null);
          var inline = body.style.backgroundImage;
          var bg = null;
          var bgSize = '';
          if (inline && inline.indexOf('data:') !== -1) {
            bg = inline;
            bgSize = body.style.backgroundSize;
          } else {
            var sheets = document.styleSheets;
            for (var i = sheets.length - 1; i >= 0; i--) {
              var rules;
              try { rules = sheets[i].cssRules; } catch (e) { continue; }
              for (var j = rules.length - 1; j >= 0; j--) {
                var rule = rules[j];
                if (!rule.selectorText || !rule.style) continue;
                var sel = rule.selectorText.toLowerCase();
                var img = rule.style.backgroundImage;
                if (!img || img.indexOf('data:') === -1) continue;
                if (sel === 'body' || sel === 'html' || sel.indexOf('body') !== -1) {
                  bg = img;
                  bgSize = rule.style.backgroundSize || '';
                  break;
                }
              }
              if (bg) break;
            }
          }
          if (!bg) return resolve(null);
          var dataIdx = bg.indexOf('data:');
          if (dataIdx === -1) return resolve(null);
          var urlEnd = bg.length;
          for (var k = dataIdx; k < bg.length; k++) {
            var ch = bg.charAt(k);
            if (ch === ')' || ch === "'" || ch === '"') { urlEnd = k; break; }
          }
          var rawUrl = bg.slice(dataIdx, urlEnd);
          var img = new Image();
          img.onload = function () {
            try {
              var docH = Math.max(document.documentElement.scrollHeight, body.scrollHeight);
              var w = document.documentElement.clientWidth;
              var tileH = w * (img.naturalHeight / img.naturalWidth);
              if (!(tileH > 0) || docH <= tileH * 1.05) return resolve(null);
              if (docH > 16000) return resolve(null);
              var canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = docH;
              var ctx = canvas.getContext('2d');
              if (!ctx) return resolve(null);
              var y = 0;
              while (y < docH) {
                ctx.drawImage(img, 0, y, w, tileH);
                y += tileH;
              }
              canvas.style.position = 'absolute';
              canvas.style.top = '0px';
              canvas.style.left = '0px';
              canvas.style.width = w + 'px';
              canvas.style.height = docH + 'px';
              canvas.style.zIndex = '-1';
              canvas.style.pointerEvents = 'none';
              canvas.setAttribute('data-obscura-bg-layer', '1');
              body.appendChild(canvas);
              resolve(function () {
                var el = document.querySelector('canvas[data-obscura-bg-layer]');
                if (el && el.parentNode) el.parentNode.removeChild(el);
              });
            } catch (e) {
              resolve(null);
            }
          };
          img.onerror = function () { resolve(null); };
          img.src = rawUrl;
        });
      })()`);
      return null;
    } catch {
      return null;
    }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array | string> {
    const format = options.type ?? 'png';
    const params: any = { format };
    if (format !== 'png' && options.quality !== undefined) {
      params.quality = Math.min(100, Math.max(0, Math.round(options.quality)));
    }
    if (options.clip) {
      params.clip = { x: options.clip.x, y: options.clip.y, width: options.clip.width, height: options.clip.height, scale: 1 };
      params.captureBeyondViewport = true;
    } else if (options.fullPage) {
      if (options.omitBackground) {
        await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }).catch(() => {});
      }
      const metrics = await this.evaluate(() => ({
        w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
        h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
      }));
      const original = { ...this.#viewport };
      const targetW = Math.max(original.width, Math.min(metrics?.w ?? 0, 20000));
      const targetH = Math.max(original.height, Math.min(metrics?.h ?? 0, 16000));
      let shimResult: string | null = null;
      let cleanup: () => Promise<void> = async () => {};
      try {
        if (targetH > original.height || targetW > original.width) {
          await this.setViewport({ width: targetW, height: targetH, deviceScaleFactor: original.deviceScaleFactor });
        }
        shimResult = await this.#applyBackgroundCompat();
        if (shimResult === 'canvas-installed') {
          cleanup = async () => {
            try {
              await this.evaluate('(function(){var el=document.querySelector("canvas[data-obscura-bg-layer]");if(el&&el.parentNode)el.parentNode.removeChild(el)})()');
            } catch {}
          };
        }
      } catch {}
      try {
        const result = await this.send('Page.captureScreenshot', params);
        const data = result?.data;
        if (!data) throw new Error('Screenshot failed: empty capture data');
        if (options.encoding === 'base64') return data;
        const buffer = Buffer.from(data, 'base64');
        if (options.path) {
          try {
            await writeFile(options.path, buffer);
          } catch (error) {
            throw new Error('Screenshot failed to write ' + options.path + ': ' + (error instanceof Error ? error.message : String(error)));
          }
        }
        return buffer;
      } finally {
        try { await cleanup(); } catch {}
        try { await this.setViewport(original); } catch {}
        if (options.omitBackground) {
          await this.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {});
        }
      }
    }
    if (options.omitBackground) {
      await this.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }).catch(() => {});
    }
    try {
      const result = await this.send('Page.captureScreenshot', params);
      const data = result?.data;
      if (!data) throw new Error('Screenshot failed: empty capture data');
      if (options.encoding === 'base64') return data;
      const buffer = Buffer.from(data, 'base64');
      if (options.path) {
        try {
          await writeFile(options.path, buffer);
        } catch (error) {
          throw new Error('Screenshot failed to write ' + options.path + ': ' + (error instanceof Error ? error.message : String(error)));
        }
      }
      return buffer;
    } finally {
      if (options.omitBackground) {
        await this.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {});
      }
    }
  }

  async elementScreenshot(handle: ElementHandle, options: ScreenshotOptions = {}): Promise<Uint8Array | string> {
    const rect = await handle.boundingBox();
    if (!rect) throw new Error('Element is not visible');
    return await this.screenshot({ ...options, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }

  async pdf(options: PdfOptions = {}): Promise<Uint8Array> {
    const size = (options.format && PDF_FORMATS[options.format.toLowerCase()]) ?? { width: options.width ?? 8.5, height: options.height ?? 11 };
    const params: any = {
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? false,
      scale: options.scale ?? 1,
      paperWidth: size.width,
      paperHeight: size.height,
      marginTop: options.margin?.top ?? 0,
      marginBottom: options.margin?.bottom ?? 0,
      marginLeft: options.margin?.left ?? 0,
      marginRight: options.margin?.right ?? 0
    };
    const result = await this.send('Page.printToPDF', params);
    const data = result?.data;
    if (!data) throw new Error('PDF export failed: empty data');
    const buffer = Buffer.from(data, 'base64');
    if (options.path) {
      try {
        await writeFile(options.path, buffer);
      } catch (error) {
        throw new Error('PDF failed to write ' + options.path + ': ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    return buffer;
  }

  async frames(): Promise<FrameHandle[]> {
    const tree = await this.send('Page.getFrameTree');
    const list: FrameInfo[] = [];
    const walk = (node: any, index: number): void => {
      if (!node?.frame) return;
      list.push({ id: node.frame.id ?? '', url: node.frame.url ?? '', name: node.frame.name ?? '', parentId: node.frame.parentId ?? null, index });
      let childIndex = 0;
      for (const child of node.childFrames ?? []) {
        walk(child, childIndex);
        childIndex++;
      }
    };
    walk(tree?.frameTree, 0);
    return list.map((frame) => new FrameHandle(this.#client, this.#sessionId, frame));
  }

  async setRequestInterception(handler: (request: InterceptRequest) => void | Promise<void>): Promise<void> {
    this.#stopRequestInterception();
    const disposers: (() => void)[] = [];
    const inFlight = new Set<string>();
    const decide = async (params: any): Promise<void> => {
      const requestId = params?.requestId;
      if (!requestId || inFlight.has(requestId)) return;
      inFlight.add(requestId);
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        inFlight.delete(requestId);
      };
      const request: InterceptRequest = {
        url: String(params.request?.url ?? ''),
        method: String(params.request?.method ?? 'GET'),
        headers: params.request?.headers ?? {},
        resourceType: params.resourceType,
        requestId,
        continue: async () => {
          if (settled) return;
          finish();
          await this.send('Fetch.continueRequest', { requestId }).catch(() => {});
        },
        fulfill: async (response: InterceptResponse) => {
          if (settled) return;
          finish();
          const params: any = { requestId, responseCode: response.status ?? 200 };
          const headers: Record<string, string> = { ...(response.headers ?? {}) };
          if (response.contentType) headers['Content-Type'] = response.contentType;
          if (Object.keys(headers).length) {
            params.responseHeaders = Object.entries(headers).map(([name, value]) => ({ name, value }));
          }
          if (response.body !== undefined) {
            params.body = typeof response.body === 'string' ? Buffer.from(response.body, 'utf-8').toString('base64') : Buffer.from(response.body).toString('base64');
          }
          await this.send('Fetch.fulfillRequest', params).catch(() => {});
        },
        respond: async (response: InterceptResponse) => {
          await request.fulfill(response);
        },
        abort: async () => {
          if (settled) return;
          finish();
          await this.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        }
      };
      try {
        await handler(request);
      } catch {}
      if (!settled) await request.continue();
    };
    disposers.push(this.#client.on('Fetch.requestPaused', (params, sessionId) => {
      if (sessionId && sessionId !== this.#sessionId) return;
      void decide(params);
    }));
    try {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    } catch (error) {
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
      throw error;
    }
    this.#interceptDisposers = () => {
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
      this.send('Fetch.disable').catch(() => {});
    };
  }

  #stopRequestInterception(): void {
    const dispose = this.#interceptDisposers;
    this.#interceptDisposers = null;
    if (dispose) dispose();
  }

  async setDownloadDir(dir: string): Promise<void> {
    if (!dir) throw new Error('Download directory is required');
    this.#stopDownloads();
    await mkdir(dir, { recursive: true }).catch(() => {});
    const disposers: (() => void)[] = [];
    this.#downloadPending.clear();
    disposers.push(this.#client.on('Network.responseReceived', (params, sessionId) => {
      if (sessionId && sessionId !== this.#sessionId) return;
      const headers = params?.response?.headers ?? {};
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-disposition');
      const disposition = key ? String(headers[key]) : '';
      if (!disposition || !/attachment/i.test(disposition)) return;
      const url = String(params.response?.url ?? '');
      this.#downloadPending.set(params.requestId, { url, filename: parseAttachmentFilename(disposition, url) });
    }));
    disposers.push(this.#client.on('Network.loadingFinished', (params, sessionId) => {
      if (sessionId && sessionId !== this.#sessionId) return;
      const info = this.#downloadPending.get(params.requestId);
      if (!info) return;
      this.#downloadPending.delete(params.requestId);
      void this.#saveDownload(dir, params.requestId, info);
    }));
    disposers.push(this.#client.on('Network.loadingFailed', (params, sessionId) => {
      if (sessionId && sessionId !== this.#sessionId) return;
      const info = this.#downloadPending.get(params.requestId);
      if (!info) return;
      this.#downloadPending.delete(params.requestId);
      this.#emitLocal('download', { url: info.url, filename: info.filename, error: params?.errorText ?? 'download failed' });
    }));
    try {
      await this.send('Network.enable');
    } catch {}
    this.#downloadDisposers = disposers;
  }

  async #saveDownload(dir: string, requestId: string, info: { url: string; filename: string }): Promise<void> {
    try {
      const body = await this.send('Network.getResponseBody', { requestId });
      const raw = String(body?.body ?? '');
      const buffer = body?.base64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf-8');
      const path = await reserveDownloadPath(dir, info.filename);
      await writeFile(path, buffer);
      this.#emitLocal('download', { url: info.url, filename: info.filename, path, size: buffer.length });
    } catch (error) {
      this.#emitLocal('download', { url: info.url, filename: info.filename, error: error instanceof Error ? error.message : String(error) });
    }
  }

  #stopDownloads(): void {
    const disposers = this.#downloadDisposers;
    this.#downloadDisposers = null;
    this.#downloadPending.clear();
    if (!disposers) return;
    for (const dispose of disposers) {
      try { dispose(); } catch {}
    }
  }

  async mainFrameId(): Promise<string | null> {
    const tree = await this.send('Page.getFrameTree');
    return tree?.frameTree?.frame?.id ?? null;
  }

  async addInitScript(source: string): Promise<void> {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async createIsolatedWorld(name = 'isolated'): Promise<string> {
    const result = await this.send('Page.createIsolatedWorld', { frameId: await this.mainFrameId(), worldName: name, grantUniveralAccess: true });
    return result?.executionContextId;
  }

  async setJavaScriptEnabled(enabled: boolean): Promise<void> {
    await this.send('Emulation.setScriptExecutionDisabled', { value: !enabled });
  }

  async setEmulatedMedia(features: Array<{ name: string; value: string }> = []): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', { features });
  }

  async setTimezone(timezoneId: string): Promise<void> {
    await this.send('Emulation.setTimezoneOverride', { timezoneId });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopRequestInterception();
    this.#stopDownloads();
    this.#localHandlers.clear();
    try {
      await this.#client.send('Target.closeTarget', { targetId: this.#targetId });
    } catch {}
    try {
      this.#onClose?.();
    } catch {}
    this.#onClose = null;
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', timeout = 30000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.#closed) return;
      const ready = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (state === 'domcontentloaded' && ready !== 'loading') return;
      if (state === 'networkidle' && ready === 'complete') {
        await this.waitForTimeout(200);
        return;
      }
      if (state === 'load' && ready === 'complete') return;
      await this.waitForTimeout(50);
    }
  }
}

function parseAttachmentFilename(disposition: string, url: string): string {
  const utf8Match = disposition.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].replace(/^"|"$/g, '')) || 'download';
    } catch {}
  }
  const plainMatch = disposition.match(/filename=(?:"([^"]+)"|([^;\s]+))/i);
  if (plainMatch) {
    const value = plainMatch[1] ?? plainMatch[2];
    if (value) return value;
  }
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (path) return decodeURIComponent(path);
  } catch {}
  return 'download';
}

async function reserveDownloadPath(dir: string, filename: string): Promise<string> {
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download';
  const ext = extname(safe);
  const base = ext ? safe.slice(0, -ext.length) : safe;
  let candidate = join(dir, safe);
  for (let i = 1; existsSync(candidate); i++) {
    candidate = join(dir, base + '-' + i + ext);
  }
  return candidate;
}
