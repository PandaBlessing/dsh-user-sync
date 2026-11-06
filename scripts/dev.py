#!/usr/bin/env python3
"""本地开发服务一键管理（Python 脚本，替代重复敲命令）。

用法：
    python scripts/dev.py start      # 启动 3306 / 10001 / 10002 / 9527 并等待就绪
    python scripts/dev.py stop       # 停止这四类服务
    python scripts/dev.py status     # 查看端口与健康状态
    python scripts/dev.py restart

说明：
- 只用标准库（subprocess / socket / urllib / json）；
- 9527 由 vite 启动，监听可能在 IPv6，检测时同时试 localhost 与 127.0.0.1；
- 各服务日志写到 %TEMP%\\dsh-local\\*.log，启动失败时打印日志尾部。
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("DSH_NODE_BIN", r"C:\Users\panda\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe")
PNPM = os.environ.get("DSH_PNPM_BIN", r"C:\Users\panda\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs")
ADMIN_DIR = Path(os.environ.get("DSH_ADMIN_DIR", r"H:\work\go\dsh-admin"))
FRONT_DIR = ADMIN_DIR / "front"
ADMIN_KEY = os.environ.get("DSH_SYNC_ADMIN_KEY", "36ad1b67d884df76dd081fbe714f6bfa28605f544dd5df4dad2b1eeb35f62c8d")
DEBUG_ROOT = Path(tempfile.gettempdir()) / "dsh-admin-debug"
LOG_DIR = Path(tempfile.gettempdir()) / "dsh-local"
MYSQLD = os.environ.get("DSH_MYSQLD", r"C:\Program Files\MariaDB 11.4\bin\mysqld.exe")

PORTS = {"mysql": 3306, "plugin-server": 10001, "admin-backend": 10002, "admin-frontend": 9527}


def log(message: str) -> None:
    print(message, flush=True)


def port_open(port: int, host: str = "127.0.0.1") -> bool:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(1.0)
        try:
            return sock.connect_ex((host, port)) == 0
        except OSError:
            return False


def any_port_open(port: int) -> bool:
    return port_open(port, "127.0.0.1") or port_open(port, "::1")


def wait_until(pending: dict[str, int], timeout: float) -> None:
    """并行等待多个端口就绪（间隔 0.5s），全部就绪或超时后返回。"""
    if not pending:
        return
    deadline = time.time() + timeout
    while time.time() < deadline:
        for name in list(pending):
            if any_port_open(pending[name]):
                log(f"  {name} 就绪（{pending[name]}）")
                pending.pop(name)
        if not pending:
            return
        time.sleep(0.5)
    for name, port in pending.items():
        log(f"  {name} 超时未就绪（{port}）")


def start_background(command: list[str], cwd: Path, log_name: str, env: dict | None = None) -> subprocess.Popen:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / log_name
    handle = open(log_path, "w", encoding="utf-8", errors="replace")
    return subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=handle,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        env={**os.environ, **(env or {})},
    )


def tail(path: Path, lines: int = 12) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return ""


def start() -> int:
    PORTS_OPEN = {name: any_port_open(port) for name, port in PORTS.items()}
    log("当前端口状态：")
    for name, port in PORTS.items():
        log(f"  {name:<14} {port}  {'已启动' if PORTS_OPEN[name] else '未启动'}")

    # 先全部并发拉起，再统一等待（比逐个等待快得多）
    pending: dict[str, int] = {}
    if not PORTS_OPEN["mysql"]:
        start_background([MYSQLD, "--console"], ROOT, "mysql.log")
        pending["MySQL"] = PORTS["mysql"]
    if not PORTS_OPEN["plugin-server"]:
        start_background(
            [NODE, str(ROOT / "server" / "dist" / "index.js"), str(ROOT)],
            ROOT,
            "plugin-server.log",
            env={
                "DSH_SYNC_PORT": "10001",
                "DSH_SYNC_DATA": str(DEBUG_ROOT / "data"),
                "DSH_SYNC_SECRETS": str(DEBUG_ROOT / "secrets.json"),
            },
        )
        pending["插件服务端"] = PORTS["plugin-server"]
    if not PORTS_OPEN["admin-backend"]:
        start_background(
            ["go", "run", ".", "server", "-c", "config/settings.local.dev.yml"],
            ADMIN_DIR / "end",
            "admin-backend.log",
            env={"GOFLAGS": "-mod=mod", "DSH_SYNC_ADMIN_KEY": ADMIN_KEY},
        )
        pending["后台后端"] = PORTS["admin-backend"]
    if not PORTS_OPEN["admin-frontend"]:
        start_background([NODE, PNPM, "dev"], FRONT_DIR, "admin-frontend.log")
        pending["后台前端"] = PORTS["admin-frontend"]

    if pending:
        log("等待服务就绪…")
        wait_until(pending, timeout=90)
    return status()


def stop() -> int:
    stopped = 0
    for name, port in PORTS.items():
        for proc in find_pids(port):
            try:
                subprocess.run(["taskkill", "/PID", str(proc), "/F"], capture_output=True)
                stopped += 1
            except OSError:
                pass
        log(f"  {name:<14} {port}  {'已停止' if not any_port_open(port) else '仍在运行'}")
    log(f"共停止 {stopped} 个进程")
    return 0


def find_pids(port: int) -> list[int]:
    result = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True)
    pids = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[1].endswith(f":{port}") and "LISTEN" in line.upper():
            try:
                pids.add(int(parts[-1]))
            except ValueError:
                pass
    return sorted(pids)


def status() -> int:
    ok = True
    log("服务状态：")
    for name, port in PORTS.items():
        open_ = any_port_open(port)
        ok = ok and open_
        log(f"  {name:<14} {port}  {'✅ 运行中' if open_ else '❌ 未运行'}")

    try:
        with urllib.request.urlopen("http://127.0.0.1:10001/v1/health", timeout=5) as res:
            health = json.loads(res.read().decode("utf-8"))
        log(f"  插件健康        ok={health.get('ok')} storage={health.get('storage')}")
    except Exception as error:  # noqa: BLE001 - 状态检查不抛出
        log(f"  插件健康        ❌ {error}")
        ok = False

    try:
        with urllib.request.urlopen("http://localhost:9527/", timeout=5):
            log("  后台前端        ✅ HTTP 200")
    except Exception as error:  # noqa: BLE001
        log(f"  后台前端        ❌ {error}")
        ok = False

    log(f"\n后台地址：http://localhost:9527/（admin / 123456）")
    log(f"插件地址：http://127.0.0.1:10001/v1/health")
    return 0 if ok else 1


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if action == "start":
        return start()
    if action == "stop":
        return stop()
    if action == "restart":
        stop()
        return start()
    if action == "status":
        return status()
    log(f"未知命令: {action}（可用：start / stop / restart / status）")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
