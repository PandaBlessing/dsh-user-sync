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
    const webdav = secrets.webdav;
    const webdavUrl = webdav?.baseUrl ?? webdav?.url;
    return {
        port: Number(process.env.DSH_SYNC_PORT || secrets.port || 10001),
        dataDir: process.env.DSH_SYNC_DATA || secrets.dataDir || `${baseDir}/data`,
        // 凭据不完整时视为未配置，回退本地磁盘（避免服务起不来）
        webdav: webdav?.username && webdav?.password && webdavUrl ? { ...webdav, baseUrl: webdavUrl } : null,
        quotaPackageBytes: Number(secrets.quotaPackageBytes || 10 * 1024 * 1024),
        quotaTotalBytes: Number(secrets.quotaTotalBytes || 50 * 1024 * 1024),
        adminKey: typeof secrets.adminKey === 'string' && secrets.adminKey.trim() ? secrets.adminKey.trim() : null,
        logDir: `${baseDir}/logs`,
        feishu: secrets.feishu && secrets.feishu.appId && secrets.feishu.appSecret && Array.isArray(secrets.feishu.chatIds) && secrets.feishu.chatIds.length
            ? { appId: secrets.feishu.appId, appSecret: secrets.feishu.appSecret, chatIds: secrets.feishu.chatIds, verificationToken: secrets.feishu.verificationToken ?? '' }
            : null,
    };
}
