# 需求反馈：支持账号级插件与配置同步（多设备一致性）

> 提交渠道：DSH 账号菜单 →「意见反馈」（官方飞书问卷）／ 备选：GitHub Discussions（deepseek-ai/deepseek-harness）
> 反馈环境：DeepSeek Harness **0.2.0-rc.2**（nightly，win-x64）＋ 另一台 macOS 设备，同一账号

---

## 一、需求背景（真实场景）

同一 DeepSeek 账号在两台设备上使用 DSH：**macOS 上收集/配置，Windows 上同步使用**。
在 mac 上配好的插件与偏好（provider、默认模型、UI 设置等），切到 Windows 后全部缺失，需要逐项重配；反向亦然。
期望：**同账号设备之间，插件与配置能够一键对齐**，或至少提供官方认可的导入/导出能力。

## 二、现状核查（在 0.2.0-rc.2 上实测）

1. **插件构成**：profile = 「有序的 plugin-bundle 补丁层 + 用户覆盖层」；包本体由 pnpm 从 npm registry 安装，全部落在本机 `$DSH_HOME/profiles/<profile>/`。
2. **账号只承载身份**：`.credentials.yaml` 中只有 `device` 与 `token` 类记录，没有配置/插件同步载荷。
3. **应用内无同步实现**：在 116MB 应用代码中检索 `账号同步／设置同步／云同步／syncAccount／accountSync／profileSync／settingsSync` 等 12 个关键词，**全部未命中**。
4. **CLI 无法代管桌面 profile**：执行 `dsh --profile desktop --dump-config` / `--patch` 均被拒，报 `profile "desktop" is managed exclusively by the Electron application`。
5. **结论**：多设备一致性目前只能靠用户手工拷贝 profile 声明文件，无官方手段。

## 三、痛点

1. **重复配置成本高、易漂移**：每台设备都要重装/重配一遍，且无从判断哪台是最新。
2. **缺少官方一致性校验**：没有「差异在哪、谁为准」的可视化手段。
3. **跨平台隐藏坑**：同一份配置在 macOS(LF) 与 Windows(CRLF) 下字节不同，朴素哈希比对会误判为「有改动」并反复覆盖，手工同步极易踩。
4. **凭据边界不清晰**：API key、登录态**不应**同步，但缺少明确指引告诉用户「哪些会跟着走、哪些必须各设备单独配」。
5. **桌面 profile 独占管理**：使第三方脚本无法借助官方 CLI 完成对齐，只能绕开（直接改文件）。

## 四、建议方案（按优先级）

### P0 — 官方导入/导出能力
- 新增 `dsh profile export` / `dsh profile import`：产出带**版本信息与逐文件校验和**的配置包。
- 为 Electron 独占管理的 profile 提供 GUI 侧入口（如 设置 → 插件 → 导出/导入配置）。
- **比对口径跨平台稳定**（例如换行归一化后再计算校验和），避免 CRLF/LF 误判为变更。

### P1 — 账号级插件清单同步（可选开关，默认关闭）
- 同步内容：bundle 列表 + 用户层 patch 配置。
- 明确排除：凭据、会话记录、本机路径相关状态（`sessions/`、`storages/`、`.credentials.yaml`）。
- 冲突策略：以设备为单位手动「拉取 / 推送」，不做隐式覆盖，冲突时给出差异预览。

### P2 — 多设备体验
- 账号页展示已登录设备列表，支持「把配置应用到本设备」。
- 提供差异视图：哪些插件、哪些配置项不同。

### 安全与可审计（贯穿各阶段）
- 同步载荷必须可见、可导出、可撤销；凭据永不进入同步内容。
- 依赖环境变量的 provider（如 `XXX_API_KEY`）在目标设备缺失时给出明确提示，避免「插件装了但用不了」。

## 五、附：用户侧临时方案（可作参考原型）

为解燃眉之急，已自建两个脚本（mac 导出 / Windows 导入），要点：

- **同步 4 个声明文件**：`package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml`
- **配置包**：zip + `manifest.json`（schemaVersion / hashMode / 每个文件 SHA-256 / bundles / 平台）
- **跨平台哈希口径**：删除所有 CR 字节后再算 SHA-256 —— 实测使「仅换行不同的同一配置」被正确判为**内容等价、无需改动**
- **导入策略**：先校验校验和 → 差异预览 → 自动备份 → 仅改写确有差异的文件（幂等）
- **实测结果**：mac 生成的包在 Windows 导入后，目标文件字节哈希与源机完全一致；全新机器（profile 目录不存在）可自动创建

## 六、期望回应

1. 该能力是否已在路线图中？预计形态与时间点？
2. 若短期不做，官方推荐的多设备工作流是什么（手工拷贝 / 第三方工具 / 暂不支持）？
3. 桌面 profile 的独占管理是否会开放 CLI 或有官方自动化入口？
