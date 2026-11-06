#!/usr/bin/env python3
"""腾讯云部署：打包 → 上传 → 解压 → 重启 → 验证。

用法：
    python scripts/deploy.py server        # 只部署插件服务端（dist 重启）
    python scripts/deploy.py front         # 只部署后台前端（dist 替换）
    python scripts/deploy.py all           # 两者都部署
    python scripts/deploy.py all --dry-run # 只打包，不上传

远端操作执行前须经用户弹窗确认（agent 侧约定）；本脚本只负责执行动作。
依赖：系统 ssh / scp（~/.ssh/config 中配置的目标主机）。
"""
from __future__ import annotations

import os
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADMIN_DIR = Path(os.environ.get("DSH_ADMIN_DIR", r"H:\work\go\dsh-admin"))
HOST = os.environ.get("DSH_DEPLOY_HOST", "Cicada-Tencent-Dev")
SERVER_DIR = "/data/server/dsh-user-sync"
ADMIN_REMOTE_DIR = "/data/server/dsh-admin"
ADMIN_KEY = os.environ.get("DSH_SYNC_ADMIN_KEY", "36ad1b67d884df76dd081fbe714f6bfa28605f544dd5df4dad2b1eeb35f62c8d")


def run(command: list[str], cwd: Path | None = None, timeout: int = 900) -> str:
    proc = subprocess.run(command, cwd=str(cwd) if cwd else None, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"命令失败（{proc.returncode}）：{' '.join(command)}\n{(proc.stdout + proc.stderr)[-800:]}")
    return proc.stdout


def make_tar(source: Path, target: Path) -> Path:
    with tarfile.open(target, "w:gz") as archive:
        archive.add(source, arcname=source.name)
    print(f"  打包 {target.name}（{target.stat().st_size / 1024:.1f} KB）")
    return target


def deploy_server(dry_run: bool) -> None:
    target = Path(tempfile.gettempdir()) / "dsh-server-dist.tar.gz"
    make_tar(ROOT / "server" / "dist", target)
    if dry_run:
        return
    run(["scp", "-o", "BatchMode=yes", str(target), f"{HOST}:/tmp/dsh-server-dist.tar.gz"])
    print("  已上传，远端解压并重启…")
    script = f"""
set -e
cd {SERVER_DIR}
cp -r app /tmp/dsh-app-backup-$(date +%s)
rm -rf app && mkdir -p app
tar -xzf /tmp/dsh-server-dist.tar.gz -C app --strip-components=1
printf '{{\"type\":\"module\"}}\\n' > app/package.json
systemctl restart dsh-user-sync
sleep 3
systemctl is-active dsh-user-sync
curl -s -o /dev/null -w 'health: %{{http_code}}\\n' http://127.0.0.1:10001/v1/health
"""
    print(run(["ssh", "-o", "BatchMode=yes", HOST, script]))


def deploy_front(dry_run: bool) -> None:
    target = Path(tempfile.gettempdir()) / "dsh-admin-dist.tar.gz"
    make_tar(ADMIN_DIR / "front" / "dist", target)
    if dry_run:
        return
    run(["scp", "-o", "BatchMode=yes", str(target), f"{HOST}:/tmp/dsh-admin-dist.tar.gz"])
    print("  已上传，远端替换 dist…")
    script = f"""
set -e
cd {ADMIN_REMOTE_DIR}
cp -r dist /tmp/dsh-admin-dist-backup-$(date +%s)
rm -rf dist && tar -xzf /tmp/dsh-admin-dist.tar.gz -C .
curl -s -o /dev/null -w 'admin: %{{http_code}}\\n' https://dsh-admin.wenzhi.info/
"""
    print(run(["ssh", "-o", "BatchMode=yes", HOST, script]))


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "all"
    dry_run = "--dry-run" in sys.argv
    if dry_run:
        print("dry-run：只打包，不上传")
    if action in {"server", "all"}:
        print("部署插件服务端：")
        deploy_server(dry_run)
    if action in {"front", "all"}:
        print("部署后台前端：")
        deploy_front(dry_run)
    print("完成。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
