import { loadState, saveState } from './state.js';
/**
 * 自动检查调度器：启动后检查一次，之后按间隔检查远端**元数据**（list + meta），
 * 不下载、不写盘（只把检查时间与判定记进 state.json）。
 * 失败不无限重试：下一次到点照常。
 */
export function createScheduler({ sync, statePath, intervalHours = 6, tickMs = 60_000, now = () => Date.now(), }) {
    let timer = null;
    let checking = false;
    function settings() {
        const state = loadState(statePath);
        return {
            autoCheck: state.autoCheck !== false,
            intervalHours: Number(state.intervalHours) > 0 ? Number(state.intervalHours) : intervalHours,
            lastCheckAt: state.lastCheckAt ?? null,
            lastDecision: state.lastDecision ?? null,
            lastCheckError: state.lastCheckError ?? null,
        };
    }
    function isDue(at = now()) {
        const current = settings();
        if (!current.autoCheck)
            return false;
        if (!current.lastCheckAt)
            return true;
        const last = Date.parse(current.lastCheckAt);
        if (!Number.isFinite(last))
            return true;
        return at - last >= current.intervalHours * 3_600_000;
    }
    async function runOnce() {
        if (checking)
            return null;
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
        }
        catch (error) {
            const state = loadState(statePath);
            state.lastCheckAt = new Date().toISOString();
            state.lastCheckError = error?.message ?? String(error);
            saveState(statePath, state);
            return { decision: null, error: state.lastCheckError };
        }
        finally {
            checking = false;
        }
    }
    function tick() {
        if (isDue()) {
            // 后台检查：不阻塞调用方，错误已记录在 state
            void runOnce();
        }
    }
    function start() {
        if (timer)
            return;
        tick();
        timer = setInterval(tick, tickMs);
        // 不阻止 Node 进程退出（测试与无界面场景都靠它）
        timer.unref?.();
    }
    function stop() {
        if (timer)
            clearInterval(timer);
        timer = null;
    }
    return { start, stop, runOnce, tick, isDue, settings };
}
