import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

import { toPosix } from './paths.ts';

export const DEFAULT_MODULES = ['skills', 'plugins', 'config', 'userMemory'];
export const ALL_MODULES = ['skills', 'plugins', 'config', 'userMemory', 'projectMemory', 'sessions'];

/** 单文件超过 8 MiB 拒绝打包。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 包总量超过 10 MiB 拒绝打包。 */
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export interface ScanEntry {
  module: string;
  path: string;
  absPath: string;
  size: number;
  mode: string;
  linkTarget?: string;
  /** 会话标题（仅 sessions 模块）：来自 DSH 的 session_projcache。 */
  title?: string | null;
}

export interface ScanError {
  code: string;
  path?: string;
  size?: number;
  total?: number;
  limit?: number;
}

export interface ScanSkipped {
  path: string;
  reason: string;
}

export interface ScanOptions {
  dshHome: string;
  userHome: string;
  profileName?: string;
  modules?: string[];
  excludeGlobs?: string[];
}

export interface ScanResult {
  entries: ScanEntry[];
  errors: ScanError[];
  skipped: ScanSkipped[];
  totalBytes: number;
}

interface ScanContext {
  out: ScanEntry[];
  errors: ScanError[];
  skipped: ScanSkipped[];
  excludeGlobs: string[];
}

const IGNORE_DIRS = new Set(['node_modules', '.git']);
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const IGNORE_NAMES = ['.credentials.yaml', '.credentials.yml', 'credentials.json', '.anonymous-user-id'];

/** Windows 保留名（不区分大小写，`CON.txt` 也算）。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isReservedName(name: string): boolean {
  const base = name.split(/[\\/]/).pop() ?? name;
  return RESERVED.test(base) || /[. ]$/.test(base);
}

function shouldIgnore(name: string, rel: string): boolean {
  if (IGNORE_DIRS.has(name) || IGNORE_FILES.has(name)) return true;
  if (name.endsWith('.map') || name.includes('.bak-')) return true;
  if (IGNORE_NAMES.includes(name)) return true;
  if (toPosix(rel).split('/').includes('storages')) return true;
  return false;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** 判断一个包内路径是否命中排除模式。 */
export function isExcluded(rel: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((glob) => globToRegExp(glob).test(rel) || globToRegExp(glob).test(rel.split('/').pop() ?? rel));
}

function walk(root: string, prefix: string, module: string, ctx: ScanContext): void {
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    ctx.skipped.push({ path: toPosix(prefix || root), reason: `unreadable: ${code}` });
    return;
  }
  for (const dirent of dirents) {
    const name = dirent.name;
    const abs = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (shouldIgnore(name, rel)) {
      ctx.skipped.push({ path: rel, reason: 'ignored' });
      continue;
    }
    if (isReservedName(name)) {
      ctx.errors.push({ code: 'E_RESERVED_NAME', path: rel });
      continue;
    }
    if (dirent.isSymbolicLink()) {
      let target: string;
      try {
        target = readlinkSync(abs);
      } catch {
        target = '';
      }
      if (isExcluded(rel, ctx.excludeGlobs)) {
        ctx.skipped.push({ path: rel, reason: 'excluded' });
        continue;
      }
      ctx.out.push({ module, path: toPosix(rel), absPath: abs, size: 0, mode: '120000', linkTarget: target });
      continue;
    }
    if (dirent.isDirectory()) {
      walk(abs, rel, module, ctx);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (isExcluded(rel, ctx.excludeGlobs)) {
      ctx.skipped.push({ path: rel, reason: 'excluded' });
      continue;
    }
    const stat = lstatSync(abs);
    if (stat.size > MAX_FILE_BYTES) {
      ctx.errors.push({ code: 'E_FILE_TOO_LARGE', path: rel, size: stat.size });
      continue;
    }
    ctx.out.push({
      module,
      path: toPosix(rel),
      absPath: abs,
      size: stat.size,
      mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
    });
  }
}

function collectSkills({ userHome, ctx }: { userHome: string; ctx: ScanContext }): void {
  const skillsRoot = join(userHome, '.agents', 'skills');
  let dirents;
  try {
    dirents = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return; // 技能根不存在：正常空态
  }
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const skillDir = join(skillsRoot, dirent.name);
    const hasManifest = (() => {
      try {
        return readdirSync(skillDir).includes('SKILL.md');
      } catch {
        return false;
      }
    })();
    if (!hasManifest) {
      ctx.skipped.push({ path: `skills/${dirent.name}`, reason: 'no SKILL.md' });
      continue;
    }
    walk(skillDir, `skills/${dirent.name}`, 'skills', ctx);
  }
}

function collectProfileFiles({
  dshHome,
  profileName,
  modules,
  ctx,
}: {
  dshHome: string;
  profileName: string;
  modules: string[];
  ctx: ScanContext;
}): void {
  const profileDir = join(dshHome, 'profiles', profileName);
  const read = (name: string): number | null => {
    try {
      const stat = lstatSync(join(profileDir, name));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  };
  const push = (name: string, module: string): void => {
    const size = read(name);
    if (size === null) return;
    const rel = `profiles/${profileName}/${name}`;
    if (isExcluded(rel, ctx.excludeGlobs)) {
      ctx.skipped.push({ path: rel, reason: 'excluded' });
      return;
    }
    if (size > MAX_FILE_BYTES) {
      ctx.errors.push({ code: 'E_FILE_TOO_LARGE', path: rel, size });
      return;
    }
    ctx.out.push({ module, path: rel, absPath: join(profileDir, name), size, mode: '100644' });
  };

  if (modules.includes('plugins')) {
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml']) push(name, 'plugins');
    // pnpm-workspace.yaml 的 patchedDependencies 指向 patches/*.patch；
    // 少了这些文件，换机后 pnpm install 会报 ERR_PNPM_PATCH_NOT_FOUND，插件全部装不上
    let patchFiles: string[] = [];
    try {
      patchFiles = readdirSync(join(profileDir, 'patches'), { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.patch'))
        .map((dirent) => dirent.name);
    } catch {
      patchFiles = [];
    }
    for (const name of patchFiles) push(`patches/${name}`, 'plugins');
  }
  if (modules.includes('config')) {
    push('cordis.patch.yml', 'config');
  }
}

function collectUserMemory({ dshHome, ctx }: { dshHome: string; ctx: ScanContext }): void {
  // 用户级记忆主文件：AGENTS.md 放在 DSH 主目录根
  const agents = join(dshHome, 'AGENTS.md');
  try {
    const stat = lstatSync(agents);
    if (stat.isFile() && !isExcluded('AGENTS.md', ctx.excludeGlobs)) {
      if (stat.size > MAX_FILE_BYTES) ctx.errors.push({ code: 'E_FILE_TOO_LARGE', path: 'AGENTS.md', size: stat.size });
      else ctx.out.push({ module: 'userMemory', path: 'AGENTS.md', absPath: agents, size: stat.size, mode: '100644' });
    }
  } catch {
    // 没有 AGENTS.md 不算错误
  }
  const root = join(dshHome, 'memories');
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!['MEMORY.md', 'USER.md', 'KEY.md'].includes(dirent.name)) {
      ctx.skipped.push({ path: `memories/${dirent.name}`, reason: 'not user-memory whitelist' });
      continue;
    }
    const rel = `memories/${dirent.name}`;
    if (isExcluded(rel, ctx.excludeGlobs)) {
      ctx.skipped.push({ path: rel, reason: 'excluded' });
      continue;
    }
    const stat = lstatSync(join(root, dirent.name));
    if (stat.size > MAX_FILE_BYTES) {
      ctx.errors.push({ code: 'E_FILE_TOO_LARGE', path: rel, size: stat.size });
      continue;
    }
    ctx.out.push({ module: 'userMemory', path: rel, absPath: join(root, dirent.name), size: stat.size, mode: '100644' });
  }
}

function collectProjectMemory({ dshHome, ctx }: { dshHome: string; ctx: ScanContext }): void {
  const root = join(dshHome, 'memories');
  for (const sub of ['projects', 'daily']) {
    let dirents;
    try {
      dirents = readdirSync(join(root, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const abs = join(root, sub, dirent.name);
      const rel = `memories/${sub}/${dirent.name}`;
      if (dirent.isFile()) {
        if (isExcluded(rel, ctx.excludeGlobs)) continue;
        const stat = lstatSync(abs);
        if (stat.size > MAX_FILE_BYTES) {
          ctx.errors.push({ code: 'E_FILE_TOO_LARGE', path: rel, size: stat.size });
          continue;
        }
        ctx.out.push({ module: 'projectMemory', path: rel, absPath: abs, size: stat.size, mode: '100644' });
      } else if (dirent.isDirectory()) {
        walk(abs, rel, 'projectMemory', ctx);
      }
    }
  }
}

function collectSessions({ dshHome, ctx }: { dshHome: string; ctx: ScanContext }): void {
  const sessionsRoot = join(dshHome, 'sessions');
  // 工作区注册表：归档会话列表 + 会话归属工作区
  const archived = new Set<string>();
  const workspaceTitles = new Map<string, string>();
  try {
    const registry = JSON.parse(
      lstatSync(join(dshHome, 'storages', 'workspace.json')).isFile()
        ? readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8')
        : '{}',
    ) as {
      global?: { archivedSessionIds?: string[] };
      tables?: { workspaces?: Record<string, { title?: string; sessionIds?: string[] }> };
    };
    for (const id of registry.global?.archivedSessionIds ?? []) archived.add(id);
    for (const ws of Object.values(registry.tables?.workspaces ?? {})) {
      for (const sid of ws.sessionIds ?? []) workspaceTitles.set(sid, ws.title ?? '');
    }
  } catch {
    // 没有注册表时按未归档处理
  }

  let wsDirs;
  try {
    wsDirs = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const wsDir of wsDirs) {
    if (!wsDir.isDirectory()) continue;
    let sessionDirs;
    try {
      sessionDirs = readdirSync(join(sessionsRoot, wsDir.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const sid = sessionDir.name;
      const rel = `sessions/${wsDir.name}/${sid}`;
      if (archived.has(sid)) {
        ctx.skipped.push({ path: rel, reason: 'archived' });
        continue;
      }
      // 空会话（只有元数据行、UI 不显示）不纳入同步：主日志小于 2 KiB 视为空会话
      const sessionDirAbs = join(sessionsRoot, wsDir.name, sid);
      let payloadBytes = 0;
      try {
        for (const entry of readdirSync(sessionDirAbs, { withFileTypes: true })) {
          if (entry.isFile()) payloadBytes += lstatSync(join(sessionDirAbs, entry.name)).size;
        }
      } catch {
        payloadBytes = 0;
      }
      if (payloadBytes < 2048) {
        ctx.skipped.push({ path: rel, reason: 'empty-session' });
        continue;
      }
      let title: string | null = null;
      try {
        const cache = JSON.parse(
          lstatSync(join(dshHome, 'storages', 'session_projcache', 'sessions', `${sid}.json`)).isFile()
            ? readFileSync(join(dshHome, 'storages', 'session_projcache', 'sessions', `${sid}.json`), 'utf8')
            : '{}',
        ) as { record?: { rows?: { title?: { val?: string | null } } } };
        title = cache.record?.rows?.title?.val ?? null;
      } catch {
        title = null;
      }
      const before = ctx.out.length;
      walk(join(sessionsRoot, wsDir.name, sid), rel, 'sessions', ctx);
      const workspaceTitle = workspaceTitles.get(sid) ?? wsDir.name;
      for (let i = before; i < ctx.out.length; i++) {
        ctx.out[i].title = title ?? `（无标题）${workspaceTitle}`;
      }
    }
  }
}

/** 扫描用户级资产。 */
export function scanAssets({
  dshHome,
  userHome,
  profileName = 'desktop',
  modules = DEFAULT_MODULES,
  excludeGlobs = [],
}: ScanOptions): ScanResult {
  const ctx: ScanContext = { out: [], errors: [], skipped: [], excludeGlobs };

  if (modules.includes('skills')) collectSkills({ userHome, ctx });
  if (modules.some((m) => ['plugins', 'config'].includes(m))) {
    collectProfileFiles({ dshHome, profileName, modules, ctx });
  }
  if (modules.includes('userMemory')) collectUserMemory({ dshHome, ctx });
  if (modules.includes('projectMemory')) collectProjectMemory({ dshHome, ctx });
  if (modules.includes('sessions')) collectSessions({ dshHome, ctx });

  const entries = ctx.out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    ctx.errors.push({ code: 'E_TOTAL_TOO_LARGE', total: totalBytes, limit: MAX_TOTAL_BYTES });
  }
  return { entries, errors: ctx.errors, skipped: ctx.skipped, totalBytes };
}
