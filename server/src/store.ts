import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface AccountRecord {
  token: string;
  createdAt: string;
}

export interface PackageMeta {
  size?: number;
  createdAt?: string;
  manifest?: Record<string, unknown>;
  [key: string]: unknown;
}

function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * 本地元数据：账号、包索引、审计。
 * token 明文存 accounts.json（0600）：服务端本身就是信任边界，且 login 要取回同一 token。
 */
export function createStore(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const accountsPath = `${dataDir}/accounts.json`;
  const packagesPath = `${dataDir}/packages.json`;
  const auditPath = `${dataDir}/audit.jsonl`;

  const accounts = loadJson<Record<string, AccountRecord>>(accountsPath, {});
  const packages = loadJson<Record<string, Record<string, PackageMeta>>>(packagesPath, {});

  const saveAccounts = (): void => writeJsonAtomic(accountsPath, accounts);
  const savePackages = (): void => writeJsonAtomic(packagesPath, packages);

  return {
    getAccount(accountKey: string): AccountRecord | null {
      return accounts[accountKey] ?? null;
    },
    createAccount(accountKey: string, token: string): void {
      accounts[accountKey] = { token, createdAt: new Date().toISOString() };
      saveAccounts();
    },
    deleteAccount(accountKey: string): void {
      delete accounts[accountKey];
      delete packages[accountKey];
      saveAccounts();
      savePackages();
    },
    findByToken(token: string): string | null {
      for (const [accountKey, account] of Object.entries(accounts)) {
        if (account.token === token) return accountKey;
      }
      return null;
    },

    listPackages(accountKey: string): Array<{ id: string } & PackageMeta> {
      return Object.entries(packages[accountKey] ?? {}).map(([id, meta]) => ({ id, ...meta }));
    },
    getPackageMeta(accountKey: string, id: string): PackageMeta | null {
      return packages[accountKey]?.[id] ?? null;
    },
    setPackage(accountKey: string, id: string, meta: PackageMeta): void {
      packages[accountKey] = packages[accountKey] ?? {};
      packages[accountKey][id] = meta;
      savePackages();
    },
    removePackage(accountKey: string, id: string): void {
      if (packages[accountKey]) {
        delete packages[accountKey][id];
        savePackages();
      }
    },
    /** 运营方监控用：所有账号的占用汇总（accountKey 只给前缀，避免泄露）。 */
    allUsage(): {
      accounts: number;
      totalBytes: number;
      largest: Array<{ accountHint: string; bytes: number; packages: number; updatedAt: string | null }>;
    } {
      const keys = Object.keys(accounts);
      const largest = keys.map((accountKey) => {
        const items = Object.entries(packages[accountKey] ?? {});
        const bytes = items.reduce((sum, [, meta]) => sum + (meta.size ?? 0), 0);
        const updatedAt = items
          .map(([id, meta]) => meta.createdAt ?? null)
          .filter((value): value is string => Boolean(value))
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
    totalBytes(accountKey: string): number {
      return Object.values(packages[accountKey] ?? {}).reduce((sum, meta) => sum + (meta.size ?? 0), 0);
    },

    audit(entry: Record<string, unknown>): void {
      try {
        appendFileSync(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
      } catch {
        // 审计失败不影响主流程
      }
    },
  };
}
