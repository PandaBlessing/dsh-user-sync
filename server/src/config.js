import { readFileSync, existsSync } from 'node:fs';
/** 读取配置：secrets.json 优先，其次环境变量。 */
export function loadConfig(baseDir) {
    const secretsPath = process.env.DSH_SYNC_SECRETS || `${baseDir}/secrets.json`;
    let secrets = {};
    if (existsSync(secretsPath)) {
        try {
            secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
        }
        catch (error) {
            throw new Error(`secrets.json 解析失败: ${error.message}`);
        }
    }
    return {
        port: Number(process.env.DSH_SYNC_PORT || secrets.port || 9301),
        dataDir: process.env.DSH_SYNC_DATA || secrets.dataDir || `${baseDir}/data`,
        // 凭据不完整时视为未配置，回退本地磁盘（避免服务起不来）
        webdav: secrets.webdav?.username && secrets.webdav?.password ? secrets.webdav : null,
        quotaPackageBytes: Number(secrets.quotaPackageBytes || 10 * 1024 * 1024),
        quotaTotalBytes: Number(secrets.quotaTotalBytes || 50 * 1024 * 1024),
        logDir: `${baseDir}/logs`,
    };
}
