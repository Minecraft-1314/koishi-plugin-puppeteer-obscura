import { CdpClient } from '../cdp'
import { ElementHandle } from './element'

export interface FrameInfo {
  id: string;
  url: string;
  name: string;
  parentId: string | null;
  index: number;
}

const LOCATE_SOURCE = '(function () { var url = URLJSON; var idx = IDX; var list = Array.prototype.slice.call(document.querySelectorAll("iframe,frame")); var host = null; for (var i = 0; i < list.length; i++) { var f = list[i]; try { var d = f.contentDocument; if (d && (d.URL === url || d.documentURL === url)) { host = f; break } } catch (e) {} } if (!host && idx >= 0 && idx < list.length) host = list[idx]; if (!host) return null; var inner = host.contentDocument; if (!inner) return null; return (EXPR) })()';

function locateExpression(info: FrameInfo, expr: string): string {
  return LOCATE_SOURCE
    .replace('URLJSON', JSON.stringify(info.url))
    .replace('IDX', String(info.index))
    .replace('EXPR', expr);
}

export class FrameHandle {
  #client: CdpClient;
  #sessionId: string;
  #frame: FrameInfo;

  constructor(client: CdpClient, sessionId: string, frame: FrameInfo) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#frame = frame;
  }

  get id(): string { return this.#frame.id; }
  get url(): string { return this.#frame.url; }
  get name(): string { return this.#frame.name; }
  get parentId(): string | null { return this.#frame.parentId; }

  #evaluateInFrame<R = any>(expression: string): Promise<R> {
    const wrapped = locateExpression(this.#frame, '(function () { return (' + expression + ') }).call(inner)');
    return this.#client.send('Runtime.evaluate', { expression: wrapped, returnByValue: true }, this.#sessionId).then((result) => {
      if (result?.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
        throw new Error(String(text ?? 'frame evaluate failed'));
      }
      return result?.result?.value as R;
    });
  }

  async #locateObjectId(selector: string): Promise<string | null> {
    const wrapped = locateExpression(this.#frame, '(function () { return inner.querySelector(' + JSON.stringify(selector) + ') })()');
    const result = await this.#client.send('Runtime.evaluate', { expression: wrapped }, this.#sessionId).catch(() => null);
    if (!result || result.exceptionDetails) return null;
    return result.result?.objectId ?? null;
  }

  async #locateOffset(): Promise<{ x: number; y: number }> {
    const wrapped = locateExpression(this.#frame, '(function () { var fr = host.getBoundingClientRect(); var se = host.contentDocument.scrollingElement; return { x: fr.x + host.clientLeft - (se ? se.scrollLeft : 0), y: fr.y + host.clientTop - (se ? se.scrollTop : 0) } })()');
    const result = await this.#client.send('Runtime.evaluate', { expression: wrapped, returnByValue: true }, this.#sessionId).catch(() => null);
    const value = result && !result.exceptionDetails ? result.result?.value : null;
    return { x: Number(value?.x ?? 0), y: Number(value?.y ?? 0) };
  }

  async $(selector: string): Promise<ElementHandle | null> {
    const objectId = await this.#locateObjectId(selector);
    if (!objectId) return null;
    const offset = await this.#locateOffset();
    return new ElementHandle(this.#client, this.#sessionId, null, objectId, offset);
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    const count = await this.#evaluateInFrame<number>('inner.querySelectorAll(' + JSON.stringify(selector) + ').length').catch(() => 0);
    const offset = count > 0 ? await this.#locateOffset() : { x: 0, y: 0 };
    const handles: ElementHandle[] = [];
    for (let i = 0; i < count; i++) {
      const wrapped = locateExpression(this.#frame, '(function () { return inner.querySelectorAll(' + JSON.stringify(selector) + ')[' + i + '] })()');
      const result = await this.#client.send('Runtime.evaluate', { expression: wrapped }, this.#sessionId).catch(() => null);
      const objectId = result && !result.exceptionDetails ? result.result?.objectId : null;
      if (objectId) handles.push(new ElementHandle(this.#client, this.#sessionId, null, objectId, offset));
    }
    return handles;
  }

  async $eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R> {
    const list = args.map((arg) => JSON.stringify(arg)).join(', ');
    const expression = '(function () { var el = inner.querySelector(' + JSON.stringify(selector) + '); if (!el) throw new Error("failed to find element matching selector " + ' + JSON.stringify(selector) + '); return (' + pageFunction.toString() + ')(el' + (list ? ', ' + list : '') + ') })()';
    return await this.#evaluateInFrame<R>(expression);
  }

  async $$eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R> {
    const list = args.map((arg) => JSON.stringify(arg)).join(', ');
    const expression = '(function () { var elements = Array.prototype.slice.call(inner.querySelectorAll(' + JSON.stringify(selector) + ')); if (!elements.length) throw new Error("failed to find element matching selector " + ' + JSON.stringify(selector) + '); return (' + pageFunction.toString() + ')(elements' + (list ? ', ' + list : '') + ') })()';
    return await this.#evaluateInFrame<R>(expression);
  }

  async evaluate<R = any>(expression: string): Promise<R> {
    return await this.#evaluateInFrame<R>(expression);
  }

  async content(): Promise<string> {
    return await this.#evaluateInFrame<string>('inner.documentElement.outerHTML');
  }

  async title(): Promise<string> {
    return await this.#evaluateInFrame<string>('inner.title');
  }
}
