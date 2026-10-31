import { CdpClient } from '../cdp';
export interface ElementRect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export declare class ElementHandle {
    #private;
    constructor(client: CdpClient, sessionId: string, nodeId: number | null, objectId?: string | null, offset?: {
        x: number;
        y: number;
    });
    get nodeId(): number | null;
    get objectId(): string | null;
    get disposed(): boolean;
    evaluate<R = any>(pageFunction: any, ...args: any[]): Promise<R>;
    getProperty<R = any>(name: string): Promise<R>;
    setProperty(name: string, value: any): Promise<void>;
    textContent(): Promise<string>;
    innerHTML(): Promise<string>;
    outerHTML(): Promise<string>;
    describe(): Promise<any>;
    getAttribute(name: string): Promise<string | null>;
    getAttributes(): Promise<Record<string, string>>;
    boundingBox(): Promise<ElementRect | null>;
    hover(): Promise<void>;
    $(selector: string): Promise<ElementHandle | null>;
    $$(selector: string): Promise<ElementHandle[]>;
    $eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R>;
    $$eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R>;
    screenshot(options?: {
        type?: 'png' | 'jpeg' | 'webp';
        quality?: number;
        omitBackground?: boolean;
        encoding?: 'base64' | 'binary';
        path?: string;
    }): Promise<Uint8Array | string>;
    click(): Promise<void>;
    focus(): Promise<void>;
    scrollIntoView(): Promise<void>;
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    dispose(): Promise<void>;
}
