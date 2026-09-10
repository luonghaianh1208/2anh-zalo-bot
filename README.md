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

## What sets this apart

1. **Not a standalone chatbot — a full Hermes platform.** The bot shares tools, memory, skills, and cron jobs with the same Hermes agent running on the owner's machine. Messaging on Zalo talks to that agent directly, on equal footing with Telegram, Discord, and Slack in Hermes.

2. **Two layers of authorization, not one.** Splitting tools into `zalo_owner`/`zalo_public` toolsets only hides tools from the model's tool list. The real barrier is `_owner_only` in `hermes-plugin/zalo_tools/tools.py`, which checks the sender's identity at call time for every owner tool — a misconfiguration still can't let one through.

3. **Two-step confirmation with a real code for destructive actions.** Recalling a message, changing group membership, and similar actions generate a random six-character code (`_PENDING_CONFIRMATIONS`); the owner has to send that code back in a fresh message. The model cannot confirm on someone's behalf.

4. **A token-authenticated bridge.** The local WebSocket channel between the sidecar and Hermes rejects any connection carrying a browser `Origin` header outright, and compares the token with `timingSafeEqual` — another process on the same machine cannot just connect and take over the Zalo account.

5. **Built to avoid Zalo account bans.** The rate limiter is a token bucket: a burst of 5 messages goes out immediately, then throughput settles to a sustainable 20/minute, and conversational replies are prioritized ahead of bulk operations. Losing the account means losing the whole channel.

6. **Markdown translated into Zalo's native formatting against measured limits, not guesses.** Zalo caps messages at 3000 UTF-16 code units and its style array at roughly 256 JSON characters — go over either and Zalo just returns "Unknown error" with no hint why. The formatter truncates at a readable boundary and keeps styles by importance when the budget is tight.

7. **SQLite history and an audit trail.** Every message is stored in SQLite with age-based retention (365 days by default); every action with real-world effect is written to `audit_log` with the acting identity and the outcome.

8. **A re-runnable installer with diagnostics and a clean uninstall.** `install:hermes` merges configuration without overwriting values the customer already changed; `doctor` runs 8 checks from the Hermes layout to the bridge token; `uninstall:hermes` removes only the managed plugin directories, leaving `.env`, the Zalo session, and `config.yaml` untouched.

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

45 tools total, split into two toolsets: 31 owner-only, 14 shared with everyone in a group. `ZALO_ALLOWED_USERS` decides who counts as the owner.

| Group | Tools |
|---|---|
| Facebook Page | `zalo_fb_pages` `zalo_fb_posts` `zalo_fb_comments` `zalo_fb_draft` `zalo_fb_publish` |
| Send content | `zalo_send_file` `zalo_send_voice` `zalo_send_sticker` `zalo_send_link` `zalo_forward` |
| Read context | `zalo_read_history` `zalo_list_groups` `zalo_group_members` `zalo_find_user` `zalo_user_info` `zalo_list_friends` |
| Zalo-specific | `zalo_create_poll` `zalo_poll_detail` `zalo_lock_poll` `zalo_create_note` `zalo_create_reminder` `zalo_list_reminders` `zalo_remove_reminder` `zalo_pin_conversation` `zalo_mute` |
| Fix mistakes & administration | `zalo_undo` `zalo_rename_group` `zalo_group_member_change` `zalo_group_deputy` `zalo_pending_members` `zalo_review_member` |
| Create groups & invites | `zalo_create_group` `zalo_invite_to_groups` `zalo_group_link` `zalo_join_group_link` |
| Bot profile | `zalo_set_bio` `zalo_set_active_status` |
| Knowledge base | `zalo_kb_list` `zalo_kb_read` |
| Web lookup | `zalo_web_search` `zalo_web_read` |
| People notebook | `zalo_remember_person` `zalo_recall_person` `zalo_list_people` `zalo_forget_person` |

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
