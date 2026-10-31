import { CdpClient } from '../cdp';
import { ElementHandle } from './element';
export interface FrameInfo {
    id: string;
    url: string;
    name: string;
    parentId: string | null;
    index: number;
}
export declare class FrameHandle {
    #private;
    constructor(client: CdpClient, sessionId: string, frame: FrameInfo);
    get id(): string;
    get url(): string;
    get name(): string;
    get parentId(): string | null;
    $(selector: string): Promise<ElementHandle | null>;
    $$(selector: string): Promise<ElementHandle[]>;
    $eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R>;
    $$eval<R = any>(selector: string, pageFunction: any, ...args: any[]): Promise<R>;
    evaluate<R = any>(expression: string): Promise<R>;
    content(): Promise<string>;
    title(): Promise<string>;
}
