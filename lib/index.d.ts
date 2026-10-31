import { Context, Service, Schema } from 'koishi';
import { CdpClient } from './cdp';
import { type ObscuraProcess } from './launcher';
import { ObscuraPage } from './api/page';
import { SVG, type SVGOptions } from './compat';
export { SVG, Tag } from './compat';
export type { SVGOptions, ViewBox } from './compat';
declare module 'koishi' {
    interface Context {
        puppeteer: Puppeteer;
    }
}
export interface PageOptions {
    before?: (page: ObscuraPage) => void | Promise<void>;
    onPage?: (page: ObscuraPage) => void | Promise<void>;
    size?: {
        width: number;
        height: number;
    } | null;
}
export type RenderCallback = (page: ObscuraPage, next: (handle?: any) => Promise<string>) => Promise<string>;
export declare class Puppeteer extends Service {
    config: Puppeteer.Config;
    static [Service.provide]: string;
    _process: ObscuraProcess | null;
    _client: CdpClient | null;
    _pages: Set<ObscuraPage>;
    _detach: (() => void) | null;
    constructor(ctx: Context, config: Puppeteer.Config);
    get endpoint(): string;
    get pages(): ObscuraPage[];
    get executable(): string;
    private _executable;
    private _browserShim;
    _stopping: boolean;
    _reconnecting: boolean;
    _everStarted: boolean;
    _heartbeat: NodeJS.Timeout | null;
    _heartbeatFailures: number;
    get reconnecting(): boolean;
    _startHeartbeat(client: CdpClient): void;
    _stopHeartbeat(): void;
    _waitPortFree(port: number, timeout: number): Promise<boolean>;
    _handleDisconnect(): void;
    _reconnectLoop(): Promise<void>;
    _ensureConnected(timeout?: number): Promise<CdpClient>;
    get browser(): any;
    launch(): Promise<void>;
    close(): Promise<void>;
    svg(options?: SVGOptions): SVG;
    render: (content: string, callback?: RenderCallback) => Promise<string>;
    page(options?: PageOptions): Promise<ObscuraPage>;
    private createPage;
    private registerHtmlComponent;
    start(): Promise<void>;
    stop(): Promise<void>;
}
export declare namespace Puppeteer {
    interface Config {
        executable: string;
        executablePath: string;
        port: number;
        host: string;
        autoLaunch: boolean;
        startupTimeout: number;
        stealth: boolean;
        allowFileAccess: boolean;
        allowPrivateNetwork: boolean;
        fontDirs: string[];
        autoFontDownload: boolean;
        autoDownload: boolean;
        downloadDir: string;
        obscuraDownloadUrl: string;
        fontDownloadUrl: string;
        requestTimeout: number;
        heartbeatInterval: number;
        maxAlivePages: number;
        verbose: boolean;
        workers: number;
        maxProcesses: number;
        debug: boolean;
        defaultViewport: {
            width: number;
            height: number;
            deviceScaleFactor: number;
        };
    }
}
export declare const Config: Schema<Puppeteer.Config>;
declare const _default: {
    name: string;
    reusable: boolean;
    Config: Schema<Puppeteer.Config>;
    apply(ctx: Context, config: Puppeteer.Config): void;
};
export default _default;
