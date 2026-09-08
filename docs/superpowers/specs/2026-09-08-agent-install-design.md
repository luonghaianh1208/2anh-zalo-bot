# Agent-Friendly Hermes Installation Design

## Goal

Make `2anh-zalo-bot` installable into an existing Hermes Agent checkout after an agent clones the repository and runs one documented command:

```text
npm run install:hermes
```

The installation must be repeatable, preserve customer-owned configuration and data, avoid changes to Hermes core source files, and explain the two remaining human actions: Zalo QR login and owner enrollment.

## Supported environment

- Node.js 22 or newer.
- Windows, macOS, and Linux paths handled through Node path APIs.
- An existing Hermes Agent source checkout with a usable Python environment.
- The Zalo sidecar remains in the cloned `2anh-zalo-bot` repository.
- Both Hermes plugins are copied into the Hermes checkout; no symlinks and no Hermes core patches.

The installer does not install Hermes itself. If Hermes cannot be found, it exits with a clear error and accepts an explicit `--hermes-home <path>` or `HERMES_HOME` on the next run.

## User and agent workflow

An operator asks an agent to clone the repository and follow its instructions. The root `AGENTS.md` tells the agent to:

1. Confirm Node.js 22 and an existing Hermes checkout.
2. Run `npm ci`.
3. Run `npm run install:hermes -- [--hermes-home <path>]`.
4. Run `npm run doctor -- [--hermes-home <path>]`.
5. Report the QR-login and owner-enrollment steps without attempting them automatically.

The README exposes the same commands for humans. No instruction asks an agent to paste cookies, tokens, session databases, logs, or `.env` contents into chat.

## Installer architecture

`scripts/hermes-install-lib.js` contains pure discovery, config transformation, copy-planning, and diagnostic functions. `scripts/install-hermes.js` is the mutating command-line entry point. `scripts/doctor.js` is read-only and uses the same discovery and validation code so installation and diagnosis cannot drift apart.

The installer performs these operations in order:

1. Validate Node.js 22+.
2. Resolve the Hermes source checkout from `--hermes-home`, `HERMES_HOME`, the current working tree, and documented platform defaults.
3. Require positive evidence of Hermes: `plugins/`, `gateway/`, and `pyproject.toml` in the resolved source root.
4. Create the sidecar `data/` directory and copy `.env.example` to `.env` only when `.env` does not exist.
5. Copy `hermes-plugin/zalo` to `plugins/platforms/zalo` and `hermes-plugin/zalo_tools` to `plugins/zalo_tools`.
6. Render the installed platform manifest with an absolute, quoted sidecar start command derived from the clone path. The tracked template contains no machine-specific path.
7. Merge only installer-owned Zalo keys into Hermes `config.yaml`, preserving unrelated keys and existing customer values. Existing Zalo values win; missing safe defaults are added.
8. Enable `zalo-platform` and `zalo-tools` through Hermes CLI when available. If the CLI is absent, write no invented plugin registry state and report the exact enable commands.
9. Install `websockets` into the detected Hermes Python environment.
10. Run the same checks as `doctor` and exit nonzero if the resulting installation is incomplete.

Every filesystem mutation is limited to the cloned repository's `.env`/`data` paths and the resolved Hermes checkout's two plugin destinations plus its configuration file.

## Configuration policy

The installer adds missing values needed for safe public/owner operation:

- `known_plugin_toolsets.zalo`: `zalo_owner`, `zalo_public`.
- `group_sessions_per_user: false`.
- Zalo display settings that suppress internal progress and reasoning.

It does not guess owner UIDs, home-channel IDs, knowledge-base paths, secrets, or a Zalo session. Existing values are retained. If structured YAML editing cannot be performed safely, installation stops before changing `config.yaml` and prints the manual snippet; it must not replace the file with a generated configuration.

The sidecar reads `.env` from its own repository root. Any legacy Hermes database import is driven by an explicit configured Hermes location and is skipped when no legacy database exists.

## Repeatability and upgrades

Running the installer again updates the two plugin code directories from the cloned repository while preserving customer-owned Hermes configuration, `.env`, Zalo session data, SQLite history, and logs. Before replacing a plugin directory, the installer writes new content to a sibling staging directory and then swaps it into place so an interrupted copy does not leave a partial plugin.

The installer records no credentials and does not copy sidecar runtime data into Hermes. Uninstallation is deliberately separate and conservative: `npm run uninstall:hermes` removes only the two installed plugin directories after verifying their exact resolved paths, and never removes `.env`, `data/`, SQLite databases, sessions, or general Hermes configuration.

## Doctor contract

`npm run doctor` is read-only and reports a pass/fail result for:

- Node.js version.
- Sidecar dependencies installed.
- Hermes checkout resolved and structurally valid.
- Both plugin directories installed.
- Both plugin manifests valid and the sidecar command points to an existing `server.js`.
- Required Zalo toolsets and safe display defaults present in `config.yaml`.
- Hermes Python and `websockets` available.

It never starts the sidecar, starts or restarts Hermes, connects to Zalo, sends a message, or prints secret values.

## Safety boundaries

- `.gitignore` must continue to exclude `.env`, `data/`, databases, WAL/SHM files, logs, PID files, and `node_modules`.
- The package requires Node.js 22+ because durable storage uses `node:sqlite`.
- Installation does not expose dashboard or bridge ports beyond loopback.
- Installation does not weaken public/owner authorization.
- The separately identified bridge authentication and runtime security findings must be resolved before a public release; installer convenience is not treated as security readiness.
- No service restart, Zalo login, message send, or GitHub push occurs automatically.

## Test strategy

Node's built-in test runner exercises the real installer against temporary fake repository and Hermes directory trees. Tests cover explicit and automatic path discovery, rejection of non-Hermes directories, first install, reinstall, preservation of `.env` and unrelated/configured YAML values, installation of both plugins, portable manifest rendering, missing CLI/Python diagnostics, doctor success/failure, and safe uninstall behavior.

External package installation and live Hermes restart are not performed in unit tests. A final sandbox smoke test uses a temporary Hermes-shaped checkout and invokes the actual CLI commands end to end. Existing sidecar, bridge, policy, storage, and plugin tests must remain green.

## Acceptance criteria

- A fresh clone plus `npm ci && npm run install:hermes -- --hermes-home <checkout>` installs both plugins and exits successfully in a Hermes-shaped sandbox.
- A second run produces the same effective installation without overwriting customer configuration or runtime data.
- `npm run doctor -- --hermes-home <checkout>` exits zero only when the installation is complete.
- `npm run uninstall:hermes -- --hermes-home <checkout>` removes only the two managed plugin directories.
- No tracked file contains a developer-machine absolute path or runtime credential.
- README and `AGENTS.md` provide one canonical install flow and accurately state Node/tool requirements.
- The live Hermes/Lăng Tiêu process is not modified or restarted during development verification.
