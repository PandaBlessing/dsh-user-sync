import { parseTarGz, MANIFEST_PATH } from './lib/archive.js';
import type { ServerStorage } from './storage/types.js';
import type { Store } from './store.js';

export interface AdminFileInfo {
  path: string;
  module: string;
  size: number;
}

export interface AdminPackageSummary {
  account: string;
  accountHint: string;
  packageId: string;
  createdAt: string;
  size: number;
  fileCount: number;
  modules: Record<string, { files: number; bytes: number }>;
  plugins: Array<{ name: string; version: string }>;
}

/** 按包内路径归类到同步模块（与插件端扫描口径一致）。 */
function classify(path: string): string {
  if (path.startsWith('skills/')) return 'skills';
  if (path === 'AGENTS.md' || path.startsWith('memories/')) return 'userMemory';
  if (path === 'profiles/' || path.startsWith('profiles/')) {
    if (path.endsWith('cordis.patch.yml')) return 'config';
    return 'plugins';
  }
  if (path.startsWith('.dsh-user-sync/')) return 'meta';
  return 'other';
}

function hintOf(accountKey: string): string {
  return accountKey.slice(0, 6);
}

interface ParsedPackage {
  summary: AdminPackageSummary;
  files: AdminFileInfo[];
  entries: Map<string, Buffer>;
}

async function parseAccountPackage(
  store: Store,
  storage: ServerStorage,
  accountKey: string,
): Promise<ParsedPackage | null> {
  const packages = store.listPackages(accountKey).sort(
    (a: { createdAt?: string }, b: { createdAt?: string }) =>
      Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''),
  );
  const latest = packages[0];
  if (!latest) return null;
  const buffer = await storage.get(accountKey, latest.id);
  if (!buffer) return null;

  const entries = new Map<string, Buffer>();
  for (const entry of parseTarGz(buffer)) entries.set(entry.path, entry.data);

  const rawManifest = entries.get(MANIFEST_PATH);
  const manifest = rawManifest ? (JSON.parse(rawManifest.toString('utf8')) as Record<string, unknown>) : {};

  const modules: Record<string, { files: number; bytes: number }> = {};
  const files: AdminFileInfo[] = [];
  for (const [path, data] of entries) {
    if (path === MANIFEST_PATH) continue;
    const module = classify(path);
    modules[module] = modules[module] ?? { files: 0, bytes: 0 };
    modules[module].files += 1;
    modules[module].bytes += data.length;
    files.push({ path, module, size: data.length });
  }

  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
  const plugins = Object.entries(dependencies).map(([name, version]) => ({ name, version: String(version) }));

  return {
    summary: {
      account: accountKey,
      accountHint: hintOf(accountKey),
      packageId: String(manifest.packageId ?? latest.id),
      createdAt: String(manifest.createdAt ?? latest.createdAt ?? ''),
      size: latest.size ?? buffer.length,
      fileCount: files.length,
      modules,
      plugins,
    },
    files,
    entries,
  };
}

/** 全量账号包汇总（供后台列表）。 */
export async function listAdminPackages(
  store: Store,
  storage: ServerStorage,
): Promise<{ ok: true; packages: AdminPackageSummary[]; pluginStats: Array<{ name: string; accounts: number }> }> {
  const packages: AdminPackageSummary[] = [];
  const pluginAccounts = new Map<string, Set<string>>();

  for (const accountKey of store.listAccounts()) {
    try {
      const parsed = await parseAccountPackage(store, storage, accountKey);
      if (!parsed) continue;
      packages.push(parsed.summary);
      for (const plugin of parsed.summary.plugins) {
        const set = pluginAccounts.get(plugin.name) ?? new Set<string>();
        set.add(hintOf(accountKey));
        pluginAccounts.set(plugin.name, set);
      }
    } catch {
      // 单个账号解析失败不影响整体
    }
  }

  packages.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const pluginStats = [...pluginAccounts.entries()]
    .map(([name, accounts]) => ({ name, accounts: accounts.size }))
    .sort((a, b) => b.accounts - a.accounts || a.name.localeCompare(b.name));

  return { ok: true, packages, pluginStats };
}

/** 单账号包详情：模块汇总 + 文件清单。 */
export async function getAdminPackage(
  store: Store,
  storage: ServerStorage,
  accountKey: string,
): Promise<{ ok: boolean; summary?: AdminPackageSummary; files?: AdminFileInfo[]; detail?: string }> {
  try {
    const parsed = await parseAccountPackage(store, storage, accountKey);
    if (!parsed) return { ok: false, detail: '账号没有可解析的包' };
    return { ok: true, summary: parsed.summary, files: parsed.files };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

/** 单文件内容（配置/技能/用户记忆），只返回文本。 */
export async function getAdminFile(
  store: Store,
  storage: ServerStorage,
  accountKey: string,
  filePath: string,
): Promise<{ ok: boolean; path?: string; module?: string; size?: number; content?: string; truncated?: boolean; detail?: string }> {
  try {
    const parsed = await parseAccountPackage(store, storage, accountKey);
    if (!parsed) return { ok: false, detail: '账号没有可解析的包' };
    const data = parsed.entries.get(filePath);
    if (!data) return { ok: false, detail: '文件不存在' };
    const text = data.toString('utf8');
    if (text.includes('\u0000')) return { ok: false, detail: '二进制文件，不能作为文本查看' };
    return {
      ok: true,
      path: filePath,
      module: classify(filePath),
      size: data.length,
      truncated: false,
      content: text,
    };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
