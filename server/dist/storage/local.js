import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
/** 本地磁盘存储（调试 / 无 WebDAV 时的回退）。 */
export function createLocal(rootDir) {
    const dirFor = (accountKey) => `${rootDir}/packages/${accountKey}`;
    return {
        id: 'local',
        async test() {
            return { ok: true, detail: rootDir };
        },
        async put(accountKey, id, data) {
            mkdirSync(dirFor(accountKey), { recursive: true });
            writeFileSync(`${dirFor(accountKey)}/${id}`, data);
        },
        async get(accountKey, id) {
            const path = `${dirFor(accountKey)}/${id}`;
            return existsSync(path) ? readFileSync(path) : null;
        },
        async remove(accountKey, id) {
            rmSync(`${dirFor(accountKey)}/${id}`, { force: true });
        },
    };
}
