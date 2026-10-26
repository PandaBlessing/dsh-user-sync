import { gzipSync, gunzipSync } from 'node:zlib';
const BLOCK = 512;
export const MANIFEST_PATH = '.dsh-user-sync/manifest.json';
/** 包名必须匹配；不匹配的一律在发请求前拒绝（§6.4）。 */
export const PACKAGE_ID_RE = /^dsh-user-sync-\d{8}-\d{4}-[a-z0-9]{6,16}\.tar\.gz$/;
export function isPackageId(name) {
    return PACKAGE_ID_RE.test(name);
}
function writeString(buf, offset, value, length = 100) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > length)
        throw new Error(`tar 字段超长: ${value}`);
    bytes.copy(buf, offset);
}
function writeOctal(buf, offset, value, length) {
    const text = value.toString(8).padStart(length - 1, '0');
    buf.write(`${text}\0`, offset, length, 'ascii');
}
function readString(buf, offset, length) {
    const slice = buf.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}
function splitUstarPath(path) {
    const bytes = Buffer.byteLength(path, 'utf8');
    if (bytes <= 100)
        return { name: path, prefix: '' };
    const parts = path.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
        const name = parts.slice(i).join('/');
        const prefix = parts.slice(0, i).join('/');
        if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155)
            return { name, prefix };
    }
    throw new Error(`tar 路径过长（不支持 PAX）: ${path}`);
}
function headerFor({ path, mode = 0o644, size = 0, type = 'file', linkTarget = '', mtime = 0 }) {
    const header = Buffer.alloc(BLOCK);
    const { name, prefix } = splitUstarPath(path);
    writeString(header, 0, name);
    writeOctal(header, 100, mode, 8);
    writeOctal(header, 108, 0, 8);
    writeOctal(header, 116, 0, 8);
    writeOctal(header, 124, type === 'file' ? size : 0, 12);
    writeOctal(header, 136, mtime, 12);
    header.write('        ', 148, 'ascii');
    header.write(type === 'file' ? '0' : type === 'symlink' ? '2' : '5', 156, 'ascii');
    writeString(header, 157, linkTarget, 100);
    writeString(header, 257, 'ustar', 6);
    writeString(header, 263, '00', 2);
    if (prefix)
        writeString(header, 345, prefix, 155);
    let sum = 0;
    for (const byte of header)
        sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return header;
}
function padToBlock(buf) {
    const remainder = buf.length % BLOCK;
    return remainder === 0 ? buf : Buffer.concat([buf, Buffer.alloc(BLOCK - remainder)]);
}
/**
 * 生成 tar 与 tar.gz。
 * mode 接受 '100644' | '100755' | '120000'（与 manifest 一致）或数字。
 */
export function buildTar(entries) {
    const chunks = [];
    for (const entry of entries) {
        const type = entry.type ?? (entry.mode === '120000' ? 'symlink' : 'file');
        const mode = typeof entry.mode === 'string' ? parseInt(entry.mode, 8) & 0o777 : (entry.mode ?? 0o644);
        const data = type === 'file' ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
        chunks.push(headerFor({ path: entry.path, mode, size: data.length, type, linkTarget: entry.linkTarget ?? '' }));
        if (type === 'file')
            chunks.push(padToBlock(data));
    }
    chunks.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(chunks);
}
export function buildTarGz(entries) {
    return gzipSync(buildTar(entries));
}
/** 解析 tar（不校验内容哈希，哈希由调用方逐文件算）。 */
export function parseTar(buf) {
    const entries = [];
    let offset = 0;
    while (offset + BLOCK <= buf.length) {
        const header = buf.subarray(offset, offset + BLOCK);
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
        const rawMode = parseInt(readString(header, 100, 8).trim() || '644', 8) || 0o644;
        const mode = type === '2' ? '120000' : (rawMode & 0o111) !== 0 ? '100755' : '100644';
        const dataStart = offset + BLOCK;
        const data = type === '0' ? buf.subarray(dataStart, dataStart + size) : Buffer.alloc(0);
        entries.push({
            path,
            type: type === '2' ? 'symlink' : type === '5' ? 'dir' : 'file',
            mode,
            size,
            data,
            linkTarget: readString(header, 157, 100),
        });
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    }
    return entries;
}
export function parseTarGz(buf) {
    return parseTar(gunzipSync(buf));
}
/** 组装 manifest（首条目）。 */
export function buildManifest(files, meta) {
    return {
        schemaVersion: 3,
        format: 'dsh-user-sync/1',
        hashMode: 'lf',
        packageId: meta.packageId,
        createdAt: meta.createdAt,
        deviceId: meta.deviceId,
        platform: meta.platform,
        arch: meta.arch,
        dshVersion: meta.dshVersion ?? null,
        profile: meta.profile,
        modules: meta.modules,
        bundles: meta.bundles,
        dependencies: meta.dependencies,
        files: files.map(({ path, sha256, size, mode }) => ({ path, sha256, size, mode })),
    };
}
/** 解析 manifest；v2 的 files[].name 映射为 path，exportedAt 作为 createdAt。 */
export function normalizeManifest(raw) {
    const schemaVersion = raw.schemaVersion ?? 2;
    const files = (raw.files ?? []).map((file) => ({
        path: file.path ?? file.name,
        sha256: file.sha256,
        size: file.size,
        mode: file.mode ?? '100644',
    }));
    return {
        schemaVersion,
        format: raw.format ?? 'dsh-user-sync/1',
        hashMode: raw.hashMode ?? 'lf',
        packageId: raw.packageId ?? '',
        createdAt: raw.createdAt ?? raw.exportedAt ?? null,
        deviceId: raw.deviceId ?? '',
        modules: raw.modules ?? ['plugins', 'config'],
        ...raw,
        files,
    };
}
