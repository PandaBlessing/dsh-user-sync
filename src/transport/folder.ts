import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isPackageId, MANIFEST_PATH, parseTarGz } from '../archive.ts';
import type { PackageEntry, Transport, TransportTestResult } from './types.ts';

/**
 * 同步目录传输（folder）：自用/调试模式。
 * 布局：<dir>/dsh-user-sync/<stamp>-<deviceId>.tar.gz（§6.2）
 */
export function createFolderTransport({ dir }: { dir: string }): Transport {
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true });
  };

  const assertSafeName = (name: string): void => {
    if (!isPackageId(name)) throw new Error(`非法包名: ${name}`);
  };

  return {
    id: 'folder',

    async test(): Promise<TransportTestResult> {
      try {
        ensureDir();
        const probe = join(dir, `.probe-${Date.now()}`);
        writeFileSync(probe, 'ok');
        rmSync(probe, { force: true });
        return { ok: true, detail: `可写: ${dir}` };
      } catch (error) {
        return { ok: false, detail: (error as Error).message };
      }
    },

    async list(): Promise<PackageEntry[]> {
      ensureDir();
      return readdirSync(dir)
        .filter((name) => isPackageId(name))
        .map((name) => ({
          name,
          size: statSync(join(dir, name)).size,
          modifiedAt: statSync(join(dir, name)).mtime.toISOString(),
        }))
        .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    },

    async meta(name: string): Promise<Record<string, unknown> | null> {
      assertSafeName(name);
      const abs = join(dir, name);
      if (!existsSync(abs)) return null;
      try {
        const entries = parseTarGz(readFileSync(abs));
        const manifest = entries.find((entry) => entry.path === MANIFEST_PATH);
        if (!manifest) return null;
        return JSON.parse(manifest.data.toString('utf8'));
      } catch {
        return null;
      }
    },

    async get(name: string): Promise<Buffer> {
      assertSafeName(name);
      return readFileSync(join(dir, name));
    },

    async put(name: string, data: Buffer): Promise<void> {
      assertSafeName(name);
      ensureDir();
      writeFileSync(join(dir, name), data);
    },

    async remove(name: string): Promise<void> {
      assertSafeName(name);
      rmSync(join(dir, name), { force: true });
    },
  };
}
