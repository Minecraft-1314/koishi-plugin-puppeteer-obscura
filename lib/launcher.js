"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasAnyFont = hasAnyFont;
exports.ensureNotoFontDownloaded = ensureNotoFontDownloaded;
exports.readArMembers = readArMembers;
exports.locatePortableGlibcLoader = locatePortableGlibcLoader;
exports.ensurePortableGlibc = ensurePortableGlibc;
exports.resolveFontDirs = resolveFontDirs;
exports.buildObscuraSources = buildObscuraSources;
exports.buildFontSources = buildFontSources;
exports.downloadFromSources = downloadFromSources;
exports.validateBinary = validateBinary;
exports.elfInterpreter = elfInterpreter;
exports.describeSpawnFailure = describeSpawnFailure;
exports.ensureObscuraDownloaded = ensureObscuraDownloaded;
exports.autoInstallRuntime = autoInstallRuntime;
exports.getActiveObscuraProcessCount = getActiveObscuraProcessCount;
exports.stopAllObscuraProcesses = stopAllObscuraProcesses;
exports.buildServeArgs = buildServeArgs;
exports.launchObscura = launchObscura;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const node_net_1 = require("node:net");
const node_stream_1 = require("node:stream");
const promises_1 = require("node:stream/promises");
const DEFAULT_PORT = 9222;
const DEFAULT_EXECUTABLE = 'obscura';
const DEFAULT_STARTUP_TIMEOUT = 30000;
const LOG_LIMIT = 8192;
const STOP_GRACE_MS = 3000;
const RELEASE_BASE = 'https://github.com/h4ckf0r0day/obscura/releases/latest/download';
const NOTO_FONT_URL = 'https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/00_NotoSansCJK.ttc.zip';
const BUILTIN_MIRRORS = [
    'https://gh-proxy.com/',
    'https://ghfast.top/',
    'https://ghproxy.net/'
];
const FONT_EXTENSIONS = ['.ttf', '.ttc', '.otf', '.otc'];
const SYSTEM_FONT_DIRS = {
    win32: ['C:/Windows/Fonts'],
    linux: ['/usr/share/fonts', '/usr/local/share/fonts', (0, node_path_1.join)((0, node_os_1.homedir)(), '.local/share/fonts'), (0, node_path_1.join)((0, node_os_1.homedir)(), '.fonts')],
    darwin: ['/System/Library/Fonts', '/Library/Fonts', (0, node_path_1.join)((0, node_os_1.homedir)(), 'Library/Fonts')]
};
function isFontFile(name) {
    const lower = name.toLowerCase();
    return FONT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
function directoryHasFont(dir, depth) {
    let entries;
    try {
        entries = (0, node_fs_1.readdirSync)(dir, { withFileTypes: true });
    }
    catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.isFile() && isFontFile(entry.name))
            return true;
    }
    if (depth <= 0)
        return false;
    for (const entry of entries) {
        if (entry.isDirectory() && directoryHasFont((0, node_path_1.join)(dir, entry.name), depth - 1))
            return true;
    }
    return false;
}
function hasAnyFont(userFontDirs) {
    for (const dir of userFontDirs ?? []) {
        if (typeof dir === 'string' && dir.trim() && directoryHasFont(dir.trim(), 2))
            return true;
    }
    for (const dir of SYSTEM_FONT_DIRS[process.platform] ?? []) {
        if (directoryHasFont(dir, 2))
            return true;
    }
    return false;
}
async function downloadNotoFonts(downloadDir, fontUrl, onLog) {
    const root = downloadDir && downloadDir.trim() ? downloadDir.trim() : (0, node_path_1.join)((0, node_os_1.homedir)(), '.obscura-koishi');
    const dir = (0, node_path_1.join)(root, 'noto-sans-cjk');
    if (directoryHasFont(dir, 2))
        return dir;
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    const archive = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'noto-sans-cjk-' + Date.now() + '.zip');
    try {
        onLog?.('开始下载 Noto Sans CJK 全语言字体');
        await downloadFromSources(buildFontSources(fontUrl), archive, onLog);
        if (process.platform === 'win32') {
            const ps = 'Expand-Archive -LiteralPath \'' + archive.replace(/'/g, "''") + '\' -DestinationPath \'' + dir.replace(/'/g, "''") + '\' -Force';
            await run('powershell.exe', ['-NoProfile', '-Command', ps]);
        }
        else {
            await run('unzip', ['-o', archive, '-d', dir]);
        }
        if (!directoryHasFont(dir, 2))
            throw new Error('Downloaded font archive did not contain any font files');
        return dir;
    }
    catch (error) {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
        throw error;
    }
    finally {
        (0, node_fs_1.rmSync)(archive, { force: true });
    }
}
let fontDownloadInflight = null;
function ensureNotoFontDownloaded(downloadDir, fontUrl, onLog) {
    if (!fontDownloadInflight) {
        fontDownloadInflight = downloadNotoFonts(downloadDir, fontUrl, onLog).finally(() => {
            fontDownloadInflight = null;
        });
    }
    return fontDownloadInflight;
}
const DEBIAN_LIBC6_POOLS = [
    'https://mirrors.tuna.tsinghua.edu.cn/debian/pool/main/g/glibc/',
    'https://mirrors.ustc.edu.cn/debian/pool/main/g/glibc/',
    'https://deb.debian.org/debian/pool/main/g/glibc/'
];
function readArMembers(debPath) {
    const buffer = (0, node_fs_1.readFileSync)(debPath);
    if (buffer.subarray(0, 8).toString('ascii') !== '!<arch>\n')
        throw new Error('不是有效的 .deb 归档（缺少 ar 头）：' + debPath);
    const members = [];
    let offset = 8;
    while (offset + 60 <= buffer.length) {
        const header = buffer.subarray(offset, offset + 60);
        if (header.toString('ascii', 58, 60) !== '\x60\n')
            break;
        const rawName = header.toString('ascii', 0, 16).trim();
        const size = parseInt(header.toString('ascii', 48, 58).trim(), 10);
        if (!Number.isFinite(size) || size < 0)
            break;
        const dataStart = offset + 60;
        if (dataStart + size > buffer.length)
            break;
        const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
        if (name !== 'debian-binary' && !rawName.startsWith('/')) {
            members.push({ name, data: Buffer.from(buffer.subarray(dataStart, dataStart + size)) });
        }
        offset = dataStart + size + (size % 2);
    }
    return members;
}
function debVersionKey(version) {
    return version.split(/[.\-+~]/).map((part) => parseInt(part, 10) || 0);
}
async function pickLatestLibc6Deb(poolUrl, onLog) {
    const response = await fetch(poolUrl, {
        signal: AbortSignal.timeout(30000),
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) koishi-plugin-puppeteer-obscura' }
    });
    if (!response.ok)
        throw new Error('HTTP ' + response.status);
    const html = await response.text();
    const versions = [];
    const pattern = /libc6_([0-9][0-9A-Za-z.+\-~]*?)_amd64\.deb/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        const stableMatch = match[1].match(/deb(\d+)u/);
        versions.push({
            file: 'libc6_' + match[1] + '_amd64.deb',
            key: debVersionKey(match[1]),
            stable: stableMatch ? parseInt(stableMatch[1], 10) : 0
        });
    }
    if (!versions.length)
        throw new Error('目录中未找到 libc6 amd64 包');
    versions.sort((a, b) => {
        if (a.stable !== b.stable)
            return a.stable - b.stable;
        for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
            const diff = (a.key[i] ?? 0) - (b.key[i] ?? 0);
            if (diff !== 0)
                return diff;
        }
        return 0;
    });
    const chosen = versions[versions.length - 1];
    onLog?.('选择 libc6 包：' + chosen.file + (chosen.stable > 0 ? '（stable 系）' : ''));
    return poolUrl + chosen.file;
}
function locatePortableGlibcLoader(cacheDir) {
    const root = cacheDir && cacheDir.trim() ? cacheDir.trim() : (0, node_path_1.join)((0, node_os_1.homedir)(), '.obscura-koishi');
    const libDir = (0, node_path_1.join)(root, 'glibc-runtime');
    const candidates = [
        (0, node_path_1.join)(libDir, 'usr', 'lib', 'x86_64-linux-gnu', 'ld-linux-x86-64.so.2'),
        (0, node_path_1.join)(libDir, 'lib', 'x86_64-linux-gnu', 'ld-linux-x86-64.so.2'),
        (0, node_path_1.join)(libDir, 'usr', 'lib64', 'ld-linux-x86-64.so.2'),
        (0, node_path_1.join)(libDir, 'lib64', 'ld-linux-x86-64.so.2'),
        (0, node_path_1.join)(libDir, 'ld-linux-x86-64.so.2')
    ];
    for (const loader of candidates) {
        if ((0, node_fs_1.existsSync)(loader))
            return { loader, libPath: (0, node_path_1.dirname)(loader) };
    }
    return null;
}
async function ensurePortableGlibc(cacheDir, onLog) {
    const cached = locatePortableGlibcLoader(cacheDir);
    if (cached)
        return cached;
    const root = cacheDir && cacheDir.trim() ? cacheDir.trim() : (0, node_path_1.join)((0, node_os_1.homedir)(), '.obscura-koishi');
    const libDir = (0, node_path_1.join)(root, 'glibc-runtime');
    if (!(0, node_fs_1.existsSync)('/sbin/apk') && !(0, node_fs_1.existsSync)('/usr/sbin/apk')) {
        onLog?.('当前环境无 apk 包管理器，跳过便携 glibc 安装');
        return null;
    }
    try {
        await run('apk', ['add', '--no-cache', 'zstd']);
    }
    catch { }
    try {
        await run('apk', ['add', '--no-cache', 'xz']);
    }
    catch { }
    const archive = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'libc6-' + Date.now() + '.deb');
    try {
        let downloaded = false;
        for (const pool of DEBIAN_LIBC6_POOLS) {
            try {
                onLog?.('从 ' + new URL(pool).host + ' 获取 Debian glibc 运行时');
                const debUrl = await pickLatestLibc6Deb(pool, onLog);
                await downloadFromSources([{ label: new URL(debUrl).host, url: debUrl }], archive, onLog);
                downloaded = true;
                break;
            }
            catch (error) {
                onLog?.('源 ' + new URL(pool).host + ' 不可用：' + (error instanceof Error ? error.message : String(error)));
            }
        }
        if (!downloaded)
            throw new Error('所有 Debian 镜像均不可用');
        const members = readArMembers(archive);
        const dataMember = members.find((m) => m.name.startsWith('data.tar'));
        if (!dataMember)
            throw new Error('deb 中没有 data 归档');
        (0, node_fs_1.mkdirSync)(libDir, { recursive: true });
        const dataPath = (0, node_path_1.join)(libDir, dataMember.name);
        (0, node_fs_1.writeFileSync)(dataPath, dataMember.data);
        if (dataMember.name.endsWith('.zst')) {
            await run('zstd', ['-d', '-f', dataPath, '-o', dataPath.slice(0, -4)]);
        }
        else if (dataMember.name.endsWith('.xz')) {
            await run('xz', ['-d', '-f', dataPath]);
        }
        const tarPath = dataPath.replace(/\.(zst|xz)$/, '');
        if (!(0, node_fs_1.existsSync)(tarPath))
            throw new Error('解压后未找到 tar 归档：' + tarPath);
        await run('tar', ['-xf', tarPath, '-C', libDir]);
        (0, node_fs_1.rmSync)(dataPath, { force: true });
        const found = locatePortableGlibcLoader(cacheDir);
        if (found) {
            onLog?.('便携 glibc 运行时就绪：' + found.loader);
            return found;
        }
        const discovered = [];
        const walk = (dir, depth) => {
            if (depth > 3 || discovered.length >= 12)
                return;
            let entries;
            try {
                entries = (0, node_fs_1.readdirSync)(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                const full = (0, node_path_1.join)(dir, entry.name);
                if (entry.isDirectory())
                    walk(full, depth + 1);
                else
                    discovered.push(full.slice(libDir.length + 1));
            }
        };
        walk(libDir, 0);
        onLog?.('解包内容示例：' + discovered.join(', '));
        throw new Error('解包完成但未找到 ld-linux loader（解包内容见上方日志）');
    }
    catch (error) {
        onLog?.('便携 glibc 安装失败：' + (error instanceof Error ? error.message : String(error)));
        return null;
    }
    finally {
        (0, node_fs_1.rmSync)(archive, { force: true });
    }
}
async function resolveFontDirs(userFontDirs, autoFontDownload, downloadDir, fontUrl, onLog) {
    const dirs = (userFontDirs ?? []).map((d) => (typeof d === 'string' ? d.trim() : '')).filter(Boolean);
    if (autoFontDownload === false)
        return dirs;
    if (hasAnyFont(dirs))
        return dirs;
    onLog?.('系统与字体目录中未找到任何字体文件，开始下载 Noto Sans CJK 全语言字体');
    const downloaded = await ensureNotoFontDownloaded(downloadDir, fontUrl, onLog);
    onLog?.('Noto Sans CJK 字体就绪：' + downloaded);
    return [...dirs, downloaded];
}
const PLATFORM_ASSETS = {
    'win32-x64': 'obscura-x86_64-windows.zip',
    'linux-x64': 'obscura-x86_64-linux.tar.gz',
    'linux-arm64': 'obscura-aarch64-linux.tar.gz',
    'darwin-x64': 'obscura-x86_64-macos.tar.gz',
    'darwin-arm64': 'obscura-aarch64-macos.tar.gz'
};
function platformAsset() {
    const key = process.platform + '-' + process.arch;
    const asset = PLATFORM_ASSETS[key];
    if (!asset)
        throw new Error('Obscura has no prebuilt package for ' + key + ', specify executable manually');
    return asset;
}
function findBinary(dir) {
    const names = process.platform === 'win32' ? ['obscura.exe'] : ['obscura'];
    for (const name of names) {
        const direct = (0, node_path_1.join)(dir, name);
        if ((0, node_fs_1.existsSync)(direct))
            return direct;
    }
    const stack = [dir];
    while (stack.length) {
        const current = stack.pop();
        let entries;
        try {
            entries = (0, node_fs_1.readdirSync)(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = (0, node_path_1.join)(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            }
            else if (names.includes(entry.name)) {
                return full;
            }
        }
    }
    return null;
}
async function pipelineWithProgress(response, target, onLog) {
    const total = Number(response.headers.get('content-length') ?? 0);
    let downloaded = 0;
    let lastLoggedAt = Date.now();
    const startedAt = Date.now();
    const formatMB = (bytes) => (bytes / 1048576).toFixed(1) + 'MB';
    const report = (force) => {
        const now = Date.now();
        if (!force && now - lastLoggedAt < 2000)
            return;
        lastLoggedAt = now;
        const elapsed = (now - startedAt) / 1000;
        const speed = formatMB(elapsed > 0 ? downloaded / elapsed : 0) + '/s';
        if (total > 0) {
            onLog?.('下载进度：' + (downloaded / total * 100).toFixed(1) + '%（' + formatMB(downloaded) + ' / ' + formatMB(total) + '），速度 ' + speed);
        }
        else {
            onLog?.('下载进度：已下载 ' + formatMB(downloaded) + '，速度 ' + speed);
        }
    };
    const counter = new node_stream_1.Transform({
        transform(chunk, _encoding, callback) {
            downloaded += chunk.length;
            report(false);
            callback(null, chunk);
        },
        flush(callback) {
            report(true);
            callback();
        }
    });
    await (0, promises_1.pipeline)(node_stream_1.Readable.fromWeb(response.body), counter, (0, node_fs_1.createWriteStream)(target));
    const elapsed = (Date.now() - startedAt) / 1000;
    onLog?.('下载完成：' + formatMB(downloaded) + '，耗时 ' + elapsed.toFixed(1) + ' 秒，平均速度 ' + formatMB(elapsed > 0 ? downloaded / elapsed : 0) + '/s');
}
function buildObscuraSources(userUrl, asset) {
    const official = RELEASE_BASE + '/' + asset;
    const sources = [];
    const trimmed = userUrl && userUrl.trim();
    if (trimmed) {
        sources.push({
            label: '自定义地址',
            url: trimmed.includes('{asset}') ? trimmed.replace('{asset}', encodeURIComponent(asset)) : trimmed.replace(/\/+$/, '') + '/' + asset
        });
    }
    sources.push({ label: '官方 GitHub', url: official });
    for (const mirror of BUILTIN_MIRRORS) {
        sources.push({ label: '镜像 ' + new URL(mirror).host, url: mirror + official });
    }
    return sources;
}
function buildFontSources(userUrl, official = NOTO_FONT_URL) {
    const sources = [];
    const trimmed = userUrl && userUrl.trim();
    if (trimmed)
        sources.push({ label: '自定义地址', url: trimmed });
    sources.push({ label: '官方 GitHub', url: official });
    for (const mirror of BUILTIN_MIRRORS) {
        sources.push({ label: '镜像 ' + new URL(mirror).host, url: mirror + official });
    }
    return sources;
}
async function downloadFromSources(sources, target, onLog) {
    if (!sources.length)
        throw new Error('下载失败：未提供任何下载源');
    try {
        (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(target), { recursive: true });
    }
    catch { }
    const failures = [];
    for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                if (index > 0 && attempt === 1) {
                    onLog?.('上一个下载源失败，自动切换到：' + source.label);
                }
                const response = await fetch(source.url, {
                    redirect: 'follow',
                    signal: AbortSignal.timeout(600000),
                    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) koishi-plugin-puppeteer-obscura' }
                });
                if (!response.ok || !response.body)
                    throw new Error('HTTP ' + response.status);
                await pipelineWithProgress(response, target, onLog);
                if ((0, node_fs_1.statSync)(target).size <= 0)
                    throw new Error('downloaded file is empty');
                return;
            }
            catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                failures.push(source.label + '（' + reason + '）');
                try {
                    (0, node_fs_1.rmSync)(target, { force: true });
                }
                catch { }
                if (attempt < 2) {
                    onLog?.('下载失败（' + reason + '），2 秒后在本源重试');
                    await new Promise((resolve) => { setTimeout(resolve, 2000); });
                }
            }
        }
    }
    throw new Error('下载失败：已尝试 ' + sources.length + ' 个下载源全部失败（' + failures.join('；') + '）。可在插件配置中把下载地址改为可用的镜像加速地址，或关闭对应的自动下载开关');
}
function validateBinary(binary) {
    const fd = (0, node_fs_1.openSync)(binary, 'r');
    const header = Buffer.alloc(4);
    (0, node_fs_1.readSync)(fd, header, 0, 4, 0);
    (0, node_fs_1.closeSync)(fd);
    const isElf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
    const isPe = header[0] === 0x4d && header[1] === 0x5a;
    const expectedElf = process.platform !== 'win32';
    if (expectedElf ? !isElf : !isPe) {
        throw new Error('下载产物不是有效的可执行文件（期望 ' + (expectedElf ? 'ELF' : 'PE/MZ') + ' 头，实际为 ' + header.toString('hex') + '），已清除缓存：' + binary);
    }
    if (!expectedElf)
        return;
    try {
        (0, node_fs_1.chmodSync)(binary, 0o755);
        (0, node_fs_1.accessSync)(binary, node_fs_1.constants.X_OK);
    }
    catch (error) {
        throw new Error('Obscura 可执行文件无执行权限：' + binary + '（原因：' + (error instanceof Error ? error.message : String(error)) + '）');
    }
}
function elfInterpreter(binary) {
    let fd = null;
    try {
        fd = (0, node_fs_1.openSync)(binary, 'r');
        const buffer = Buffer.alloc(65536);
        const read = (0, node_fs_1.readSync)(fd, buffer, 0, buffer.length, 0);
        const content = buffer.subarray(0, read);
        const start = content.indexOf('/lib');
        if (start < 0)
            return null;
        let end = start;
        while (end < content.length && content[end] !== 0)
            end++;
        return content.toString('utf8', start, end);
    }
    catch {
        return null;
    }
    finally {
        if (fd !== null) {
            try {
                (0, node_fs_1.closeSync)(fd);
            }
            catch { }
        }
    }
}
function describeSpawnFailure(resolved, code) {
    if (code !== 'ENOENT')
        return null;
    if (!(0, node_fs_1.existsSync)(resolved)) {
        return 'Obscura 可执行文件在启动前消失：' + resolved + '（磁盘/解压异常，删除缓存目录后可触发重新下载）';
    }
    const interp = elfInterpreter(resolved);
    if (interp && !(0, node_fs_1.existsSync)(interp)) {
        return 'Obscura 可执行文件存在但当前环境缺少它需要的动态链接器 ' + interp + '。这通常发生在 Alpine/musl 精简容器中运行 glibc 构建的程序，请改用 glibc 基础镜像（如 debian/ubuntu）部署 Koishi，或在配置中把 executable 指向可运行的宿主机路径：' + resolved;
    }
    return 'Obscura 可执行文件存在但无法启动：' + resolved + '（文件可能已损坏，删除缓存目录 ' + (0, node_path_1.dirname)(resolved) + ' 后重启可触发重新下载）';
}
function run(command, args) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, args, { stdio: 'ignore', windowsHide: true });
        let error = null;
        child.once('error', (e) => {
            error = e instanceof Error ? e : new Error(String(e));
        });
        child.once('close', (code) => {
            if (code === 0)
                return resolve();
            reject(new Error('Extraction failed' + (error ? ': ' + error.message : ' with exit code ' + code) + ' (' + command + ')'));
        });
    });
}
async function downloadObscura(downloadDir, obscuraUrl, onLog) {
    const asset = platformAsset();
    const root = downloadDir && downloadDir.trim() ? downloadDir.trim() : (0, node_path_1.join)((0, node_os_1.homedir)(), '.obscura-koishi');
    const dir = (0, node_path_1.join)(root, asset.replace(/\.(zip|tar\.gz)$/, ''));
    const existing = findBinary(dir);
    if (existing)
        return existing;
    (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    const archive = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'obscura-download-' + Date.now() + '-' + asset);
    try {
        onLog?.('未找到 Obscura 可执行文件，开始下载 ' + asset + '（官方失败将自动切换镜像）');
        await downloadFromSources(buildObscuraSources(obscuraUrl, asset), archive, onLog);
        onLog?.('Obscura 下载完成，正在解压');
        if (asset.endsWith('.zip')) {
            if (process.platform === 'win32') {
                const ps = 'Expand-Archive -LiteralPath \'' + archive.replace(/'/g, "''") + '\' -DestinationPath \'' + dir.replace(/'/g, "''") + '\' -Force';
                await run('powershell.exe', ['-NoProfile', '-Command', ps]);
            }
            else {
                await run('unzip', ['-o', archive, '-d', dir]);
            }
        }
        else {
            await run('tar', ['-xzf', archive, '-C', dir]);
        }
        const binary = findBinary(dir);
        if (!binary)
            throw new Error('下载的压缩包中没有找到 obscura 可执行文件：' + dir);
        validateBinary(binary);
        return binary;
    }
    catch (error) {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
        throw error;
    }
    finally {
        (0, node_fs_1.rmSync)(archive, { force: true });
    }
}
let downloadInflight = null;
function ensureObscuraDownloaded(downloadDir, obscuraUrl, onLog) {
    if (!downloadInflight) {
        downloadInflight = downloadObscura(downloadDir, obscuraUrl, onLog).finally(() => {
            downloadInflight = null;
        });
    }
    return downloadInflight;
}
function findExecutable(candidate) {
    if (candidate.includes('/') || candidate.includes('\\')) {
        return (0, node_fs_1.existsSync)(candidate) ? candidate : null;
    }
    const path = process.env.PATH ?? '';
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of path.split(process.platform === 'win32' ? ';' : ':')) {
        if (!dir)
            continue;
        for (const ext of exts) {
            const full = dir + '/' + candidate + ext;
            if ((0, node_fs_1.existsSync)(full))
                return full;
        }
    }
    return null;
}
function waitPort(host, port, timeout, aborted) {
    return new Promise((resolve) => {
        let settled = false;
        let connecting = false;
        let attemptTimer = null;
        const deadline = Date.now() + Math.max(0, timeout);
        const settle = (value) => {
            if (settled)
                return;
            settled = true;
            if (attemptTimer)
                clearTimeout(attemptTimer);
            resolve(value);
        };
        const attempt = () => {
            if (settled || connecting)
                return;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return settle(false);
            if (aborted?.())
                return settle(false);
            connecting = true;
            const socket = (0, node_net_1.createConnection)({ host, port });
            const finish = (ok) => {
                connecting = false;
                socket.destroy();
                if (settled)
                    return;
                if (ok)
                    return settle(true);
                if (aborted?.())
                    return settle(false);
                if (Date.now() >= deadline)
                    return settle(false);
                attemptTimer = setTimeout(attempt, 120);
            };
            socket.setTimeout(Math.min(1000, remaining), () => finish(false));
            socket.once('connect', () => finish(true));
            socket.once('error', () => finish(false));
        };
        attempt();
    });
}
function stopChild(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            child.stdout?.destroy();
            child.stderr?.destroy();
            return resolve();
        }
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            clearTimeout(graceTimer);
            clearTimeout(lastResortTimer);
            child.off('close', finish);
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve();
        };
        const graceTimer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            }
            catch { }
        }, STOP_GRACE_MS);
        const lastResortTimer = setTimeout(finish, STOP_GRACE_MS + 500);
        graceTimer.unref?.();
        lastResortTimer.unref?.();
        child.once('close', finish);
        try {
            child.kill();
        }
        catch {
            finish();
        }
    });
}
const SAFE_SHELL_ARG = /^[A-Za-z0-9._:\-]+$/;
function requiresShell(resolved) {
    const lower = resolved.toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat');
}
function validateShellArgs(args) {
    for (const arg of args) {
        if (!SAFE_SHELL_ARG.test(arg))
            throw new Error('Unsafe argument for batch script launch: ' + arg);
    }
}
function isRootUser() {
    try {
        return typeof process.getuid === 'function' && process.getuid() === 0;
    }
    catch {
        return false;
    }
}
async function autoInstallRuntime(onLog) {
    if (process.platform !== 'linux')
        return false;
    if (!isRootUser()) {
        onLog?.('当前进程不是 root，跳过自动安装 glibc 兼容层');
        return false;
    }
    if ((0, node_fs_1.existsSync)('/sbin/apk') || (0, node_fs_1.existsSync)('/usr/sbin/apk')) {
        onLog?.('检测到 Alpine/musl 系统，尝试自动安装 glibc 兼容层：apk add gcompat');
        try {
            await run('apk', ['add', '--no-cache', 'gcompat']);
            onLog?.('gcompat 安装成功');
            return true;
        }
        catch {
            onLog?.('gcompat 安装失败，尝试 libc6-compat');
            try {
                await run('apk', ['add', '--no-cache', 'libc6-compat']);
                onLog?.('libc6-compat 安装成功');
                return true;
            }
            catch {
                onLog?.('apk 安装均失败，可能缺少网络或软件源，可手动执行 apk add gcompat');
                return false;
            }
        }
    }
    if ((0, node_fs_1.existsSync)('/usr/bin/apt-get')) {
        onLog?.('检测到 Debian/Ubuntu 系统，尝试自动安装：apt-get install libc6');
        try {
            await run('apt-get', ['install', '-y', 'libc6']);
            onLog?.('libc6 安装成功');
            return true;
        }
        catch {
            onLog?.('apt-get 安装失败，可手动执行 apt-get update && apt-get install -y libc6');
            return false;
        }
    }
    onLog?.('未识别到 apk 或 apt-get 包管理器，无法自动安装，请手动安装 glibc 运行环境');
    return false;
}
const activeProcesses = new Map();
function processKey(host, port) {
    return host + ':' + port;
}
function getActiveObscuraProcessCount() {
    return activeProcesses.size;
}
async function stopAllObscuraProcesses() {
    const all = [...activeProcesses.values()];
    activeProcesses.clear();
    for (const p of all) {
        try {
            await p.stop();
        }
        catch { }
    }
}
function buildServeArgs(options, fontDirs, host, port) {
    const args = ['serve'];
    if (options.verbose)
        args.push('-v');
    args.push('--host', host, '--port', String(port));
    if (options.stealth)
        args.push('--stealth');
    if (options.allowFileAccess)
        args.push('--allow-file-access');
    if (options.allowPrivateNetwork)
        args.push('--allow-private-network');
    const workers = Math.max(1, Math.min(8, Math.round(options.workers ?? 1)));
    if (workers > 1) {
        args.push('--workers', String(workers), '--worker-drain-timeout', '60');
    }
    for (const dir of fontDirs)
        args.push('--font-dir', dir);
    return args;
}
async function launchObscura(options = {}) {
    const host = options.host ?? '127.0.0.1';
    const port = options.port ?? DEFAULT_PORT;
    const executable = options.executable ?? DEFAULT_EXECUTABLE;
    let resolved = findExecutable(executable);
    if (!resolved) {
        if (options.autoDownload) {
            resolved = await ensureObscuraDownloaded(options.downloadDir, options.obscuraDownloadUrl, options.onLog);
        }
        else {
            throw new Error('Obscura executable not found: ' + executable);
        }
    }
    const fontDirs = await resolveFontDirs(options.fontDirs, options.autoFontDownload, options.downloadDir, options.fontDownloadUrl, options.onLog);
    const args = buildServeArgs(options, fontDirs, host, port);
    const useShell = requiresShell(resolved);
    if (useShell)
        validateShellArgs(args);
    let runtimeFixTried = false;
    let portableGlibc = locatePortableGlibcLoader(options.downloadDir);
    if (portableGlibc) {
        options.onLog?.('检测到便携 glibc 运行时缓存，直接以 loader 启动 Obscura');
    }
    let bindRetryCount = 0;
    const key = processKey(host, port);
    const existing = activeProcesses.get(key);
    if (existing) {
        options.onLog?.('端口 ' + port + ' 已有活跃的 Obscura 实例，先停止旧实例');
        activeProcesses.delete(key);
        try {
            await existing.stop();
        }
        catch { }
    }
    const maxProcesses = Math.max(1, options.maxProcesses ?? 4);
    if (activeProcesses.size >= maxProcesses) {
        options.onLog?.('活跃 Obscura 进程数已达上限 ' + maxProcesses + '，自动停止最早启动的实例');
        const oldestKey = activeProcesses.keys().next().value;
        const oldestProc = oldestKey ? activeProcesses.get(oldestKey) : null;
        if (oldestKey)
            activeProcesses.delete(oldestKey);
        if (oldestProc) {
            try {
                await oldestProc.stop();
            }
            catch { }
        }
    }
    for (;;) {
        let spawnCommand = resolved;
        let spawnArgs = args;
        if (portableGlibc) {
            spawnCommand = portableGlibc.loader;
            spawnArgs = ['--library-path', portableGlibc.libPath, resolved, ...args];
        }
        const child = useShell
            ? (0, node_child_process_1.spawn)([spawnCommand, ...spawnArgs].join(' '), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true })
            : (0, node_child_process_1.spawn)(spawnCommand, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let logs = '';
        let failure = null;
        let failureCode;
        let exited = false;
        const appendLog = (chunk) => {
            logs += String(chunk);
            if (logs.length > LOG_LIMIT)
                logs = logs.slice(logs.length - LOG_LIMIT);
        };
        child.stdout?.on('data', appendLog);
        child.stderr?.on('data', appendLog);
        child.once('error', (error) => {
            failure = error instanceof Error ? error : new Error(String(error));
            failureCode = error?.code;
        });
        child.once('exit', () => {
            exited = true;
        });
        const ready = await waitPort(host, port, options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT, () => exited || failure !== null);
        if (ready) {
            const handle = {
                endpoint: 'ws://' + host + ':' + port + '/devtools/browser',
                port,
                binaryPath: resolved,
                get exitInfo() {
                    return { code: child.exitCode, signal: child.signalCode };
                },
                get lastOutput() {
                    return logs.slice(-300);
                },
                stop: () => {
                    activeProcesses.delete(key);
                    return stopChild(child);
                }
            };
            activeProcesses.set(key, handle);
            return handle;
        }
        await stopChild(child);
        const bindInUse = logs.includes('Address already in use') || logs.includes('EADDRINUSE') || (failure?.message ?? '').includes('bind');
        if (bindInUse) {
            const attempt = ++bindRetryCount;
            if (attempt <= 3) {
                options.onLog?.('端口 ' + port + ' 暂被占用（旧实例尚未完全退出），' + 1500 * attempt + 'ms 后重试（' + attempt + '/3）');
                await new Promise((resolve) => { setTimeout(resolve, 1500 * attempt); });
                continue;
            }
            throw new Error('Obscura 启动失败（端口 ' + port + '）：端口被其他进程长期占用，请检查是否有残留的 obscura 进程（输出：' + logs.slice(-300) + '）');
        }
        const relocatingFailure = logs.includes('symbol not found') || logs.includes('Error relocating');
        if (failure) {
            const spawnFailure = describeSpawnFailure(resolved, failureCode);
            if (spawnFailure?.includes('动态链接器') && !runtimeFixTried) {
                runtimeFixTried = true;
                const installed = await autoInstallRuntime(options.onLog);
                if (installed) {
                    options.onLog?.('glibc 兼容环境已就绪，重试启动 Obscura');
                    continue;
                }
            }
            if (spawnFailure)
                throw new Error(spawnFailure);
            throw new Error('Obscura 启动失败（端口 ' + port + '）：' + failureCode + ' ' + failure.message);
        }
        if (exited) {
            if (relocatingFailure && !portableGlibc) {
                options.onLog?.('gcompat 兼容层缺少 obscura 需要的 glibc 符号，改用完整便携 glibc 运行时');
                portableGlibc = await ensurePortableGlibc(options.downloadDir, options.onLog);
                if (portableGlibc) {
                    options.onLog?.('改用便携 glibc loader 重新启动 Obscura');
                    continue;
                }
            }
            throw new Error('Obscura 启动失败（端口 ' + port + '）：进程意外退出，输出：' + logs.slice(-500));
        }
        if (relocatingFailure && !portableGlibc) {
            options.onLog?.('gcompat 兼容层缺少 obscura 需要的 glibc 符号，改用完整便携 glibc 运行时');
            portableGlibc = await ensurePortableGlibc(options.downloadDir, options.onLog);
            if (portableGlibc) {
                options.onLog?.('改用便携 glibc loader 重新启动 Obscura');
                continue;
            }
        }
        throw new Error('Obscura 启动失败（端口 ' + port + '）：等待 ' + (options.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT) + 'ms 后 CDP 端口仍未就绪，最后输出：' + logs.slice(-500));
    }
}
