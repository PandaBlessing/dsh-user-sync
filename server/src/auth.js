import { randomBytes } from 'node:crypto';
/** token：随机 32 字节十六进制。 */
export function newToken() {
    return randomBytes(32).toString('hex');
}
/** 从 Authorization 头解析 Bearer token。 */
export function bearerOf(headers) {
    const value = headers.authorization ?? '';
    return value.startsWith('Bearer ') ? value.slice(7) : null;
}
