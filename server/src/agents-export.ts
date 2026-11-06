import { gzipSync } from 'node:zlib';

import { parseTarGz } from './lib/archive.js';
import type { ServerStorage } from './storage/types.js';
import type { Store } from './store.js';

export interface AgentsExportEntry {
  accountHint: string;
  packageId: string;
  path: string;
  data: Buffer;
}

/** 读取所有账号最新包里的 AGENTS.md（用户级记忆）。 */
export async function collectAgents(store: Store, storage: ServerStorage): Promise<AgentsExportEntry[]> {
  const entries: AgentsExportEntry[] = [];
  for (const accountKey of store.listAccounts()) {
    const packages = store.listPackages(accountKey);
    if (!packages.length) continue;
    const latest = [...packages].sort(
      (a, b) =>
        Date.parse((b as { createdAt?: string }).createdAt ?? '') -
        Date.parse((a as { createdAt?: string }).createdAt ?? ''),
    )[0];
    try {
      const data = await storage.get(accountKey, latest.id);
      if (!data) continue;
      for (const file of parseTarGz(data)) {
        if (file.path === 'AGENTS.md' || file.path.endsWith('/AGENTS.md')) {
          entries.push({
            accountHint: accountKey.slice(0, 6),
            packageId: latest.id,
            path: file.path,
            data: file.data,
          });
        }
      }
    } catch {
      // 单个账号包损坏时跳过，不影响其它账号
    }
  }
  return entries;
}

/** 生成 tar（ustar）字节。 */
function writeTar(files: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const name = Buffer.from(file.name, 'utf8').subarray(0, 100);
    name.copy(header, 0);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${file.data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.write('        ', 148, 8);
    header.write('0', 156, 1);
    header.write('ustar  \0', 257, 8);
    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    chunks.push(header, file.data);
    const pad = (512 - (file.data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** 打包为 tar.gz：每个账号一个文件 AGENTS.md.&lt;hint&gt;（同名文件用账号 hint 区分）。 */
export function buildAgentsArchive(entries: AgentsExportEntry[]): Buffer {
  const files = entries.map((entry, index) => ({
    name: `agents/${entry.accountHint}-${entry.packageId.replace(/\.tar\.gz$/, '')}-${entry.path.split('/').pop() ?? 'AGENTS.md'}`,
    data: entry.data,
  }));
  return gzipSync(writeTar(files), { level: 9 });
}
