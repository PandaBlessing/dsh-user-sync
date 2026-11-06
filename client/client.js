// src/client.ts
/** client 注册 id 必须等于 npm 包名（module-loader 契约，见 design §9.1）。 */
const PACKAGE_NAME = "@pandablessing/dsh-user-sync";
if (typeof window !== "undefined") {
	if (!window.__ModuleLoader__) throw new Error("[dsh-user-sync] __ModuleLoader__ 不可用，无法注册面板");
	try {
		window.__ModuleLoader__.load({
			id: PACKAGE_NAME,
			factory: (require$1) => {
				const module = { exports: {} };
				const exports = module.exports;
				let React = null;
				try {
					React = require$1("react");
				} catch (error) {
					console.error("[dsh-user-sync] 无法加载 react，面板已禁用", error);
				}
				if (!React) {
					exports.apply = () => {};
					exports.inject = [];
					return module.exports;
				}
				const R = React;
				const API = "/api/dsh-user-sync";
				const MODULE_LABELS = {
					skills: "技能",
					plugins: "插件清单",
					config: "配置",
					userMemory: "用户记忆",
					projectMemory: "项目记忆",
					sessions: "会话"
				};
				const USER_LEVEL = [
					"skills",
					"plugins",
					"config",
					"userMemory"
				];
				/** 每个模块同步的内容简介（按钮悬停与下方小字）。 */
				const MODULE_HINTS = {
					skills: "~/.dsh/skills 与 ~/.agents/skills 下的技能包（需含 SKILL.md）",
					plugins: "profile 的 package.json 与依赖锁文件",
					config: "cordis.patch.yml（含自定义 agent 预设）与 AGENTS.md",
					userMemory: "AGENTS.md 与 memories/ 下的用户级记忆（MEMORY/USER/KEY）",
					projectMemory: "memories/projects 与 daily 下的项目记忆",
					sessions: "sessions/ 下的会话记录"
				};
				const styles = {
					section: {
						display: "flex",
						flexDirection: "column",
						gap: 12
					},
					heading: {
						margin: 0,
						fontSize: 18,
						fontWeight: 600
					},
					card: {
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: 8,
						padding: 12,
						display: "flex",
						flexDirection: "column",
						gap: 6
					},
					row: {
						display: "flex",
						justifyContent: "space-between",
						gap: 12,
						fontSize: 13
					},
					muted: {
						margin: 0,
						fontSize: 13,
						color: "var(--dsw-alias-label-tertiary)"
					},
					moduleRow: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						fontSize: 13
					},
					moduleWrap: {
						display: "flex",
						flexWrap: "wrap",
						gap: 8
					},
					moduleGrid: {
						display: "grid",
						gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
						gap: 8
					},
					moduleItem: {
						display: "flex",
						flexDirection: "column",
						gap: 4,
						minWidth: 0
					},
					moduleHint: {
						fontSize: 11,
						lineHeight: 1.4,
						color: "var(--dsw-alias-label-tertiary)"
					},
					linkButton: {
						alignSelf: "flex-start",
						padding: 0,
						border: 0,
						background: "transparent",
						color: "var(--dsw-alias-state-business-primary)",
						fontSize: 11,
						cursor: "pointer",
						textDecoration: "underline"
					},
					warn: {
						margin: 0,
						fontSize: 12,
						color: "var(--dsw-alias-state-warning-primary, #b26b00)"
					},
					fileList: {
						margin: 0,
						padding: "4px 0 0 16px",
						listStyle: "disc",
						maxHeight: 160,
						overflowY: "auto"
					},
					fileItem: {
						fontSize: 11,
						lineHeight: 1.5,
						fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
						wordBreak: "break-all"
					},
					moduleButton: {
						padding: "5px 12px",
						borderRadius: 999,
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "transparent",
						color: "inherit",
						fontSize: 13,
						cursor: "pointer",
						userSelect: "none",
						WebkitUserSelect: "none"
					},
					moduleButtonActive: {
						padding: "5px 12px",
						borderRadius: 999,
						border: "1px solid var(--dsw-alias-state-business-primary)",
						background: "var(--dsw-alias-state-business-primary)",
						color: "#fff",
						fontSize: 13,
						cursor: "pointer",
						userSelect: "none",
						WebkitUserSelect: "none"
					},
					actions: {
						display: "flex",
						gap: 8,
						flexWrap: "wrap"
					},
					primary: {
						padding: "6px 14px",
						borderRadius: 6,
						border: 0,
						cursor: "pointer",
						background: "var(--dsw-alias-state-business-primary)",
						color: "#fff",
						fontSize: 13
					},
					secondary: {
						padding: "6px 14px",
						borderRadius: 6,
						cursor: "pointer",
						border: "1px solid var(--dsw-alias-border-l2)",
						background: "transparent",
						color: "inherit",
						fontSize: 13
					},
					error: {
						margin: 0,
						fontSize: 13,
						color: "var(--dsw-alias-state-error-primary, #d33)"
					},
					overlay: {
						position: "fixed",
						inset: 0,
						background: "rgba(0, 0, 0, 0.4)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 1e3
					},
					dialog: {
						width: 360,
						maxWidth: "calc(100vw - 48px)",
						background: "var(--dsw-alias-bg-elevated, #fff)",
						color: "inherit",
						borderRadius: 10,
						padding: 16,
						display: "flex",
						flexDirection: "column",
						gap: 10,
						boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)"
					}
				};
				async function fetchJson(url, options = {}) {
					const response = await fetch(url, {
						cache: "no-store",
						...options
					});
					const text = await response.text();
					try {
						return JSON.parse(text);
					} catch {
						return {
							error: `HTTP ${response.status}`,
							detail: text.slice(0, 200)
						};
					}
				}
				function fmtBytes(bytes) {
					const n = Number(bytes ?? 0);
					if (!Number.isFinite(n)) return "-";
					if (n < 1024) return `${n} B`;
					if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
					return `${(n / 1048576).toFixed(1)} MB`;
				}
				/** ISO 时间 → 本地 `MM-DD HH:mm`。 */
				function fmtTime(iso) {
					if (!iso) return "—";
					const date = new Date(iso);
					if (Number.isNaN(date.getTime())) return String(iso);
					const pad = (value) => String(value).padStart(2, "0");
					return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
				}
				const DECISION_LABELS = {
					pull: "发现更新",
					push: "本机有更新",
					skip: "已是最新",
					confirm: "需人工确认",
					"remote-missing": "远端无包"
				};
				/** 最近一次同步的摘要：上传 / 应用 / 检查。 */
				/** 最近一次同步的摘要：上传 / 应用 / 检查。 */
				function lastSyncSummary(status) {
					if (!status) return "尚未同步";
					const parts = [];
					if (status.lastUploaded?.createdAt) parts.push(`上次上传 ${fmtTime(status.lastUploaded.createdAt)}`);
					if (status.lastApplied?.createdAt) parts.push(`上次应用 ${fmtTime(status.lastApplied.createdAt)}`);
					if (status.scheduler?.lastCheckAt) {
						const decision = status.scheduler.lastDecision;
						const label = decision?.action && DECISION_LABELS[decision.action] ? DECISION_LABELS[decision.action] : "";
						const checkAt = Date.parse(status.scheduler.lastCheckAt);
						const newerAt = Math.max(status.lastUploaded?.createdAt ? Date.parse(status.lastUploaded.createdAt) : Number.NEGATIVE_INFINITY, status.lastApplied?.createdAt ? Date.parse(status.lastApplied.createdAt) : Number.NEGATIVE_INFINITY);
						const suffix = label && !(Number.isFinite(checkAt) && newerAt > checkAt) ? `（${label}）` : "";
						parts.push(`上次检查 ${fmtTime(status.scheduler.lastCheckAt)}${suffix}`);
					}
					return parts.length > 0 ? parts.join(" · ") : "尚未同步";
				}
				function ResultCard({ notice, onConfirmModules, onDismiss, onForceUpload }) {
					if (!notice) return null;
					const { kind, data } = notice;
					if (kind === "check") {
						const decision = data.decision ?? {};
						return R.createElement("div", { style: styles.card }, R.createElement("strong", null, decision.action === "skip" ? "本机已是最新" : "本机有改动"), R.createElement("p", { style: styles.muted }, `判定：${decision.reason ?? decision.action}`));
					}
					if (kind === "error") {
						const remoteNewer = data.code === "E_REMOTE_NEWER";
						return R.createElement("div", { style: styles.card }, R.createElement("strong", { style: styles.error }, remoteNewer ? "远端有更新的包" : "操作失败"), R.createElement("p", { style: styles.muted }, data.detail ?? data.error ?? "未知错误"), data.hits ? R.createElement("p", { style: styles.error }, `敏感扫描命中 ${data.hits.length} 处：${data.hits.map((h) => `${h.file}:${h.line}（${h.pattern}）`).join("；")}`) : null, remoteNewer ? R.createElement("p", { style: styles.muted }, "覆盖动作会在弹窗中确认。") : null);
					}
					const pluginSummary = (() => {
						const installed = Array.isArray(data.installed) ? data.installed : [];
						const linkDeps = Array.isArray(data.linkDeps) ? data.linkDeps : [];
						if (installed.length === 0 && linkDeps.length === 0) return null;
						const okList = installed.filter((item) => item.ok).map((item) => item.name);
						const failList = installed.filter((item) => !item.ok).map((item) => item.name);
						const parts = [okList.length > 0 ? `已安装 ${okList.length} 个插件：${okList.join("、")}` : "没有需要安装的插件"];
						if (failList.length > 0) parts.push(`安装失败 ${failList.length} 个：${failList.join("、")}`);
						if (linkDeps.length > 0) parts.push(`需手动放回：${linkDeps.map((item) => item.name).join("、")}`);
						return parts.join("；");
					})();
					return R.createElement("div", { style: styles.card }, R.createElement("strong", null, "完成"), pluginSummary ? R.createElement("p", { style: styles.muted }, pluginSummary) : null, R.createElement("p", { style: styles.muted }, data.detail ? String(data.detail) : data.packageId ? `包 ${data.packageId} · ${fmtBytes(data.size ?? 0)}` : `写入 ${data.written?.length ?? 0} 个文件，跳过 ${data.skipped?.length ?? 0} 个`));
				}
				function UserSyncSection() {
					const [status, setStatus] = R.useState(null);
					const [scan, setScan] = R.useState(null);
					const [modules, setModules] = R.useState([
						"skills",
						"plugins",
						"config",
						"userMemory"
					]);
					const [settings, setSettings] = R.useState({
						transport: "folder",
						baseUrl: "",
						autoCheck: true,
						intervalHours: 6
					});
					const [busy, setBusy] = R.useState(false);
					const [notice, setNotice] = R.useState(null);
					const [confirmDialog, setConfirmDialog] = R.useState(null);
					const [overwriteDialog, setOverwriteDialog] = R.useState(null);
					const [updateInfo, setUpdateInfo] = R.useState(null);
					const [updateDone, setUpdateDone] = R.useState(null);
					const [feedbackOpen, setFeedbackOpen] = R.useState(false);
					const [feedbackType, setFeedbackType] = R.useState("design");
					const [feedbackContent, setFeedbackContent] = R.useState("");
					const [feedbackContact, setFeedbackContact] = R.useState("");
					const [feedbackBusy, setFeedbackBusy] = R.useState(false);
					const [feedbackDone, setFeedbackDone] = R.useState(null);
					const [feedbackResult, setFeedbackResult] = R.useState(null);
					const openFeedback = () => {
						try {
							const draft = JSON.parse(localStorage.getItem("dsh-user-sync:feedback-draft") || "{}");
							if (draft.type) setFeedbackType(draft.type);
							if (draft.content) setFeedbackContent(draft.content);
							if (draft.contact) setFeedbackContact(draft.contact);
						} catch {}
						setFeedbackDone(null);
						setFeedbackOpen(true);
					};
					const saveDraft = () => {
						try {
							localStorage.setItem("dsh-user-sync:feedback-draft", JSON.stringify({
								type: feedbackType,
								content: feedbackContent,
								contact: feedbackContact
							}));
						} catch {}
					};
					const submitFeedback = async () => {
						if (!feedbackContent.trim()) return;
						setFeedbackBusy(true);
						try {
							const result = await fetchJson(`${API}/feedback`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									type: feedbackType,
									content: feedbackContent,
									contact: feedbackContact,
									context: { accountHint: status?.account?.hint ?? "" },
									platform: typeof navigator !== "undefined" ? navigator.platform : ""
								})
							});
							if (result.ok) {
								setFeedbackOpen(false);
								setFeedbackDone(null);
								setFeedbackContent("");
								setFeedbackContact("");
								try {
									localStorage.removeItem("dsh-user-sync:feedback-draft");
								} catch {}
								setFeedbackResult({
									ok: true,
									message: `反馈已提交，感谢反馈。编号：${result.id ?? ""}`
								});
							} else {
								setFeedbackOpen(false);
								setFeedbackResult({
									ok: false,
									message: `反馈提交失败：${result.error ?? "未知错误"}`
								});
							}
						} catch (error) {
							setFeedbackOpen(false);
							setFeedbackResult({
								ok: false,
								message: `反馈提交失败：${String(error)}`
							});
						} finally {
							setFeedbackBusy(false);
						}
					};
					const [busyAction, setBusyAction] = R.useState(null);
					const [resultDialog, setResultDialog] = R.useState(null);
					const updatePlugin = async () => {
						const target = updateInfo?.latest;
						if (!target) return;
						setBusy(true);
						try {
							const result = await fetchJson(`${API}/update`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ version: target })
							});
							if (result.ok) {
								setUpdateInfo(null);
								setUpdateDone(`已更新到 v${result.version ?? target}，请重启 DSH 生效`);
							} else setNotice({
								kind: "error",
								data: { detail: `更新失败：${result.error ?? "未知错误"}` }
							});
						} catch (error) {
							setNotice({
								kind: "error",
								data: { detail: String(error) }
							});
						} finally {
							setBusy(false);
						}
					};
					const [expandedModule, setExpandedModule] = R.useState(null);
					const [settingsDirty, setSettingsDirty] = R.useState(false);
					const [localConsent, setLocalConsent] = R.useState(() => {
						try {
							return localStorage.getItem("dsh-user-sync:consent") === "1";
						} catch {
							return false;
						}
					});
					const consentGiven = Boolean(status?.consent?.acceptedAt) || localConsent;
					const refresh = () => {
						fetchJson(`${API}/status`).then((data) => {
							if (data?.error) {
								setStatus((previous) => ({
									...previous ?? {},
									error: data.error,
									detail: data.detail
								}));
								return;
							}
							setStatus(data);
							setSettings({
								transport: data.transportSetting ?? "folder",
								baseUrl: data.baseUrl ?? "",
								autoCheck: data.scheduler?.autoCheck !== false,
								intervalHours: data.scheduler?.intervalHours ?? 6
							});
						}).catch((error) => setStatus((previous) => ({
							...previous ?? {},
							error: "status-fetch-failed",
							detail: String(error)
						})));
						fetchJson(`${API}/scan`).then((data) => {
							if (data?.error) {
								setScan({
									error: data.error,
									detail: data.detail
								});
								return;
							}
							setScan(data);
							if (Array.isArray(data.modules)) setModules(data.modules);
						}).catch((error) => setScan({
							error: "scan-fetch-failed",
							detail: String(error)
						}));
					};
					R.useEffect(() => {
						refresh();
						fetchJson(`${API}/update-check`).then((data) => setUpdateInfo(data)).catch(() => setUpdateInfo(null));
					}, []);
					R.useEffect(() => {
						if (!settingsDirty) return void 0;
						const timer = setTimeout(() => {
							saveSettings();
						}, 600);
						return () => clearTimeout(timer);
					}, [settings, settingsDirty]);
					R.useEffect(() => {
						if (notice?.kind !== "result") return void 0;
						const timer = setTimeout(() => setNotice(null), 3e3);
						return () => clearTimeout(timer);
					}, [notice]);
					const saveSettings = async () => {
						try {
							const result = await fetchJson(`${API}/config`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									autoCheck: settings.autoCheck,
									intervalHours: Number(settings.intervalHours) || 6
								})
							});
							if (result.error) setNotice({
								kind: "error",
								data: { detail: `设置保存失败：${result.error}` }
							});
							else setNotice({
								kind: "result",
								data: { detail: "自动检查设置已保存" }
							});
							setSettingsDirty(false);
							refresh();
						} catch (error) {
							setNotice({
								kind: "error",
								data: { detail: String(error) }
							});
						}
					};
					const toggleModule = async (id, checked) => {
						const base = modules ?? [];
						const next = checked ? [.../* @__PURE__ */ new Set([...base, id])] : base.filter((item) => item !== id);
						try {
							const result = await fetchJson(`${API}/config`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ modules: next })
							});
							if (result.warning) {
								setConfirmDialog({
									modules: next,
									warning: result.warning
								});
								return;
							}
							setModules(next);
							refresh();
						} catch (error) {
							setNotice({
								kind: "error",
								data: { detail: String(error) }
							});
						}
					};
					const confirmModules = async (next) => {
						try {
							await fetchJson(`${API}/config`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									modules: next,
									confirmNonUserLevel: true
								})
							});
							setModules(next);
							setNotice(null);
							setConfirmDialog(null);
							refresh();
						} catch (error) {
							setNotice({
								kind: "error",
								data: { detail: String(error) }
							});
						}
					};
					const acceptConsent = async () => {
						setBusy(true);
						try {
							const result = await fetchJson(`${API}/consent`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ accepted: true })
							});
							if (result?.error) {
								setNotice({
									kind: "error",
									data: result
								});
								return;
							}
							const consent = result?.consent ?? { acceptedAt: (/* @__PURE__ */ new Date()).toISOString() };
							setStatus((previous) => ({
								...previous ?? {},
								consent
							}));
							try {
								localStorage.setItem("dsh-user-sync:consent", "1");
							} catch {}
							setLocalConsent(true);
							setNotice({
								kind: "result",
								data: { detail: "已同意" }
							});
							refresh();
						} catch (error) {
							setNotice({
								kind: "error",
								data: { detail: String(error) }
							});
						} finally {
							setBusy(false);
						}
					};
					/** 把服务端返回的 JSON 错误体解析成可读文案（如 {"error":"E_EMPTY_PACKAGE","detail":"..."}）。 */
					const parseServerError = (detail) => {
						if (!detail) return void 0;
						try {
							const data = JSON.parse(detail);
							if (data?.error === "E_EMPTY_PACKAGE") return "没有可同步的文件（请检查同步范围）。";
							if (typeof data?.detail === "string") return data.detail;
							if (typeof data?.error === "string") return data.error;
						} catch {
							return;
						}
					};
					/** force=true 表示用户已确认「用本机覆盖远端」（远端更新时才需要）。 */
					const upload = async (force = false) => {
						setBusy(true);
						setBusyAction("upload");
						setNotice(null);
						try {
							const result = await fetchJson(`${API}/upload`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ force })
							});
							if (result.ok) {
								setResultDialog({
									title: "上传完成",
									detail: result.detail ?? "已上传到远端"
								});
								refresh();
							} else if (result.code === "E_REMOTE_NEWER") setOverwriteDialog({
								kind: "upload",
								detail: `远端已有更新的包 ${result.latest?.name ?? ""}；继续会用本机配置覆盖它。`
							});
							else {
								const hint = typeof result.code === "string" ? {
									"quota-exceeded": "远端配额已满：请联系维护者清理旧包，或稍后再试。",
									"package-too-large": "包超过 10 MiB 上限：请减少同步范围（取消项目记忆/大文件）后重试。",
									"E_LOCKED": "另一台设备正在同步，请稍后再试。"
								}[result.code] : void 0;
								setResultDialog({
									title: "上传失败",
									error: true,
									detail: hint ? `${hint}（${result.detail ?? result.code}）` : parseServerError(result.detail) ?? result.detail ?? "上传失败：远端存储可能空间不足或不可用，请联系维护者。"
								});
							}
							refresh();
						} catch (error) {
							setResultDialog({
								title: "上传失败",
								detail: String(error),
								error: true
							});
						} finally {
							setBusyAction(null);
							setBusy(false);
						}
					};
					const checkRemote = async () => {
						setBusy(true);
						setBusyAction("pull");
						setNotice(null);
						try {
							const result = await fetchJson(`${API}/check`);
							if (result.error) setResultDialog({
								title: "检查失败",
								detail: result.detail ?? "检查远端失败",
								error: true
							});
							else {
								const action = result.decision?.action;
								if ((action === "pull" || action === "confirm") && result.latest?.name) {
									const overwritten = (result.plan?.overwritten ?? []).length;
									setOverwriteDialog({
										kind: "pull",
										name: result.latest.name,
										detail: `远端包 ${result.latest.name}（${fmtTime(result.meta?.createdAt) ?? "时间未知"}），将覆盖本机 ${overwritten} 个文件。`
									});
								} else if (action === "push") setResultDialog({
									title: "检查完成",
									detail: "本地有更新，可上传到远端（或用「上传用户配置」覆盖远端），也可「强制覆盖」从远端拉取。",
									forceApply: result.latest?.name
								});
								else setResultDialog({
									title: "检查完成",
									detail: result.detail ?? "已是最新"
								});
								refresh();
							}
						} catch (error) {
							setResultDialog({
								title: "检查失败",
								detail: String(error),
								error: true
							});
						} finally {
							setBusyAction(null);
							setBusy(false);
						}
					};
					const applyRemote = async (name) => {
						if (!name) return;
						setBusy(true);
						setBusyAction("pull");
						try {
							const result = await fetchJson(`${API}/apply`, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ name })
							});
							setResultDialog({
								title: result.ok ? "同步完成" : "同步失败",
								error: !result.ok,
								detail: result.detail ?? (result.ok ? "已从远端同步到本机" : "同步失败")
							});
							refresh();
						} catch (error) {
							setResultDialog({
								title: "同步失败",
								detail: String(error),
								error: true
							});
						} finally {
							setBusyAction(null);
							setBusy(false);
						}
					};
					const moduleIds = (scan?.allModules ?? [
						...USER_LEVEL,
						"projectMemory",
						"sessions"
					]).filter((id) => id !== "sessions");
					const counts = status?.probe?.counts ?? scan?.counts ?? {};
					return R.createElement("div", { style: styles.section }, R.createElement("h2", { style: styles.heading }, "设置同步"), updateInfo?.available ? R.createElement("div", { style: styles.card }, R.createElement("strong", { style: styles.warn }, `插件有新版本 v${updateInfo.latest}（当前 v${updateInfo.current}）`), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.secondary,
						disabled: busy,
						onClick: updatePlugin
					}, busy ? "更新中…" : "更新插件"))) : null, !consentGiven ? R.createElement("div", { style: styles.card }, R.createElement("strong", null, "启用前请确认"), R.createElement("p", { style: styles.muted }, "上传内容：技能、插件清单、配置、用户记忆。数据经运营方服务中转并存放在运营方账号（非 DSH 官方服务器）；远端只保留 1 份，上传即覆盖。"), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.secondary,
						disabled: busy,
						onClick: acceptConsent
					}, "同意并启用上传"))) : null, R.createElement("div", { style: styles.card }, R.createElement("div", { style: styles.row }, R.createElement("span", null, "DSH 主目录"), R.createElement("code", null, status?.dshHome ?? "…")), R.createElement("div", { style: styles.row }, R.createElement("span", null, "Profile"), R.createElement("span", null, status?.profile ?? "…")), R.createElement("div", { style: styles.row }, R.createElement("span", null, "账号"), R.createElement("span", null, status?.account?.hint ? `已配对 · ${status.account.hint}` : "未登录官方账号")), R.createElement("div", { style: styles.row }, R.createElement("span", null, "版本"), R.createElement("span", null, status?.version ? `v${status.version}` : "加载中…")), R.createElement("div", { style: styles.row }, R.createElement("span", null, "服务地址"), R.createElement("span", null, `${status?.baseUrl ?? "（未解析）"}${status?.baseUrlSource === "user" ? "（自定义）" : "（内置）"}`), status?.dev ? R.createElement("button", {
						style: styles.secondary,
						onClick: async () => {
							const target = status?.baseUrl?.includes("127.0.0.1") ? "remote" : "local";
							try {
								const result = await fetchJson(`${API}/switch-env`, {
									method: "POST",
									headers: { "content-type": "application/json" },
									body: JSON.stringify({ target })
								});
								if (result.ok) {
									setNotice({
										kind: "result",
										data: { detail: `已切换到${target === "local" ? "本地服务端" : "远程服务端"}：${result.baseUrl ?? ""}` }
									});
									refresh();
								} else setNotice({
									kind: "error",
									data: { detail: `切换失败：${result.error ?? "未知错误"}` }
								});
							} catch (error) {
								setNotice({
									kind: "error",
									data: { detail: String(error) }
								});
							}
						}
					}, status?.baseUrl?.includes("127.0.0.1") ? "切到远程" : "切到本地") : null), R.createElement("div", { style: styles.row }, R.createElement("span", null, "接口"), R.createElement("span", { style: status?.error ? styles.error : void 0 }, status?.error ? `错误：${status.error}${status.detail ? `（${status.detail}）` : ""}` : status?.installed ? "正常" : "加载中…")), R.createElement("div", { style: styles.row }, R.createElement("span", null, "扫描"), R.createElement("span", { style: scan?.error ? styles.error : void 0 }, scan?.error ? `失败：${scan.error}${scan.detail ? `：${String(scan.detail).slice(0, 160)}` : ""}` : `已选 ${scan?.selectedFiles ?? scan?.totalFiles ?? 0} 个文件 · ${fmtBytes(scan?.selectedBytes ?? scan?.totalBytes ?? 0)}（同步范围 ${scan?.syncableFiles ?? scan?.totalFiles ?? 0} 个 · ${fmtBytes(scan?.syncableBytes ?? scan?.totalBytes ?? 0)}）`))), R.createElement("div", { style: styles.card }, R.createElement("strong", null, "同步范围"), (scan?.selectedBytes ?? 0) > 10485760 ? R.createElement("p", { style: styles.warn }, `预计 ${fmtBytes(scan?.selectedBytes)}，超过 10 MiB 单包上限；上传会被拒绝，请取消「会话」或减少同步范围。`) : null, R.createElement("div", { style: styles.moduleGrid }, ...moduleIds.map((id) => {
						const checked = (modules ?? []).includes(id);
						const usePluginList = id === "plugins" && Array.isArray(scan?.plugins);
						const moduleCount = usePluginList ? scan?.plugins?.length ?? 0 : counts[id] ?? 0;
						const moduleFiles = (scan?.files ?? []).filter((file) => file.module === id);
						const moduleEntries = usePluginList ? (scan?.plugins ?? []).map((plugin) => `${plugin.name}@${plugin.spec}`) : moduleFiles.map((file) => id === "sessions" && file.title ? file.title : file.path);
						return R.createElement("div", {
							key: id,
							style: styles.moduleItem
						}, R.createElement("button", {
							type: "button",
							"aria-pressed": checked,
							title: MODULE_HINTS[id] ?? "",
							onClick: () => toggleModule(id, !checked),
							style: checked ? styles.moduleButtonActive : styles.moduleButton
						}, `${MODULE_LABELS[id] ?? id}（${moduleCount}）${USER_LEVEL.includes(id) ? "" : " · 非用户级"}`), R.createElement("span", { style: styles.moduleHint }, MODULE_HINTS[id] ?? ""), moduleEntries.length > 0 ? R.createElement("button", {
							type: "button",
							style: styles.linkButton,
							onClick: () => setExpandedModule(expandedModule === id ? null : id)
						}, expandedModule === id ? "收起清单" : usePluginList ? `查看 ${moduleEntries.length} 个插件` : id === "sessions" ? `查看 ${moduleEntries.length} 个会话` : `查看 ${moduleEntries.length} 个文件`) : null, expandedModule === id ? R.createElement("ul", { style: styles.fileList }, ...moduleEntries.map((entry) => R.createElement("li", {
							key: entry,
							style: styles.fileItem
						}, entry))) : null);
					}))), R.createElement("div", { style: styles.card }, R.createElement("div", { style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 12,
						flexWrap: "wrap"
					} }, R.createElement("strong", null, "自动检查"), R.createElement("button", {
						style: styles.secondary,
						onClick: openFeedback
					}, "反馈")), R.createElement("label", { style: styles.moduleRow }, R.createElement("input", {
						type: "checkbox",
						checked: settings.autoCheck,
						onChange: (event) => {
							setSettings({
								...settings,
								autoCheck: Boolean(event.target.checked)
							});
							setSettingsDirty(true);
						}
					}), "启动与定时检查远端（只提醒，不自动覆盖）"), R.createElement("label", { style: styles.moduleRow }, R.createElement("span", null, "间隔（小时）"), R.createElement("input", {
						type: "number",
						min: 1,
						max: 168,
						value: settings.intervalHours,
						onChange: (event) => {
							setSettings({
								...settings,
								intervalHours: Number(event.target.value ?? 6)
							});
							setSettingsDirty(true);
						},
						style: {
							width: 72,
							padding: "2px 6px",
							fontSize: 13
						}
					}))), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.secondary,
						disabled: busy || !consentGiven,
						onClick: () => upload()
					}, busy && busyAction === "upload" ? "上传中…" : busy ? "处理中…" : "上传用户配置"), R.createElement("button", {
						style: styles.secondary,
						disabled: busy,
						onClick: checkRemote
					}, busy && busyAction === "pull" ? "同步中…" : busy ? "处理中…" : "从远端同步")), R.createElement("p", { style: styles.muted }, lastSyncSummary(status)), R.createElement(ResultCard, {
						notice,
						onConfirmModules: confirmModules,
						onDismiss: () => setNotice(null),
						onForceUpload: () => upload(true)
					}), confirmDialog ? R.createElement("div", {
						style: styles.overlay,
						onClick: () => setConfirmDialog(null)
					}, R.createElement("div", {
						style: styles.dialog,
						onClick: (event) => event.stopPropagation?.()
					}, R.createElement("strong", null, "同步项目/会话内容？"), R.createElement("p", { style: styles.muted }, `${confirmDialog.warning.map((id) => MODULE_LABELS[id] ?? id).join("、")} 属于项目/会话级，可能包含具体工作内容。确认要跨机器同步吗？`), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.primary,
						onClick: () => confirmModules(confirmDialog.modules)
					}, "仍要同步"), R.createElement("button", {
						style: styles.secondary,
						onClick: () => setConfirmDialog(null)
					}, "取消")))) : null, overwriteDialog ? R.createElement("div", {
						style: styles.overlay,
						onClick: () => setOverwriteDialog(null)
					}, R.createElement("div", {
						style: styles.dialog,
						onClick: (event) => event.stopPropagation?.()
					}, R.createElement("strong", null, overwriteDialog.kind === "upload" ? "用本机覆盖远端？" : "用远端覆盖本机？"), R.createElement("p", { style: styles.muted }, overwriteDialog.detail), R.createElement("p", { style: styles.muted }, overwriteDialog.kind === "upload" ? "远端已有的包会被本机内容替换（远端只保留 1 份）。" : "本机会先做快照，再用远端包覆盖同步范围内的文件。"), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.primary,
						onClick: () => {
							const target = overwriteDialog;
							setOverwriteDialog(null);
							if (target.kind === "upload") upload(true);
							else if (target.name) applyRemote(target.name);
						}
					}, overwriteDialog.kind === "upload" ? "用本机覆盖远端" : "用远端覆盖本机"), R.createElement("button", {
						style: styles.secondary,
						onClick: () => setOverwriteDialog(null)
					}, "取消")))) : null, updateDone ? R.createElement("div", {
						style: styles.overlay,
						onClick: () => setUpdateDone(null)
					}, R.createElement("div", {
						style: styles.dialog,
						onClick: (event) => event.stopPropagation?.()
					}, R.createElement("strong", null, "更新完成"), R.createElement("p", { style: styles.muted }, updateDone), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.primary,
						onClick: () => setUpdateDone(null)
					}, "知道了")))) : null, resultDialog ? R.createElement("div", {
						style: styles.overlay,
						onClick: () => setResultDialog(null)
					}, R.createElement("div", {
						style: styles.dialog,
						onClick: (event) => event.stopPropagation?.()
					}, R.createElement("strong", { style: resultDialog.error ? styles.warn : void 0 }, resultDialog.title), R.createElement("p", { style: styles.muted }, resultDialog.detail), R.createElement("div", { style: styles.actions }, resultDialog.forceApply ? R.createElement("button", {
						style: styles.primary,
						onClick: () => {
							const name = resultDialog.forceApply;
							setResultDialog(null);
							applyRemote(name);
						}
					}, "强制覆盖") : null, R.createElement("button", {
						style: styles.secondary,
						onClick: () => setResultDialog(null)
					}, "知道了")))) : null, feedbackOpen ? R.createElement("div", {
						style: styles.overlay,
						onClick: () => setFeedbackOpen(false)
					}, R.createElement("div", {
						style: styles.dialog,
						onClick: (event) => event.stopPropagation?.()
					}, R.createElement("strong", null, "反馈"), feedbackDone ? R.createElement("div", null, R.createElement("p", { style: styles.muted }, "已收到，感谢反馈。"), R.createElement("p", { style: styles.muted }, `反馈编号：${feedbackDone}`), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.primary,
						onClick: () => setFeedbackOpen(false)
					}, "知道了"))) : R.createElement("div", null, R.createElement("div", { style: styles.row }, R.createElement("span", null, "类型"), R.createElement("select", {
						value: feedbackType,
						onChange: (event) => setFeedbackType(String(event.target.value ?? "design")),
						style: {
							padding: "6px 8px",
							border: "1px solid #d0d7de",
							borderRadius: 6,
							fontSize: 12,
							width: "100%",
							boxSizing: "border-box"
						}
					}, R.createElement("option", { value: "design" }, "设计建议"), R.createElement("option", { value: "feature" }, "功能建议"), R.createElement("option", { value: "bug" }, "问题"), R.createElement("option", { value: "other" }, "其他"))), R.createElement("textarea", {
						value: feedbackContent,
						placeholder: "请描述你的建议或问题（提交内容运营方可见，请勿填写密码/密钥）",
						rows: 5,
						style: {
							padding: "6px 8px",
							border: "1px solid #d0d7de",
							borderRadius: 6,
							fontSize: 12,
							width: "100%",
							boxSizing: "border-box"
						},
						onChange: (event) => {
							setFeedbackContent(String(event.target.value ?? ""));
							saveDraft();
						}
					}), R.createElement("input", {
						value: feedbackContact,
						placeholder: "联系方式（可选）",
						style: {
							padding: "6px 8px",
							border: "1px solid #d0d7de",
							borderRadius: 6,
							fontSize: 12,
							width: "100%",
							boxSizing: "border-box"
						},
						onChange: (event) => {
							setFeedbackContact(String(event.target.value ?? ""));
							saveDraft();
						}
					}), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.primary,
						disabled: feedbackBusy || !feedbackContent.trim(),
						onClick: submitFeedback
					}, feedbackBusy ? "提交中…" : "提交"), R.createElement("button", {
						style: styles.secondary,
						onClick: () => setFeedbackOpen(false)
					}, "取消"))))) : null, feedbackResult ? R.createElement("div", {
						style: styles.overlay,
						onClick: () => setFeedbackResult(null)
					}, R.createElement("div", {
						style: styles.dialog,
						onClick: (event) => event.stopPropagation?.()
					}, R.createElement("strong", null, feedbackResult.ok ? "提交成功" : "提交失败"), R.createElement("p", { style: styles.muted }, feedbackResult.message), R.createElement("div", { style: styles.actions }, R.createElement("button", {
						style: styles.primary,
						onClick: () => setFeedbackResult(null)
					}, "知道了")))) : null);
				}
				function UserSyncStatusSection() {
					const [status, setStatus] = R.useState(null);
					const [error, setError] = R.useState(null);
					R.useEffect(() => {
						let alive = true;
						fetchJson(`${API}/status`).then((data) => {
							if (alive) setStatus(data);
						}).catch((err) => {
							if (!alive) return;
							setError(String(err?.message ?? err));
						});
						return () => {
							alive = false;
						};
					}, []);
					if (error) return R.createElement("div", { style: styles.row }, `同步状态读取失败：${error}`);
					if (!status) return R.createElement("div", { style: styles.row }, "加载中…");
					const account = status.account?.paired ? `已配对 · ${status.account.hint ?? ""}` : "未登录官方账号";
					const scheduler = status.scheduler ?? {};
					const decision = scheduler.lastDecision;
					const checkLabel = decision?.action && DECISION_LABELS[decision.action] ? DECISION_LABELS[decision.action] : "";
					const rows = [
						`账号：${account}`,
						`版本：${status.version ?? "—"}`,
						`服务地址：${status.baseUrl ?? "—"}`,
						scheduler.lastCheckAt ? `上次检查：${fmtTime(scheduler.lastCheckAt)}${checkLabel ? `（${checkLabel}）` : ""}` : "上次检查：无",
						decision?.action === "skip" ? "结论：本机已是最新" : "结论：本机有改动或远端有更新"
					];
					return R.createElement("div", null, ...rows.map((row) => R.createElement("div", { style: styles.row }, row)), R.createElement("p", { style: styles.muted }, "上传与同步请到「设置 → 设置同步」操作。"));
				}
				function apply(ctx) {
					const reportSlot = (message) => {
						fetchJson(`${API}/client-log`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ message })
						}).catch(() => {});
					};
					try {
						ctx.slots.inject("settings.section", () => ctx.slots.register({
							name: "settings.section",
							id: "user-sync",
							order: 50,
							label: "设置同步"
						}, UserSyncSection));
						ctx.slots.inject("plugins.bundle.config", () => {
							reportSlot("slot-injected plugins.bundle.config");
							return ctx.slots.register({
								name: "plugins.bundle.config",
								key: "@pandablessing/dsh-user-sync",
								inject: () => ({})
							}, (ownerProps) => {
								if (ownerProps?.view === "summary") return null;
								reportSlot("render plugins.bundle.config");
								return R.createElement(UserSyncStatusSection, {});
							});
						});
					} catch (error) {
						console.error("[dsh-user-sync] 面板注册失败", error);
					}
				}
				exports.apply = apply;
				exports.inject = ["slots"];
				return module.exports;
			}
		});
	} catch (error) {
		if (!String(error?.message ?? error).includes("duplicate factory registration")) throw error;
		console.warn("[dsh-user-sync] client bundle 已注册过，忽略重复注册");
	}
}
