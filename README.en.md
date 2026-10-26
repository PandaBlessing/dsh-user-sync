# dsh-user-sync

User-level configuration sync for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): move your skills, plugin manifest, config and user memory between machines, with snapshot-before-apply and a single "remote keeps one package" rule.

## What it syncs

| Module | Content | Default |
|---|---|---|
| Skills | `~/.agents/skills/<name>/SKILL.md` and files | ✅ |
| Plugin manifest | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `cordis.yml` | ✅ |
| Config | `cordis.patch.yml` | ✅ |
| User memory | `AGENTS.md` + `memories/` root | ✅ |
| Project memory | `memories/projects/` and `daily/` | ⬜ |
| Sessions | — | never synced |

## Install

```powershell
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync
```

Restart DSH, then open Settings → **设置同步** (Sync Settings), accept the consent card and click **上传用户配置** (Upload).

## Behavior

- **Implicit remote** (LWW): pushing overwrites the remote; pulling overwrites local. No conflict merge.
- **Safety first**: every apply snapshots local files first; a single remote package is kept; sessions are excluded.
- **Plugins**: sync restores declarations only; missing plugins are listed and can be installed with one click.
- **Auto check**: on start and every 6 hours (configurable), read-only — it only notifies, never applies.

## Development

```powershell
pnpm install
pnpm run build        # src/*.ts  → lib/*.js
pnpm run build:server # server/src/*.ts → server/dist/*.js
pnpm test             # 144 tests
```

Docs: [design](docs/design.md) · [test cases](docs/test-cases.md) · [deploy](docs/deploy.md) · [changelog](CHANGELOG.md).

## Sponsor

The plugin is free and open source (MulanPSL-2.0). If it saved you time migrating machines, a small tip is welcome —
it covers the storage quota of the hosted service (Nutstore space for remote packages) and ongoing compatibility work.

![WeChat sponsor QR](docs/assets/sponsor-wechat.jpg)

Scan with WeChat Pay. Tips are voluntary and do not unlock any extra feature.


## License

[MulanPSL-2.0](LICENSE)
