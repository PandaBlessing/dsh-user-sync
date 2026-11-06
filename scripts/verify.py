#!/usr/bin/env python3
"""本地完整验证：构建 → 全量测试 → 接口验证 → 写 TESTREPORT.md。

用法：
    python scripts/verify.py            # 全部步骤
    python scripts/verify.py --skip-build   # 跳过构建（只跑测试与接口）

退出码：0 全部通过；1 有失败。
"""
from __future__ import annotations

import json
import os
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
ADMIN_KEY = os.environ.get("DSH_SYNC_ADMIN_KEY", "36ad1b67d884df76dd081fbe714f6bfa28605f544dd5df4dad2b1eeb35f62c8d")
REPORT = ROOT / "TESTREPORT.md"

results: list[dict] = []


def step(name: str, fn) -> bool:
    started = time.time()
    try:
        detail = fn()
        ok = True
    except Exception as error:  # noqa: BLE001 - 报告需要任何异常
        detail = str(error)
        ok = False
    elapsed = round(time.time() - started, 1)
    results.append({"step": name, "ok": ok, "detail": str(detail)[:300], "seconds": elapsed})
    print(f"{'✅' if ok else '❌'} {name}（{elapsed}s）", flush=True)
    if not ok:
        print(f"   {detail}", flush=True)
    return ok


def run(command: list[str], cwd: Path, timeout: int = 600) -> str:
    proc = subprocess.run(command, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = "\n".join((proc.stdout + proc.stderr).splitlines()[-15:])
        raise RuntimeError(f"退出码 {proc.returncode}：\n{tail}")
    return "ok"


def tsc(root: Path, tsconfig: str) -> str:
    tsc_js = ROOT / "node_modules" / "typescript" / "bin" / "tsc"
    return run([NODE, str(tsc_js), "-p", tsconfig], root)


def http_json(url: str, headers: dict | None = None) -> dict:
    request = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def build_plugin() -> str:
    return tsc(ROOT, "tsconfig.json")


def build_server() -> str:
    return tsc(ROOT / "server", "tsconfig.json")


def build_frontend() -> str:
    return run([NODE, str(PNPM), "build:prod"], ADMIN_DIR / "front", timeout=900)


def tests() -> str:
    proc = subprocess.run([NODE, "--test", "test/*.test.js"], cwd=str(ROOT), capture_output=True, text=True, timeout=900)
    output = proc.stdout + proc.stderr
    summary = [line for line in output.splitlines() if line.startswith("ℹ ")]
    if proc.returncode != 0 or any("fail 0" not in line for line in summary if "fail" in line):
        tail = "\n".join(output.splitlines()[-15:])
        raise RuntimeError(f"测试失败：\n{tail}")
    return " / ".join(summary)


def api_checks() -> str:
    health = http_json("http://127.0.0.1:10001/v1/health")
    if not health.get("ok"):
        raise RuntimeError(f"10001 健康检查失败：{health}")
    request = urllib.request.Request(
        "http://127.0.0.1:10001/v1/admin/agents-export",
        headers={"authorization": f"Bearer {ADMIN_KEY}"},
    )
    try:
        urllib.request.urlopen(request, timeout=10)
        export_status = "200"
    except urllib.error.HTTPError as error:
        export_status = str(error.code)
    if export_status not in {"200", "404"}:
        raise RuntimeError(f"agents-export 异常状态：{export_status}")
    return f"health=ok agents-export={export_status}"


def main() -> int:
    skip_build = "--skip-build" in sys.argv
    if not skip_build:
        step("构建：插件 tsc", build_plugin)
        step("构建：服务端 tsc", build_server)
        step("构建：后台前端 build:prod", build_frontend)
    step("测试：全量 node --test", tests)
    step("接口：10001 health + agents-export", api_checks)

    passed = sum(1 for item in results if item["ok"])
    lines = [
        "# 测试报告",
        "",
        f"- 生成时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"- 结果：{passed}/{len(results)} 通过",
        "",
        "| 步骤 | 结果 | 耗时(s) | 详情 |",
        "|---|---|---|---|",
    ]
    for item in results:
        detail = item["detail"].replace("|", "\\|").replace("\n", " ")
        lines.append(f"| {item['step']} | {'✅ 通过' if item['ok'] else '❌ 失败'} | {item['seconds']} | {detail} |")
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n报告已写入 {REPORT}")
    print(f"结果：{passed}/{len(results)} 通过")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
