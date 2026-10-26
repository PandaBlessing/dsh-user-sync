# 服务端部署（Cicada-Tencent-Dev）

> 目标：把 `server/` 部署到腾讯云服务器，供插件以 `api` 传输访问。
> 本文件只写「现在怎么部署、怎么验证」，不写过程踩坑史；命令均在本机实测通过。

## 1. 拓扑

```text
插件（HTTPS） ──▶ nginx 443（dsh-user-sync-test.wenzhi.info）
                     │
                     └─▶ 127.0.0.1:9301  node server/dist/index.js
                              │
                              ├─ 元数据：/data/server/dsh-user-sync/data（accounts/packages/audit）
                              └─ 包本体：坚果云 WebDAV（未配凭据时回退 data/packages 本地磁盘）
```

## 2. 服务器上的固定值

| 项 | 值 |
|---|---|
| 部署目录 | `/data/server/dsh-user-sync`（`app/` 代码、`data/` 元数据、`logs/`、`runtime/` Node） |
| Node | `runtime/node/bin/node`（v22.11.0，官方 tar 解压，不依赖系统包） |
| 监听 | `127.0.0.1:9301`（只被 nginx 反代，不直接对公网） |
| 域名 | `dsh-user-sync-test.wenzhi.info`（证书复用 `/etc/nginx/ssl.key/fullchain.pem`，通配 `*.wenzhi.info`） |
| systemd | `dsh-user-sync.service` |
| nginx | `/etc/nginx/conf.d/dsh-user-sync-test.wenzhi.info.conf` |

## 3. 首次部署（已验证）

```bash
# 1) 目录
mkdir -p /data/server/dsh-user-sync/{app,data,logs,runtime}

# 2) 代码（本机先构建，再打包 server/ 的产物后上传）
#    源码在 server/src/*.ts；服务器不跑构建，只上传构建结果。
#    本机：pnpm run build:server   → server/dist/*.js
tar -czf /tmp/dsh-user-sync-server.tar.gz -C server dist
scp /tmp/dsh-user-sync-server.tar.gz Cicada-Tencent-Dev:/tmp/
# 服务器上（dist 内容直接放 app 根，并声明 ESM）：
rm -rf /data/server/dsh-user-sync/app && mkdir -p /data/server/dsh-user-sync/app
tar -xzf /tmp/dsh-user-sync-server.tar.gz -C /data/server/dsh-user-sync/app --strip-components=1
printf '{"type":"module"}\n' > /data/server/dsh-user-sync/app/package.json

# 3) Node（官方 tar，不装系统包）
cd /data/server/dsh-user-sync/runtime
curl -fsSL -o node.tar.xz https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-linux-x64.tar.xz
tar -xJf node.tar.xz && mv node-v22.11.0-linux-x64 node && rm -f node.tar.xz

# 4) 配置（凭据见 §4）
cat > /data/server/dsh-user-sync/secrets.json <<'EOF'
{
  "port": 9301,
  "webdav": { "baseUrl": "https://dav.jianguoyun.com/dav/", "username": "", "password": "" },
  "quotaPackageBytes": 10485760,
  "quotaTotalBytes": 52428800
}
EOF
chmod 600 /data/server/dsh-user-sync/secrets.json

# 5) systemd
cat > /etc/systemd/system/dsh-user-sync.service <<'EOF'
[Unit]
Description=dsh-user-sync API
After=network.target

[Service]
Type=simple
WorkingDirectory=/data/server/dsh-user-sync/app
ExecStart=/data/server/dsh-user-sync/runtime/node/bin/node /data/server/dsh-user-sync/app/index.js /data/server/dsh-user-sync
Restart=on-failure
RestartSec=3
Environment=DSH_SYNC_PORT=9301

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now dsh-user-sync

# 6) nginx（复用现有证书）
cat > /etc/nginx/conf.d/dsh-user-sync-test.wenzhi.info.conf <<'EOF'
server {
    listen 80;
    server_name dsh-user-sync-test.wenzhi.info;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name dsh-user-sync-test.wenzhi.info;
    ssl_certificate     /etc/nginx/ssl.key/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl.key/certkey.pem;
    client_max_body_size 12m;
    location / {
        proxy_pass http://127.0.0.1:9301;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
    }
}
EOF
nginx -t && systemctl reload nginx
```

## 4. 坚果云凭据（服务端持有，插件永不可见）

**凭据不要贴进对话**。在服务器上直接编辑：

```bash
vi /data/server/dsh-user-sync/secrets.json
```

填入坚果云账号（邮箱）与应用密码：

```json
{ "webdav": { "baseUrl": "https://dav.jianguoyun.com/dav/", "username": "你的坚果云邮箱", "password": "应用密码" } }
```

然后重启并确认 storage 变为 `webdav`：

```bash
systemctl restart dsh-user-sync
curl -s http://127.0.0.1:9301/v1/health
# 期望：{"ok":true,"storage":"webdav",...}
```

凭据留空时服务仍可运行，包落在 `data/packages/`（本地磁盘回退）。

## 5. DNS

在腾讯云 DNSPod 添加记录：

| 主机记录 | 类型 | 值 |
|---|---|---|
| `dsh-user-sync-test` | A | `82.157.127.207` |

解析生效后，公网可直接访问 `https://dsh-user-sync-test.wenzhi.info/v1/health`。

## 6. 验证

```bash
HOST=dsh-user-sync-test.wenzhi.info
curl -kfsS --resolve $HOST:443:127.0.0.1 https://$HOST/v1/health
```

实测通过的完整链路（服务器本机执行）：

```bash
C="curl -kfsS --resolve $HOST:443:127.0.0.1"
TOKEN=$($C -X POST -H 'content-type: application/json' -d '{"accountKey":"0123456789abcdef"}' "https://$HOST/v1/auth/register" | sed -E 's/.*"token":"([^"]+)".*/\1/')
$C -X POST -H 'content-type: application/json' -d '{"accountKey":"0123456789abcdef"}' "https://$HOST/v1/auth/login"   # 同一个 token
$C -X PUT -H "authorization: Bearer $TOKEN" --data-binary @pkg.tar.gz "https://$HOST/v1/packages/<包名>.tar.gz"
$C -H "authorization: Bearer $TOKEN" "https://$HOST/v1/packages"
$C -H "authorization: Bearer $TOKEN" "https://$HOST/v1/packages/<包名>.tar.gz/meta"
$C -H "authorization: Bearer $TOKEN" "https://$HOST/v1/quota"
$C -X DELETE -H "authorization: Bearer $TOKEN" "https://$HOST/v1/me"
```

## 7. 插件侧配置

设置 → 设置同步 → 直接上传（传输固定走运营方 API，服务地址内置）：

```text
https://dsh-user-sync-test.wenzhi.info
```

保存后插件会用官方账号 `accountKey` 自动配对（无需登录运营方账号）。

## 9. 运营方监控接口（供 dsh-admin 等后台调用）

只读用量接口，用于监控坚果云占用与账号规模：

```text
GET /v1/admin/usage
Authorization: Bearer <secrets.json 的 adminKey>
```

响应（200；未配置 adminKey 返回 404 `admin-disabled`，密钥错误返回 401 `unauthorized`）：

```json
{
  "ok": true,
  "storage": "webdav",
  "storageTest": { "ok": true, "detail": "PROPFIND 207" },
  "quotaPackageBytes": 10485760,
  "quotaTotalBytes": 52428800,
  "accounts": 1,
  "totalBytes": 33837,
  "largest": [{ "accountHint": "5e15a3", "bytes": 33837, "packages": 1, "updatedAt": "2026-10-25T04:05:02.264Z" }],
  "webdav": true
}
```

- `accountHint` 只暴露 accountKey 前 6 位；
- 配置：在服务器 `secrets.json` 增加 `"adminKey": "<随机 32 字节 hex>"`，重启服务；建议按 `totalBytes / quotaTotalBytes` 与 `storageTest.ok` 做容量告警。


## 8. 运维

| 操作 | 命令 |
|---|---|
| 状态 | `systemctl status dsh-user-sync` |
| 日志 | `journalctl -u dsh-user-sync -n 100 --no-pager` |
| 审计 | `tail -20 /data/server/dsh-user-sync/data/audit.jsonl` |
| 改代码后 | 本机 `pnpm run build:server` 后重新上传 `server/dist`，`systemctl restart dsh-user-sync` |
| 备份 | `tar czf /data/backup/dsh-user-sync-$(date +%F).tar.gz -C /data/server/dsh-user-sync data secrets.json` |

## 端口约定（10000 号段）

| 服务 | 端口 | 说明 |
|---|---|---|
| dsh-user-sync 服务端 | **10001** | systemd DSH_SYNC_PORT=10001；仅监听 127.0.0.1，经 nginx 对外 |
| dsh-admin 管理后台 | **10002** | 前端 VUE_APP_BASE_API=http://localhost:10002 |
| 管理后台 → 服务端 | http://127.0.0.1:10001 | 本地端口调用（腾讯云同机部署时同样如此） |