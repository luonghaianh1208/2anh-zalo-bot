# 2Anh Zalo Bot

**English** | [Tiếng Việt](README.vi.md)

Connect a personal Zalo account to [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a full messaging platform alongside Telegram, Discord, and Slack.

Messages sent through Zalo reach the same Hermes agent running on your computer, with its tools, memory, skills, and scheduled jobs.

```text
Zalo  <->  zca-js sidecar (Node.js)  <->  local WebSocket  <->  Python plugins  <->  Hermes Agent
```

## Highlights

- QR-code login with persisted sessions and automatic reconnects.
- Closed-by-default authorization for direct messages and group mentions.
- Separate `owner` and `public` toolsets, enforced again at execution time.
- SQLite message history, paginated backfill, audit logs, and runtime health reporting.
- Native Zalo formatting, reactions, read receipts, typing indicators, files, links, stickers, and voice bubbles.
- Two-step confirmation for destructive actions such as recalling messages or changing group membership.
- Optional offline Vietnamese TTS with VieNeu v3 Nano and an Edge TTS fallback.
- An idempotent installer and doctor command for existing Hermes deployments.

## Important risk notice

`zca-js` is an unofficial client built from Zalo Web behavior. Using it may violate Zalo's terms of service and can put the account at risk.

- Always use a secondary Zalo account.
- Do not automate bulk messaging or friend requests.
- Keep group replies mention-only unless you explicitly understand the risk.
- Never publish the sidecar `data/` directory, `.env`, cookies, IMEI, SQLite databases, or bridge token.
- The QR dashboard listens on `127.0.0.1` and has no password. Do not expose it to the internet.

## Requirements

- Node.js 22 or newer.
- An existing Hermes Agent installation.
- A secondary Zalo account.
- `ffmpeg` when using voice messages or the optional Edge fallback.

The optional VieNeu provider runs on CPU and does not require an API key. Its v3 Nano model downloads roughly 282 MB on first use. For an always-on Hermes installation, about 10 GB of available RAM is a comfortable baseline; a GPU is not required.

## Install with a coding agent

Tell the agent:

> Clone this repository, install it into my existing Hermes Agent according to `AGENTS.md`, run the doctor, and report every failed check.

Before installing, the agent must ask whether you want the optional offline Vietnamese voice provider. It should explain the local CPU/RAM/disk trade-offs and must not enable it without your approval.

## Manual installation

```bash
git clone https://github.com/luonghaianh1208/2anh-zalo-bot.git
cd 2anh-zalo-bot
npm ci
npm run install:hermes -- --hermes-home <path-to-Hermes-home>
npm run doctor -- --hermes-home <path-to-Hermes-home>
```

If Hermes is in a standard location or `HERMES_HOME` is already set, you may omit `--hermes-home`.

The installer creates the sidecar `.env` when missing, generates a private bridge token, installs both Zalo plugins, merges safe defaults without replacing customer values, installs `websockets`, and runs its doctor checks. Repeated installation preserves Zalo sessions, SQLite data, `.env`, and customer configuration.

### Optional offline Vietnamese voice

Enable VieNeu only after the customer explicitly agrees:

```bash
npm run install:hermes -- --hermes-home <path-to-Hermes-home> --vieneu-tts
npm run doctor -- --hermes-home <path-to-Hermes-home>
```

This opt-in action:

- creates an isolated Python environment at `<HERMES_HOME>/tts/.venv`;
- installs `vieneu==3.6.4` and `edge-tts` without modifying Hermes' own environment;
- installs the provider at `<HERMES_HOME>/tts/vieneu_provider.py`;
- selects VieNeu v3 Nano on CPU/ONNX with the Northern Vietnamese male voice `Minh Quân`;
- falls back to `vi-VN-NamMinhNeural` through Edge TTS if VieNeu fails;
- preserves other customer-owned TTS provider configuration.

Without `--vieneu-tts`, the installer does not download, configure, or alter TTS.

### Start and connect

```bash
npm start
```

1. Open `http://127.0.0.1:3872`.
2. Create and scan the QR code with the secondary Zalo account.
3. From the owner's personal Zalo account, send `/sethome` to the secondary account.
4. Start or restart the Hermes gateway using the service manager used by that installation.

Verify the bridge:

```bash
curl http://127.0.0.1:3872/api/status
```

The response should report `"status": "logged-in"` and `"hermesAttached": true`.

## Authorization model

| Capability | Owner | Other group members |
|---|---:|---:|
| Zalo toolsets | `hermes-zalo`, `zalo_owner`, `zalo_public` | `zalo_public` only |
| Core terminal and file tools | Yes | No |
| Browser and general web tools | Yes | No |
| Target another conversation | Yes | No |
| Direct-message access | Yes | Disabled by default |

Public tools are removed before the model sees the tool list, scoped to the current conversation, and checked again in the backend. Destructive owner actions also require a fresh six-character confirmation code.

## Configuration

The installer manages these Hermes configuration areas without overwriting explicit customer values:

- `known_plugin_toolsets.zalo`
- `plugins.enabled`
- `platforms.zalo`
- `display.platforms.zalo`
- top-level `group_sessions_per_user`

Owner identity and gateway admission remain environment settings:

```env
ZALO_BRIDGE_URL=ws://127.0.0.1:3873
ZALO_BRIDGE_TOKEN=<same generated value as the sidecar>
ZALO_ALLOWED_USERS=<owner Zalo UID>
ZALO_HOME_CHANNEL=<owner Zalo UID>
ZALO_GROUP_REPLY_ONLY_TAGGED=true
```

A Zalo UID is normally a long 17–21 digit value and is not a phone number.

## Agent tools

The integration exposes tools for sending rich content; reading history, groups, members, friends, and user information; managing polls, notes, reminders, and groups; recalling bot messages; safe knowledge-base reading; and restricted public web lookup.

The bridge accepts only allowlisted `zca-js` operations. High-risk automation such as bulk friend requests, blocking users, dissolving groups, or money-related operations is deliberately excluded.

## Health and history

`GET /api/health` reports Zalo and Hermes connection state, SQLite and audit counts, backfill progress, recent traffic, and the last runtime error. Message history and audits are stored in the sidecar SQLite database; Hermes conversation memory remains in Hermes' own `state.db`.

## Troubleshooting

| Symptom | Common cause |
|---|---|
| `no saved session` | QR login has not completed or the saved cookie expired |
| `hermesAttached: false` | Hermes is stopped or the bridge URL/port is wrong |
| No direct-message reply | `/sethome` was not completed or the owner UID is absent |
| No group reply | The bot was not tagged; mention-only replies are the default |
| `Unauthorized user ... on zalo` | The sender is not admitted by the configured policy |
| Markdown markers appear literally | The sidecar is outdated; pull and restart it |
| Port already in use | Change `ZCA_PORT` or `ZALO_BRIDGE_PORT` consistently |
| VieNeu doctor check fails | Re-run the opt-in installer and confirm Python 3.10+, disk, and initial-download network access |

Sidecar logs are printed by `npm start`. Hermes gateway logs live under `<HERMES_HOME>/logs/gateway.log`.

## Uninstall

```bash
npm run uninstall:hermes -- --hermes-home <path-to-Hermes-home>
```

The uninstaller removes only the managed Zalo plugin directories. It preserves the sidecar `.env`, Zalo session/history, Hermes `config.yaml`, and optional TTS environment so it never leaves a configuration pointing at deleted files.

## License

MIT — see [LICENSE](LICENSE).

This project is not affiliated with Zalo or VNG. `zca-js` belongs to [RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js).
