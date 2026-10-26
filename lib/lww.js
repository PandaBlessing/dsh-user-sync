/**
 * 新覆盖旧判定（G7）。
 * 只按包级 createdAt 比较，不看文件 mtime；两侧相差 ≤ 5 分钟视为并发，转人工确认。
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export function decide({ remote = null, lastApplied = null, lastUploaded = null, localFiles, appliedFiles, clockSkewMs = CLOCK_SKEW_MS, } = {}) {
    const localChanged = detectLocalChanges(localFiles, appliedFiles);
    if (!remote) {
        return { action: 'push', reason: 'remote-missing', localChanged, remoteUpdated: false };
    }
    // 远端就是本机上次上传的那份包：只看本机在上传后有没有再改动。
    // 否则「刚上传 → 再检查」会被误判成两侧并发。
    if (lastUploaded?.packageId && remote.packageId && lastUploaded.packageId === remote.packageId) {
        return localChanged
            ? { action: 'push', reason: 'local-changed-since-upload', localChanged, remoteUpdated: false }
            : { action: 'skip', reason: 'in-sync', localChanged, remoteUpdated: false };
    }
    const remoteUpdated = !lastApplied || compareTime(remote.createdAt, lastApplied.createdAt) > 0;
    if (!localChanged && !remoteUpdated) {
        return { action: 'skip', reason: 'in-sync', localChanged, remoteUpdated };
    }
    if (remoteUpdated && !localChanged) {
        return { action: 'pull', reason: 'remote-newer', localChanged, remoteUpdated };
    }
    if (!remoteUpdated && localChanged) {
        return { action: 'push', reason: 'local-newer', localChanged, remoteUpdated };
    }
    // 两侧都有更新：拿远端包与「本机上次上传」比；相差 ≤ 阈值转人工
    const remoteTime = toEpoch(remote.createdAt);
    const uploadTime = toEpoch(lastUploaded?.createdAt);
    const skewMs = Math.abs(remoteTime - uploadTime);
    if (skewMs <= clockSkewMs) {
        return { action: 'confirm', reason: 'clock-skew', localChanged, remoteUpdated, skewMs };
    }
    if (remoteTime > uploadTime) {
        return { action: 'pull', reason: 'remote-newer', localChanged, remoteUpdated, skewMs };
    }
    return { action: 'push', reason: 'local-newer', localChanged, remoteUpdated, skewMs };
}
/** 解析时间字符串为毫秒；无法解析视为 0（最旧）。 */
export function toEpoch(value) {
    if (value === null || value === undefined)
        return 0;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
}
/** 比较两个时间字符串；缺省视为 0（最旧）。 */
export function compareTime(a, b) {
    const ta = toEpoch(a);
    const tb = toEpoch(b);
    return ta === tb ? 0 : ta > tb ? 1 : -1;
}
/** 本地是否相对上次应用有改动：新增、删除、内容变化都算。 */
export function detectLocalChanges(localFiles, appliedFiles) {
    if (!localFiles || !appliedFiles)
        return false;
    if (localFiles.size !== appliedFiles.size)
        return true;
    for (const [path, sha] of localFiles) {
        if (appliedFiles.get(path) !== sha)
            return true;
    }
    return false;
}
