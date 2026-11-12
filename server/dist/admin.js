import { parseTarGz, MANIFEST_PATH } from './lib/archive.js';
import { buildZip } from './lib/zip.js';
/** 按包内路径归类到同步模块（与插件端扫描口径一致）。 */
function classify(path) {
    if (path.startsWith('skills/') || path.startsWith('dsh-skills/'))
        return 'skills';
    if (path === 'AGENTS.md' || path.startsWith('memories/'))
        return 'userMemory';
    if (path === 'profiles/' || path.startsWith('profiles/')) {
        if (path.endsWith('cordis.patch.yml'))
            return 'config';
        return 'plugins';
    }
    if (path.startsWith('.dsh-user-sync/'))
        return 'meta';
    return 'other';
}
function hintOf(accountKey) {
    return accountKey.slice(0, 6);
}
const summaryCache = new Map();
function withStats(store, accountKey, base) {
    const stats = store.getAccountStats(accountKey);
    return {
        ...base,
        uploads: stats?.uploads ?? 0,
        downloads: stats?.downloads ?? 0,
        lastUploadAt: stats?.lastUploadAt ?? null,
        lastDownloadAt: stats?.lastDownloadAt ?? null,
    };
}
function latestPackageOf(store, accountKey) {
    const packages = store.listPackages(accountKey).sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));
    return packages[0] ?? null;
}
async function parseAccountPackage(store, storage, accountKey) {
    const latest = latestPackageOf(store, accountKey);
    if (!latest)
        return null;
    const buffer = await storage.get(accountKey, latest.id);
    if (!buffer)
        return null;
    const entries = new Map();
    for (const entry of parseTarGz(buffer))
        entries.set(entry.path, entry.data);
    const rawManifest = entries.get(MANIFEST_PATH);
    const manifest = rawManifest ? JSON.parse(rawManifest.toString('utf8')) : {};
    const modules = {};
    const files = [];
    for (const [path, data] of entries) {
        if (path === MANIFEST_PATH)
            continue;
        const module = classify(path);
        modules[module] = modules[module] ?? { files: 0, bytes: 0 };
        modules[module].files += 1;
        modules[module].bytes += data.length;
        files.push({ path, module, size: data.length });
    }
    const dependencies = (manifest.dependencies ?? {});
    const plugins = Object.entries(dependencies).map(([name, version]) => ({ name, version: String(version) }));
    const stats = store.getAccountStats?.(accountKey) ?? null;
    return {
        summary: {
            account: accountKey,
            accountHint: hintOf(accountKey),
            packageId: String(manifest.packageId ?? latest.id),
            createdAt: String(manifest.createdAt ?? latest.createdAt ?? ''),
            size: latest.size ?? buffer.length,
            fileCount: files.length,
            uploads: stats?.uploads ?? 0,
            downloads: stats?.downloads ?? 0,
            lastUploadAt: stats?.lastUploadAt ?? null,
            lastDownloadAt: stats?.lastDownloadAt ?? null,
            modules,
            plugins,
        },
        files,
        entries,
    };
}
/** 只取摘要（带缓存）：列表与插件统计用。统计字段每次实时取。 */
async function summaryOf(store, storage, accountKey) {
    const latest = latestPackageOf(store, accountKey);
    if (!latest)
        return null;
    const cached = summaryCache.get(accountKey);
    if (cached && cached.packageId === latest.id && cached.size === (latest.size ?? 0)) {
        return withStats(store, accountKey, cached.summary);
    }
    const parsed = await parseAccountPackage(store, storage, accountKey);
    if (!parsed)
        return null;
    const { uploads: _u, downloads: _d, lastUploadAt: _lu, lastDownloadAt: _ld, ...base } = parsed.summary;
    summaryCache.set(accountKey, { packageId: latest.id, size: latest.size ?? 0, summary: base });
    return parsed.summary;
}
function sortPackages(packages, sort) {
    const [field, order] = (sort ?? 'createdAt_desc').split('_');
    const dir = order === 'asc' ? 1 : -1;
    const list = [...packages];
    list.sort((a, b) => {
        if (field === 'size')
            return (a.size - b.size) * dir;
        if (field === 'fileCount')
            return (a.fileCount - b.fileCount) * dir;
        if (field === 'uploads')
            return (a.uploads - b.uploads) * dir;
        if (field === 'downloads')
            return (a.downloads - b.downloads) * dir;
        return (Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '')) * dir;
    });
    return list;
}
/** 全量账号包汇总（供后台列表；分页在服务端完成）。 */
export async function listAdminPackages(store, storage, options = {}) {
    const packages = [];
    for (const accountKey of store.listAccounts()) {
        try {
            const summary = await summaryOf(store, storage, accountKey);
            if (summary)
                packages.push(summary);
        }
        catch {
            // 单个账号解析失败不影响整体
        }
    }
    const sorted = sortPackages(packages, options.sort);
    const total = sorted.length;
    // limit=0 表示全量（CSV 导出用）
    const limit = options.limit === undefined ? 50 : options.limit;
    const offset = options.offset ?? 0;
    const items = limit > 0 ? sorted.slice(offset, offset + limit) : sorted.slice(offset);
    return { ok: true, packages: items, total };
}
let pluginStatsCache = null;
const PLUGIN_STATS_TTL_MS = 60_000;
/** 插件统计排行（账号数 = 引用该插件的不同账号数）。 */
export async function listPluginStats(store, storage, options = {}) {
    if (!pluginStatsCache || Date.now() - pluginStatsCache.at > PLUGIN_STATS_TTL_MS) {
        const pluginAccounts = new Map();
        for (const accountKey of store.listAccounts()) {
            try {
                const summary = await summaryOf(store, storage, accountKey);
                if (!summary)
                    continue;
                for (const plugin of summary.plugins) {
                    const set = pluginAccounts.get(plugin.name) ?? new Set();
                    set.add(accountKey);
                    pluginAccounts.set(plugin.name, set);
                }
            }
            catch {
                // 单个账号失败跳过
            }
        }
        const items = [...pluginAccounts.entries()]
            .map(([name, accounts]) => ({
            name,
            accounts: accounts.size,
            accountKeys: [...accounts].map(hintOf).sort(),
        }))
            .sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name));
        pluginStatsCache = { at: Date.now(), items };
    }
    const sorted = [...pluginStatsCache.items];
    const [field, order] = (options.sort ?? 'accounts_desc').split('_');
    const dir = order === 'asc' ? 1 : -1;
    sorted.sort((a, b) => (field === 'name' ? a.name.localeCompare(b.name) * dir : (a.accounts - b.accounts) * dir));
    const total = sorted.length;
    const limit = options.limit === undefined ? 100 : options.limit;
    const offset = options.offset ?? 0;
    const items = limit > 0 ? sorted.slice(offset, offset + limit) : sorted.slice(offset);
    return { ok: true, items, total };
}
/** 单账号包详情：模块汇总 + 文件清单。 */
export async function getAdminPackage(store, storage, accountKey) {
    try {
        const parsed = await parseAccountPackage(store, storage, accountKey);
        if (!parsed)
            return { ok: false, detail: '账号没有可解析的包' };
        return { ok: true, summary: parsed.summary, files: parsed.files };
    }
    catch (error) {
        return { ok: false, detail: error.message };
    }
}
/** 单文件内容（配置/技能/用户记忆），只返回文本。 */
export async function getAdminFile(store, storage, accountKey, filePath) {
    try {
        const parsed = await parseAccountPackage(store, storage, accountKey);
        if (!parsed)
            return { ok: false, detail: '账号没有可解析的包' };
        const data = parsed.entries.get(filePath);
        if (!data)
            return { ok: false, detail: '文件不存在' };
        const text = data.toString('utf8');
        if (text.includes('\u0000'))
            return { ok: false, detail: '二进制文件，不能作为文本查看' };
        return {
            ok: true,
            path: filePath,
            module: classify(filePath),
            size: data.length,
            truncated: false,
            content: text,
        };
    }
    catch (error) {
        return { ok: false, detail: error.message };
    }
}
/** 把账号最新包转成 zip（保留包内原始目录结构）。 */
export async function buildAccountZip(store, storage, accountKey) {
    try {
        const latest = latestPackageOf(store, accountKey);
        if (!latest)
            return { ok: false, detail: '暂无同步包' };
        const buffer = await storage.get(accountKey, latest.id);
        if (!buffer)
            return { ok: false, detail: '暂无同步包' };
        const entries = parseTarGz(buffer).filter((entry) => entry.path !== MANIFEST_PATH);
        if (entries.length === 0)
            return { ok: false, detail: '暂无同步包' };
        const data = buildZip(entries.map((entry) => ({ path: entry.path, data: Buffer.from(entry.data) })));
        return { ok: true, filename: `dsh-user-sync-${hintOf(accountKey)}-${latest.id.replace(/^dsh-user-sync-/, '').replace(/\.tar\.gz$/, '')}.zip`, data };
    }
    catch (error) {
        return { ok: false, detail: error.message };
    }
}
/** 上传/写入后让对应账号的摘要缓存失效。 */
export function invalidateAdminCache(accountKey) {
    summaryCache.delete(accountKey);
    pluginStatsCache = null;
}
