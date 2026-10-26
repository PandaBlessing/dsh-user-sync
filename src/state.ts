import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const HISTORY_LIMIT = 200;
export const LOCK_STALE_MS = 90_000;

export interface StateFile {
  deviceId: string | null;
  auth: unknown;
  lastApplied: unknown;
  lastUploaded: unknown;
  files: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LockHolder {
  pid: number;
  startedAt: number;
  heartbeat: number;
  [key: string]: unknown;
}

export interface AcquireLockInput {
  lockPath: string;
  pid?: number;
  now?: number;
  staleMs?: number;
}

export function emptyState(deviceId: string | null = null): StateFile {
  return { deviceId, auth: null, lastApplied: null, lastUploaded: null, files: {} };
}

export function loadState(statePath: string): StateFile {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    return { ...emptyState(), ...raw, files: raw.files ?? {} };
  } catch {
    return emptyState();
  }
}

export function saveState(statePath: string, state: StateFile): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, statePath);
}

/** 追加一条审计记录，只保留最近 200 行。 */
export function appendHistory(historyPath: string, entry: unknown): void {
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, `${JSON.stringify(entry)}\n`);
  const lines = readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  if (lines.length > HISTORY_LIMIT) {
    writeFileSync(historyPath, `${lines.slice(-HISTORY_LIMIT).join('\n')}\n`);
  }
}

/**
 * 获取单实例锁。
 * 心跳超 staleMs 视为僵死，允许抢占并标注 stolen。
 */
export function acquireLock({
  lockPath,
  pid = process.pid,
  now = Date.now(),
  staleMs = LOCK_STALE_MS,
}: AcquireLockInput): { acquired: boolean; holder: LockHolder | null; stolen: boolean } {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    let holder: LockHolder | null = null;
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      holder = null;
    }
    const heartbeat = holder?.heartbeat ?? holder?.startedAt ?? 0;
    if (holder && now - heartbeat < staleMs) {
      return { acquired: false, holder, stolen: false };
    }
    writeFileSync(lockPath, JSON.stringify({ pid, startedAt: now, heartbeat: now }));
    return { acquired: true, holder, stolen: true };
  }
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: now, heartbeat: now }));
  return { acquired: true, holder: null, stolen: false };
}

export function heartbeatLock({ lockPath, pid = process.pid, now = Date.now() }: { lockPath: string; pid?: number; now?: number }): boolean {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (holder.pid !== pid) return false;
    writeFileSync(lockPath, JSON.stringify({ ...holder, heartbeat: now }));
    return true;
  } catch {
    return false;
  }
}

export function releaseLock({ lockPath, pid = process.pid }: { lockPath: string; pid?: number }): boolean {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (holder.pid !== pid) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 只清理本插件产生的包：前缀匹配 + 以 `-<deviceId>.tar.gz` 结尾。
 * keep <= 0 表示不清理（§11）。
 */
export function cleanupPackages({
  dir,
  deviceId = '',
  keep = 1,
  prefix = 'dsh-user-sync-',
}: {
  dir: string;
  deviceId?: string;
  keep?: number;
  prefix?: string;
}): { removed: string[] } {
  if (keep <= 0 || !existsSync(dir)) return { removed: [] };
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tar.gz'))
    .filter((name) => (deviceId ? name.endsWith(`-${deviceId}.tar.gz`) : true))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const removed = candidates.slice(keep).map((candidate) => candidate.name);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return { removed };
}

/** 把快照目录下的全部文件按相对路径复制回目标根（支持多根映射）。 */
export function restoreSnapshot({
  snapshotRoot,
  targetRoot,
  resolveTarget,
}: {
  snapshotRoot: string;
  targetRoot?: string;
  resolveTarget?: (rel: string) => string;
}): { restored: string[] } {
  if (!existsSync(snapshotRoot)) return { restored: [] };
  const toAbs = resolveTarget ?? ((rel: string) => join(targetRoot as string, rel));
  const restored: string[] = [];
  for (const rel of walkFiles(snapshotRoot, '')) {
    const from = join(snapshotRoot, rel);
    const to = toAbs(rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    restored.push(rel);
  }
  return { restored };
}

function walkFiles(root: string, prefix: string): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) out.push(...walkFiles(root, rel));
    else if (dirent.isFile()) out.push(rel);
  }
  return out;
}
