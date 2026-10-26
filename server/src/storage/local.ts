import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { ServerStorage } from './types.ts';

/** 本地磁盘存储（调试 / 无 WebDAV 时的回退）。 */
export function createLocal(rootDir: string): ServerStorage {
  const dirFor = (accountKey: string): string => `${rootDir}/packages/${accountKey}`;

  return {
    id: 'local',
    async test() {
      return { ok: true, detail: rootDir };
    },
    async put(accountKey: string, id: string, data: Buffer) {
      mkdirSync(dirFor(accountKey), { recursive: true });
      writeFileSync(`${dirFor(accountKey)}/${id}`, data);
    },
    async get(accountKey: string, id: string) {
      const path = `${dirFor(accountKey)}/${id}`;
      return existsSync(path) ? readFileSync(path) : null;
    },
    async remove(accountKey: string, id: string) {
      rmSync(`${dirFor(accountKey)}/${id}`, { force: true });
    },
  };
}
