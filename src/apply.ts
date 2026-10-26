import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { hashBytes } from './hash.ts';
import { MANIFEST_PATH } from './archive.ts';
import { isUnsafeRelPath, resolveInside } from './paths.ts';

export interface ApplyFile {
  path: string;
  sha256: string;
  mode?: string;
}

export interface ApplyPlan {
  added: ApplyFile[];
  overwritten: ApplyFile[];
  skipped: ApplyFile[];
}

export interface ApplyEntry {
  path: string;
  type: string;
  mode: string;
  data: Buffer;
  linkTarget?: string;
}

export interface ApplyResult {
  written: string[];
  skipped: string[];
  snapshotPath: string | null;
}

/**
 * 应用计划：把包内文件分成「新增 / 覆盖 / 跳过」三态。
 * 大小写冲突直接拒绝（§5.5）。
 */
export function planApply({
  manifestFiles,
  localFiles,
}: {
  manifestFiles: ApplyFile[];
  localFiles?: Map<string, string>;
}): ApplyPlan {
  const added: ApplyFile[] = [];
  const overwritten: ApplyFile[] = [];
  const skipped: ApplyFile[] = [];
  const seen = new Map<string, string>();

  for (const file of manifestFiles) {
    if (isUnsafeRelPath(file.path)) throw new Error(`非法包内路径: ${file.path}`);
    const lower = file.path.toLowerCase();
    if (seen.has(lower) && seen.get(lower) !== file.path) {
      throw new Error(`大小写冲突: ${seen.get(lower)} / ${file.path}`);
    }
    seen.set(lower, file.path);

    const localSha = localFiles?.get(file.path);
    if (localSha === undefined) added.push(file);
    else if (localSha !== file.sha256) overwritten.push(file);
    else skipped.push(file);
  }
  return { added, overwritten, skipped };
}

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function snapshotFile(abs: string, rel: string, preRestoreRoot: string): string {
  const backup = join(preRestoreRoot, rel);
  ensureDir(dirname(backup));
  copyFileSync(abs, backup);
  return backup;
}

/**
 * 应用 tar 条目到目标根。
 * 先快照将被覆盖的文件，再逐文件原子写（tmp → rename）；失败时整批还原。
 */
export function applyEntries({
  entries,
  targetRoot,
  resolveTarget,
  preRestoreRoot,
  dryRun = false,
}: {
  entries: ApplyEntry[];
  targetRoot?: string;
  resolveTarget?: (rel: string) => string;
  preRestoreRoot: string;
  dryRun?: boolean;
}): ApplyResult {
  const toAbs = resolveTarget ?? ((rel) => resolveInside(targetRoot as string, rel));
  const plan = entries.filter((entry) => entry.type !== 'dir' && entry.path !== MANIFEST_PATH);
  const written: string[] = [];
  const skipped: string[] = [];

  const seen = new Map<string, string>();
  for (const entry of plan) {
    if (isUnsafeRelPath(entry.path)) throw new Error(`非法包内路径: ${entry.path}`);
    const lower = entry.path.toLowerCase();
    if (seen.has(lower) && seen.get(lower) !== entry.path) {
      throw new Error(`大小写冲突: ${seen.get(lower)} / ${entry.path}`);
    }
    seen.set(lower, entry.path);
  }
  if (dryRun) return { written, skipped: plan.map((entry) => entry.path), snapshotPath: null };

  const snapshots: string[] = [];
  try {
    for (const entry of plan) {
      const abs = toAbs(entry.path);
      ensureDir(dirname(abs));

      if (entry.type === 'symlink') {
        if (existsSync(abs)) {
          snapshotFile(abs, entry.path, preRestoreRoot);
          snapshots.push(entry.path);
          rmSync(abs, { force: true });
        }
        symlinkSync(entry.linkTarget ?? '', abs);
        written.push(entry.path);
        continue;
      }

      const existing = existsSync(abs) ? readFileSync(abs) : null;
      if (existing !== null && hashBytes(existing) === hashBytes(entry.data)) {
        skipped.push(entry.path); // 内容等价：不写盘、不改 mtime
        continue;
      }
      if (existing !== null) {
        snapshotFile(abs, entry.path, preRestoreRoot);
        snapshots.push(entry.path);
      }
      const tmp = join(dirname(abs), `.${entry.path.split('/').pop()}.tmp-${randomUUID().slice(0, 8)}`);
      writeFileSync(tmp, entry.data);
      renameSync(tmp, abs);
      written.push(entry.path);
    }
  } catch (error) {
    for (const rel of snapshots) {
      const backup = join(preRestoreRoot, rel);
      if (existsSync(backup)) copyFileSync(backup, toAbs(rel));
    }
    for (const rel of written) {
      if (!snapshots.includes(rel)) rmSync(toAbs(rel), { force: true });
    }
    throw error;
  }

  return {
    written,
    skipped,
    snapshotPath: snapshots.length > 0 ? preRestoreRoot : null,
  };
}
