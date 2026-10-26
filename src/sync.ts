import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildManifest, buildTarGz, MANIFEST_PATH, normalizeManifest, parseTarGz } from './archive.ts';
import type { Manifest, ManifestFile } from './archive.ts';
import type { ScanEntry, ScanError } from './scan.ts';
import { applyEntries, planApply } from './apply.ts';
import type { ApplyPlan, ApplyResult } from './apply.ts';
import { hashBytes } from './hash.ts';
import { decide } from './lww.ts';
import type { Decision } from './lww.ts';
import { scanAssets, DEFAULT_MODULES } from './scan.ts';
import type { ScanResult } from './scan.ts';
import { scanBuffer } from './secret.ts';
import type { SecretHit } from './secret.ts';
import { acquireLock, appendHistory, loadState, releaseLock, saveState } from './state.ts';
import type { Transport } from './transport/types.ts';

export interface SyncOptions {
  dshHome: string;
  userHome: string;
  profileName?: string;
  transport: Transport;
  statePath?: string;
  historyPath?: string;
  lockPath?: string;
  preRestoreRoot?: string;
  modules?: string[];
  excludeGlobs?: string[];
  clockSkewMs?: number;
  deviceId?: string;
}

export interface SyncPaths {
  state: string;
  history: string;
  lock: string;
  /** 快照基目录：每次应用在其下生成独立的 `pre-restore-<时间戳>-<随机>` 子目录。 */
  preRestoreBase: string;
}

export interface PackOk {
  ok: true;
  buffer: Buffer;
  manifest: Manifest;
}

export interface PackFail {
  ok: false;
  code: string;
  errors?: ScanError[];
  hits?: SecretHit[];
}

export type PackResult = PackOk | PackFail;

export interface UploadResult {
  ok: boolean;
  code?: string;
  detail?: string;
  holder?: unknown;
  packageId?: string;
  name?: string;
  size?: number;
  manifest?: Manifest;
  /** 远端已有更新包时返回其摘要，供界面显示「谁更新」并二次确认覆盖。 */
  remote?: { name: string; createdAt: string };
}

export interface CheckResult {
  decision: Decision;
  latest: { name: string; size: number; modifiedAt: string } | null;
  meta: Record<string, unknown> | null;
  plan: ApplyPlan | null;
  [key: string]: unknown;
}

export interface ApplyResultEnvelope extends Partial<ApplyResult> {
  ok: boolean;
  code?: string;
  reason?: string;
  detail?: string;
  holder?: unknown;
  manifest?: Manifest;
  plan?: ApplyPlan;
  missingEnv?: string[];
  hits?: SecretHit[];
}

export function makePackageId({ deviceId = 'local0000', now = new Date() }: { deviceId?: string; now?: Date } = {}): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stamp}-${String(deviceId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16).padEnd(6, '0')}`;
}

/**
 * 同步编排：扫描 → 打包 → 判定 → 应用 → 审计。
 * 不直接写界面状态；所有动作返回结果对象，由调用方决定展示与确认。
 */
export function createSync({
  dshHome,
  userHome,
  profileName = 'desktop',
  transport,
  statePath,
  historyPath,
  lockPath,
  preRestoreRoot,
  modules,
  excludeGlobs = [],
  clockSkewMs,
  deviceId,
}: SyncOptions) {
  const paths: SyncPaths = {
    state: statePath ?? join(dshHome, 'user-sync', 'state.json'),
    history: historyPath ?? join(dshHome, 'user-sync', 'history.jsonl'),
    lock: lockPath ?? join(dshHome, 'user-sync', 'lock'),
    preRestoreBase: preRestoreRoot ?? join(dshHome, 'user-sync'),
  };

  /**
   * 每次应用都生成独立快照目录：同进程内多次恢复不会互相覆盖快照（§7.5）。
   * 显式传入 preRestoreRoot 时它作为基目录，快照仍落在其下的时间戳子目录。
   */
  function nextPreRestoreRoot(): string {
    // 精确到毫秒 + 随机后缀：同一秒内连续两次应用也不会撞目录
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    return join(paths.preRestoreBase, `pre-restore-${stamp}`);
  }

  /** 包内路径 → 绝对路径：skills/ 落到 userHome，其余落到 dshHome。 */
  const resolveTarget = (rel: string): string => {
    if (rel.startsWith('skills/')) return join(userHome, '.agents', 'skills', rel.slice('skills/'.length));
    return join(dshHome, rel);
  };

  /** 活动传输：folder 用于调试，api 用于多用户。可在运行时切换。 */
  let activeTransport: Transport = transport;

  function setTransport(next: Transport): string {
    if (!next) throw new Error('transport 不能为空');
    activeTransport = next;
    return activeTransport.id;
  }

  /** 运行时模块配置：显式参数优先，其次 state.json，最后默认四类用户级。会话不参与同步（体积大且不跨机）。 */
  const modulesNow = (): string[] => {
    const raw = modules ?? (Array.isArray(loadState(paths.state).modules) ? (loadState(paths.state).modules as string[]) : DEFAULT_MODULES);
    return raw.filter((id) => id !== 'sessions');
  };

  function getModules(): string[] {
    return modulesNow();
  }

  function setModules(list: unknown): string[] {
    const state = loadState(paths.state);
    const next = Array.isArray(list) ? (list as string[]).filter((id) => id !== 'sessions') : DEFAULT_MODULES;
    state.modules = next;
    saveState(paths.state, state);
    return next;
  }

  function currentDeviceId(): string {
    if (deviceId) return deviceId;
    const state = loadState(paths.state);
    return (state.deviceId as string | null) ?? 'local0000';
  }

  function currentFiles(): { entries: ScanEntry[]; map: Map<string, string> } {
    const { entries } = scanAssets({ dshHome, userHome, profileName, modules: modulesNow(), excludeGlobs });
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (entry.mode === '120000') continue;
      map.set(entry.path, hashBytes(readFileSync(entry.absPath)));
    }
    return { entries, map };
  }

  /** 扫描 + 敏感扫描 + 打包。命中敏感数据整包拒绝（G4）。 */
  function pack(): PackResult {
    const { entries, errors } = scanAssets({ dshHome, userHome, profileName, modules: modulesNow(), excludeGlobs });
    if (errors.length > 0) return { ok: false, code: errors[0].code ?? 'E_SCAN', errors };

    const hits: SecretHit[] = [];
    const files: ManifestFile[] = [];
    for (const entry of entries) {
      if (entry.mode === '120000') {
        files.push({ path: entry.path, sha256: hashBytes(Buffer.from(entry.linkTarget ?? '', 'utf8')), size: 0, mode: '120000' });
        continue;
      }
      const data = readFileSync(entry.absPath);
      const scan = scanBuffer(data, entry.path);
      hits.push(...scan.hits);
      files.push({ path: entry.path, sha256: hashBytes(data), size: data.length, mode: entry.mode });
    }
    if (hits.length > 0) return { ok: false, code: 'E_SENSITIVE', hits };

    // 把 profile 的依赖声明写进 manifest：目标机应用后据此自动安装缺失插件
    let dependencies: Record<string, string> = {};
    try {
      const pkg = JSON.parse(
        readFileSync(join(dshHome, 'profiles', profileName, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      dependencies = pkg.dependencies ?? {};
    } catch {
      dependencies = {};
    }

    const packageId = makePackageId({ deviceId: currentDeviceId() });
    const manifest = buildManifest(files, {
      packageId,
      createdAt: new Date().toISOString(),
      deviceId: currentDeviceId(),
      platform: process.platform,
      arch: process.arch,
      profile: profileName,
      modules: modulesNow(),
      dependencies,
    });

    const tarEntries: Array<{ path: string; data?: Buffer; mode?: string; type?: 'file' | 'symlink'; linkTarget?: string }> = [
      { path: MANIFEST_PATH, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    ];
    for (const entry of entries) {
      if (entry.mode === '120000') {
        tarEntries.push({ path: entry.path, mode: '120000', type: 'symlink', linkTarget: entry.linkTarget });
      } else {
        tarEntries.push({ path: entry.path, data: readFileSync(entry.absPath), mode: entry.mode });
      }
    }
    return { ok: true, buffer: buildTarGz(tarEntries), manifest };
  }

  /**
   * 只读远端最新包（list + meta），失败时返回 null。
   * 用于上传前判断「远端是否已被别的设备更新」，离线时不影响上传。
   */
  async function latestRemote(): Promise<{ name: string; packageId: string | null; createdAt: string } | null> {
    let remoteList: Array<{ name: string; modifiedAt: string }>;
    try {
      remoteList = await activeTransport.list();
    } catch {
      return null;
    }
    if (remoteList.length === 0) return null;
    const latest = [...remoteList].sort((a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0))[0];
    let packageId: string | null = null;
    let createdAt = latest.modifiedAt;
    try {
      const meta = await activeTransport.meta(latest.name);
      if (meta?.packageId) packageId = String(meta.packageId);
      if (meta?.createdAt) createdAt = String(meta.createdAt);
    } catch {
      // 元数据不可读时退回列表时间；不阻塞上传
    }
    return { name: latest.name, packageId, createdAt };
  }

  /**
   * 上传当前本地包。上传前先只读检查远端：
   * 远端是另一份更新的包时返回 `E_REMOTE_NEWER`，由用户确认后带 `force` 重试（G2）。
   */
  async function upload({ force = false }: { force?: boolean } = {}): Promise<UploadResult> {
    const lock = acquireLock({ lockPath: paths.lock });
    if (!lock.acquired) return { ok: false, code: 'E_LOCKED', holder: lock.holder };
    const started = Date.now();
    try {
      if (!force) {
        const state = loadState(paths.state);
        const lastUploaded = state.lastUploaded as { packageId?: string; createdAt?: string } | null;
        const lastApplied = state.lastApplied as { packageId?: string; createdAt?: string } | null;
        const remote = await latestRemote();
        // 远端就是本机上次上传/应用的包：不算「别人更新」，直接覆盖自己
        const isMine = remote?.packageId
          ? remote.packageId === lastUploaded?.packageId || remote.packageId === lastApplied?.packageId
          : false;
        if (remote && !isMine) {
          const remoteTime = Date.parse(remote.createdAt) || 0;
          const localTime = Math.max(Date.parse(lastUploaded?.createdAt ?? '') || 0, Date.parse(lastApplied?.createdAt ?? '') || 0);
          if (remoteTime > localTime) {
            return {
              ok: false,
              code: 'E_REMOTE_NEWER',
              detail: `远端有更新的包（${remote.name}，${remote.createdAt}），确认后再用本机覆盖`,
              remote: { name: remote.name, createdAt: remote.createdAt },
            };
          }
        }
      }
      const packed = pack();
      if (!packed.ok) return packed;
      const name = `dsh-user-sync-${packed.manifest.packageId}.tar.gz`;
      await activeTransport.put(name, packed.buffer);
      const state = loadState(paths.state);
      state.lastUploaded = { packageId: packed.manifest.packageId, createdAt: packed.manifest.createdAt };
      // 上传快照：check 用 state.files 判断「上传之后本机有没有再改」，
      // 否则从未应用过本机时会把「刚上传」误判成两侧并发。
      state.files = Object.fromEntries(
        packed.manifest.files.map((file) => [file.path, { sha256: file.sha256, size: file.size, uploadedAt: new Date().toISOString() }]),
      );
      state.deviceId = state.deviceId ?? currentDeviceId();
      saveState(paths.state, state);
      appendHistory(paths.history, {
        at: new Date().toISOString(),
        action: 'backup',
        modules: packed.manifest.modules,
        files: packed.manifest.files.length,
        bytes: packed.buffer.length,
        ok: true,
        ms: Date.now() - started,
      });
      return { ok: true, packageId: packed.manifest.packageId, name, size: packed.buffer.length, manifest: packed.manifest };
    } catch (error) {
      appendHistory(paths.history, { at: new Date().toISOString(), action: 'backup', ok: false, ms: Date.now() - started });
      const code = (error as { code?: string })?.code ?? 'E_UPLOAD_FAILED';
      return { ok: false, code, detail: (error as Error).message };
    } finally {
      releaseLock({ lockPath: paths.lock });
    }
  }

  /** 只读远端元数据，返回判定结果；不下载、不写盘。 */
  async function check(): Promise<CheckResult> {
    const remoteList = await activeTransport.list();
    // 服务端按账号只留 1 份，但历史遗留多份时按时间取最新，不能依赖列表顺序
    const latest =
      [...remoteList].sort((a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0))[0] ?? null;
    const meta = latest ? await activeTransport.meta(latest.name) : null;
    const state = loadState(paths.state);
    const { map: localFiles } = currentFiles();
    const appliedFiles = new Map(
      Object.entries(state.files ?? {}).map(([path, value]) => [path, (value as { sha256: string }).sha256]),
    );

    const remote = meta
      ? { packageId: meta.packageId as string, createdAt: meta.createdAt as string }
      : latest
        ? { packageId: latest.name, createdAt: latest.modifiedAt }
        : null;

    const decision = decide({
      remote,
      lastApplied: state.lastApplied as { packageId?: string; createdAt?: string } | null,
      lastUploaded: state.lastUploaded as { packageId?: string; createdAt?: string } | null,
      localFiles,
      appliedFiles,
      clockSkewMs,
    });
    let plan: ApplyPlan | null = null;
    if (Array.isArray(meta?.files) && (meta.files as unknown[]).length > 0) {
      try {
        plan = planApply({ manifestFiles: meta.files as ManifestFile[], localFiles });
      } catch {
        plan = null; // 大小写冲突等由应用阶段拒绝，检查阶段不阻塞
      }
    }
    return { decision, latest, meta, plan };
  }

  /** 下载并应用远端包；必须先由调用方完成覆盖确认。 */
  async function applyRemote(name: string): Promise<ApplyResultEnvelope> {
    const lock = acquireLock({ lockPath: paths.lock });
    if (!lock.acquired) return { ok: false, code: 'E_LOCKED', holder: lock.holder };
    const started = Date.now();
    try {
      const buffer = await activeTransport.get(name);
      const entries = parseTarGz(buffer);
      const manifestEntry = entries.find((entry) => entry.path === MANIFEST_PATH);
      if (!manifestEntry) return { ok: false, code: 'E_HASH_MISMATCH', reason: 'manifest 缺失' };
      const manifest = normalizeManifest(JSON.parse(manifestEntry.data.toString('utf8')));

      for (const file of manifest.files) {
        const entry = entries.find((item) => item.path === file.path);
        if (!entry) return { ok: false, code: 'E_HASH_MISMATCH', detail: `缺少文件 ${file.path}` };
        if (entry.type === 'file' && hashBytes(entry.data) !== file.sha256) {
          return { ok: false, code: 'E_HASH_MISMATCH', detail: `哈希不符 ${file.path}` };
        }
      }
      for (const entry of entries) {
        if (entry.path === MANIFEST_PATH || entry.type !== 'file') continue;
        const scan = scanBuffer(entry.data, entry.path);
        if (scan.hits.length > 0) return { ok: false, code: 'E_SENSITIVE', hits: scan.hits };
      }

      const { map: localFiles } = currentFiles();
      const plan = planApply({ manifestFiles: manifest.files, localFiles });
      const applied = applyEntries({ entries, resolveTarget, preRestoreRoot: nextPreRestoreRoot() });

      // PLUG-06：包内 cordis.patch.yml 引用的环境变量在本机缺失时提示（「插件装了但用不了」）
      const missingEnv: string[] = [];
      for (const entry of entries) {
        if (!/^profiles\/[^/]+\/cordis\.patch\.yml$/.test(entry.path)) continue;
        const text = entry.data.toString('utf8');
        for (const match of text.matchAll(/apiKeyEnv:\s*["']?([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const varName = match[1];
          if (!process.env[varName] && !missingEnv.includes(varName)) missingEnv.push(varName);
        }
      }

      const state = loadState(paths.state);
      state.lastApplied = { packageId: manifest.packageId, createdAt: manifest.createdAt };
      state.deviceId = state.deviceId ?? currentDeviceId();
      state.files = Object.fromEntries(
        manifest.files.map((file) => [file.path, { sha256: file.sha256, size: file.size, appliedAt: new Date().toISOString() }]),
      );
      saveState(paths.state, state);
      appendHistory(paths.history, {
        at: new Date().toISOString(),
        action: 'restore',
        modules: manifest.modules,
        files: applied.written.length,
        skipped: applied.skipped.length,
        ok: true,
        ms: Date.now() - started,
      });
      return { ok: true, manifest, plan, missingEnv, ...applied };
    } catch (error) {
      appendHistory(paths.history, { at: new Date().toISOString(), action: 'restore', ok: false, ms: Date.now() - started });
      return { ok: false, code: 'E_APPLY_FAILED', detail: (error as Error).message };
    } finally {
      releaseLock({ lockPath: paths.lock });
    }
  }

  return { paths, pack, upload, check, applyRemote, getModules, setModules, setTransport, getTransportId: () => activeTransport.id };
}
