# Installing 2Anh Zalo Bot into Hermes Agent

When the user asks you to install this repository, perform the installation instead of only describing it.

## Required workflow

1. Confirm that Node.js 22 or newer is available with `node --version`.
2. Locate the existing Hermes home or source checkout. A Hermes home normally contains `config.yaml` and a `hermes-agent/` child; a source checkout contains `pyproject.toml`, `gateway/`, and `plugins/`.
3. Ask whether the customer wants the optional offline Vietnamese voice provider. Explain that VieNeu v3 Nano needs no API key or GPU, downloads about 282 MB on first use, runs on CPU, and is most comfortable when the always-on machine keeps about 10 GB RAM available. It uses the Northern Vietnamese male voice `Minh Quân` and falls back to Edge TTS. Never opt in on the customer's behalf.
4. Run `npm ci` in this repository.
5. Run `npm run install:hermes -- --hermes-home <resolved-path>`. Append `--vieneu-tts` only when the customer explicitly agreed in step 3.
6. Run `npm run doctor -- --hermes-home <resolved-path>` and report every failed check.
7. If doctor passes, tell the user to run `npm start`, open `http://127.0.0.1:3872`, scan the QR code with a secondary Zalo account, and configure their owner UID.

Do not print `.env`, cookies, bridge tokens, Zalo session data, SQLite contents, or API keys. Do not copy `data/`, `.env`, logs, databases, or `node_modules` into Hermes. Do not start or restart an existing Hermes service unless the user explicitly asks. Do not patch Hermes core files.

If the customer cannot be asked interactively, omit `--vieneu-tts`. The default installation must never alter an existing TTS provider.

The installer is idempotent. Use the same install command for upgrades. Use `npm run uninstall:hermes -- --hermes-home <resolved-path>` only when the user explicitly asks to uninstall; it preserves the sidecar `.env`, Zalo session/history, and Hermes `config.yaml`.
