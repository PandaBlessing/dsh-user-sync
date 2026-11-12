/**
 * 同步应用后的插件对齐计划（§7.8 延伸）：
 * - 缺失的依赖 → 安装；
 * - 已装但版本落后于声明（`^x.y.z` / `~x.y.z` / `x.y.z`）→ 更新；
 * - 上次同步管理过、本次远端包不再声明 → 移除（首次没有管理记录时不删，防止误删本地手动安装的插件）；
 * - `link:` / `file:` 本地依赖一律不动。
 *
 * 安装/移除都走宿主 `pluginManager`，宿主据此发布新 release；
 * 调用方在拿到 `changed: true` 后刷新页面，新插件即时生效（无需重启 DSH 进程）。
 */

export interface ManagedDependency {
  name: string;
  spec: string;
}

export interface SyncPlan {
  /** 需要安装或更新的包（installBundle 参数用 `name@spec`）。 */
  install: Array<ManagedDependency & { reason: 'missing' | 'outdated'; installed?: string }>;
  /** 需要移除的包名。 */
  remove: string[];
  /** 本地路径依赖，只提示不处理。 */
  linkDeps: ManagedDependency[];
  /** 本次同步后应由本插件管理的包名（写回 state.managedPlugins）。 */
  managed: string[];
}

/** 取 spec 里的版本基线（`^0.31.1` → `0.31.1`；取不到返回 null）。 */
export function versionBase(spec: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(spec);
  return match ? match[0] : null;
}

/** 只比较 x.y.z 数字段，a > b 返回 true。 */
export function isVersionNewer(a: string, b: string): boolean {
  const toParts = (value: string) => value.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = toParts(a);
  const right = toParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}

export function planPluginSync({
  dependencies = {},
  installed = {},
  managed = null,
}: {
  dependencies?: Record<string, unknown>;
  /** name → 已装版本。 */
  installed?: Record<string, string>;
  /** 上次同步管理的包名；null 表示没有历史记录（首次同步，不执行移除）。 */
  managed?: string[] | null;
} = {}): SyncPlan {
  const install: SyncPlan['install'] = [];
  const linkDeps: ManagedDependency[] = [];
  const managedNames: string[] = [];

  for (const [name, spec] of Object.entries(dependencies)) {
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      linkDeps.push({ name, spec });
      continue;
    }
    managedNames.push(name);
    const current = installed[name];
    if (!current) {
      install.push({ name, spec, reason: 'missing' });
      continue;
    }
    const base = versionBase(spec);
    // 声明版本更高 → 需要更新；声明是范围且已装版本满足时不重装
    if (base && isVersionNewer(base, current)) {
      install.push({ name, spec, reason: 'outdated', installed: current });
    }
  }

  const linked = new Set(linkDeps.map((item) => item.name));
  const remove = (managed ?? [])
    .filter((name) => !managedNames.includes(name) && !linked.has(name))
    .filter((name, index, list) => list.indexOf(name) === index);

  return { install, remove, linkDeps, managed: managedNames };
}
