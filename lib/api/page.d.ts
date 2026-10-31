import { CdpClient } from '../cdp';
import { ElementHandle } from './element';
import { FrameHandle } from './frame';
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
    clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
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
    margin?: {
        top?: number;
        right?: number;
        bottom?: number;
        left?: number;
    };
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
export declare class ObscuraPage {
    #private;
    constructor(client: CdpClient, targetId: string, sessionId: string, viewport: Viewport, onClose?: () => void);
    static create(client: CdpClient, viewport: Viewport, onClose?: () => void): Promise<ObscuraPage>;
    get targetId(): string;
    get sessionId(): string;
    get viewport(): Viewport;
    get closed(): boolean;
    get keyboard(): {
        type: (text: string, options?: {
            delay?: number;
        }) => Promise<void>;
        press: (key: string, options?: {
            delay?: number;
        }) => Promise<void>;
        down: (key: string) => Promise<void>;
        up: (key: string) => Promise<void>;
        sendCharacter: (char: string) => Promise<void>;
    };
    get mouse(): {
        click: (x: number, y: number, options?: {
            button?: string;
            clickCount?: number;
        }) => Promise<void>;
        move: (x: number, y: number, options?: {
            steps?: number;
        }) => Promise<void>;
        down: (options?: {
            button?: string;
            clickCount?: number;
            x?: number;
            y?: number;
        }) => Promise<void>;
        up: (options?: {
            button?: string;
            clickCount?: number;
            x?: number;
            y?: number;
        }) => Promise<void>;
        wheel: (options?: {
            deltaX?: number;
            deltaY?: number;
        }) => Promise<void>;
    };
    mainFrame(): Promise<any>;
    send(method: string, params?: any): Promise<any>;
    on(method: string, handler: (params: any) => void): () => void;
    setViewport(viewport: Viewport): Promise<void>;
    setUserAgent(userAgent: string): Promise<void>;
    setExtraHeaders(headers: Record<string, string>): Promise<void>;
    setOffline(offline: boolean): Promise<void>;
    goto(url: string, options?: {
        waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'networkidle0' | 'networkidle2';
        timeout?: number;
    }): Promise<any>;
    reload(options?: {
        ignoreCache?: boolean;
    }): Promise<any>;
    goBack(): Promise<any>;
    goForward(): Promise<any>;
    setContent(html: string): Promise<void>;
    evaluate<R = any>(pageFunction: string | ((...args: any[]) => any), ...args: any[]): Promise<R>;
    evaluateHandle(pageFunction: string | ((...args: any[]) => any), ...args: any[]): Promise<any>;
    addStyleTag(options: {
        content?: string;
        url?: string;
    }): Promise<null>;
    addScriptTag(options: {
        content?: string;
        url?: string;
    }): Promise<null>;
    waitForNavigation(options?: {
        timeout?: number;
    }): Promise<null>;
    waitForNetworkIdle(timeout?: number, idleTime?: number): Promise<boolean>;
    title(): Promise<string>;
    url(): Promise<string>;
    content(): Promise<string>;
    $(selector: string): Promise<ElementHandle | null>;
    $$(selector: string): Promise<ElementHandle[]>;
    $eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R>;
    $$eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R>;
    waitForSelector(selector: string, options?: WaitOptions): Promise<ElementHandle | null>;
    waitForTimeout(ms: number): Promise<void>;
    waitForFunction(expression: string, options?: WaitOptions): Promise<boolean>;
    mouseClick(x: number, y: number, options?: {
        button?: string;
        clickCount?: number;
    }): Promise<void>;
    select(selector: string, ...values: string[]): Promise<string[]>;
    mouseMove(x: number, y: number): Promise<void>;
    keyboardType(text: string): Promise<void>;
    keyboardPress(key: string): Promise<void>;
    touchStart(x: number, y: number): Promise<void>;
    touchEnd(): Promise<void>;
    cookies(): Promise<CookieParam[]>;
    setCookie(...cookies: CookieParam[]): Promise<void>;
    deleteCookie(...cookies: CookieParam[]): Promise<void>;
    screenshot(options?: ScreenshotOptions): Promise<Uint8Array | string>;
    elementScreenshot(handle: ElementHandle, options?: ScreenshotOptions): Promise<Uint8Array | string>;
    pdf(options?: PdfOptions): Promise<Uint8Array>;
    frames(): Promise<FrameHandle[]>;
    setRequestInterception(handler: (request: InterceptRequest) => void | Promise<void>): Promise<void>;
    setDownloadDir(dir: string): Promise<void>;
    mainFrameId(): Promise<string | null>;
    addInitScript(source: string): Promise<void>;
    createIsolatedWorld(name?: string): Promise<string>;
    setJavaScriptEnabled(enabled: boolean): Promise<void>;
    setEmulatedMedia(features?: Array<{
        name: string;
        value: string;
    }>): Promise<void>;
    setTimezone(timezoneId: string): Promise<void>;
    close(): Promise<void>;
    waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', timeout?: number): Promise<void>;
}
