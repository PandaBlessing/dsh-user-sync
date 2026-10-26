/**
 * 目标机插件恢复计划（§7.8）：
 * - `dependencies` 里缺失的包 → 逐个 `installBundle`
 * - `link:` / `file:` 本地依赖 → 手工具清单，不自动安装
 */

export interface PluginDependency {
  name: string;
  spec: string;
}

export interface PluginPlan {
  missing: PluginDependency[];
  linkDeps: Array<PluginDependency & { reason: 'local-path' }>;
}

export interface InstallResult {
  name: string;
  spec: string;
  ok: boolean;
  error?: string;
}

export function planPluginRecovery({
  dependencies = {},
  installed = [],
}: {
  dependencies?: Record<string, unknown>;
  installed?: string[];
} = {}): PluginPlan {
  const installedSet = new Set(installed);
  const missing: PluginDependency[] = [];
  const linkDeps: Array<PluginDependency & { reason: 'local-path' }> = [];

  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue;
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
export async function installMissing({
  plan,
  installBundle,
}: {
  plan: Pick<PluginPlan, 'missing'>;
  installBundle: (spec: string) => Promise<unknown>;
}): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  for (const dependency of plan.missing) {
    const spec = dependency.spec ? `${dependency.name}@${dependency.spec}` : dependency.name;
    try {
      await installBundle(spec);
      results.push({ name: dependency.name, spec, ok: true });
    } catch (error) {
      results.push({ name: dependency.name, spec, ok: false, error: (error as Error)?.message ?? String(error) });
    }
  }
  return results;
}
