#!/usr/bin/env python3
"""npm 发布：npm-cli 直发 + registry 验证（替代 publish.mjs）。

用法：
    python scripts/publish.py              # 发布当前版本
    python scripts/publish.py --dry-run    # 只打包校验
    python scripts/publish.py --otp=123456

token 优先级：NPM_TOKEN → .env.local → H:/work/dsh/npm-token.txt（可用 DSH_NPM_TOKEN_FILE 覆盖）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("DSH_NODE_BIN", r"C:\Users\panda\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe")
NPM_CLI_CANDIDATES = [
    os.environ.get("npm_execpath", ""),
    r"G:\Program Files (x86)\Nodejs\node_modules\npm\bin\npm-cli.js",
    r"C:\Program Files (x86)\Nodejs\node_modules\npm\bin\npm-cli.js",
    r"C:\Program Files\Nodejs\node_modules\npm\bin\npm-cli.js",
]
TOKEN_FILE = Path(os.environ.get("DSH_NPM_TOKEN_FILE", r"H:\work\token\npm_token.txt"))
REGISTRY = os.environ.get("NPM_REGISTRY", "https://registry.npmjs.org/")


def read_token() -> str:
    token = os.environ.get("NPM_TOKEN", "")
    if token:
        return token
    env_local = ROOT / ".env.local"
    if env_local.exists():
        match = re.search(r"^\s*NPM_TOKEN\s*=\s*(.+)$", env_local.read_text(encoding="utf-8"), re.MULTILINE)
        if match:
            return match.group(1).strip().strip('"').strip("'")
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    return ""


def find_npm_cli() -> str | None:
    for candidate in NPM_CLI_CANDIDATES:
        if candidate and candidate.endswith("npm-cli.js") and Path(candidate).exists():
            return candidate
    return None


def registry_tag(name: str, tag: str) -> str | None:
    url = f"{REGISTRY.rstrip('/')}/{name.replace('/', '%2F')}?t={int(time.time())}"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
        return data.get("dist-tags", {}).get(tag)
    except Exception:  # noqa: BLE001 - 轮询期间忽略网络波动
        return None


def main() -> int:
    args = sys.argv[1:]
    dry_run = "--dry-run" in args
    otp = next((value.split("=", 1)[1] for value in args if value.startswith("--otp=")), os.environ.get("NPM_OTP", ""))
    tag = next((value.split("=", 1)[1] for value in args if value.startswith("--tag=")), "latest")

    token = read_token()
    if not token:
        print("缺少 npm token：设置 NPM_TOKEN / .env.local / H:/work/dsh/npm-token.txt")
        return 1
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    npm_cli = find_npm_cli()
    if not npm_cli:
        print("找不到 npm-cli.js（可用 DSH_NODE_BIN/npm 路径调整）")
        return 1

    config_dir = Path(tempfile.mkdtemp(prefix="dsh-publish-"))
    npmrc = config_dir / ".npmrc"
    host = urllib.request.urlparse(REGISTRY).hostname if hasattr(urllib.request, "urlparse") else REGISTRY.split("//")[-1].split("/")[0]
    npmrc.write_text(f"registry={REGISTRY}\n//{host}/:_authToken={token}\n", encoding="utf-8")
    print(f"发布 {package['name']}@{package['version']} → {REGISTRY}（tag: {tag}{'，dry-run' if dry_run else ''}）")

    command = [NODE, npm_cli, "publish", "--registry", REGISTRY, "--tag", tag]
    if otp:
        command += ["--otp", otp]
    if dry_run:
        command.append("--dry-run")
    env = {**os.environ, "npm_config_userconfig": str(npmrc)}
    proc = subprocess.run(command, cwd=str(ROOT), env=env)
    config_dir_exists = config_dir.exists()
    if config_dir_exists:
        for item in config_dir.iterdir():
            item.unlink(missing_ok=True)
        config_dir.rmdir()
    if dry_run:
        return proc.returncode
    if proc.returncode != 0:
        print("发布失败：若报 409/previously staged，请到 npm 网页确认或删除该版本，不要直接换版本号。")
        return proc.returncode

    for attempt in range(12):
        time.sleep(10)
        current = registry_tag(package["name"], tag)
        if current == package["version"]:
            print(f"确认完成：{package['name']}@{package['version']} 已是 {tag}（registry 验证通过）。")
            return 0
        print(f"等待 registry 生效…（第 {attempt + 1} 次，latest={current or '未知'}）")
    print("发布命令成功但 registry 未指向本次版本（可能仍 staged），请到网页确认。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
