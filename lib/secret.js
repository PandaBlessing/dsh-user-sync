/**
 * 敏感数据扫描：文件名黑名单 + 内容模式。
 * 设计 §5.4：命中即**整包拒绝**（不是警告、不是跳过）。
 * 本模块只做检测，不决定动作；调用方根据结果拒绝打包/应用。
 */
export const BLOCKED_NAMES = [
    /^\.credentials\.ya?ml$/i,
    /^credentials\.json$/i,
    /\.token$/i,
    /\.key$/i,
    /^cloud-credentials\.json$/i,
    /^github\.token$/i,
    /^\.npmrc\.auth$/i,
    /^\.netrc$/i,
    /^id_rsa$/i,
    /^id_ed25519$/i,
];
export const CONTENT_PATTERNS = [
    { name: 'sk-密钥', re: /sk-[A-Za-z0-9]{16,}/g },
    { name: '通用密钥字段', re: /(api[_-]?key|token|secret|password|passwd)["'\s:=-]+[A-Za-z0-9_-]{20,}/gi },
    { name: 'Bearer', re: /Bearer\s+[A-Za-z0-9._-]{20,}/g },
    { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g },
    { name: '云厂商 AK', re: /LTAI[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}/g },
    { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { name: 'npm 凭据', re: /_authToken\s*=|_auth\s*=/g },
];
/** 单文件超过此大小进入抽样扫描。 */
export const SAMPLE_THRESHOLD = 1024 * 1024;
/** 抽样时前后各取多少字节。 */
export const SAMPLE_BYTES = 64 * 1024;
/** 文件名是否命中黑名单（只看 basename）。 */
export function isBlockedName(name) {
    const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
    return BLOCKED_NAMES.some((re) => re.test(base));
}
/**
 * 扫描文本内容，返回命中位置。
 * 只返回「文件 + 行号 + 模式名」，不返回命中的值本身（§5.4 日志与 UI 不显示值）。
 */
export function scanText(text, filePath = '') {
    const hits = [];
    const lines = text.split('\n');
    for (const { name, re } of CONTENT_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
                hits.push({ file: filePath, line: i + 1, pattern: name });
            }
        }
    }
    return hits;
}
/** 扫描缓冲区。超过阈值时只扫前后各 SAMPLE_BYTES，并标记 sampled。 */
export function scanBuffer(buf, filePath = '') {
    const sampled = buf.length > SAMPLE_THRESHOLD;
    if (!sampled) {
        return { hits: scanText(buf.toString('utf8'), filePath), sampled };
    }
    const head = buf.subarray(0, SAMPLE_BYTES).toString('utf8');
    const tail = buf.subarray(buf.length - SAMPLE_BYTES).toString('utf8');
    return { hits: [...scanText(head, filePath), ...scanText(tail, filePath)], sampled };
}
