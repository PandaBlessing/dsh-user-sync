import { loadState, saveState } from './state.ts';

export interface SyncCheckResult {
  decision?: { action?: string | null; reason?: string | null } | null;
  latest?: { name?: string | null; modifiedAt?: string | null } | null;
  meta?: { createdAt?: string | null } | null;
  [key: string]: unknown;
}

export interface SyncLike {
  check: () => Promise<SyncCheckResult>;
}

export interface SchedulerOptions {
  sync: SyncLike;
  statePath: string;
  intervalHours?: number;
  tickMs?: number;
  now?: () => number;
}

export interface SchedulerSettings {
  autoCheck: boolean;
  intervalHours: number;
  lastCheckAt: string | null;
  lastDecision: unknown;
  lastCheckError: string | null;
}

/**
 * 自动检查调度器：启动后检查一次，之后按间隔检查远端**元数据**（list + meta），
 * 不下载、不写盘（只把检查时间与判定记进 state.json）。
 * 失败不无限重试：下一次到点照常。
 */
export function createScheduler({
  sync,
  statePath,
  intervalHours = 6,
  tickMs = 60_000,
  now = () => Date.now(),
}: SchedulerOptions) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let checking = false;

  function settings(): SchedulerSettings {
    const state = loadState(statePath);
    return {
      autoCheck: state.autoCheck !== false,
      intervalHours: Number(state.intervalHours) > 0 ? Number(state.intervalHours) : intervalHours,
      lastCheckAt: (state.lastCheckAt as string | null) ?? null,
      lastDecision: state.lastDecision ?? null,
      lastCheckError: (state.lastCheckError as string | null) ?? null,
    };
  }

  function isDue(at = now()): boolean {
    const current = settings();
    if (!current.autoCheck) return false;
    if (!current.lastCheckAt) return true;
    const last = Date.parse(current.lastCheckAt);
    if (!Number.isFinite(last)) return true;
    return at - last >= current.intervalHours * 3_600_000;
  }

  async function runOnce(): Promise<SyncCheckResult | null> {
    if (checking) return null;
    checking = true;
    try {
      const result = await sync.check();
      const state = loadState(statePath);
      state.lastCheckAt = new Date().toISOString();
      state.lastDecision = {
        action: result.decision?.action ?? null,
        reason: result.decision?.reason ?? null,
        packageId: result.latest?.name ?? null,
        createdAt: result.meta?.createdAt ?? result.latest?.modifiedAt ?? null,
      };
      delete state.lastCheckError;
      saveState(statePath, state);
      return result;
    } catch (error) {
      const state = loadState(statePath);
      state.lastCheckAt = new Date().toISOString();
      state.lastCheckError = (error as Error)?.message ?? String(error);
      saveState(statePath, state);
      return { decision: null, error: state.lastCheckError };
    } finally {
      checking = false;
    }
  }

  function tick(): void {
    if (isDue()) {
      // 后台检查：不阻塞调用方，错误已记录在 state
      void runOnce();
    }
  }

  function start(): void {
    if (timer) return;
    tick();
    timer = setInterval(tick, tickMs);
    // 不阻止 Node 进程退出（测试与无界面场景都靠它）
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, tick, isDue, settings };
}
