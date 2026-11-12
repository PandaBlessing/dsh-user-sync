import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
function loadJson(path, fallback) {
    try {
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
    }
    catch {
        return fallback;
    }
}
function writeJsonAtomic(path, value) {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
}
export function createStore(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    const accountsPath = `${dataDir}/accounts.json`;
    const packagesPath = `${dataDir}/packages.json`;
    const auditPath = `${dataDir}/audit.jsonl`;
    const accounts = loadJson(accountsPath, {});
    const packages = loadJson(packagesPath, {});
    const saveAccounts = () => writeJsonAtomic(accountsPath, accounts);
    const savePackages = () => writeJsonAtomic(packagesPath, packages);
    return {
        getAccount(accountKey) {
            return accounts[accountKey] ?? null;
        },
        createAccount(accountKey, token) {
            accounts[accountKey] = {
                token,
                createdAt: new Date().toISOString(),
                stats: { uploads: 0, downloads: 0, lastUploadAt: null, lastDownloadAt: null },
            };
            saveAccounts();
        },
        /** 上传成功计 1（空包/配额拒绝等失败分支不调用）。 */
        recordUpload(accountKey) {
            const account = accounts[accountKey];
            if (!account)
                return;
            account.stats = account.stats ?? { uploads: 0, downloads: 0, lastUploadAt: null, lastDownloadAt: null };
            account.stats.uploads += 1;
            account.stats.lastUploadAt = new Date().toISOString();
            saveAccounts();
        },
        /** 客户端下载计 1；后台（admin）下载不走这里。 */
        recordDownload(accountKey) {
            const account = accounts[accountKey];
            if (!account)
                return;
            account.stats = account.stats ?? { uploads: 0, downloads: 0, lastUploadAt: null, lastDownloadAt: null };
            account.stats.downloads += 1;
            account.stats.lastDownloadAt = new Date().toISOString();
            saveAccounts();
        },
        /** 读账号的上传/下载统计（后台列表用）。 */
        getAccountStats(accountKey) {
            return accounts[accountKey]?.stats ?? null;
        },
        deleteAccount(accountKey) {
            delete accounts[accountKey];
            delete packages[accountKey];
            saveAccounts();
            savePackages();
        },
        findByToken(token) {
            for (const [accountKey, account] of Object.entries(accounts)) {
                if (account.token === token)
                    return accountKey;
            }
            return null;
        },
        listAccounts() {
            return Object.keys(accounts);
        },
        listPackages(accountKey) {
            return Object.entries(packages[accountKey] ?? {}).map(([id, meta]) => ({ id, ...meta }));
        },
        getPackageMeta(accountKey, id) {
            return packages[accountKey]?.[id] ?? null;
        },
        setPackage(accountKey, id, meta) {
            packages[accountKey] = packages[accountKey] ?? {};
            packages[accountKey][id] = meta;
            savePackages();
        },
        removePackage(accountKey, id) {
            if (packages[accountKey]) {
                delete packages[accountKey][id];
                savePackages();
            }
        },
        /** 运营方监控用：所有账号的占用汇总（accountKey 只给前缀，避免泄露）。 */
        allUsage() {
            const keys = Object.keys(accounts);
            const largest = keys.map((accountKey) => {
                const items = Object.entries(packages[accountKey] ?? {});
                const bytes = items.reduce((sum, [, meta]) => sum + (meta.size ?? 0), 0);
                const updatedAt = items
                    .map(([id, meta]) => meta.createdAt ?? null)
                    .filter((value) => Boolean(value))
                    .sort()
                    .pop() ?? null;
                const stats = accounts[accountKey]?.stats;
                return {
                    accountHint: accountKey.slice(0, 6),
                    bytes,
                    packages: items.length,
                    updatedAt,
                    createdAt: accounts[accountKey]?.createdAt ?? null,
                    uploads: stats?.uploads ?? 0,
                    downloads: stats?.downloads ?? 0,
                    lastUploadAt: stats?.lastUploadAt ?? null,
                    lastDownloadAt: stats?.lastDownloadAt ?? null,
                };
            });
            largest.sort((a, b) => b.bytes - a.bytes);
            return {
                accounts: keys.length,
                uploaded: largest.filter((item) => item.packages > 0).length,
                totalBytes: largest.reduce((sum, item) => sum + item.bytes, 0),
                totalUploads: largest.reduce((sum, item) => sum + item.uploads, 0),
                totalDownloads: largest.reduce((sum, item) => sum + item.downloads, 0),
                largest: largest.slice(0, 20),
            };
        },
        /** 全量账号统计（供 dsh-admin 同步进 MySQL；含完整 accountKey，仅 admin 接口使用）。 */
        listAccountStats() {
            return Object.keys(accounts).map((accountKey) => {
                const items = Object.entries(packages[accountKey] ?? {});
                const stats = accounts[accountKey]?.stats;
                const updatedAt = items
                    .map(([, meta]) => meta.createdAt ?? null)
                    .filter((value) => Boolean(value))
                    .sort()
                    .pop() ?? null;
                return {
                    accountKey,
                    accountHint: accountKey.slice(0, 6),
                    createdAt: accounts[accountKey]?.createdAt ?? null,
                    uploads: stats?.uploads ?? 0,
                    downloads: stats?.downloads ?? 0,
                    lastUploadAt: stats?.lastUploadAt ?? null,
                    lastDownloadAt: stats?.lastDownloadAt ?? null,
                    bytes: items.reduce((sum, [, meta]) => sum + (meta.size ?? 0), 0),
                    packages: items.length,
                    updatedAt,
                };
            });
        },
        totalBytes(accountKey) {
            return Object.values(packages[accountKey] ?? {}).reduce((sum, meta) => sum + (meta.size ?? 0), 0);
        },
        audit(entry) {
            try {
                appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
            }
            catch {
                // 审计失败不影响主流程
            }
        },
    };
}
