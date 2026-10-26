# 测试 fixture

> 只放**样本数据**，不放测试代码。用例定义见 [docs/test-cases.md](../../docs/test-cases.md) §1。
> 本目录的 `.gitattributes` 用 `* -text` 关闭换行符转换，保证 `fx-crlf` 的 CRLF 字节不被改写。

## 结构约定

每个 fixture 用两个子目录模拟两个根：

```text
<fx-name>/
  dsh-home/          ← 伪 DSH_HOME（profiles/、memories/、sessions/、storages/、AGENTS.md）
  user-home/         ← 伪 userHome（.agents/skills/）
```

## 清单

| fixture | 用途 | 关键特征 |
|---|---|---|
| `fx-minimal` | 最小可扫描集 | profile 四件套 + `AGENTS.md` + `memories/MEMORY.md`；无技能、无项目记忆 |
| `fx-full` | 全模块扫描 | 在 minimal 基础上加 `pnpm-lock.yaml`、`memories/USER.md`、`projects/<hash>/TODOS.md`、`daily/`、`sessions/`、`storages/`、`user-home/.agents/skills/{foo,bar}` |
| `fx-crlf` | 换行等价 | 与 `fx-minimal` 内容相同，全部 CRLF；用于 HASH-01 |
| `fx-secret` | 敏感扫描 | `cordis.patch.yml` 含 `sk-` 明文、`.credentials.yaml`、`memories/id_rsa`；用于 SEC-01/02/03 |
| `fx-v2` | 旧包兼容 | 原型脚本的 `schemaVersion: 2` 包：`manifest.json` + `package.json` + `cordis.patch.yml`，`files[].name` 字段；用于 ARCH-03/04 |

## 维护规则

1. **不写测试结果**：结果只进 `docs/test-results/`。
2. **不改 `.gitattributes`**：`* -text` 是 fixture 有效性的前提。
3. **新增 fixture 先改用例**：在 [docs/test-cases.md](../../docs/test-cases.md) §1 登记用途，再建目录。
4. **符号链接不预置进仓库**：Windows 上创建符号链接需要权限，符号链接相关用例（SCAN-07/08）在测试里用临时目录动态创建。
5. **`fx-v2` 的哈希是真实计算的**（删 `0x0D` 后 SHA-256）；改文件内容必须重算 `manifest.json`。
