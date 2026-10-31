export interface CdpMessage {
    id?: number;
    method?: string;
    sessionId?: string;
    params?: any;
    result?: any;
    error?: {
        code: number;
        message: string;
    };
}
type EventHandler = (params: any, sessionId?: string) => void;
export interface CdpClientOptions {
    requestTimeout?: number;
    connectTimeout?: number;
    debugLog?: (message: string) => void;
}
export declare class CdpClient {
    #private;
    constructor(endpoint: string, options?: CdpClientOptions);
    get closed(): boolean;
    ready(): Promise<void>;
    send(method: string, params?: any, sessionId?: string): Promise<any>;
    on(method: string, handler: EventHandler): () => void;
    onClose(callback: () => void): () => void;
    once(method: string, predicate?: (params: any) => boolean): Promise<any>;
    close(): void;
}
export {};
