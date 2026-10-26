#!/bin/sh
# dsh-profile-sync.sh — 在 macOS / Linux 上导出 DSH profile 配置，供 Windows 端导入。
#
# 用法:
#   ./dsh-profile-sync.sh --action export [--profile desktop] [--outdir .] [--root ~/.dsh]
#
# 背景:
#   DSH 官方没有账号级插件同步。插件是本机 profile 的「bundle 层 + 用户 patch 覆盖层」，
#   包本体由 pnpm 从 npm registry 装在本机。跨机器一致靠同步 profile 的声明文件实现。
#   DSH_HOME 默认 ~/.dsh（跨平台一致，可用环境变量 DSH_HOME 或 --root 覆盖）。
#
# 同步对象: package.json / cordis.patch.yml / cordis.yml / pnpm-workspace.yaml
# 不同步:   node_modules（按声明重装）、sessions 与 storages（本机状态）、.credentials.yaml（凭据）
#
# 哈希口径: 先把 CRLF 归一化为 LF 再算 SHA-256 —— 否则同一份配置在 macOS(LF) 与
#           Windows(CRLF) 上哈希不同，导入端会误判为「有差异」而反复覆盖。
#
# 依赖: 系统自带的 sh / shasum 或 sha256sum / zip。无需安装任何东西。

set -eu

SYNC_FILES="package.json cordis.patch.yml cordis.yml pnpm-workspace.yaml"
ACTION=export
PROFILE=desktop
OUTDIR=.
ROOT="${DSH_HOME:-$HOME/.dsh}"

while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="${2:-}"; shift 2 ;;
    --profile|-p) PROFILE="${2:-}"; shift 2 ;;
    --outdir|-o) OUTDIR="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ "$ACTION" != "export" ]; then
  echo "macOS/Linux 端当前只实现 export（导入请在 Windows 端用 dsh-profile-sync.ps1）" >&2
  exit 2
fi

# ---- 定位 sha256 工具（macOS 自带 shasum；Linux/Git Bash 常用 sha256sum）
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
else
  echo "找不到 shasum / sha256sum，无法计算校验和" >&2
  exit 1
fi

PROFILE_DIR="$ROOT/profiles/$PROFILE"
if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile 目录: $PROFILE_DIR" >&2
  echo "可用的 profile:" >&2
  ls -1 "$ROOT/profiles" 2>/dev/null >&2 || echo "  (无)" >&2
  exit 1
fi

hash_lf() { tr -d '\r' < "$1" | $SHA_CMD | awk '{print $1}'; }
stat_size() { wc -c < "$1" | tr -d ' '; }

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/dshsync-export.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT INT TERM

FILES_JSON=""
WARNINGS=""
COUNT=0

for name in $SYNC_FILES; do
  src="$PROFILE_DIR/$name"
  [ -f "$src" ] || continue
  cp "$src" "$STAGING/$name"
  h=$(hash_lf "$src")
  s=$(stat_size "$src")
  if [ "$COUNT" -gt 0 ]; then FILES_JSON="$FILES_JSON,"; fi
  FILES_JSON="$FILES_JSON{\"name\":\"$name\",\"sha256\":\"$h\",\"size\":$s}"
  COUNT=$((COUNT + 1))
  # 敏感值扫描：凭据应放在 .credentials.yaml，不该出现在 profile 里
  if grep -Eq 'sk-[A-Za-z0-9]{16,}|(api[_-]?key|token|secret)[[:space:]]*:[[:space:]]*"?[A-Za-z0-9_-]{20,}' "$src" 2>/dev/null; then
    WARNINGS="$WARNINGS$name "
  fi
done

if [ "$COUNT" -eq 0 ]; then
  echo "profile 目录下没有可同步的声明文件: $PROFILE_DIR" >&2
  exit 1
fi

# ---- 从 package.json 提取 bundles（够用即可，不做完整 JSON 解析）
BUNDLES=""
if [ -f "$PROFILE_DIR/package.json" ]; then
  BUNDLES=$(tr -d '\r\n' < "$PROFILE_DIR/package.json" |
    sed -n 's/.*"bundles"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' |
    tr -d '",' | tr -s ' ')
fi
BUNDLES_JSON=""
for b in $BUNDLES; do
  [ -n "$BUNDLES_JSON" ] && BUNDLES_JSON="$BUNDLES_JSON,"
  BUNDLES_JSON="$BUNDLES_JSON\"$b\""
done

MACHINE=$(hostname 2>/dev/null || echo unknown)
STAMP=$(date +%Y%m%d-%H%M)
PLATFORM=$(uname -s 2>/dev/null || echo unknown)

{
  printf '{\n'
  printf '  "schemaVersion": 2,\n'
  printf '  "hashMode": "lf",\n'
  printf '  "exportedAt": "%s",\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf '  "machine": "%s",\n' "$MACHINE"
  printf '  "platform": "%s",\n' "$PLATFORM"
  printf '  "profile": "%s",\n' "$PROFILE"
  printf '  "bundles": [%s],\n' "$BUNDLES_JSON"
  printf '  "dependencies": [],\n'
  printf '  "files": [%s]\n' "$FILES_JSON"
  printf '}\n'
} > "$STAGING/manifest.json"

mkdir -p "$OUTDIR"
OUTDIR_ABS=$(cd "$OUTDIR" && pwd)
ZIP_PATH="$OUTDIR_ABS/dsh-profile-$PROFILE-$STAMP.zip"
rm -f "$ZIP_PATH"

if command -v zip >/dev/null 2>&1; then
  # -X: 不写入多余的扩展属性，避免 Windows 端解出噪音文件
  (cd "$STAGING" && zip -q -X -r "$ZIP_PATH" .)
else
  echo "找不到 zip 命令，无法打包" >&2
  exit 1
fi

echo "✅ 已导出: $ZIP_PATH"
echo "   profile : $PROFILE  ($ROOT)"
echo "   平台    : $PLATFORM / $MACHINE"
echo "   文件    : $COUNT 个 -> $(echo $SYNC_FILES | tr ' ' ',')"
if [ -n "$BUNDLES_JSON" ]; then echo "   bundles : $BUNDLES"; else echo "   bundles : (未解析到)"; fi
if [ -n "$WARNINGS" ]; then
  echo "⚠️  以下文件疑似含明文密钥，请确认后再跨机传输: $WARNINGS"
else
  echo "   ✓ 未发现明文密钥"
fi
echo ""
echo "下一步：把该 zip 拷到 Windows，执行"
echo "  .\\dsh-profile-sync.ps1 -Action Import -Package \"$(basename "$ZIP_PATH")\" -WhatIf"
