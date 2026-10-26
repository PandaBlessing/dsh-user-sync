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
/**
 * 本地元数据：账号、包索引、审计。
 * token 明文存 accounts.json（0600）：服务端本身就是信任边界，且 login 要取回同一 token。
 */
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
