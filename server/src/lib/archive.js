import { gunzipSync } from 'node:zlib';
const BLOCK = 512;
export const MANIFEST_PATH = '.dsh-user-sync/manifest.json';
function readString(buf, offset, length) {
    const slice = buf.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}
/** 解析 tar.gz，只取文件条目（服务端只需要 manifest）。 */
export function parseTarGz(buf) {
    const tar = gunzipSync(buf);
    const entries = [];
    let offset = 0;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0))
            break;
        const stored = parseInt(readString(header, 148, 8).trim(), 8);
        let sum = 0;
        for (let i = 0; i < BLOCK; i++)
            sum += i >= 148 && i < 156 ? 32 : header[i];
        if (stored !== sum)
            throw new Error(`tar 头校验失败 @${offset}`);
        const type = String.fromCharCode(header[156]);
        const size = parseInt(readString(header, 124, 12).trim() || '0', 8) || 0;
        const prefix = readString(header, 345, 155);
        const name = readString(header, 0, 100);
        const path = prefix ? `${prefix}/${name}` : name;
        const dataStart = offset + BLOCK;
        if (type === '0') {
            entries.push({ path, data: tar.subarray(dataStart, dataStart + size) });
        }
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    }
    return entries;
}
export function readManifest(buf) {
    const entries = parseTarGz(buf);
    const manifest = entries.find((entry) => entry.path === MANIFEST_PATH);
    if (!manifest)
        return null;
    return JSON.parse(manifest.data.toString('utf8'));
}
