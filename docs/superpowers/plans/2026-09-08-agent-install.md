# Agent-Friendly Hermes Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a sanitized, current `2anh-zalo-bot` repository that an agent can clone and install into another existing Hermes Agent checkout with one command.

**Architecture:** Keep the Node Zalo sidecar in its own clone and install two portable Hermes plugins by copying them into a detected Hermes source checkout. A shared Node library owns discovery, safe YAML merging, atomic plugin replacement, diagnostics, and conservative uninstall; thin CLIs expose install, doctor, and uninstall.

**Tech Stack:** Node.js 22 ESM, Node built-in test runner, `yaml`, Python Hermes plugins, PowerShell smoke verification on Windows.

**Spec:** `docs/superpowers/specs/2026-09-08-agent-install-design.md`

## Global Constraints

- Require Node.js 22 or newer.
- Do not modify Hermes core source files.
- Never copy or commit `.env`, `data/`, SQLite/WAL/SHM files, logs, PID files, cookies, or tokens.
- Preserve existing customer configuration, Zalo sessions, history databases, and logs.
- Do not start or restart Hermes, connect to Zalo, send messages, or push to GitHub during installation tests.
- Keep bridge and dashboard listeners bound to loopback.

---

### Task 1: Synchronize the sanitized current implementation

**Files:**
- Modify: root sidecar source files and `hermes-plugin/zalo/**`, `hermes-plugin/zalo_tools/**`
- Create: existing sidecar `*.test.js` files and durable-history modules from the tested live sidecar source
- Test: `*.test.js`, `test_zalo_adapter.py`

**Interfaces:**
- Consumes: the tested live sidecar source and the two installed plugin directories.
- Produces: the current portable source baseline without runtime data.

- [ ] **Step 1: Copy tests before production modules**

Copy only `*.test.js` and `test_zalo_adapter.py`; do not copy `data/`, `.env`, logs, PID files, `node_modules`, or package metadata.

- [ ] **Step 2: Run tests to verify the stale repository fails**

Run: `node --test --test-reporter=dot`

Expected: FAIL because durable-history modules such as `zalo-store.js` are absent.

- [ ] **Step 3: Copy the corresponding production source and plugin files**

Use an explicit filename allowlist for root JavaScript and recursively copy only the two plugin source trees. Preserve the public repository's `.gitignore`, `LICENSE`, README, package identity, and installer files.

- [ ] **Step 4: Run the synchronized baseline**

Run: `node --test --test-reporter=dot`

Expected: all imported Node tests pass.

Run: `py -3 -m unittest test_zalo_adapter.py -v`

Expected: 22 tests pass.

- [ ] **Step 5: Commit**

```text
git add <explicit synchronized source and test paths>
git commit -m "feat: sync durable Zalo runtime"
```

### Task 2: Close release-blocking portability and authorization gaps

**Files:**
- Modify: `server.js`, `hermes-bridge.js`, `zalo-policy.js`, `hermes-plugin/zalo/adapter.py`, `hermes-plugin/zalo_tools/tools.py`
- Modify: their existing test files

**Interfaces:**
- Consumes: current durable runtime from Task 1.
- Produces: authenticated loopback bridge, fail-closed owner checks, confined public media access, sanitized audit records, reliable undo IDs, and clean listener lifecycle.

- [ ] **Step 1: Add failing behavior tests**

Add tests that exercise these observable contracts:

```text
unauthenticated bridge client -> close/reject
wrong bridge token -> close/reject
correct bridge token -> hello and command handling
missing turn context for owner-only tool -> permission error
public local voice path outside ZALO_KB_DIR -> permission error
logout/runtime stop -> listener.stop called exactly once
audited thrown error -> secret/path redacted
generic rich-media send -> outbound message ID persisted for undo
occupied HTTP port -> controlled diagnostic and nonzero exit, not unhandled rejection
```

- [ ] **Step 2: Run focused tests and confirm expected failures**

Run: `node --test hermes-bridge.test.js zalo-policy.test.js`

Run: `py -3 -m unittest test_zalo_adapter.py -v`

Expected: each new test fails because the named guard or lifecycle behavior is missing.

- [ ] **Step 3: Implement minimal hardening**

Generate/store a non-logged `ZALO_BRIDGE_TOKEN` in `.env`; require it in the WebSocket handshake and adapter URL/header. Reject browser origins by default. Make owner-only tools reject absent turn context, and confine public local voice files to the same realpath boundary used for public knowledge files. Stop the listener during logout and signal shutdown. Redact audit errors and derive targets from invoke arguments. Persist returned message IDs for rich-media sends. Add a server `error` handler with an actionable port-conflict message.

- [ ] **Step 4: Run focused and complete tests**

Run: `node --test --test-reporter=dot`

Run: `py -3 -m unittest test_zalo_adapter.py -v`

Expected: all tests pass with no unhandled errors.

- [ ] **Step 5: Commit**

```text
git add server.js hermes-bridge.js zalo-policy.js hermes-plugin *.test.js test_zalo_adapter.py .env.example
git commit -m "fix: harden portable Zalo runtime"
```

### Task 3: Build the reusable installer core

**Files:**
- Create: `scripts/hermes-install-lib.js`
- Create: `scripts/hermes-install-lib.test.js`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `parseArgs(argv)`, `resolveHermesLayout(options)`, `mergeHermesConfig(text)`, `renderPlatformManifest(template, sidecarRoot)`, `installHermes(options)`, `doctorHermes(options)`, and `uninstallHermes(options)`.

- [ ] **Step 1: Write failing temporary-tree tests**

Tests create a Hermes-shaped tree with `plugins/`, `gateway/`, `pyproject.toml`, and `config.yaml`, then assert literal outcomes: both plugin destinations exist, unrelated YAML remains semantically equal, existing Zalo values win, missing safe defaults appear, manifest command points to the clone's `server.js`, reinstall preserves `.env` and data, and non-Hermes targets are rejected.

- [ ] **Step 2: Run tests and verify missing-module failure**

Run: `node --test scripts/hermes-install-lib.test.js`

Expected: FAIL with module-not-found for `hermes-install-lib.js`.

- [ ] **Step 3: Add the YAML dependency and minimal library**

Run: `npm install yaml`

Implement the exported functions using `fs`, `path`, `child_process`, and `yaml`. Stage each plugin into a sibling temporary directory before replacing its exact validated destination. Never traverse or remove a path outside the resolved Hermes plugin directories.

- [ ] **Step 4: Run focused tests**

Run: `node --test scripts/hermes-install-lib.test.js`

Expected: all installer-library tests pass.

- [ ] **Step 5: Commit**

```text
git add scripts/hermes-install-lib.js scripts/hermes-install-lib.test.js package.json package-lock.json
git commit -m "feat: add safe Hermes installer core"
```

### Task 4: Add install, doctor, uninstall, and agent entrypoints

**Files:**
- Replace: `scripts/setup.js` with `scripts/install-hermes.js`
- Create: `scripts/doctor.js`, `scripts/uninstall-hermes.js`, `scripts/cli.test.js`, `AGENTS.md`
- Modify: `package.json`, `README.md`, `.env.example`, `hermes-plugin/zalo/plugin.yaml`

**Interfaces:**
- Consumes: installer functions from Task 3.
- Produces: `npm run install:hermes`, `npm run doctor`, `npm run uninstall:hermes`, and canonical instructions for agents/humans.

- [ ] **Step 1: Write failing CLI integration tests**

Spawn each real CLI against a temporary Hermes-shaped directory. Assert install and doctor exit zero, doctor on an incomplete install exits nonzero without mutation, uninstall removes exactly the two plugin directories, and second install preserves a sentinel existing config value and sidecar `.env`.

- [ ] **Step 2: Run CLI tests and verify command failures**

Run: `node --test scripts/cli.test.js`

Expected: FAIL because the new CLI files and package scripts do not exist.

- [ ] **Step 3: Implement thin CLI wrappers and documentation**

Each wrapper parses `--hermes-home`, calls one library operation, prints no secrets, and sets a nonzero exit code on failure. `AGENTS.md` instructs an agent to run `npm ci`, install, doctor, and report manual QR/owner steps. README uses the same canonical flow, states Node 22+, removes standalone-chatbot claims, and reports 45 tools: 14 public and 31 owner. The tracked manifest uses a placeholder consumed only by the installer and contains no developer path.

- [ ] **Step 4: Run CLI and full regression tests**

Run: `node --test --test-reporter=dot`

Run: `py -3 -m unittest test_zalo_adapter.py -v`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```text
git add scripts package.json package-lock.json AGENTS.md README.md .env.example hermes-plugin/zalo/plugin.yaml
git commit -m "feat: add one-command Hermes installation"
```

### Task 5: Final installation and release verification

**Files:**
- Verify all tracked files; no new production interface.

- [ ] **Step 1: Run a fresh sandbox install twice**

Create a temporary Hermes-shaped checkout, run `npm ci`, run `npm run install:hermes -- --hermes-home <sandbox>` twice, and run `npm run doctor -- --hermes-home <sandbox>`.

Expected: all commands exit zero and customer sentinel values remain unchanged.

- [ ] **Step 2: Run full test and package checks**

Run: `node --test --test-reporter=dot`

Run: `py -3 -m unittest test_zalo_adapter.py -v`

Run: `npm audit --omit=dev --audit-level=high`

Run: `npm pack --dry-run --json`

Expected: tests pass, audit reports zero high-severity vulnerabilities, and package contents exclude all runtime/secrets paths.

- [ ] **Step 3: Scan tracked content and inspect Git state**

Run an `rg` scan for developer absolute paths, cookie/token patterns, `.env`, SQLite/WAL/SHM, and logs. Run `git diff --check`, `git status --short`, and inspect `git diff origin/main...HEAD`.

Expected: no secret/runtime artifacts, no developer-machine path, clean whitespace, and only task-scoped commits. Do not push.
