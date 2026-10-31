# koishi-plugin-puppeteer-obscura

## 项目介绍

这是一个为 Koishi 机器人框架开发的**浏览器服务插件**，由 Obscura（纯 Rust 无头浏览器）驱动，通过 Chrome DevTools Protocol 工作。

它负责四件事：按需拉起并守护 Obscura 浏览器进程、暴露与官方 puppeteer 插件一致的页面操作接口、提供断线自愈与进程数量管控、自动处理字体与下载源等部署环境问题。

用户只需在 Koishi 中启用本插件，即可通过 `ctx.puppeteer` 完成网页截图、PDF 导出、元素操作、请求拦截与下载管理。

## 项目仓库

- Obscura 引擎：https://github.com/h4ckf0r0day/obscura

## 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|------|------|------|------|
| `executable` | string | `obscura` | Obscura 可执行文件路径或 PATH 中的程序名，找不到且开启自动下载时按系统自动下载 |
| `autoLaunch` | boolean | `true` | 由插件自动启动 Obscura 进程，关闭后需自行运行并连接已有实例 |
| `autoDownload` | boolean | `true` | 找不到可执行文件时自动识别系统与架构，从官方 releases 下载对应预编译包并缓存 |
| `downloadDir` | string | `~/.obscura-koishi` | 自动下载的缓存目录（Obscura 程序、便携 glibc 运行时、Noto 字体共用） |
| `host` | string | `127.0.0.1` | CDP 服务地址 |
| `port` | number | `9222` | CDP 服务端口 |
| `startupTimeout` | number | `30000` | 等待 Obscura 启动完成的超时（毫秒） |
| `stealth` | boolean | `false` | 反检测模式（一致的浏览器指纹与 TLS 伪装） |
| `allowFileAccess` | boolean | `true` | 允许页面访问 file:// 协议 |
| `allowPrivateNetwork` | boolean | `false` | 允许访问本机与内网地址（引擎默认阻止以防 SSRF，访问 localhost 或内网服务时开启） |
| `fontDirs` | string[] | `[]` | 自定义字体目录，递归加载 TTF/TTC/OTF/OTC，与系统字体一起生效 |
| `autoFontDownload` | boolean | `true` | 系统与字体目录里都没有任何字体文件时，自动下载 Noto Sans CJK 全语言字体并挂载 |
| `obscuraDownloadUrl` | string | 官方 releases | Obscura 预编译包下载地址，支持 `{asset}` 占位符，可填镜像加速 |
| `fontDownloadUrl` | string | 官方 Noto | Noto Sans CJK 字体包完整下载地址，可填镜像 |
| `requestTimeout` | number | `120000` | 单条 CDP 请求的超时（毫秒） |
| `heartbeatInterval` | number | `15000` | 连接心跳间隔（毫秒），进程崩溃后主动发现并自动恢复，0 为关闭 |
| `maxAlivePages` | number | `10` | 同时存活的页面上限，超过自动关闭最早页面，0 为不限制 |
| `maxProcesses` | number | `4` | 同时运行的 Obscura 进程总数上限，超过自动停止最早实例 |
| `workers` | number | `1` | Obscura 工作进程数，不稳定环境设为 2，工作进程崩溃不拖垮服务 |
| `verbose` | boolean | `false` | 开启 Obscura 详细日志（-v），崩溃诊断时使用 |
| `debug` | boolean | `false` | 输出插件调试日志（页面创建/关闭、CDP 收发） |
| `defaultViewport` | object | `1280x768x2` | 新建页面的默认视口（width / height / deviceScaleFactor） |

### 下载源与镜像

自动下载内置多源回退：自定义地址（若配置）→ 官方 GitHub → 国内镜像依次尝试，每个源失败自动重试 1 次。

### maxProcesses 进程上限

| 行为 | 说明 |
|------|------|
| 同端口防重 | 同一 `host:port` 重启时先停止旧实例再启动新实例，不会堆积重复进程 |
| 超限驱逐 | 活跃进程数达到上限时自动停止最早启动的实例 |
| 生命周期闭环 | 插件卸载时回收全部进程，注册表清零 |

## 服务接口

启用插件后通过 `ctx.puppeteer` 访问，与官方 koishi-plugin-puppeteer 服务声明一致。

| 接口 | 参数 | 返回 |
|------|------|------|
| `ctx.puppeteer.page()` | `{ before, onPage, size }` 钩子可选 | `ObscuraPage` 页面实例 |
| `ctx.puppeteer.render(content, callback?)` | HTML 字符串与回调 | `<img>` 标签字符串 |
| `ctx.puppeteer.svg(options)` | `{ size, width, height, viewBox }` | 链式 SVG 构建器（`fill`/`circle`/`rect`/`line`/`text`/`g`/`render`） |
| `ctx.puppeteer.launch()` | 无 | `Promise<void>`，启动并连接浏览器（幂等） |
| `ctx.puppeteer.close()` | 无 | `Promise<void>`，关闭浏览器并取消连接 |
| `ctx.puppeteer.browser` | 无 | 兼容层对象（`newPage` / `close` / `wsEndpoint` / `pages`） |
| `ctx.puppeteer.endpoint` | 无 | CDP 端点字符串，可交给 Puppeteer / Playwright 直连 |
| `ctx.puppeteer.pages` | 无 | 当前跟踪中的页面列表 |
| `ctx.puppeteer.executable` | 无 | 当前使用的 Obscura 可执行文件路径 |

## 渲染与引擎限制

涉及大面积背景图或复杂长页渲染、且上述绕过不满足时，建议对该类页面使用官方 puppeteer 插件（需 Chromium）。

## 故障排查

**日志出现「与 Obscura 的连接已断开，正在自动重连」**

Obscura 进程崩溃或被系统回收。插件会自动重启并恢复，期间到达的调用排队等待（上限 60 秒）。若频繁出现，查看紧邻的「进程异常退出」诊断行确认死因。

**日志出现「进程异常退出（退出码 127）+ mallopt/__res_init symbol not found」**

Alpine/musl 容器的 gcompat 兼容层缺少符号。插件会自动进入第二级方案（下载 Debian libc6 便携运行时并以 loader 显式加载）。若仍未恢复，按诊断行中的根治方案把 Koishi 移到 glibc 基础镜像（debian/ubuntu）部署。

**日志出现「bind 127.0.0.1:9222: Address already in use (os error 98)」**

旧进程退出后的端口 TIME_WAIT 竞态。插件会自动等待端口释放并重试（最多 3 次），无需手动处理。持续出现则检查是否有残留的 obscura 进程。

**下载 Obscura 时提示「下载失败：已尝试 N 个下载源全部失败」**

所有下载源（含镜像）均不可达。按错误信息中的各源原因排查网络，或在 `obscuraDownloadUrl` 配置一个可用的镜像加速地址。

**渲染中文出现方块字**

精简系统无字体。开启 `autoFontDownload`（默认开启），插件会自动下载 Noto Sans CJK 并挂载。

## 项目贡献者

| 贡献者 | 贡献内容 |
|------|------|
| Minecraft-1314 | 插件完整开发 |
| h4ckf0r0day | Obscura 引擎完整开发 |

> 欢迎通过 Issues 或 PR 加入贡献者列表。

## 许可协议

本项目采用 MIT 许可证，详情参见 [LICENSE](LICENSE) 文件。

Obscura 引擎由 h4ckf0r0day 开发，遵循其自有许可协议，发布于 https://github.com/h4ckf0r0day/obscura 。

## 支持我们

如果这个项目对您有帮助，欢迎点亮右上角的 Star 支持我们！
