import { Context, h, Service, Schema } from 'koishi'
import { CdpClient } from './cdp'
import { launchObscura, type ObscuraProcess } from './launcher'
import { ObscuraPage } from './api/page'
import { SVG, type SVGOptions } from './compat'

export { SVG, Tag } from './compat'
export type { SVGOptions, ViewBox } from './compat'
import { type Attributes } from './compat'

declare module 'koishi' {
  interface Context {
    puppeteer: Puppeteer;
  }
}

export interface PageOptions {
  before?: (page: ObscuraPage) => void | Promise<void>;
  onPage?: (page: ObscuraPage) => void | Promise<void>;
  size?: { width: number; height: number } | null;
}

export type RenderCallback = (page: ObscuraPage, next: (handle?: any) => Promise<string>) => Promise<string>;

export class Puppeteer extends Service {
  static [Service.provide] = 'puppeteer';

  _process: ObscuraProcess | null = null;
  _client: CdpClient | null = null;
  _pages = new Set<ObscuraPage>();
  _detach: (() => void) | null = null;

  constructor(ctx: Context, public config: Puppeteer.Config) {
    super(ctx, 'puppeteer');
    if (!this.config) this.config = {} as Puppeteer.Config;
  }

  get endpoint(): string {
    const host = this.config?.host ?? '127.0.0.1';
    const port = this.config?.port ?? 9222;
    return this._process?.endpoint ?? (this.config?.autoLaunch === false ? 'ws://' + host + ':' + port + '/devtools/browser' : '');
  }

  get pages(): ObscuraPage[] {
    return [...this._pages];
  }

  get executable(): string {
    return this._executable ?? this.config?.executablePath ?? this.config?.executable ?? 'obscura';
  }

  private _executable: string | null = null;
  private _browserShim: any = null;
  _stopping = false;
  _reconnecting = false;
  _everStarted = false;
  _heartbeat: NodeJS.Timeout | null = null;
  _heartbeatFailures = 0;

  get reconnecting(): boolean {
    return this._reconnecting;
  }

  _startHeartbeat(client: CdpClient): void {
    this._stopHeartbeat();
    const interval = this.config.heartbeatInterval ?? 15000;
    if (interval <= 0) return;
    this._heartbeatFailures = 0;
    this._heartbeat = setInterval(() => {
      if (this._stopping || this._reconnecting || client.closed) {
        if (client.closed && !this._stopping && !this._reconnecting) this._handleDisconnect();
        return;
      }
      void client.send('Browser.getVersion', {}, undefined)
        .then(() => {
          this._heartbeatFailures = 0;
        })
        .catch(() => {
          this._heartbeatFailures++;
          if (this._heartbeatFailures >= 2 && !this._stopping && !this._reconnecting) {
            this.ctx.logger('puppeteer-obscura').warn('连接心跳连续失败，判定 Obscura 已不可用');
            this._handleDisconnect();
          }
        });
    }, interval);
    this._heartbeat.unref?.();
  }

  _stopHeartbeat(): void {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  async _waitPortFree(port: number, timeout: number): Promise<boolean> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const occupied = await new Promise<boolean>((resolve) => {
        const net = require('net') as typeof import('net');
        const socket = new net.Socket();
        const done = (value: boolean) => { socket.destroy(); resolve(value) };
        socket.setTimeout(800, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.connect(port, '127.0.0.1');
      });
      if (!occupied) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => { setTimeout(resolve, 300) });
    }
  }

  _handleDisconnect(): void {
    if (this._stopping || this._reconnecting) return;
    this._reconnecting = true;
    this._stopHeartbeat();
    this._detach?.();
    this._detach = null;
    this._client = null;
    this._pages.clear();
    const logger = this.ctx.logger('puppeteer-obscura');
    logger.warn('与 Obscura 的连接已断开，正在自动重连');
    void this._reconnectLoop();
  }

  async _reconnectLoop(): Promise<void> {
    const logger = this.ctx.logger('puppeteer-obscura');
    let delay = 2000;
    for (;;) {
      if (this._stopping) {
        this._reconnecting = false;
        return;
      }
      await new Promise((resolve) => { setTimeout(resolve, delay) });
      if (this._stopping) {
        this._reconnecting = false;
        return;
      }
      try {
        if (this.config.autoLaunch !== false) {
          if (this._process) {
            const exitInfo = this._process.exitInfo;
            const tail = this._process.lastOutput.trim();
            if (exitInfo.signal) {
              logger.warn('Obscura 进程被信号 ' + exitInfo.signal + ' 强制终止（常见原因：容器/系统内存不足触发 OOM，或被手动杀死）' + (tail ? '，最后输出：' + tail : ''));
            } else if (exitInfo.code !== null && exitInfo.code !== 0) {
              logger.warn('Obscura 进程异常退出（退出码 ' + exitInfo.code + '）。若在 Alpine/musl 容器内通过便携 glibc 运行且反复出现，属于该环境下引擎的稳定性问题，根治方案：把 Koishi 移到 glibc 基础镜像（debian/ubuntu）部署，或在宿主机直接运行 obscura 并将本插件 autoLaunch 关闭后连接宿主机实例；也可尝试在 obscuraDownloadUrl 中指定其他版本' + (tail ? '，最后输出：' + tail : ''));
            }
            try { await this._process.stop(); } catch {}
            this._process = null;
            const portFree = await this._waitPortFree(this.config.port ?? 9222, 5000);
            if (!portFree) {
              logger.warn('端口 ' + (this.config.port ?? 9222) + ' 仍被占用，等待其释放后再启动新实例');
            }
          }
          if (this._stopping) {
            this._reconnecting = false;
            return;
          }
          this._process = await launchObscura({
            executable: this.config.executable ?? this.config.executablePath ?? 'obscura',
            port: this.config.port ?? 9222,
            host: this.config.host ?? '127.0.0.1',
            stealth: this.config.stealth ?? false,
            allowFileAccess: this.config.allowFileAccess ?? true,
            allowPrivateNetwork: this.config.allowPrivateNetwork ?? false,
            fontDirs: this.config.fontDirs ?? [],
            autoFontDownload: this.config.autoFontDownload ?? true,
            autoDownload: this.config.autoDownload ?? true,
            downloadDir: this.config.downloadDir,
            obscuraDownloadUrl: this.config.obscuraDownloadUrl,
            fontDownloadUrl: this.config.fontDownloadUrl,
            verbose: this.config.verbose ?? false,
            workers: this.config.workers ?? 1,
            maxProcesses: this.config.maxProcesses ?? 4,
            onLog: (message) => logger.info(message),
            startupTimeout: this.config.startupTimeout ?? 30000
          });
          this._executable = this._process.binaryPath;
          if (this._stopping) {
            try { await this._process.stop(); } catch {}
            this._process = null;
            this._reconnecting = false;
            return;
          }
        }
        const host = this.config.host ?? '127.0.0.1';
        const port = this.config.port ?? 9222;
        const endpoint = this._process?.endpoint ?? ('ws://' + host + ':' + port + '/devtools/browser');
        const client = new CdpClient(endpoint, {
          requestTimeout: this.config.requestTimeout ?? 120000,
          debugLog: this.config.debug ? (message) => logger.debug(message) : null
        });
        await client.ready();
        this._client = client;
        this._detach = client.on('Target.targetDestroyed', (params) => {
          for (const page of [...this._pages]) {
            if (page.targetId === params.targetId) this._pages.delete(page);
          }
        });
        client.onClose(() => this._handleDisconnect());
        this._startHeartbeat(client);
        this._reconnecting = false;
        logger.info('Obscura 连接已自动恢复：%s', endpoint);
        return;
      } catch (error) {
        logger.warn('Obscura 自动重连失败（' + (error instanceof Error ? error.message : String(error)) + '），' + Math.round(delay / 1000) + ' 秒后再次尝试');
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  async _ensureConnected(timeout = 60000): Promise<CdpClient> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const client = this._client;
      if (client && !client.closed) return client;
      if (this._stopping) throw new Error('Obscura 浏览器服务正在停止');
      if (!this._reconnecting) {
        if (this._everStarted) {
          this._handleDisconnect();
          continue;
        }
        throw new Error('Obscura 浏览器服务未运行：启动失败或已被停止，请检查上方启动错误日志');
      }
      if (Date.now() > deadline) {
        throw new Error('Obscura 连接曾断开，自动重连超时（' + timeout + 'ms）仍未恢复，请检查 Obscura 进程状态');
      }
      await new Promise((resolve) => { setTimeout(resolve, 200) });
    }
  }

  get browser(): any {
    if (!this._browserShim) {
      const service = this;
      this._browserShim = {
        newPage: () => service.page(),
        close: () => service.stop(),
        wsEndpoint: () => service.endpoint,
        pages: () => Promise.resolve(service.pages)
      };
    }
    return this._browserShim;
  }

  async launch(): Promise<void> {
    const client = this._client;
    if (client && !client.closed && this._process) return;
    if (this._everStarted && !this._client && !this._stopping) {
      await this._ensureConnected();
      return;
    }
    await this.start();
  }

  close(): Promise<void> {
    return this.stop();
  }

  svg(options?: SVGOptions): SVG {
    return new SVG(options);
  }

  render = async (content: string, callback?: RenderCallback): Promise<string> => {
    const page = await this.page();
    try {
      if (content) await page.setContent(content);
      const fallback = async (_: ObscuraPage, next: (handle?: any) => Promise<string>) => {
        const handle = await page.$('body');
        return await next(handle);
      };
      const output = await (callback ?? fallback)(page, async (handle) => {
        const clip = handle ? await handle.boundingBox() : null;
        const buffer = (await page.screenshot({ clip: clip ?? undefined })) as Buffer;
        return h.image(buffer, 'image/png').toString();
      });
      return output;
    } finally {
      try { await page.close(); } catch {}
    }
  };

  async page(options?: PageOptions): Promise<ObscuraPage> {
    const maxAlive = this.config.maxAlivePages ?? 0;
    while (maxAlive > 0 && this._pages.size >= maxAlive) {
      const oldest = this._pages.values().next().value as ObscuraPage | undefined;
      if (!oldest) break;
      this.ctx.logger('puppeteer-obscura').warn('存活页面已达上限 ' + maxAlive + '，自动关闭最早的页面 ' + oldest.targetId + '（如非预期请检查调用方是否遗漏 close）');
      this._pages.delete(oldest);
      try { await oldest.close(); } catch {}
    }
    const page = await this.createPage();
    try {
      if (options?.size) {
        await page.setViewport({
          width: options.size.width ?? this.config.defaultViewport?.width ?? 1280,
          height: options.size.height ?? this.config.defaultViewport?.height ?? 768,
          deviceScaleFactor: this.config.defaultViewport?.deviceScaleFactor ?? 2
        });
      }
      if (options?.before) await options.before(page);
      if (options?.onPage) await options.onPage(page);
    } catch (error) {
      try { await page.close(); } catch {}
      throw error;
    }
    return page;
  }

  private async createPage(): Promise<ObscuraPage> {
    const client = await this._ensureConnected();
    const logger = this.ctx.logger('puppeteer-obscura');
    let page: ObscuraPage | null = null;
    page = await ObscuraPage.create(client, {
      width: this.config.defaultViewport?.width ?? 1280,
      height: this.config.defaultViewport?.height ?? 768,
      deviceScaleFactor: this.config.defaultViewport?.deviceScaleFactor ?? 2
    }, () => {
      if (page) {
        this._pages.delete(page);
        logger.debug('page closed: %s', page.targetId);
      }
    });
    this._pages.add(page);
    logger.debug('page opened: %s', page.targetId);
    return page;
  }

  private registerHtmlComponent(): void {
    const transformStyle = (source: Attributes, base: Attributes = {}) => {
      return Object.entries({ ...base, ...source }).map(([key, value]) => {
        return key.replace(/[A-Z]/g, (str) => '-' + str.toLowerCase()) + ': ' + (Array.isArray(value) ? value.join(', ') : value);
      }).join('; ');
    };

    this.ctx.component('html', async (attrs: any, children: any[]) => {
      const head: any[] = [];

      const transform = (element: any): any => {
        if (element.type === 'head') {
          head.push(...element.children);
          return null;
        }
        const attributes = { ...element.attrs };
        if (typeof attributes.style === 'object') {
          attributes.style = transformStyle(attributes.style);
        }
        return h(element.type, attributes, element.children.map(transform).filter(Boolean));
      };

      const page = await this.page();
      try {
        if (attrs.src) {
          await page.goto(String(attrs.src));
        } else {
          const bodyStyle = typeof attrs.style === 'object'
            ? transformStyle({ display: 'inline-block' }, attrs.style)
            : ['display: inline-block', attrs.style].filter(Boolean).join('; ');
          const content = children.map(transform).filter(Boolean).join('');
          const lang = attrs.lang ? ' lang="' + attrs.lang + '"' : '';
          await page.setContent('<html' + lang + '><head>' + head.join('') + '</head><body style="' + bodyStyle + '">' + content + '</body></html>');
        }
        await page.waitForNetworkIdle(attrs.timeout ? +attrs.timeout : undefined);
        const body = await page.$(attrs.selector || 'body');
        if (!body) throw new Error('html 组件未找到目标元素：' + (attrs.selector || 'body'));
        const clip = await body.boundingBox();
        const screenshot = (await page.screenshot({ clip: clip ?? undefined })) as Buffer;
        return h.image(screenshot, 'image/png');
      } finally {
        try { await page.close(); } catch {}
      }
    });
  }

  async start(): Promise<void> {
    const logger = this.ctx.logger('puppeteer-obscura');
    try {
      logger.info('正在启动 Obscura 浏览器服务（autoLaunch: %s）', this.config.autoLaunch === false ? '关闭，连接已有实例' : '开启');
      if (this.config.autoLaunch !== false) {
        this._process = await launchObscura({
          executable: this.config.executable ?? this.config.executablePath ?? 'obscura',
          port: this.config.port ?? 9222,
          host: this.config.host ?? '127.0.0.1',
          stealth: this.config.stealth ?? false,
          allowFileAccess: this.config.allowFileAccess ?? true,
          allowPrivateNetwork: this.config.allowPrivateNetwork ?? false,
          fontDirs: this.config.fontDirs ?? [],
          autoFontDownload: this.config.autoFontDownload ?? true,
          autoDownload: this.config.autoDownload ?? true,
          downloadDir: this.config.downloadDir,
          obscuraDownloadUrl: this.config.obscuraDownloadUrl,
          fontDownloadUrl: this.config.fontDownloadUrl,
          verbose: this.config.verbose ?? false,
          workers: this.config.workers ?? 1,
          maxProcesses: this.config.maxProcesses ?? 4,
          onLog: (message) => this.ctx.logger('puppeteer-obscura').info(message),
          startupTimeout: this.config.startupTimeout ?? 30000
        });
      }
      const host = this.config.host ?? '127.0.0.1';
      const port = this.config.port ?? 9222;
      const endpoint = this._process?.endpoint ?? ('ws://' + host + ':' + port + '/devtools/browser');
      const resolvedExecutable = this._process?.binaryPath ?? this.config.executable ?? this.config.executablePath ?? 'obscura';
      const client = new CdpClient(endpoint, {
        requestTimeout: this.config.requestTimeout ?? 120000,
        debugLog: this.config.debug ? (message) => logger.debug(message) : null
      });
      this._client = client;
      await client.ready();
      this._everStarted = true;
      client.onClose(() => this._handleDisconnect());
      this._startHeartbeat(client);
      this._detach = client.on('Target.targetDestroyed', (params) => {
        for (const page of [...this._pages]) {
          if (page.targetId === params.targetId) this._pages.delete(page);
        }
      });
      this._executable = this._process?.binaryPath ?? resolvedExecutable;
      this.registerHtmlComponent();
      logger.info('obscura ready at %s', endpoint);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this._stopping = true;
    try {
      const pages = [...this._pages];
      try {
        this.ctx.logger('puppeteer-obscura').info('正在停止 Obscura 浏览器服务（关闭 %d 个页面）', pages.length);
      } catch {
        console.info('[puppeteer-obscura] 正在停止 Obscura 浏览器服务（关闭 %d 个页面）', pages.length);
      }
      this._stopHeartbeat();
      this._detach?.();
      this._detach = null;
      this._pages.clear();
      for (const page of pages) {
        try { await page.close(); } catch {}
      }
      if (this._client) {
        this._client.close();
        this._client = null;
      }
      if (this._process) {
        try { await this._process.stop(); } catch {}
        this._process = null;
      }
    } finally {
      this._stopping = false;
    }
  }
}

export namespace Puppeteer {
  export interface Config {
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
    defaultViewport: { width: number; height: number; deviceScaleFactor: number };
  }
}

export const Config: Schema<Puppeteer.Config> = Schema.intersect([
  Schema.object({
    executable: Schema.string().default('obscura').description('Obscura 可执行文件路径或 PATH 中的程序名，找不到且开启自动下载时会按系统自动下载'),
    executablePath: Schema.string().default('').description('兼容官方插件配置名的可执行文件路径（与上面 executable 二选一，优先用 executable）'),
    autoLaunch: Schema.boolean().default(true).description('由插件自动启动 Obscura 进程，关闭后需自行运行并连接已有实例'),
    autoDownload: Schema.boolean().default(true).description('找不到 Obscura 可执行文件时，自动识别系统与架构并下载对应官方预编译包'),
    downloadDir: Schema.string().default('').description('自动下载的缓存目录（留空使用用户目录下的 .obscura-koishi）'),
    obscuraDownloadUrl: Schema.string().default('').description('Obscura 预编译包下载地址，支持 {asset} 占位符（如镜像/github 加速地址），留空使用官方 GitHub releases'),
    fontDownloadUrl: Schema.string().default('').description('Noto Sans CJK 字体包完整下载地址，留空使用官方 GitHub releases，访问 GitHub 受限时可填镜像'),
    host: Schema.string().default('127.0.0.1').description('CDP 服务地址'),
    port: Schema.number().min(0).max(65535).default(9222).description('CDP 服务端口'),
    startupTimeout: Schema.number().min(1000).max(600000).default(30000).description('等待 Obscura 启动完成的超时（毫秒）')
  }).description('进程设置'),
  Schema.object({
    stealth: Schema.boolean().default(false).description('反检测模式（一致的浏览器指纹与 TLS 伪装）'),
    allowFileAccess: Schema.boolean().default(true).description('允许页面访问 file:// 协议'),
    allowPrivateNetwork: Schema.boolean().default(false).description('允许访问本机与内网地址（Obscura 默认阻止以防 SSRF，需要访问 localhost 或内网服务时开启）'),
    fontDirs: Schema.array(Schema.string()).default([]).description('自定义字体目录（递归加载 TTF/TTC/OTF/OTC，渲染时与系统字体一起生效，可填多个）'),
    autoFontDownload: Schema.boolean().default(true).description('系统与字体目录里都没有任何字体文件时，自动下载 Noto Sans CJK 全语言字体（覆盖中日韩与拉丁等全部文字）'),
    requestTimeout: Schema.number().min(1000).max(3600000).default(120000).description('单条 CDP 请求的超时（毫秒）'),
    heartbeatInterval: Schema.number().min(0).max(300000).default(15000).description('连接心跳间隔（毫秒）：定时探测 Obscura 存活，崩溃后主动发现并自动恢复，0 为关闭'),
    maxAlivePages: Schema.number().min(0).max(200).default(10).description('同时存活的页面上限：超过时自动关闭最早的页面，防止调用方遗漏 close 导致内存累积，0 为不限制'),
    verbose: Schema.boolean().default(false).description('开启 Obscura 详细日志（-v）：崩溃排查时开启，断线诊断会包含更完整的现场输出'),
    workers: Schema.number().min(1).max(8).default(1).description('Obscura 工作进程数：在 Alpine/musl 容器等不稳定环境中设为 2，单个工作进程崩溃时连接可立即由新实例接管，无需重启整个服务（修改后需重载插件）'),
    maxProcesses: Schema.number().min(1).max(16).default(4).description('同时运行的 Obscura 进程总数上限：超过时自动停止最早的实例，防止进程与内存无限累积'),
    debug: Schema.boolean().default(false).description('输出调试日志')
  }).description('浏览器行为'),
  Schema.object({
    defaultViewport: Schema.object({
      width: Schema.number().min(1).max(10000).default(1280).description('视口宽度（像素）'),
      height: Schema.number().min(1).max(10000).default(768).description('视口高度（像素）'),
      deviceScaleFactor: Schema.number().min(0.1).max(10).default(2).description('设备缩放比例')
    }).description('新建页面的默认视口')
  }).description('视口设置')
]) as Schema<Puppeteer.Config>

export default {
  name: 'puppeteer-obscura',
  reusable: false,
  Config,
  apply(ctx: Context, config: Puppeteer.Config) {
    ctx.plugin(Puppeteer, config)
  }
}
