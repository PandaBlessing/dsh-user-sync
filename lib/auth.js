import { createHash } from 'node:crypto';
/**
 * 官方账号 id → accountKey（sha256 前 16 个十六进制字符）。
 * 与 profile 名、设备无关：同账号所有环境得到同一个值（G5）。
 */
export function deriveAccountKey(accountId) {
    if (!accountId)
        return null;
    return createHash('sha256').update(String(accountId), 'utf8').digest('hex').slice(0, 16);
}
