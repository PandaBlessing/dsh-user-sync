// 本地调试数据：起常驻服务端（10001，local storage），用本机真实资产打一个包并上传。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createSync } from "../lib/sync.js";
import { createApiTransport } from "../lib/transport/api.js";

const root = join(tmpdir(), "dsh-admin-debug");
const dataDir = join(root, "data");
const baseUrl = "http://127.0.0.1:10001";
const accountKey = "5e15a3a9c3b7d2e1";

mkdirSync(dataDir, { recursive: true });
const health = await fetch(`${baseUrl}/v1/health`).then((r) => r.ok).catch(() => false);
if (!health) {
  spawn(process.execPath, [join(import.meta.dirname, "..", "server", "dist", "index.js")], {
    env: { ...process.env, DSH_SYNC_PORT: "10001", DSH_SYNC_DATA: dataDir, DSH_SYNC_SECRETS: join(root, "secrets.json") },
    stdio: "ignore",
    detached: true,
  }).unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await fetch(`${baseUrl}/v1/health`).then((r) => r.ok).catch(() => false)) break;
  }
}
console.log("服务端:", (await fetch(`${baseUrl}/v1/health`)).status);

const transport = createApiTransport({ baseUrl, authPath: join(root, "auth.json") });
await transport.register(accountKey);
const sync = createSync({
  dshHome: join(homedir(), ".dsh"),
  userHome: homedir(),
  profileName: "desktop",
  transport,
  statePath: join(root, "state.json"),
  historyPath: join(root, "history.jsonl"),
  lockPath: join(root, "lock"),
  preRestoreRoot: join(root, "pre-restore"),
});
const result = await sync.upload();
console.log("上传:", result.ok ? `ok ${result.packageId} files=${result.manifest.files.length}` : JSON.stringify(result).slice(0, 300));
process.exit(result.ok ? 0 : 1);
