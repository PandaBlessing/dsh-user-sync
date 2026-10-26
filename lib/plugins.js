/**
 * 目标机插件恢复计划（§7.8）：
 * - `dependencies` 里缺失的包 → 逐个 `installBundle`
 * - `link:` / `file:` 本地依赖 → 手工具清单，不自动安装
 */
export function planPluginRecovery({ dependencies = {}, installed = [], } = {}) {
    const installedSet = new Set(installed);
    const missing = [];
    const linkDeps = [];
    for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string')
            continue;
        if (spec.startsWith('link:') || spec.startsWith('file:')) {
            linkDeps.push({ name, spec, reason: 'local-path' });
            continue;
        }
        if (!installedSet.has(name)) {
            missing.push({ name, spec });
        }
    }
    return { missing, linkDeps };
}
/** 逐个安装缺失包；单个失败不阻塞其余。 */
export async function installMissing({ plan, installBundle, }) {
    const results = [];
    for (const dependency of plan.missing) {
        const spec = dependency.spec ? `${dependency.name}@${dependency.spec}` : dependency.name;
        try {
            await installBundle(spec);
            results.push({ name: dependency.name, spec, ok: true });
        }
        catch (error) {
            results.push({ name: dependency.name, spec, ok: false, error: error?.message ?? String(error) });
        }
    }
    return results;
}
