import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** token：随机 32 字节十六进制。 */
export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** 从 Authorization 头解析 Bearer token。 */
export function bearerOf(headers: IncomingHttpHeaders): string | null {
  const value = headers.authorization ?? '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}
