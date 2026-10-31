"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElementHandle = void 0;
const promises_1 = require("node:fs/promises");
const KEY_CODES = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    Space: { key: ' ', code: 'Space', keyCode: 32 }
};
const RECT_SOURCE = 'function () { var el = this; var r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }';
class ElementHandle {
    #client;
    #sessionId;
    #nodeId;
    #objectId;
    #offset;
    #disposed = false;
    constructor(client, sessionId, nodeId, objectId, offset) {
        this.#client = client;
        this.#sessionId = sessionId;
        this.#nodeId = nodeId ?? null;
        this.#objectId = objectId ?? null;
        this.#offset = offset ?? { x: 0, y: 0 };
    }
    get nodeId() { return this.#nodeId; }
    get objectId() { return this.#objectId; }
    get disposed() { return this.#disposed; }
    #send(method, params = {}) {
        if (this.#disposed)
            return Promise.reject(new Error('ElementHandle has been disposed'));
        return this.#client.send(method, params, this.#sessionId);
    }
    async #resolveObjectId() {
        if (this.#objectId)
            return this.#objectId;
        if (this.#nodeId === null)
            throw new Error('ElementHandle has no node reference');
        const resolved = await this.#send('DOM.resolveNode', { nodeId: this.#nodeId });
        this.#objectId = resolved?.object?.objectId ?? resolved?.object?.id ?? resolved?.objectId ?? null;
        if (!this.#objectId)
            throw new Error('Cannot resolve node to a JavaScript object');
        return this.#objectId;
    }
    async #call(expression, ...args) {
        const objectId = await this.#resolveObjectId();
        const list = args.map((arg) => JSON.stringify(arg)).join(', ');
        const declaration = 'function () { var el = this; return (' + expression + ')(el' + (list ? ', ' + list : '') + ') }';
        const result = await this.#send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: declaration,
            returnByValue: true,
            awaitPromise: true
        });
        if (result?.exceptionDetails) {
            const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
            throw new Error(String(text ?? 'evaluate failed'));
        }
        return result?.result?.value;
    }
    async evaluate(pageFunction, ...args) {
        return await this.#call(pageFunction.toString(), ...args);
    }
    async getProperty(name) {
        return await this.#call('function (el, name) { return el[name] }', name);
    }
    async setProperty(name, value) {
        await this.#call('function (el, name, value) { el[name] = value }', name, value);
    }
    async textContent() {
        return (await this.getProperty('textContent')) ?? '';
    }
    async innerHTML() {
        return (await this.getProperty('innerHTML')) ?? '';
    }
    async outerHTML() {
        if (this.#nodeId !== null && !this.#disposed) {
            try {
                const result = await this.#send('DOM.getOuterHTML', { nodeId: this.#nodeId });
                if (result?.outerHTML !== undefined)
                    return result.outerHTML;
            }
            catch { }
        }
        return (await this.getProperty('outerHTML')) ?? '';
    }
    async describe() {
        if (this.#nodeId !== null && !this.#disposed) {
            try {
                const result = await this.#send('DOM.describeNode', { nodeId: this.#nodeId });
                if (result?.node)
                    return result.node;
            }
            catch { }
        }
        return await this.#call('function (el) { var attrs = []; for (var i = 0; i < el.attributes.length; i++) { attrs.push(el.attributes[i].name, el.attributes[i].value) } return { nodeName: el.nodeName, nodeType: el.nodeType, attributes: attrs, childNodeCount: el.childNodes.length } }');
    }
    async getAttribute(name) {
        return await this.#call('function (el, name) { var v = el.getAttribute(name); return v === null ? null : String(v) }', name);
    }
    async getAttributes() {
        return await this.#call('function (el) { var out = {}; for (var i = 0; i < el.attributes.length; i++) out[el.attributes[i].name] = el.attributes[i].value; return out }');
    }
    async boundingBox() {
        if (this.#disposed)
            return null;
        if (this.#nodeId !== null) {
            try {
                const model = await this.#send('DOM.getBoxModel', { nodeId: this.#nodeId });
                const quad = model?.model?.content ?? model?.model?.border;
                if (quad && quad.length >= 8) {
                    const xs = [quad[0], quad[2], quad[4], quad[6]];
                    const ys = [quad[1], quad[3], quad[5], quad[7]];
                    const x = Math.min(...xs);
                    const y = Math.min(...ys);
                    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
                }
                return null;
            }
            catch {
                return null;
            }
        }
        try {
            const rect = await this.#send('Runtime.callFunctionOn', {
                objectId: await this.#resolveObjectId(),
                functionDeclaration: RECT_SOURCE,
                returnByValue: true
            });
            const value = rect?.result?.value;
            if (!value)
                return null;
            return { x: value.x + this.#offset.x, y: value.y + this.#offset.y, width: value.width, height: value.height };
        }
        catch {
            return null;
        }
    }
    async hover() {
        const rect = await this.boundingBox();
        if (!rect)
            throw new Error('Node is either not visible or not an HTMLElement');
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    }
    async $(selector) {
        const objectId = await this.#resolveObjectId();
        const result = await this.#client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function () { return this.querySelector(' + JSON.stringify(selector) + ') || null }',
            returnByValue: false
        }, this.#sessionId);
        const childId = result?.result?.objectId;
        if (!childId)
            return null;
        return new ElementHandle(this.#client, this.#sessionId, null, childId, this.#offset);
    }
    async $$(selector) {
        const objectId = await this.#resolveObjectId();
        const count = await this.#call('function (el, sel) { return el.querySelectorAll(sel).length }', selector);
        const handles = [];
        for (let i = 0; i < count; i++) {
            const result = await this.#client.send('Runtime.callFunctionOn', {
                objectId,
                functionDeclaration: 'function () { return this.querySelectorAll(' + JSON.stringify(selector) + ')[' + i + '] || null }',
                returnByValue: false
            }, this.#sessionId);
            const childId = result?.result?.objectId;
            if (childId)
                handles.push(new ElementHandle(this.#client, this.#sessionId, null, childId, this.#offset));
        }
        return handles;
    }
    async $eval(selector, pageFunction, ...args) {
        const objectId = await this.#resolveObjectId();
        const list = args.map((arg) => JSON.stringify(arg)).join(', ');
        const declaration = 'function () { var el = this.querySelector(' + JSON.stringify(selector) + '); if (!el) throw new Error("failed to find element matching selector " + ' + JSON.stringify(selector) + '); return (' + pageFunction.toString() + ')(el' + (list ? ', ' + list : '') + ') }';
        const result = await this.#client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: declaration,
            returnByValue: true,
            awaitPromise: true
        }, this.#sessionId);
        if (result?.exceptionDetails) {
            const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
            throw new Error(String(text ?? '$eval failed'));
        }
        return result?.result?.value;
    }
    async $$eval(selector, pageFunction, ...args) {
        const objectId = await this.#resolveObjectId();
        const list = args.map((arg) => JSON.stringify(arg)).join(', ');
        const declaration = 'function () { var els = Array.prototype.slice.call(this.querySelectorAll(' + JSON.stringify(selector) + ')); if (!els.length) throw new Error("failed to find element matching selector " + ' + JSON.stringify(selector) + '); return (' + pageFunction.toString() + ')(els' + (list ? ', ' + list : '') + ') }';
        const result = await this.#client.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: declaration,
            returnByValue: true,
            awaitPromise: true
        }, this.#sessionId);
        if (result?.exceptionDetails) {
            const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
            throw new Error(String(text ?? '$$eval failed'));
        }
        return result?.result?.value;
    }
    async screenshot(options = {}) {
        const rect = await this.boundingBox();
        if (!rect)
            throw new Error('Element is not visible');
        const params = { format: options.type ?? 'png' };
        if (options.type && options.type !== 'png' && options.quality !== undefined) {
            params.quality = Math.min(100, Math.max(0, Math.round(options.quality)));
        }
        params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
        params.captureBeyondViewport = true;
        if (options.omitBackground) {
            await this.#client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, this.#sessionId).catch(() => { });
        }
        try {
            const result = await this.#client.send('Page.captureScreenshot', params, this.#sessionId);
            const data = result?.data;
            if (!data)
                throw new Error('Screenshot failed: empty capture data');
            if (options.encoding === 'base64')
                return data;
            const buffer = Buffer.from(data, 'base64');
            if (options.path) {
                try {
                    await (0, promises_1.writeFile)(options.path, buffer);
                }
                catch (error) {
                    throw new Error('Screenshot failed to write ' + options.path + ': ' + (error instanceof Error ? error.message : String(error)));
                }
            }
            return buffer;
        }
        finally {
            if (options.omitBackground) {
                await this.#client.send('Emulation.setDefaultBackgroundColorOverride', {}, this.#sessionId).catch(() => { });
            }
        }
    }
    async click() {
        if (this.#nodeId === null) {
            await this.#call('function (el) { el.click() }');
            return;
        }
        const rect = await this.boundingBox();
        if (!rect)
            throw new Error('Node is either not visible or not an HTMLElement');
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        await this.#send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
        await this.#send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await this.#send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    async focus() {
        await this.#call('function (el) { el.focus() }');
    }
    async scrollIntoView() {
        if (this.#nodeId !== null && !this.#disposed) {
            try {
                await this.#send('DOM.scrollIntoViewIfNeeded', { nodeId: this.#nodeId });
                return;
            }
            catch { }
        }
        await this.#call('function (el) { el.scrollIntoView({ block: "center", inline: "center" }) }');
    }
    async type(text) {
        await this.focus();
        await this.#send('Input.insertText', { text });
    }
    async press(key) {
        const entry = KEY_CODES[key] ?? {
            key,
            code: key,
            keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0
        };
        const common = { key: entry.key, code: entry.code, windowsVirtualKeyCode: entry.keyCode || 0, nativeVirtualKeyCode: entry.keyCode || 0 };
        await this.#send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
        await this.#send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    }
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        if (this.#objectId) {
            try {
                await this.#client.send('Runtime.releaseObject', { objectId: this.#objectId }, this.#sessionId);
            }
            catch { }
            this.#objectId = null;
        }
        this.#nodeId = null;
    }
}
exports.ElementHandle = ElementHandle;
