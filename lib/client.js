"use strict";
// client.ts —— 浏览器 bundle，由 DSH 的 module loader 执行；不是 ESM 模块。
// React 由宿主运行时注入（factory 的 require）；宿主服务的形状在下面用最小接口声明。
/** client 注册 id 必须等于 npm 包名（module-loader 契约，见 design §9.1）。 */
const PACKAGE_NAME = '@pandablessing/dsh-user-sync';
// 浏览器内由 DSH 注入 __ModuleLoader__ 后注册面板；
// 在 Node 侧（DSH 启动时预检 client 入口）import 时不抛错，避免 web boot 失败。
if (typeof window !== 'undefined') {
    // 与官方 client bundle 一致：浏览器里必须注册；加载器缺失时显式抛错，
    // 让 client-modules 的重试生效，而不是静默跳过（否则报 loaded without registering）。
    if (!window.__ModuleLoader__) {
        throw new Error('[dsh-user-sync] __ModuleLoader__ 不可用，无法注册面板');
    }
    try {
        window.__ModuleLoader__.load({
            id: PACKAGE_NAME,
            factory: (require) => {
                const module = { exports: {} };
                const exports = module.exports;
                let React = null;
                try {
                    React = require('react');
                }
                catch (error) {
                    console.error('[dsh-user-sync] 无法加载 react，面板已禁用', error);
                }
                // 最坏情况只失去面板，绝不让 client entry 失败拖垮 web boot。
                if (!React) {
                    exports.apply = () => { };
                    exports.inject = [];
                    return module.exports;
                }
                const R = React;
                const API = '/api/dsh-user-sync';
                const MODULE_LABELS = {
                    skills: '技能',
                    plugins: '插件清单',
                    config: '配置',
                    userMemory: '用户记忆',
                    projectMemory: '项目记忆',
                    sessions: '会话',
                };
                const USER_LEVEL = ['skills', 'plugins', 'config', 'userMemory'];
                /** 每个模块同步的内容简介（按钮悬停与下方小字）。 */
                const MODULE_HINTS = {
                    skills: '~/.agents/skills 下的技能包（需含 SKILL.md）',
                    plugins: 'profile 的 package.json 与依赖锁文件',
                    config: 'cordis.patch.yml（含自定义 agent 预设）与 AGENTS.md',
                    userMemory: 'AGENTS.md 与 memories/ 下的用户级记忆（MEMORY/USER/KEY）',
                    projectMemory: 'memories/projects 与 daily 下的项目记忆',
                    sessions: 'sessions/ 下的会话记录',
                };
                const styles = {
                    section: { display: 'flex', flexDirection: 'column', gap: 12 },
                    heading: { margin: 0, fontSize: 18, fontWeight: 600 },
                    card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 },
                    row: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
                    muted: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-tertiary)' },
                    moduleRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
                    moduleWrap: { display: 'flex', flexWrap: 'wrap', gap: 8 },
                    moduleGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 },
                    moduleItem: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
                    moduleHint: { fontSize: 11, lineHeight: 1.4, color: 'var(--dsw-alias-label-tertiary)' },
                    linkButton: { alignSelf: 'flex-start', padding: 0, border: 0, background: 'transparent', color: 'var(--dsw-alias-state-business-primary)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline' },
                    warn: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-warning-primary, #b26b00)' },
                    fileList: { margin: 0, padding: '4px 0 0 16px', listStyle: 'disc', maxHeight: 160, overflowY: 'auto' },
                    fileItem: { fontSize: 11, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' },
                    moduleButton: {
                        padding: '5px 12px',
                        borderRadius: 999,
                        border: '1px solid var(--dsw-alias-border-l2)',
                        background: 'transparent',
                        color: 'inherit',
                        fontSize: 13,
                        cursor: 'pointer',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                    },
                    moduleButtonActive: {
                        padding: '5px 12px',
                        borderRadius: 999,
                        border: '1px solid var(--dsw-alias-state-business-primary)',
                        background: 'var(--dsw-alias-state-business-primary)',
                        color: '#fff',
                        fontSize: 13,
                        cursor: 'pointer',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                    },
                    actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
                    primary: { padding: '6px 14px', borderRadius: 6, border: 0, cursor: 'pointer', background: 'var(--dsw-alias-state-business-primary)', color: '#fff', fontSize: 13 },
                    secondary: { padding: '6px 14px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', fontSize: 13 },
                    error: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #d33)' },
                    overlay: {
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.4)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                    },
                    dialog: {
                        width: 360,
                        maxWidth: 'calc(100vw - 48px)',
                        background: 'var(--dsw-alias-bg-elevated, #fff)',
                        color: 'inherit',
                        borderRadius: 10,
                        padding: 16,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)',
                    },
                };
                async function fetchJson(url, options = {}) {
                    // no-store：GET 结果可能被渲染进程缓存，导致「刚写入的状态读回旧值」
                    const response = await fetch(url, { cache: 'no-store', ...options });
                    const text = await response.text();
                    try {
                        return JSON.parse(text);
                    }
                    catch {
                        return { error: `HTTP ${response.status}`, detail: text.slice(0, 200) };
                    }
                }
                function fmtBytes(bytes) {
                    const n = Number(bytes ?? 0);
                    if (!Number.isFinite(n))
                        return '-';
                    if (n < 1024)
                        return `${n} B`;
                    if (n < 1024 * 1024)
                        return `${(n / 1024).toFixed(1)} KB`;
                    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
                }
                /** ISO 时间 → 本地 `MM-DD HH:mm`。 */
                function fmtTime(iso) {
                    if (!iso)
                        return '—';
                    const date = new Date(iso);
                    if (Number.isNaN(date.getTime()))
                        return String(iso);
                    const pad = (value) => String(value).padStart(2, '0');
                    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
                }
                const DECISION_LABELS = {
                    pull: '发现更新',
                    push: '本机有更新',
                    skip: '已是最新',
                    confirm: '需人工确认',
                    'remote-missing': '远端无包',
                };
                /** 最近一次同步的摘要：上传 / 应用 / 检查。 */
                /** 最近一次同步的摘要：上传 / 应用 / 检查。 */
                function lastSyncSummary(status) {
                    if (!status)
                        return '尚未同步';
                    const parts = [];
                    if (status.lastUploaded?.createdAt)
                        parts.push(`上次上传 ${fmtTime(status.lastUploaded.createdAt)}`);
                    if (status.lastApplied?.createdAt)
                        parts.push(`上次应用 ${fmtTime(status.lastApplied.createdAt)}`);
                    if (status.scheduler?.lastCheckAt) {
                        const decision = status.scheduler.lastDecision;
                        const label = decision?.action && DECISION_LABELS[decision.action] ? DECISION_LABELS[decision.action] : '';
                        // 检查结论只在「没有比它更新的上传/应用」时才算数：否则显示「发现更新」会与上传时间矛盾
                        const checkAt = Date.parse(status.scheduler.lastCheckAt);
                        const newerAt = Math.max(status.lastUploaded?.createdAt ? Date.parse(status.lastUploaded.createdAt) : Number.NEGATIVE_INFINITY, status.lastApplied?.createdAt ? Date.parse(status.lastApplied.createdAt) : Number.NEGATIVE_INFINITY);
                        const stale = Number.isFinite(checkAt) && newerAt > checkAt;
                        const suffix = label && !stale ? `（${label}）` : '';
                        parts.push(`上次检查 ${fmtTime(status.scheduler.lastCheckAt)}${suffix}`);
                    }
                    return parts.length > 0 ? parts.join(' · ') : '尚未同步';
                }
                function ResultCard({ notice, onConfirmModules, onDismiss, onForceUpload }) {
                    if (!notice)
                        return null;
                    const { kind, data } = notice;
                    if (kind === 'check') {
                        const decision = data.decision ?? {};
                        return R.createElement('div', { style: styles.card }, R.createElement('strong', null, decision.action === 'skip' ? '本机已是最新' : '本机有改动'), R.createElement('p', { style: styles.muted }, `判定：${decision.reason ?? decision.action}`));
                    }
                    if (kind === 'error') {
                        const remoteNewer = data.code === 'E_REMOTE_NEWER';
                        return R.createElement('div', { style: styles.card }, R.createElement('strong', { style: styles.error }, remoteNewer ? '远端有更新的包' : '操作失败'), R.createElement('p', { style: styles.muted }, data.detail ?? data.error ?? '未知错误'), data.hits
                            ? R.createElement('p', { style: styles.error }, `敏感扫描命中 ${data.hits.length} 处：${data.hits.map((h) => `${h.file}:${h.line}（${h.pattern}）`).join('；')}`)
                            : null, 
                        // 覆盖确认已改为弹窗；卡片只提示
                        remoteNewer ? R.createElement('p', { style: styles.muted }, '覆盖动作会在弹窗中确认。') : null);
                    }
                    // 同步后自动安装的结果：优先展示「装了哪些插件 / 哪些失败 / 哪些需手动放回」
                    const pluginSummary = (() => {
                        const installed = Array.isArray(data.installed) ? data.installed : [];
                        const linkDeps = Array.isArray(data.linkDeps) ? data.linkDeps : [];
                        if (installed.length === 0 && linkDeps.length === 0)
                            return null;
                        const okList = installed.filter((item) => item.ok).map((item) => item.name);
                        const failList = installed.filter((item) => !item.ok).map((item) => item.name);
                        const parts = [okList.length > 0 ? `已安装 ${okList.length} 个插件：${okList.join('、')}` : '没有需要安装的插件'];
                        if (failList.length > 0)
                            parts.push(`安装失败 ${failList.length} 个：${failList.join('、')}`);
                        if (linkDeps.length > 0)
                            parts.push(`需手动放回：${linkDeps.map((item) => item.name).join('、')}`);
                        return parts.join('；');
                    })();
                    return R.createElement('div', { style: styles.card }, R.createElement('strong', null, '完成'), pluginSummary
                        ? R.createElement('p', { style: styles.muted }, pluginSummary)
                        : null, R.createElement('p', { style: styles.muted }, data.detail
                        ? String(data.detail)
                        : data.packageId
                            ? `包 ${data.packageId} · ${fmtBytes(data.size ?? 0)}`
                            : `写入 ${data.written?.length ?? 0} 个文件，跳过 ${data.skipped?.length ?? 0} 个`));
                }
                function UserSyncSection() {
                    const [status, setStatus] = R.useState(null);
                    const [scan, setScan] = R.useState(null);
                    // 默认即「四类用户级选中、项目/会话不选」，不依赖 scan 是否成功（G1）。
                    const [modules, setModules] = R.useState(['skills', 'plugins', 'config', 'userMemory']);
                    const [settings, setSettings] = R.useState({ transport: 'folder', baseUrl: '', autoCheck: true, intervalHours: 6 });
                    const [busy, setBusy] = R.useState(false);
                    const [notice, setNotice] = R.useState(null);
                    // 非用户级模块确认走弹窗（dialog），不再用底部结果卡
                    const [confirmDialog, setConfirmDialog] = R.useState(null);
                    // 覆盖确认弹窗：上传发现远端更新 / 从远端同步发现远端更新时弹出（不再用结果卡按钮）
                    const [overwriteDialog, setOverwriteDialog] = R.useState(null);
                    // 版本检查结果：有新版本时在面板顶部提示（不自动安装）
                    const [updateInfo, setUpdateInfo] = R.useState(null);
                    // 更新完成弹窗（重启提示放在弹窗里，底部状态行看不到）
                    const [updateDone, setUpdateDone] = R.useState(null);
                    // 当前进行中的动作（上传/同步），用于按钮文案
                    const [busyAction, setBusyAction] = R.useState(null);
                    // 操作结果弹窗（上传/同步完成后弹出）
                    const [resultDialog, setResultDialog] = R.useState(null);
                    // 一键更新：调宿主 /update（走 DSH 官方安装器），成功后提示重启
                    const updatePlugin = async () => {
                        const target = updateInfo?.latest;
                        if (!target)
                            return;
                        setBusy(true);
                        try {
                            const result = await fetchJson(`${API}/update`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ version: target }),
                            });
                            if (result.ok) {
                                setUpdateInfo(null);
                                setUpdateDone(`已更新到 v${result.version ?? target}，请重启 DSH 生效`);
                            }
                            else {
                                setNotice({ kind: 'error', data: { detail: `更新失败：${result.error ?? '未知错误'}` } });
                            }
                        }
                        catch (error) {
                            setNotice({ kind: 'error', data: { detail: String(error) } });
                        }
                        finally {
                            setBusy(false);
                        }
                    };
                    // 当前展开文件清单的模块（null 表示都收起）
                    const [expandedModule, setExpandedModule] = R.useState(null);
                    // 设置改动后自动保存（600ms 防抖），不再提供「保存设置」按钮
                    const [settingsDirty, setSettingsDirty] = R.useState(false);
                    // 本地兜底：status 读不到时也能记住「已同意」，不再重复显示同意卡
                    const [localConsent, setLocalConsent] = R.useState(() => {
                        try {
                            return localStorage.getItem('dsh-user-sync:consent') === '1';
                        }
                        catch {
                            return false;
                        }
                    });
                    const consentGiven = Boolean(status?.consent?.acceptedAt) || localConsent;
                    const refresh = () => {
                        fetchJson(`${API}/status`)
                            .then((data) => {
                            if (data?.error) {
                                // 保留已乐观更新的 consent，只补充错误信息
                                setStatus((previous) => ({ ...(previous ?? {}), error: data.error, detail: data.detail }));
                                return;
                            }
                            setStatus(data);
                            setSettings({
                                transport: data.transportSetting ?? 'folder',
                                baseUrl: data.baseUrl ?? '',
                                autoCheck: data.scheduler?.autoCheck !== false,
                                intervalHours: data.scheduler?.intervalHours ?? 6,
                            });
                        })
                            .catch((error) => setStatus((previous) => ({ ...(previous ?? {}), error: 'status-fetch-failed', detail: String(error) })));
                        fetchJson(`${API}/scan`)
                            .then((data) => {
                            if (data?.error) {
                                setScan({ error: data.error, detail: data.detail });
                                return;
                            }
                            setScan(data);
                            if (Array.isArray(data.modules))
                                setModules(data.modules);
                        })
                            .catch((error) => setScan({ error: 'scan-fetch-failed', detail: String(error) }));
                    };
                    R.useEffect(() => {
                        refresh();
                        // 版本检查失败不影响面板（网络不可用时静默）
                        fetchJson(`${API}/update-check`)
                            .then((data) => setUpdateInfo(data))
                            .catch(() => setUpdateInfo(null));
                    }, []);
                    // 设置改动后 600ms 自动保存（输入间隔时不会每敲一下都发请求）
                    R.useEffect(() => {
                        if (!settingsDirty)
                            return undefined;
                        const timer = setTimeout(() => {
                            void saveSettings();
                        }, 600);
                        return () => clearTimeout(timer);
                    }, [settings, settingsDirty]);
                    // 操作提示（完成 / 已保存）3 秒后自动消失；覆盖确认与错误卡保留
                    R.useEffect(() => {
                        if (notice?.kind !== 'result')
                            return undefined;
                        const timer = setTimeout(() => setNotice(null), 3000);
                        return () => clearTimeout(timer);
                    }, [notice]);
                    // 自动保存不占用 busy：否则底部「上传/同步」按钮会因 disabled 切换而闪烁
                    const saveSettings = async () => {
                        try {
                            const result = await fetchJson(`${API}/config`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({
                                    autoCheck: settings.autoCheck,
                                    intervalHours: Number(settings.intervalHours) || 6,
                                }),
                            });
                            if (result.error) {
                                setNotice({ kind: 'error', data: { detail: `设置保存失败：${result.error}` } });
                            }
                            else {
                                setNotice({ kind: 'result', data: { detail: '自动检查设置已保存' } });
                            }
                            setSettingsDirty(false);
                            refresh();
                        }
                        catch (error) {
                            setNotice({ kind: 'error', data: { detail: String(error) } });
                        }
                    };
                    const toggleModule = async (id, checked) => {
                        const base = modules ?? [];
                        const next = checked ? [...new Set([...base, id])] : base.filter((item) => item !== id);
                        try {
                            const result = await fetchJson(`${API}/config`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ modules: next }),
                            });
                            if (result.warning) {
                                setConfirmDialog({ modules: next, warning: result.warning });
                                return;
                            }
                            setModules(next);
                            refresh();
                        }
                        catch (error) {
                            setNotice({ kind: 'error', data: { detail: String(error) } });
                        }
                    };
                    const confirmModules = async (next) => {
                        try {
                            await fetchJson(`${API}/config`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ modules: next, confirmNonUserLevel: true }),
                            });
                            setModules(next);
                            setNotice(null);
                            setConfirmDialog(null);
                            refresh();
                        }
                        catch (error) {
                            setNotice({ kind: 'error', data: { detail: String(error) } });
                        }
                    };
                    const acceptConsent = async () => {
                        setBusy(true);
                        try {
                            const result = await fetchJson(`${API}/consent`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ accepted: true }),
                            });
                            if (result?.error) {
                                setNotice({ kind: 'error', data: result });
                                return;
                            }
                            // 乐观更新：不等 status 刷新，卡片立即消失
                            const consent = result?.consent ?? { acceptedAt: new Date().toISOString() };
                            setStatus((previous) => ({ ...(previous ?? {}), consent }));
                            try {
                                localStorage.setItem('dsh-user-sync:consent', '1');
                            }
                            catch {
                                // 隐私模式等场景写不进去，不影响本次会话
                            }
                            setLocalConsent(true);
                            setNotice({ kind: 'result', data: { detail: '已同意' } });
                            refresh();
                        }
                        catch (error) {
                            setNotice({ kind: 'error', data: { detail: String(error) } });
                        }
                        finally {
                            setBusy(false);
                        }
                    };
                    /** force=true 表示用户已确认「用本机覆盖远端」（远端更新时才需要）。 */
                    const upload = async (force = false) => {
                        setBusy(true);
                        setBusyAction('upload');
                        setNotice(null);
                        try {
                            const result = await fetchJson(`${API}/upload`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ force }),
                            });
                            if (result.ok) {
                                setResultDialog({ title: '上传完成', detail: result.detail ?? '已上传到远端' });
                                refresh();
                            }
                            else if (result.code === 'E_REMOTE_NEWER') {
                                setOverwriteDialog({
                                    kind: 'upload',
                                    detail: `远端已有更新的包 ${result.latest?.name ?? ''}；继续会用本机配置覆盖它。`,
                                });
                            }
                            else {
                                // 常见失败给出可操作的提示（服务端错误码透传到 result.code）
                                const friendly = {
                                    'quota-exceeded': '远端配额已满：请联系维护者清理旧包，或稍后再试。',
                                    'package-too-large': '包超过 10 MiB 上限：请减少同步范围（取消项目记忆/大文件）后重试。',
                                    'E_LOCKED': '另一台设备正在同步，请稍后再试。',
                                };
                                const hint = typeof result.code === 'string' ? friendly[result.code] : undefined;
                                setResultDialog({
                                    title: '上传失败',
                                    error: true,
                                    detail: hint
                                        ? `${hint}（${result.detail ?? result.code}）`
                                        : result.detail ?? '上传失败：远端存储可能空间不足或不可用，请联系维护者。',
                                });
                            }
                            refresh();
                        }
                        catch (error) {
                            setResultDialog({ title: '上传失败', detail: String(error), error: true });
                        }
                        finally {
                            setBusyAction(null);
                            setBusy(false);
                        }
                    };
                    const checkRemote = async () => {
                        setBusy(true);
                        setBusyAction('pull');
                        setNotice(null);
                        try {
                            const result = await fetchJson(`${API}/check`);
                            if (result.error) {
                                setResultDialog({ title: '检查失败', detail: result.detail ?? '检查远端失败', error: true });
                            }
                            else {
                                // 详情仍用结果卡展示；覆盖动作改为弹窗确认
                                setResultDialog({ title: '检查完成', detail: result.detail ?? (result.decision?.action === 'skip' ? '已是最新' : '本地有更新，可上传到远端') });
                                const action = result.decision?.action;
                                if ((action === 'pull' || action === 'confirm') && result.latest?.name) {
                                    const overwritten = (result.plan?.overwritten ?? []).length;
                                    setOverwriteDialog({
                                        kind: 'pull',
                                        name: result.latest.name,
                                        detail: `远端包 ${result.latest.name}（${result.meta?.createdAt ?? '时间未知'}），将覆盖本机 ${overwritten} 个文件。`,
                                    });
                                }
                            }
                        }
                        catch (error) {
                            setResultDialog({ title: '检查失败', detail: String(error), error: true });
                        }
                        finally {
                            setBusyAction(null);
                            setBusy(false);
                        }
                    };
                    const applyRemote = async (name) => {
                        if (!name)
                            return;
                        setBusy(true);
                        setBusyAction('pull');
                        try {
                            const result = await fetchJson(`${API}/apply`, {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ name }),
                            });
                            setResultDialog({ title: result.ok ? '同步完成' : '同步失败', error: !result.ok, detail: result.detail ?? (result.ok ? '已从远端同步到本机' : '同步失败') });
                            refresh();
                        }
                        catch (error) {
                            setResultDialog({ title: '同步失败', detail: String(error), error: true });
                        }
                        finally {
                            setBusyAction(null);
                            setBusy(false);
                        }
                    };
                    // 会话不参与同步：同步范围内不展示会话模块
                    const moduleIds = (scan?.allModules ?? [...USER_LEVEL, 'projectMemory', 'sessions']).filter((id) => id !== 'sessions');
                    // 计数优先用 status 的宿主探针（与 /scan 同一条扫描路径），
                    // 这样 /scan 请求失败时面板仍能显示真实数量。
                    const counts = status?.probe?.counts ?? scan?.counts ?? {};
                    return R.createElement('div', { style: styles.section }, R.createElement('h2', { style: styles.heading }, '设置同步'), updateInfo?.available
                        ? R.createElement('div', { style: styles.card }, R.createElement('strong', { style: styles.warn }, `插件有新版本 v${updateInfo.latest}（当前 v${updateInfo.current}）`), R.createElement('div', { style: styles.actions }, R.createElement('button', { style: styles.secondary, disabled: busy, onClick: updatePlugin }, busy ? '更新中…' : '更新插件')))
                        : null, !consentGiven
                        ? R.createElement('div', { style: styles.card }, R.createElement('strong', null, '启用前请确认'), R.createElement('p', { style: styles.muted }, '上传内容：技能、插件清单、配置、用户记忆。数据经运营方服务中转并存放在运营方账号（非 DSH 官方服务器）；远端只保留 1 份，上传即覆盖。'), R.createElement('div', { style: styles.actions }, 
                        // 用普通按钮：主色按钮看起来像「已选中」，同意是主动作但不应暗示状态
                        R.createElement('button', { style: styles.secondary, disabled: busy, onClick: acceptConsent }, '同意并启用上传')))
                        : null, R.createElement('div', { style: styles.card }, R.createElement('div', { style: styles.row }, R.createElement('span', null, 'DSH 主目录'), R.createElement('code', null, status?.dshHome ?? '…')), R.createElement('div', { style: styles.row }, R.createElement('span', null, 'Profile'), R.createElement('span', null, status?.profile ?? '…')), R.createElement('div', { style: styles.row }, R.createElement('span', null, '账号'), R.createElement('span', null, status?.account?.hint ? `已配对 · ${status.account.hint}` : '未登录官方账号')), R.createElement('div', { style: styles.row }, R.createElement('span', null, '版本'), R.createElement('span', null, status?.version ? `v${status.version}` : '加载中…')), R.createElement('div', { style: styles.row }, R.createElement('span', null, '服务地址'), R.createElement('span', null, `${status?.baseUrl ?? '（未解析）'}${status?.baseUrlSource === 'user' ? '（自定义）' : '（内置）'}`)), R.createElement('div', { style: styles.row }, R.createElement('span', null, '接口'), R.createElement('span', { style: status?.error ? styles.error : undefined }, status?.error ? `错误：${status.error}${status.detail ? `（${status.detail}）` : ''}` : status?.installed ? '正常' : '加载中…')), R.createElement('div', { style: styles.row }, R.createElement('span', null, '扫描'), R.createElement('span', { style: scan?.error ? styles.error : undefined }, scan?.error
                        ? `失败：${scan.error}${scan.detail ? `：${String(scan.detail).slice(0, 160)}` : ''}`
                        : `已选 ${scan?.selectedFiles ?? scan?.totalFiles ?? 0} 个文件 · ${fmtBytes(scan?.selectedBytes ?? scan?.totalBytes ?? 0)}（同步范围 ${scan?.syncableFiles ?? scan?.totalFiles ?? 0} 个 · ${fmtBytes(scan?.syncableBytes ?? scan?.totalBytes ?? 0)}）`))), R.createElement('div', { style: styles.card }, R.createElement('strong', null, '同步范围'), (scan?.selectedBytes ?? 0) > 10 * 1024 * 1024
                        ? R.createElement('p', { style: styles.warn }, `预计 ${fmtBytes(scan?.selectedBytes)}，超过 10 MiB 单包上限；上传会被拒绝，请取消「会话」或减少同步范围。`)
                        : null, R.createElement('div', { style: styles.moduleGrid }, ...moduleIds.map((id) => {
                        const checked = (modules ?? []).includes(id);
                        // 插件清单展示「装了什么插件」（profile dependencies）；无 plugins 数据时退回文件数
                        const usePluginList = id === 'plugins' && Array.isArray(scan?.plugins);
                        const moduleCount = usePluginList ? (scan?.plugins?.length ?? 0) : counts[id] ?? 0;
                        const moduleFiles = (scan?.files ?? []).filter((file) => file.module === id);
                        // 插件清单展示「装了什么插件」，其余模块展示文件路径；会话模块优先展示标题
                        const moduleEntries = usePluginList
                            ? (scan?.plugins ?? []).map((plugin) => `${plugin.name}@${plugin.spec}`)
                            : moduleFiles.map((file) => (id === 'sessions' && file.title ? file.title : file.path));
                        return R.createElement('div', { key: id, style: styles.moduleItem }, R.createElement('button', {
                            type: 'button',
                            'aria-pressed': checked,
                            title: MODULE_HINTS[id] ?? '',
                            onClick: () => toggleModule(id, !checked),
                            style: checked ? styles.moduleButtonActive : styles.moduleButton,
                        }, `${MODULE_LABELS[id] ?? id}（${moduleCount}）${USER_LEVEL.includes(id) ? '' : ' · 非用户级'}`), R.createElement('span', { style: styles.moduleHint }, MODULE_HINTS[id] ?? ''), moduleEntries.length > 0
                            ? R.createElement('button', {
                                type: 'button',
                                style: styles.linkButton,
                                onClick: () => setExpandedModule(expandedModule === id ? null : id),
                            }, expandedModule === id
                                ? '收起清单'
                                : usePluginList
                                    ? `查看 ${moduleEntries.length} 个插件`
                                    : id === 'sessions'
                                        ? `查看 ${moduleEntries.length} 个会话`
                                        : `查看 ${moduleEntries.length} 个文件`)
                            : null, expandedModule === id
                            ? R.createElement('ul', { style: styles.fileList }, ...moduleEntries.map((entry) => R.createElement('li', { key: entry, style: styles.fileItem }, entry)))
                            : null);
                    }))), R.createElement('div', { style: styles.card }, R.createElement('strong', null, '自动检查'), R.createElement('label', { style: styles.moduleRow }, R.createElement('input', {
                        type: 'checkbox',
                        checked: settings.autoCheck,
                        onChange: (event) => {
                            setSettings({ ...settings, autoCheck: Boolean(event.target.checked) });
                            setSettingsDirty(true);
                        },
                    }), '启动与定时检查远端（只提醒，不自动覆盖）'), R.createElement('label', { style: styles.moduleRow }, R.createElement('span', null, '间隔（小时）'), R.createElement('input', {
                        type: 'number',
                        min: 1,
                        max: 168,
                        value: settings.intervalHours,
                        onChange: (event) => {
                            setSettings({ ...settings, intervalHours: Number(event.target.value ?? 6) });
                            setSettingsDirty(true);
                        },
                        style: { width: 72, padding: '2px 6px', fontSize: 13 },
                    }))), R.createElement('div', { style: styles.actions }, 
                    // 两个操作都用普通按钮：主色高亮会被看成「已选中」
                    R.createElement('button', { style: styles.secondary, disabled: busy || !consentGiven, onClick: () => upload() }, busy && busyAction === 'upload' ? '上传中…' : busy ? '处理中…' : '上传用户配置'), R.createElement('button', { style: styles.secondary, disabled: busy, onClick: checkRemote }, busy && busyAction === 'pull' ? '同步中…' : busy ? '处理中…' : '从远端同步')), R.createElement('p', { style: styles.muted }, lastSyncSummary(status)), 
                    // 服务地址只读展示：默认内置，用户覆盖后标注来源（面板不再提供输入框）
                    R.createElement(ResultCard, {
                        notice,
                        onConfirmModules: confirmModules,
                        onDismiss: () => setNotice(null),
                        onForceUpload: () => upload(true),
                    }), confirmDialog
                        ? R.createElement('div', { style: styles.overlay, onClick: () => setConfirmDialog(null) }, R.createElement('div', { style: styles.dialog, onClick: (event) => event.stopPropagation?.() }, R.createElement('strong', null, '同步项目/会话内容？'), R.createElement('p', { style: styles.muted }, `${confirmDialog.warning.map((id) => MODULE_LABELS[id] ?? id).join('、')} 属于项目/会话级，可能包含具体工作内容。确认要跨机器同步吗？`), R.createElement('div', { style: styles.actions }, R.createElement('button', { style: styles.primary, onClick: () => confirmModules(confirmDialog.modules) }, '仍要同步'), R.createElement('button', { style: styles.secondary, onClick: () => setConfirmDialog(null) }, '取消'))))
                        : null, overwriteDialog
                        ? R.createElement('div', { style: styles.overlay, onClick: () => setOverwriteDialog(null) }, R.createElement('div', { style: styles.dialog, onClick: (event) => event.stopPropagation?.() }, R.createElement('strong', null, overwriteDialog.kind === 'upload' ? '用本机覆盖远端？' : '用远端覆盖本机？'), R.createElement('p', { style: styles.muted }, overwriteDialog.detail), R.createElement('p', { style: styles.muted }, overwriteDialog.kind === 'upload'
                            ? '远端已有的包会被本机内容替换（远端只保留 1 份）。'
                            : '本机会先做快照，再用远端包覆盖同步范围内的文件。'), R.createElement('div', { style: styles.actions }, R.createElement('button', {
                            style: styles.primary,
                            onClick: () => {
                                const target = overwriteDialog;
                                setOverwriteDialog(null);
                                if (target.kind === 'upload')
                                    void upload(true);
                                else if (target.name)
                                    void applyRemote(target.name);
                            },
                        }, overwriteDialog.kind === 'upload' ? '用本机覆盖远端' : '用远端覆盖本机'), R.createElement('button', { style: styles.secondary, onClick: () => setOverwriteDialog(null) }, '取消'))))
                        : null, updateDone
                        ? R.createElement('div', { style: styles.overlay, onClick: () => setUpdateDone(null) }, R.createElement('div', { style: styles.dialog, onClick: (event) => event.stopPropagation?.() }, R.createElement('strong', null, '更新完成'), R.createElement('p', { style: styles.muted }, updateDone), R.createElement('div', { style: styles.actions }, R.createElement('button', { style: styles.primary, onClick: () => setUpdateDone(null) }, '知道了'))))
                        : null, resultDialog
                        ? R.createElement('div', { style: styles.overlay, onClick: () => setResultDialog(null) }, R.createElement('div', { style: styles.dialog, onClick: (event) => event.stopPropagation?.() }, R.createElement('strong', { style: resultDialog.error ? styles.warn : undefined }, resultDialog.title), R.createElement('p', { style: styles.muted }, resultDialog.detail), R.createElement('div', { style: styles.actions }, R.createElement('button', { style: styles.primary, onClick: () => setResultDialog(null) }, '知道了'))))
                        : null);
                }
                function apply(ctx) {
                    try {
                        ctx.slots.inject('settings.section', () => ctx.slots.register({
                            name: 'settings.section',
                            id: 'user-sync',
                            order: 50,
                            label: '设置同步',
                        }, UserSyncSection));
                    }
                    catch (error) {
                        // 面板注册失败只影响自己，不抛给 fiber，避免 web boot 失败。
                        console.error('[dsh-user-sync] 面板注册失败', error);
                    }
                }
                exports.apply = apply;
                // client 半边的 inject 是服务名（slots / locale），不是包名；
                // 不声明 slots 时 ctx.slots 为 undefined，apply 会拿不到服务。
                exports.inject = ['slots'];
                return module.exports;
            },
        });
    }
    catch (error) {
        // 同一 bundle 被两个 owner 加载（旧 junction 与 npm 包并存）时，loader 会抛
        // duplicate factory registration；第二次注册忽略即可，绝不能让 web boot 失败。
        const message = String(error?.message ?? error);
        if (!message.includes('duplicate factory registration'))
            throw error;
        console.warn('[dsh-user-sync] client bundle 已注册过，忽略重复注册');
    }
}
