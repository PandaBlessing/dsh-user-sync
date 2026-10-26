import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPackageId } from './archive.ts';
import { deriveAccountKey } from './auth.ts';
import type {
  AccountProfile,
  ApplyBody,
  CheckPayload,
  ConfigBody,
  ConfigEditorLike,
  ConnectionLike,
  ConsentBody,
  DeepseekAccountLike,
  HostRoute,
  InstallBody,
  PluginManagerLike,
} from './host.ts';
import { resolvePaths } from './paths.ts';
import { installMissing, planPluginRecovery } from './plugins.ts';
import { ALL_MODULES, scanAssets } from './scan.ts';
import { createScheduler } from './scheduler.ts';
import { loadState, saveState } from './state.ts';
import { createSync } from './sync.ts';
import { createApiTransport } from './transport/api.ts';
import { createFolderTransport } from './transport/folder.ts';

export const name = 'dsh-user-sync';
/** 不硬依赖任何服务：依赖缺失时降级，不把条目停在 pending。 */
export const inject: string[] = [];

/** 内置服务地址（运营方 API）。用户可在 state.baseUrl 覆盖；这里必须是可用的正式地址。 */
export const DEFAULT_BASE_URL = 'https://dsh-user-sync-test.wenzhi.info';

/** 非用户级模块：默认不选，首次勾选要提示一次。 */
const NON_USER_LEVEL = ['projectMemory', 'sessions'];

export interface InjectContextLike {
  get: <T = unknown>(name: string) => T;
  effect: (fn: () => unknown, label?: string) => unknown;
}

export interface CordisContextLike {
  get?: <T = unknown>(name: string, fallback?: unknown) => T;
  inject?: (deps: string[], callback: (ctx: InjectContextLike) => void) => unknown;
  effect?: (fn: () => unknown, label: string) => unknown;
  logger?: (name: string) => { info?: (message: string, meta?: unknown) => void } | undefined;
}

export interface RouteDef extends HostRoute {}

export interface ScanSummary {
  modules: string[];
  allModules: string[];
  counts: Record<string, number>;
  plugins: Array<{ name: string; spec: string }>;
  selectedFiles: number;
  selectedBytes: number;
  syncableFiles: number;
  syncableBytes: number;
  files: Array<{ module: string; path: string; size: number }>;
  totalFiles: number;
  totalBytes: number;
  errors: Array<{ code: string; path?: string }>;
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * 记录插件自身错误。绝不向外抛：任何插件 bug 都不应阻止 DSH 启动。
 * 日志落在 $DSH_HOME/user-sync/plugin-error.log（与状态文件同目录）。
 * base 可显式传入，测试用它隔离到临时目录，避免污染真实日志。
 */
/** 异步执行外部命令：绝不阻塞宿主事件循环（Electron 主进程卡死会拖垮整个界面）。 */
function runCommand(file: string, args: string[], options: { cwd: string; timeout: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    // 保留 stderr：安装失败时把它写进 plugin-error.log，便于定位（此前只有退出码）
    const child = spawn(file, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时（${options.timeout} ms）: ${file}`));
    }, options.timeout);
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`命令退出码 ${code}: ${file} ${args.join(' ')}\n${stderr.slice(-800)}`));
    });
  });
}

/** 找 DSH 运行时自带的 node 可执行文件（Electron 的 process.execPath 不能用）。 */
function findRuntimeNode(): string | null {
  const root = join(homedir(), '.dsh', 'dsh-runtimes');
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const candidate of [
        join(root, dir.name, 'dependencies', 'node', 'bin', 'node.exe'),
        join(root, dir.name, 'dependencies', 'node', 'bin', 'node'),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // 没有运行时就回退失败
  }
  return null;
}

const PLUGIN_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export function logPluginError(
  where: string,
  error: unknown,
  base: string = process.env.DSH_HOME || join(homedir(), '.dsh'),
): void {
  const line = `${new Date().toISOString()} [${where}] ${(error as Error)?.stack ?? String(error)}\n`;
  try {
    const dir = join(base, 'user-sync');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'plugin-error.log'), line);
  } catch {
    // 写日志失败也不能抛
  }
  try {
    console.error(`[dsh-user-sync] ${where}:`, error);
  } catch {
    // 控制台不可用时忽略
  }
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export function apply(ctx: CordisContextLike) {
  let logBase: string = process.env.DSH_HOME || join(homedir(), '.dsh');
  const log = (where: string, error: unknown): void => logPluginError(where, error, logBase);
  try {
    const profileContext = readService<{ home?: string; name?: string }>(ctx, 'profileContext');
    const paths = resolvePaths({
      profileContext,
      env: process.env,
      userHome: homedir(),
    });
    /** 把自己包名与当前版本写进 minimumReleaseAgeExclude：新版本刚发布时不会拖累其他插件的安装/卸载。 */
    const ensureMinimumReleaseAgeExclude = (): void => {
      const yamlPath = join(paths.profileDir, 'pnpm-workspace.yaml');
      const entry = `@pandablessing/dsh-user-sync@${PLUGIN_VERSION}`;
      try {
        const raw = readFileSync(yamlPath, 'utf8');
        if (raw.includes(entry)) return;
        const yamlLines = raw.split('\n');
        const idx = yamlLines.findIndex((line) => /^minimumReleaseAgeExclude:/.test(line));
        if (idx >= 0) {
          let insert = idx + 1;
          while (insert < yamlLines.length && /^\s+-\s/.test(yamlLines[insert])) insert++;
          yamlLines.splice(insert, 0, `  - '${entry}'`);
          writeFileSync(yamlPath, yamlLines.join('\n'), 'utf8');
        } else {
          writeFileSync(yamlPath, `${raw.trimEnd()}\nminimumReleaseAgeExclude:\n  - '${entry}'\n`, 'utf8');
        }
      } catch {
        // 没有 pnpm-workspace.yaml 时忽略
      }
    };
    ensureMinimumReleaseAgeExclude();
    // 日志跟随本 profile 的 DSH 主目录；测试里即临时目录，不污染真实日志
    logBase = paths.dshHome;

    const statePath = join(paths.dshHome, 'user-sync', 'state.json');
    const authPath = join(paths.dshHome, 'user-sync', 'auth.json');
    const folderDir = join(paths.dshHome, 'user-sync', 'remote');

    /**
     * 内置服务地址：用户未在 state 里覆盖时用它。
     * 没有它，全新安装的机器会静默落到本地目录，既不配对也不连服务端（面板已不提供地址输入）。
     */
    const effectiveBaseUrl = (): string => {
      const state = loadState(statePath);
      const configured = typeof state.baseUrl === 'string' ? state.baseUrl.trim() : '';
      return configured || DEFAULT_BASE_URL;
    };

    /**
     * 传输选择：默认走运营方 API（内置地址），地址非法或用户显式清空时才回退本地目录。
     * 面板已隐藏「传输方式」，不再读 state.transport——避免历史设置把正式环境切成 folder。
     */
    const buildTransport = () => {
      try {
        return createApiTransport({ baseUrl: effectiveBaseUrl(), authPath });
      } catch (error) {
        log('transport-api', error);
      }
      return createFolderTransport({ dir: folderDir });
    };

    const sync = createSync({
      dshHome: paths.dshHome,
      userHome: paths.userHome,
      profileName: paths.profileName,
      transport: buildTransport(),
    });

    const scheduler = createScheduler({ sync, statePath });

    const scanSummary = (): ScanSummary => {
      // 计数按全部模块扫描，勾选只决定打包范围；否则未勾选的模块会显示 0，误导用户。
      const { entries, errors, skipped, totalBytes } = scanAssets({
        dshHome: paths.dshHome,
        userHome: paths.userHome,
        profileName: paths.profileName,
        modules: ALL_MODULES,
      });
      const counts: Record<string, number> = {};
      for (const entry of entries) counts[entry.module] = (counts[entry.module] ?? 0) + 1;
      // 插件清单模块展示「装了什么插件」：直接读 profile 的 package.json dependencies
      let plugins: Array<{ name: string; spec: string }> = [];
      try {
        const pkg = JSON.parse(readFileSync(join(paths.profileDir, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>;
        };
        plugins = Object.entries(pkg.dependencies ?? {}).map(([name, spec]) => ({ name, spec: String(spec) }));
      } catch {
        plugins = [];
      }
      // 已勾选模块的统计：面板「已选」口径，避免把未选的会话体积算进去
      const selectedModules = sync.getModules();
      const selected = entries.filter((entry) => selectedModules.includes(entry.module));
      // 同步范围内（不含会话）的统计：面板「全部」显示用，避免会话体积误导
      const syncable = entries.filter((entry) => entry.module !== 'sessions');
      return {
        modules: selectedModules,
        allModules: ALL_MODULES,
        counts,
        plugins,
        selectedFiles: selected.length,
        syncableFiles: syncable.length,
        syncableBytes: syncable.reduce((sum, entry) => sum + entry.size, 0),
        selectedBytes: selected.reduce((sum, entry) => sum + entry.size, 0),
        // 每个模块具体包含哪些文件：面板「查看」展开用，按模块分组、路径升序
        files: entries.map((entry) => ({ module: entry.module, path: entry.path, size: entry.size, title: entry.title ?? null })),
        totalFiles: entries.length,
        totalBytes,
        errors,
        skipped: skipped.slice(0, 50),
      };
    };

    /** handler 异常落盘：面板显示「接口错误」时可直接从 state.diagnostics.lastError 定位。 */
    const recordHandlerError = (where: string, error: unknown): void => {
      log(`handler-${where}`, error);
      try {
        const state = loadState(statePath);
        state.diagnostics = {
          ...((state.diagnostics as Record<string, unknown> | null) ?? {}),
          lastError: {
            at: new Date().toISOString(),
            where,
            message: (error as Error)?.message ?? String(error),
            stack: String((error as Error)?.stack ?? error).slice(0, 1500),
          },
        };
        saveState(statePath, state);
      } catch {
        // 落盘失败不影响响应
      }
    };

    let pluginManager: PluginManagerLike | null = null;

    /** 运行时 pnpm 的 node + pnpm.cjs 路径；找不到时返回 null。 */
    const pnpmRuntime = (): { node: string; pnpmCjs: string } | null => {
      const runtime = findRuntimeNode();
      if (!runtime) return null;
      const pnpmCjs = join(dirname(runtime), '..', '..', 'pnpm', 'bin', 'pnpm.cjs');
      return existsSync(pnpmCjs) ? { node: runtime, pnpmCjs } : null;
    };

    /**
     * 按 profile 的 package.json 安装依赖。
     * 两类依赖会让 pnpm install 整体失败（连带普通包都装不上）：
     * - `link:` / `file:` 指向不存在的本地路径
     * - `node_modules` 里是 junction/符号链接（开发期 link 装的插件，pnpm 重装会 EPERM）
     * 因此安装期间临时把这些依赖从 package.json 摘掉，装完原样恢复，并重建被 pnpm 移走的链接。
     */
    const installProfileDependencies = async (): Promise<{ removedLinks: string[] }> => {
      const rt = pnpmRuntime();
      if (!rt) throw new Error('runtime node/pnpm not found');
      const pkgPath = join(paths.profileDir, 'package.json');
      const workspacePath = join(paths.profileDir, 'pnpm-workspace.yaml');
      const raw = readFileSync(pkgPath, 'utf8');
      const removedLinks: string[] = [];
      const linkTargets = new Map<string, string>();
      let workspaceRaw: string | null = null;
      const missingPatchLines: string[] = [];
      try {
        const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
        const dependencies = pkg.dependencies ?? {};
        // pnpm-workspace.yaml 的 patchedDependencies 指向 patches/*.patch；文件缺失时 pnpm install 会整体失败
        try {
          workspaceRaw = readFileSync(workspacePath, 'utf8');
          for (const line of workspaceRaw.split('\n')) {
            const match = line.match(/^\s+'?([^':]+)'?@[^:]+:\s*patches\/(.+?)\s*$/);
            if (match && !existsSync(join(paths.profileDir, 'patches', match[2]))) missingPatchLines.push(line);
          }
          if (missingPatchLines.length > 0) {
            const kept = workspaceRaw.split('\n').filter((line) => !missingPatchLines.includes(line));
            // 段内条目全删光时，连 `patchedDependencies:` 键一起删：pnpm 不接受 null
            const keyIndex = kept.findIndex((line) => line.trim() === 'patchedDependencies:');
            if (keyIndex >= 0) {
              const next = kept[keyIndex + 1];
              if (next === undefined || !/^\s{2}\S/.test(next)) kept.splice(keyIndex, 1);
            }
            writeFileSync(workspacePath, kept.join('\n'), 'utf8');
          }
        } catch {
          workspaceRaw = null;
        }

        // 需要临时摘除的依赖：坏 link / 文件依赖 + 已经是 junction 的已装包
        const detached = Object.entries(dependencies).filter(([name, spec]) => {
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            const target = join(paths.profileDir, spec.slice(5));
            if (!existsSync(target)) return true;
            linkTargets.set(name, target);
            return true;
          }
          const abs = join(paths.profileDir, 'node_modules', name);
          try {
            if (lstatSync(abs).isSymbolicLink()) {
              linkTargets.set(name, realpathSync(abs));
              return true;
            }
          } catch {
            // 没装或读不到：交给 pnpm 正常安装
          }
          return false;
        });
        if (detached.length > 0) {
          const patched = { ...pkg, dependencies: { ...dependencies } };
          for (const [name] of detached) {
            delete patched.dependencies[name];
            removedLinks.push(name);
          }
          writeFileSync(pkgPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
        }
        await runCommand(rt.node, [rt.pnpmCjs, 'install', '--force'], { cwd: paths.profileDir, timeout: 300_000 });
      } finally {
        if (removedLinks.length > 0) writeFileSync(pkgPath, raw, 'utf8');
        if (workspaceRaw !== null && missingPatchLines.length > 0) writeFileSync(workspacePath, workspaceRaw, 'utf8');
        // pnpm 可能把不在依赖树里的链接移进 .ignored；装完重建，保证开发期 link 不断
        for (const [name, target] of linkTargets) {
          const abs = join(paths.profileDir, 'node_modules', name);
          if (existsSync(abs)) continue;
          try {
            mkdirSync(dirname(abs), { recursive: true });
            symlinkSync(target, abs, process.platform === 'win32' ? 'junction' : 'dir');
          } catch (error) {
            log('relink', error);
          }
        }
      }
      return { removedLinks };
    };

    /** 缺失插件落盘校验：pnpm 的 .modules.yaml 可能残留记录，缺失时再跑一次 pnpm install。 */
    const forceReinstallIfMissing = async (names: string[]): Promise<void> => {
      const missing = names.filter((name) => !existsSync(join(paths.profileDir, 'node_modules', name)));
      if (missing.length === 0) return;
      try {
        await installProfileDependencies();
      } catch (error) {
        log('pnpm-force', error);
      }
    };

    /** 把远端包声明的依赖装上：先按 package.json 整体安装，再逐个 installBundle 兜底，link/file 依赖只提示手动处理。 */
    const ensurePluginsInstalled = async (
      pm: PluginManagerLike,
      dependencies: Record<string, unknown>,
    ): Promise<{ installed: Array<{ name: string; ok: boolean; error?: string }>; linkDeps: Array<{ name: string; spec: string }> }> => {
      const plan = planPluginRecovery({ dependencies, installed: [] });
      let removedLinks: string[] = [];
      try {
        const result = await installProfileDependencies();
        removedLinks = result.removedLinks;
      } catch (error) {
        log('install-dependencies', error);
      }
      // 安装后重新判定：DSH 的 listBundles 只要声明在就算 installed，实际落盘要看 node_modules
      const bundles = await pm.listBundles();
      const installedNow = bundles
        .filter((bundle) => bundle.installed)
        .map((bundle) => bundle.name)
        .filter((name) => existsSync(join(paths.profileDir, 'node_modules', name)));
      const stillMissing = planPluginRecovery({ dependencies, installed: installedNow }).missing;
      const results = await installMissing({
        plan: { missing: stillMissing },
        installBundle: (spec: string) => pm.installBundle(spec),
      });
      await forceReinstallIfMissing(stillMissing.map((item) => item.name));
      const installed = plan.missing.map((item) => ({
        name: item.name,
        ok: existsSync(join(paths.profileDir, 'node_modules', item.name)),
        error: results.find((result) => result.name === item.name)?.error,
      }));
      return { installed, linkDeps: plan.linkDeps.map(({ name, spec }) => ({ name, spec })) };
    };

    /** 判断 latest 是否比 current 新（只比较 x.y.z 数字段）。 */
    const isNewerVersion = (latest: string, current: string): boolean => {
      const toParts = (value: string) => value.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
      const a = toParts(latest);
      const b = toParts(current);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const left = a[i] ?? 0;
        const right = b[i] ?? 0;
        if (left !== right) return left > right;
      }
      return false;
    };

    /** 版本检查：查 npm registry 的 dist-tags 与当前版本比对（30 分钟缓存，失败静默）。 */
    let versionCache: { at: number; latest: string | null } | null = null;
    const checkLatestVersion = async (): Promise<{ current: string; latest: string | null; available: boolean }> => {
      const now = Date.now();
      if (versionCache && now - versionCache.at < 30 * 60_000) {
        const latest = versionCache.latest;
        return { current: PLUGIN_VERSION, latest, available: Boolean(latest && isNewerVersion(latest, PLUGIN_VERSION)) };
      }
      const registry = process.env.NPM_REGISTRY || 'https://registry.npmjs.org';
      const encoded = encodeURIComponent('@pandablessing/dsh-user-sync').replace('%2F', '%2f');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${registry}/-/package/${encoded}/dist-tags`, { signal: controller.signal });
        const tags = (await response.json()) as { latest?: string };
        const latest = typeof tags.latest === 'string' ? tags.latest : null;
        versionCache = { at: now, latest };
        return { current: PLUGIN_VERSION, latest, available: Boolean(latest && isNewerVersion(latest, PLUGIN_VERSION)) };
      } catch {
        versionCache = { at: now, latest: null };
        return { current: PLUGIN_VERSION, latest: null, available: false };
      } finally {
        clearTimeout(timer);
      }
    };


    const routes: RouteDef[] = [
      {
        // 版本检查：面板据此提示「有新版本可升级」，不做自动安装
        path: '/api/dsh-user-sync/update-check',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return json(await checkLatestVersion());
          } catch (error) {
            recordHandlerError('update-check', error);
            return json({ current: PLUGIN_VERSION, latest: null, available: false });
          }
        },
      },
      {
        // 一键更新：在 profile 里用 pnpm add 真实更新安装包（installBundle 只登记 bundle、不改安装包）
        path: '/api/dsh-user-sync/update',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let version = '';
          try {
            const body = (await request.json()) as { version?: unknown };
            version = typeof body?.version === 'string' ? body.version.trim() : '';
          } catch {
            // 无 body 时按未指定版本处理
          }
          if (!/^\d+\.\d+\.\d+$/.test(version)) return json({ ok: false, error: 'E_BAD_VERSION' }, 400);
          const spec = `@pandablessing/dsh-user-sync@${version}`;
          // 开发安装（junction/link）下 pnpm add 会与链接冲突：不尝试覆盖，提示重启即可（junction 已指向最新代码）
          try {
            const linkPath = join(paths.profileDir, 'node_modules', '@pandablessing', 'dsh-user-sync');
            if (lstatSync(linkPath).isSymbolicLink()) {
              return json({ ok: false, error: 'E_DEV_LINK: 当前是开发安装（link），重启 DSH 即加载最新代码，请勿用更新按钮' }, 409);
            }
          } catch {
            // 路径不存在时走正常安装流程
          }
          try {
            const rt = pnpmRuntime();
            if (!rt) return json({ ok: false, error: 'E_NO_PNPM' }, 503);
            // 新版本刚发布时 pnpm 的 minimumReleaseAge 会拒绝安装，显式放行；同时避免 frozen-lockfile 阻断
            await runCommand(rt.node, [rt.pnpmCjs, 'add', spec, '--config.minimumReleaseAge=0'], {
              cwd: paths.profileDir,
              timeout: 240_000,
            });
          } catch (error) {
            recordHandlerError('update', error);
            return json({ ok: false, error: (error as Error)?.message ?? String(error) }, 500);
          }
          await forceReinstallIfMissing(['@pandablessing/dsh-user-sync']);
          const installedVersion = (() => {
            try {
              const pkg = JSON.parse(
                readFileSync(join(paths.profileDir, 'node_modules', '@pandablessing', 'dsh-user-sync', 'package.json'), 'utf8'),
              ) as { version?: string };
              return pkg.version ?? null;
            } catch {
              return null;
            }
          })();
          return json({ ok: true, version: installedVersion, restartRequired: true });
        },
      },
      {
        // 最小同步路由：用于区分「同步 handler 本身不可用」与「status/scan 具体逻辑抛错」
        path: '/api/dsh-user-sync/ping',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            appendFileSync(join(logBase, 'user-sync', 'ping.log'), `${new Date().toISOString()} ping called\n`);
          } catch {
            // 诊断失败不影响响应
          }
          return new Response('pong');
        },
      },
      {
        path: '/api/dsh-user-sync/status',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => {
          try {
            const state = loadState(statePath);
            const scheduled = scheduler.settings();
            // 宿主侧探针：与 /scan 同一条扫描路径，便于对照面板是否拿不到数据
            let probe: Record<string, unknown> | null = null;
            try {
              const summary = scanSummary();
              probe = { totalFiles: summary.totalFiles, counts: summary.counts, errors: summary.errors.length };
            } catch (error) {
              probe = { error: (error as Error).message };
            }
            return json({
              installed: true,
              version: PLUGIN_VERSION,
              dshHome: paths.dshHome,
              profile: paths.profileName,
              resolvedBy: paths.resolvedBy,
              probe,
              transport: sync.getTransportId(),
              // 实际生效的传输方式（transport 已按内置地址解析，不再由 state.transport 决定）
              transportSetting: sync.getTransportId(),
              baseUrl: effectiveBaseUrl(),
              baseUrlSource: typeof state.baseUrl === 'string' && state.baseUrl.trim() ? 'user' : 'default',
              account: { hint: state.accountKeyHint ?? null, paired: Boolean(state.pairedAt) },
              deviceId: state.deviceId ?? null,
              lastApplied: state.lastApplied ?? null,
              lastUploaded: state.lastUploaded ?? null,
              consent: state.consent ?? null,
              warnedModules: state.warnedModules ?? [],
              diagnostics: state.diagnostics ?? null,
              modules: sync.getModules(),
              scheduler: {
                autoCheck: scheduled.autoCheck,
                intervalHours: scheduled.intervalHours,
                lastCheckAt: scheduled.lastCheckAt,
                lastDecision: scheduled.lastDecision,
                lastCheckError: scheduled.lastCheckError,
              },
            });
          } catch (error) {
            recordHandlerError('status', error);
            return json({ error: 'E_STATUS', detail: String((error as Error)?.stack ?? error) }, 500);
          }
        },
      },
      {
        path: '/api/dsh-user-sync/scan',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => {
          try {
            const summary = scanSummary();
            // 落盘诊断：面板显示异常时可直接从 state 读到宿主真实扫描结果
            try {
              const state = loadState(statePath);
              state.diagnostics = {
                ...((state.diagnostics as Record<string, unknown> | null) ?? {}),
                lastScan: {
                  at: new Date().toISOString(),
                  dshHome: paths.dshHome,
                  profile: paths.profileName,
                  modules: summary.modules,
                  totalFiles: summary.totalFiles,
                  counts: summary.counts,
                },
              };
              saveState(statePath, state);
            } catch {
              // 诊断失败不影响扫描
            }
            return json(summary);
          } catch (error) {
            recordHandlerError('scan', error);
            return json({ error: (error as Error).message, detail: String((error as Error)?.stack ?? '') }, 500);
          }
        },
      },
      {
        path: '/api/dsh-user-sync/config',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          if (request.method === 'GET') {
            const state = loadState(statePath);
            const settings = scheduler.settings();
            return json({
              modules: sync.getModules(),
              autoCheck: settings.autoCheck,
              intervalHours: settings.intervalHours,
              transport: sync.getTransportId(),
              baseUrl: effectiveBaseUrl(),
              baseUrlSource: typeof state.baseUrl === 'string' && state.baseUrl.trim() ? 'user' : 'default',
            });
          }
          const body = (await request.json()) as ConfigBody;
          const state = loadState(statePath);
          if (Array.isArray(body?.modules)) {
            const requested = body.modules.filter((item: string) => ALL_MODULES.includes(item));
            if (requested.length === 0) return json({ error: 'E_NO_VALID_MODULE' }, 400);
            const warned = Array.isArray(state.warnedModules) ? (state.warnedModules as string[]) : [];
            const newly = requested.filter((item: string) => NON_USER_LEVEL.includes(item) && !warned.includes(item));
            if (newly.length > 0 && body?.confirmNonUserLevel !== true) {
              return json({ warning: newly, note: '非用户级内容可能包含工作内容' });
            }
            // 注意：必须写进本函数的 state 对象，由末尾统一 saveState；
            // 之前调 sync.setModules（内部写盘）后再用旧 state 覆盖，导致设置被回滚。
            state.modules = requested;
            if (newly.length > 0) {
              state.warnedModules = [...new Set([...warned, ...newly])];
            }
          }
          if (typeof body?.transport === 'string') {
            if (!['folder', 'api'].includes(body.transport)) return json({ error: 'E_BAD_TRANSPORT' }, 400);
            state.transport = body.transport;
          }
          if (typeof body?.baseUrl === 'string') {
            const url = body.baseUrl.trim();
            if (url && !/^https?:\/\//.test(url)) return json({ error: 'E_BAD_BASE_URL' }, 400);
            state.baseUrl = url || null;
          }
          if (typeof body?.autoCheck === 'boolean') state.autoCheck = body.autoCheck;
          if (body?.intervalHours !== undefined && Number.isFinite(Number(body.intervalHours))) {
            state.intervalHours = Math.min(168, Math.max(1, Number(body.intervalHours)));
          }
          saveState(statePath, state);
          try {
            sync.setTransport(buildTransport());
          } catch (error) {
            log('set-transport', error);
          }
          return json({
            modules: Array.isArray(state.modules) ? (state.modules as string[]) : sync.getModules(),
            autoCheck: state.autoCheck ?? true,
            intervalHours: state.intervalHours ?? 6,
            transport: sync.getTransportId(),
            baseUrl: effectiveBaseUrl(),
            transportNow: sync.getTransportId(),
          });
        },
      },
      {
        path: '/api/dsh-user-sync/consent',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const body = (await request.json()) as ConsentBody;
          const state = loadState(statePath);
          if (body?.accepted) {
            state.consent = { acceptedAt: new Date().toISOString(), version: 1 };
          } else {
            delete state.consent;
          }
          saveState(statePath, state);
          return json({ consent: state.consent ?? null });
        },
      },
      {
        path: '/api/dsh-user-sync/upload',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const state = loadState(statePath);
          if (!(state.consent as { acceptedAt?: string } | null)?.acceptedAt) {
            return json({ ok: false, code: 'E_CONSENT_REQUIRED', detail: '请先同意隐私说明再上传' }, 403);
          }
          // force=true：用户已看到「远端有更新」并确认用本机覆盖远端（G2）
          let force = false;
          try {
            const body = (await request.json()) as { force?: unknown };
            force = body?.force === true;
          } catch {
            // 无 body（面板首次点击）时按未确认处理
          }
          const result = (await sync.upload({ force })) as { ok?: boolean };
          // 上传成功说明远端已与本机一致：立刻重算检查结论，底部状态行不再显示过期的「发现更新」
          if (result.ok) void scheduler.runOnce();
          return json(result);
        },
      },
      {
        path: '/api/dsh-user-sync/check',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const result = (await sync.check()) as CheckPayload;
          if (pluginManager && result.meta?.dependencies) {
            try {
              const bundles = await pluginManager.listBundles();
              const installed = bundles.filter((bundle) => bundle.installed).map((bundle) => bundle.name);
              const dependencies = (result.meta?.dependencies ?? {}) as Record<string, unknown>;
              result.plugins = planPluginRecovery({ dependencies, installed });
            } catch (error) {
              result.plugins = { error: (error as Error).message };
            }
          }
          return json(result);
        },
      },
      {
        path: '/api/dsh-user-sync/install',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const pm = pluginManager;
          if (!pm) return json({ ok: false, error: 'E_NO_PLUGIN_MANAGER' }, 503);
          const body = (await request.json()) as InstallBody;
          const packages = Array.isArray(body?.packages)
            ? (body.packages as unknown[]).filter((item) => typeof (item as { name?: unknown })?.name === 'string')
            : [];
          if (packages.length === 0) return json({ ok: false, error: 'E_NO_PACKAGES' }, 400);
          const results = await installMissing({
            plan: { missing: packages as Array<{ name: string; spec: string }> },
            installBundle: (spec: string) => pm.installBundle(spec),
          });
          // pnpm 的 .modules.yaml 可能残留「已安装」记录，导致 installBundle 返回成功却不落盘；
          // 装完检查目录，缺失时强制重装（pnpm install --force），保证「装了就是真的装了」。
          const missingDirs = (packages as Array<{ name: string }>).filter(
            (item) => !existsSync(join(paths.profileDir, 'node_modules', item.name)),
          );
          if (missingDirs.length > 0) {
            try {
              // process.execPath 是 Electron 主程序，必须找 DSH 运行时的 node
              const runtime = findRuntimeNode();
              const pnpmCjs = runtime ? join(dirname(runtime), '..', '..', 'pnpm', 'bin', 'pnpm.cjs') : '';
              if (!runtime || !existsSync(pnpmCjs)) throw new Error('runtime node/pnpm not found');
              // 异步执行：pnpm 装插件可能要几十秒，同步调用会卡住宿主主线程
              await runCommand(runtime, [pnpmCjs, 'install', '--force'], {
                cwd: paths.profileDir,
                timeout: 300_000,
              });
              for (const item of missingDirs) {
                const ok = existsSync(join(paths.profileDir, 'node_modules', item.name));
                const entry = results.find((result) => result.name === item.name);
                if (entry) entry.ok = ok;
              }
            } catch (error) {
              log('pnpm-force', error);
            }
          }
          return json({ ok: results.every((item) => item.ok), results });
        },
      },
      {
        path: '/api/dsh-user-sync/apply',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const body = (await request.json()) as ApplyBody;
          if (!isPackageId(String(body?.name ?? ''))) return json({ error: 'E_BAD_NAME' }, 400);
          const result = (await sync.applyRemote(String(body.name))) as unknown as Record<string, unknown>;
          // 同步只恢复声明文件；应用后必须真正把插件装上，否则「清单同步了却没装」
          const pm = pluginManager;
          const manifest = result.manifest as { dependencies?: Record<string, unknown> } | undefined;
          const dependencies = manifest?.dependencies ?? null;
          if (pm && result.ok && dependencies && Object.keys(dependencies).length > 0) {
            try {
              const { installed, linkDeps } = await ensurePluginsInstalled(pm, dependencies);
              result.installed = installed;
              result.linkDeps = linkDeps;
            } catch (error) {
              log('apply-install', error);
              result.installed = [];
              result.installError = (error as Error)?.message ?? String(error);
            }
          }
          // 应用成功后远端与本机一致：重算检查结论
          if (result.ok) void scheduler.runOnce();
          return json(result);
        },
      },
    ];

    // pluginManager 也可能晚到；用于缺失插件检测与安装（§7.8）
    try {
      ctx.inject?.(['pluginManager'], (c) => {
        try {
          pluginManager = c.get<PluginManagerLike>('pluginManager');
        } catch (error) {
          log('plugin-manager', error);
        }
      });
    } catch (error) {
      log('plugin-manager-inject', error);
    }

    // PLUG-07 探针：本插件条目是否在 configEditor.entries() 可见（设置面板能否自助写回）
    try {
      ctx.inject?.(['configEditor'], (c) => {
        try {
          const editor = c.get<ConfigEditorLike>('configEditor');
          const entries = typeof editor?.entries === 'function' ? editor.entries() : [];
          const visible = entries.some((entry) => entry?.options?.id === 'user-sync');
          const state = loadState(statePath);
          state.diagnostics = {
            ...((state.diagnostics as Record<string, unknown> | null) ?? {}),
            configEditorVisible: visible,
            configEditorEntries: entries.length,
            checkedAt: new Date().toISOString(),
          };
          saveState(statePath, state);
        } catch (error) {
          log('config-editor', error);
        }
      });
    } catch (error) {
      log('config-editor-inject', error);
    }

    // 启动时把宿主扫描结果写进 diagnostics：面板异常时可直接从 state 读到宿主真相
    try {
      const summary = scanSummary();
      const state = loadState(statePath);
      state.diagnostics = {
        ...((state.diagnostics as Record<string, unknown> | null) ?? {}),
        scanAtBoot: {
          at: new Date().toISOString(),
          dshHome: paths.dshHome,
          userHome: paths.userHome,
          profile: paths.profileName,
          totalFiles: summary.totalFiles,
          counts: summary.counts,
        },
      };
      saveState(statePath, state);
    } catch (error) {
      log('scan-at-boot', error);
    }

    // connection 服务在 apply 时可能还没就绪（web 启动顺序），必须用 ctx.inject 等待；
    // 直接 ctx.get 会拿到 undefined，导致所有 API 路由静默不注册、面板按钮全部 404。
    try {
      ctx.inject?.(['connection'], (c) => {
        try {
          const connection = c.get<ConnectionLike>('connection');
          const register = connection?.fetch?.register;
          if (typeof register !== 'function') {
            log('routes', new Error('connection 缺少 fetch.register'));
            return;
          }
          for (const route of routes) {
            c.effect(() => register(route), `dsh-user-sync: ${route.path}`);
          }
        } catch (error) {
          log('routes', error);
        }
      });
    } catch (error) {
      log('routes-inject', error);
    }

    // 官方账号自动配对：拿 accountKey 后按配置自动 register/login，用户无感（§9.3、§17.2）。
    try {
      ctx.inject?.(['deepseekAccount'], (c) => {
        void (async () => {
          try {
            const account = c.get<DeepseekAccountLike>('deepseekAccount');
            const profile = await account.getProfile({
              version: PLUGIN_VERSION,
              locale: 'zh-CN',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            });
            const accountId = profile?.status === 'ready' ? profile.value?.id : null;
            if (!accountId) return;

            const accountKey = deriveAccountKey(accountId) as string;
            const state = loadState(statePath);
            state.accountKeyHint = accountKey.slice(0, 6);
            saveState(statePath, state);

            // 传输固定走运营方 API（内置地址或用户覆盖），未登录/离线时只记日志、不阻塞启动
            const api = createApiTransport({ baseUrl: effectiveBaseUrl(), authPath });
            await api.register(accountKey);
            const next = loadState(statePath);
            next.pairedAt = new Date().toISOString();
            saveState(statePath, next);
          } catch (error) {
            log('pair', error);
          }
        })();
      });
    } catch (error) {
      log('pair-inject', error);
    }

    ctx.effect?.(
      () => {
        scheduler.start();
        return () => scheduler.stop();
      },
      'dsh-user-sync: scheduler',
    );

    ctx.effect?.(
      () => () => {
        // 宿主半边没有常驻资源；生命周期钩子留给后续清理
      },
      'dsh-user-sync: lifecycle',
    );

    try {
      ctx.logger?.('dsh-user-sync')?.info?.('已挂载', { dshHome: paths.dshHome, profile: paths.profileName });
    } catch {
      // logger 形态不同不影响挂载
    }

    return { paths, sync, scheduler, routes };
  } catch (error) {
    log('apply', error);
    return undefined;
  }
}

function readService<T>(ctx: CordisContextLike, key: string): T | undefined {
  try {
    return ctx.get?.(key, false) as T | undefined;
  } catch {
    return undefined;
  }
}
