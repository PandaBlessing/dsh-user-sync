# dsh-user-sync

**Sync your DSH user-level assets across machines — no more copying `~/.dsh` by hand.**

A **user-level config sync plugin** for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): keeps skills, plugin list, config and memory aligned between devices. Install once on a new machine, click once, and your environment matches the old one.

[![npm](https://img.shields.io/npm/v/@pandablessing/dsh-user-sync)](https://www.npmjs.com/package/@pandablessing/dsh-user-sync)
[![license](https://img.shields.io/badge/license-MulanPSL--2.0-blue)](LICENSE)

## Requirements

- DSH `>= 0.2.0-rc.2` (Node `>= 22`)
- A DeepSeek account (used for automatic pairing; no operator account required)
- Desktop: verified on Windows / macOS; Linux not yet verified

## Quick start

**Option 1: install from the DSH UI**

1. Open DSH → **Settings → Built-in plugins** → "Install plugin" → enter `@pandablessing/dsh-user-sync`;
2. **Restart DSH** → Settings → Settings Sync → Accept & enable → Upload config.

**Option 2: install from the command line**

```bash
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync
# Restart DSH → Settings → Settings Sync → Accept & enable → Upload config
```

On a new machine: install the same way → Settings Sync → **Sync from remote**.

> Use the npm package name `@pandablessing/dsh-user-sync`; remove any old `dsh-user-sync` entry first to avoid duplicate panels.

## What it syncs

| Module | Content | Default |
|---|---|---|
| Skills | `~/.agents/skills/<name>/SKILL.md` and files | ✅ |
| Plugin manifest | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `cordis.yml` | ✅ |
| Config | `cordis.patch.yml` (including custom agent presets) | ✅ |
| User memory | `AGENTS.md` + `memories/` | ✅ |
| Project memory | `memories/projects/` and `daily/` | ⬜ |
| Sessions | — | never synced |

## What it solves

| Pain | Before | Now |
|---|---|---|
| New machine, empty DSH | `scp -r ~/.dsh` by hand, miss files | Click "Sync from remote", confirm before overwrite |
| Plugins missing | Re-`pnpm add` one by one | Auto-installed from the remote manifest, failures listed |
| Config messed up | No backup | `pre-restore` snapshot before every apply |
| Secrets leaked | — | Filename blacklist + content scan, refused at pack time |

## Update

When a newer version is found on npm, an "Update plugin" button appears at the top of the panel. Or update manually:

```bash
cd ~/.dsh/profiles/desktop
pnpm add @pandablessing/dsh-user-sync@latest
```

## Uninstall & rollback

```bash
cd ~/.dsh/profiles/desktop
pnpm remove @pandablessing/dsh-user-sync
# Restart DSH; local state stays in ~/.dsh/user-sync/
```

Every "Sync from remote" creates a `pre-restore` snapshot in `~/.dsh/user-sync/pre-restore/`; copy files back to roll back.

## Quotas & limits

- **Only one package per account**; max **10 MB** per package (so effectively 10 MB per account);
- Only one package is kept remotely (upload overwrites); rollback relies on local `pre-restore` snapshots;
- Jianguoyun (WebDAV) has per-account traffic quotas;
- Single-node server; feedback endpoint is rate-limited in memory.

## Error codes

| Code | Meaning | Action |
|---|---|---|
| `E_REMOTE_NEWER` | Remote package is newer | Confirm overwrite, or sync from remote first |
| `E_QUOTA_EXCEEDED` | Quota exceeded | Clean up old packages or ask for more space |
| `E_LOCKED` | Another sync is running | Retry after it finishes |
| `E_BAD_NAME` | Invalid package name | Re-pack and upload |
| `E_DEV_LINK` | Dev (junction) install can't self-update | Restart DSH to load latest code |

## FAQ

**Plugins not restored?** Check the failure list after apply; `link:` deps must be placed back manually.

**Upload refused?** A sensitive-file rule matched (filename blacklist / content pattern); remove it or exclude the directory.

**Panel changes not taking effect?** Host code hot-reloads; client (panel UI) needs a DSH restart.

**Pairing failed?** Check network and account status; pairing derives a key from the official account id.

**Config not applied after sync?** Restart DSH (config loads at boot).

## Changelog

- User-facing changes: [docs/updates.md](docs/updates.md)
- Technical change log: [CHANGELOG.md](CHANGELOG.md)

## Repository layout

```text
docs/                   design / test cases / deploy / changelog
lib/                    plugin (host + client + transports + sync)
server/                 operator API (node:http)
scripts/                install / uninstall / smoke / clone drill
test/                   unit, component, timing tests and fixtures
```

## License

[Mulan PSL v2](LICENSE)
