export interface ObscuraOptions {
    executable?: string;
    port?: number;
    host?: string;
    stealth?: boolean;
    allowFileAccess?: boolean;
    allowPrivateNetwork?: boolean;
    fontDirs?: string[];
    autoFontDownload?: boolean;
    autoDownload?: boolean;
    downloadDir?: string;
    obscuraDownloadUrl?: string;
    fontDownloadUrl?: string;
    verbose?: boolean;
    workers?: number;
    maxProcesses?: number;
    onLog?: (message: string) => void;
    startupTimeout?: number;
}
export interface ObscuraProcess {
    endpoint: string;
    port: number;
    binaryPath: string;
    get exitInfo(): {
        code: number | null;
        signal: string | null;
    };
    get lastOutput(): string;
    stop(): Promise<void>;
}
export declare function hasAnyFont(userFontDirs?: string[]): boolean;
export declare function ensureNotoFontDownloaded(downloadDir?: string, fontUrl?: string, onLog?: (message: string) => void): Promise<string>;
export declare function readArMembers(debPath: string): Array<{
    name: string;
    data: Buffer;
}>;
export declare function locatePortableGlibcLoader(cacheDir: string | undefined): {
    loader: string;
    libPath: string;
} | null;
export declare function ensurePortableGlibc(cacheDir: string | undefined, onLog?: (message: string) => void): Promise<{
    loader: string;
    libPath: string;
} | null>;
export declare function resolveFontDirs(userFontDirs: string[] | undefined, autoFontDownload: boolean | undefined, downloadDir: string | undefined, fontUrl: string | undefined, onLog?: (message: string) => void): Promise<string[]>;
export interface DownloadSource {
    label: string;
    url: string;
}
export declare function buildObscuraSources(userUrl: string | undefined, asset: string): DownloadSource[];
export declare function buildFontSources(userUrl: string | undefined, official?: string): DownloadSource[];
export declare function downloadFromSources(sources: DownloadSource[], target: string, onLog?: (message: string) => void): Promise<void>;
export declare function validateBinary(binary: string): void;
export declare function elfInterpreter(binary: string): string | null;
export declare function describeSpawnFailure(resolved: string, code: string | undefined): string | null;
export declare function ensureObscuraDownloaded(downloadDir?: string, obscuraUrl?: string, onLog?: (message: string) => void): Promise<string>;
export declare function autoInstallRuntime(onLog?: (message: string) => void): Promise<boolean>;
export declare function getActiveObscuraProcessCount(): number;
export declare function stopAllObscuraProcesses(): Promise<void>;
export declare function buildServeArgs(options: ObscuraOptions, fontDirs: string[], host: string, port: number): string[];
export declare function launchObscura(options?: ObscuraOptions): Promise<ObscuraProcess>;
