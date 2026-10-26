import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { toPosix } from './paths.ts';

export interface HashEntry {
  path: string;
  sha256: string;
}

/**
 * 删除所有 0x0D 字节后计算 SHA-256。
 * 与原型脚本的 `tr -d '\r' | sha256sum` 逐字节等价：仅换行不同的同一份配置会被判为内容等价。
 * @returns 小写十六进制
 */
export function hashBytes(buf: Buffer): string {
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (const b of buf) {
    if (b !== 0x0d) out[n++] = b;
  }
  return createHash('sha256').update(out.subarray(0, n)).digest('hex');
}

/** 读取文件后按统一口径哈希。 */
export function hashFile(absPath: string): string {
  return hashBytes(readFileSync(absPath));
}

/**
 * 目录聚合哈希：POSIX 相对路径排序后，逐行 `path:sha256` 拼接再哈希。
 * 顺序无关、分隔符无关；文件级 sha256 由调用方传入（边读边算）。
 */
export function hashDirectory(entries: HashEntry[]): string {
  const rows = entries
    .map((entry) => ({ path: toPosix(entry.path), sha256: entry.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const text = rows.map((row) => `${row.path}:${row.sha256}`).join('\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
