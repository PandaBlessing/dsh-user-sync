import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
export const DEFAULT_PROFILE = 'desktop';
/**
 * 解析当前运行环境的路径上下文。
 * 主源是 profileContext（home/name），取不到时回退 DSH_HOME 与 desktop。
 * 不读 process.env：由调用方把环境对象传进来，便于单测。
 */
export function resolvePaths({ profileContext = null, env = {}, userHome = homedir() } = {}) {
    const home = profileContext?.home;
    const name = profileContext?.name;
    const fallbackHome = env.DSH_HOME;
    const dshHome = home ?? fallbackHome ?? join(userHome, '.dsh');
    const profileName = name ?? DEFAULT_PROFILE;
    const resolvedBy = home ? 'profileContext' : fallbackHome ? 'fallback' : 'default';
    return {
        dshHome,
        profileName,
        profileDir: join(dshHome, 'profiles', profileName),
        userHome,
        skillsRoot: join(userHome, '.agents', 'skills'),
        resolvedBy,
    };
}
/** 统一归一化为 POSIX 路径（包内路径与哈希都用它）。 */
export function toPosix(p) {
    return p.replace(/\\/g, '/');
}
/** 把相对路径拼到根下，越出根则抛错。 */
export function resolveInside(root, rel) {
    const rootAbs = resolve(root);
    const abs = resolve(rootAbs, rel);
    if (!isInside(rootAbs, abs)) {
        throw new Error(`路径越界: ${rel}`);
    }
    return abs;
}
/** 判断绝对路径是否落在根内（含根本身）。 */
export function isInside(root, abs) {
    const rootAbs = resolve(root);
    const target = resolve(abs);
    return target === rootAbs || target.startsWith(rootAbs + sep);
}
/** Windows 长路径前缀；非 Windows 原样返回。 */
export function toLongPath(abs) {
    if (process.platform !== 'win32')
        return abs;
    if (abs.startsWith('\\\\?\\'))
        return abs;
    if (abs.startsWith('\\\\'))
        return `\\\\?\\UNC\\${abs.slice(2)}`;
    return `\\\\?\\${resolve(abs)}`;
}
/** 包内相对路径安全检查：拒绝 `..`、空段、反斜杠与控制字符（§6.4）。 */
export function isUnsafeRelPath(p) {
    if (typeof p !== 'string' || p === '')
        return true;
    if (p.includes('\\'))
        return true;
    if (/[\u0000-\u001f]/.test(p))
        return true;
    return p.split('/').some((segment) => segment === '..' || segment === '');
}
