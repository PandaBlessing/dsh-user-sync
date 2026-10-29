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
            accounts[accountKey] = { token, createdAt: new Date().toISOString() };
            saveAccounts();
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
                return { accountHint: accountKey.slice(0, 6), bytes, packages: items.length, updatedAt };
            });
            largest.sort((a, b) => b.bytes - a.bytes);
            return {
                accounts: keys.length,
                totalBytes: largest.reduce((sum, item) => sum + item.bytes, 0),
                largest: largest.slice(0, 20),
            };
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
