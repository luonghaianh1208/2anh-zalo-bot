# Cron cho mọi nhóm Zalo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cron gửi được vào mọi nhóm Zalo và dùng được công cụ Zalo; thành viên nhóm tự tạo, xem, xoá cron của nhóm mình trong giới hạn an toàn.

**Architecture:** Sidecar nới vai trò `system` cho `send`/`typing` tới mọi hội thoại và mở `history` cho `public` trong đúng hội thoại. Plugin Python gắn danh tính cho lượt chạy cron qua `task_id = "cron:<job_id>:…"` (job không đánh dấu → chủ nhân; job `origin.zalo_scope == "group"` → người tạo, khoá nhóm). Công cụ công khai mới `zalo_group_cron` tạo job với mọi trường nguy hiểm khoá cứng và toolset `zalo_cron_member`.

**Tech Stack:** Node 22 (`node:test`, `ws`, `zca-js`), Python 3 trong venv của Hermes (`unittest`, `jsonschema`), Hermes Agent v0.21 (`cron.jobs`, `tools.cronjob_tools`, `toolsets`).

**Spec:** `docs/superpowers/specs/2026-09-11-zalo-cron-nhom-design.md`

## Global Constraints

- Làm trên nhánh `feat/zalo-cron-nhom` của repo `E:\2anh-zalo-bot`.
- Chạy Python test bằng `E:/Hermes/hermes-agent/venv/Scripts/python.exe` từ thư mục gốc repo; chạy toàn bộ bằng `HERMES_HOME=E:/Hermes npm test`. Mốc trước khi sửa: 113 test JS + 52 test Python xanh.
- Không sửa lõi Hermes Agent (`E:\Hermes\hermes-agent` ngoài `plugins/platforms/zalo` và `plugins/zalo_tools`).
- Giới hạn cron thành viên: prompt ≤ 1000 ký tự, tên ≤ 80 ký tự, lặp cách nhau ≥ 1440 phút (đo 20 lần chạy kế tiếp), 3 job đang bật / người, 10 / nhóm; chủ nhân miễn hạn mức.
- Job thành viên: `deliver = "zalo:<nhóm>"`, `enabled_toolsets = ["zalo_cron_member", "no_mcp"]`, không truyền `script`, `workdir`, `skills`, `model`, `provider`, `base_url`, `context_from`, `monitor_*`.
- Tên toolset: `zalo_public`, `zalo_owner`, `zalo_cron` (chứa `zalo_group_history`), `zalo_cron_member` (toolset ghép).
- **Không chạy `npm run install:hermes` trên máy Lăng Tiêu:** `.env` của repo mang token cầu nối khác `E:\Hermes\config.yaml` và `HERMES_HOME` trỏ thư mục tạm — trình cài sẽ ghi đè token và làm Lăng Tiêu mất kết nối. Cài bằng cách chép tệp (Task 7).
- Chữ hiển thị cho người dùng viết tiếng Việt; commit kết thúc bằng `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Sidecar — `system` gửi được mọi hội thoại, `history` công khai trong đúng hội thoại, audit ghi mã cron

**Files:**
- Modify: `zalo-policy.js` (hàm `classify`, `authorizeBridgeCommand`)
- Modify: `hermes-bridge.js:110` (`activeHomeChannel`), `:314` (tham số `homeChannel`), `:325`, `:633-655` (`auditTargetSummary`), `:664`
- Test: `zalo-policy.test.js`, `hermes-bridge.test.js`

**Interfaces:**
- Consumes: không có.
- Produces: `authorizeBridgeCommand(command, { ownerUids })` — bỏ tùy chọn `homeChannel`. Frame từ adapter có thể mang `auth.cronJobId` (chuỗi); audit lưu vào `targetSummary.cronJobId`.

- [ ] **Step 1: Viết test hỏng cho luật mới**

Trong `zalo-policy.test.js`, thay nguyên test `'system actor (cron, thông báo gateway) chỉ gửi được tới chủ nhân hoặc kênh nhà'` (dòng 82-89) bằng:

```js
test('system actor (cron, gửi bù, thông báo gateway) gửi chữ được tới mọi hội thoại nhưng không làm gì khác', () => {
  const system = { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false };
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'owner-1', threadType: 0, auth: system }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'send', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'typing', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).allowed, true);
  assert.equal(authorizeBridgeCommand({ type: 'invoke', method: 'getAllGroups', args: [], auth: system }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({
    type: 'invoke', method: 'sendMessage', args: [{ msg: 'x' }, 'group-1', 1], auth: system,
  }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).code, 'auth_required');
  assert.equal(authorizeBridgeCommand({ type: 'undo', threadId: 'group-1', threadType: 1, auth: system }, policyOptions).code, 'auth_required');
});

test('history mở cho public nhưng chỉ trong đúng hội thoại đang thao tác', () => {
  assert.deepEqual(authorizeBridgeCommand({ type: 'history', threadId: 'group-1', threadType: 1, auth: publicAuth }, policyOptions), {
    allowed: true, role: 'public', code: 'allowed', category: 'read',
  });
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'other-group', threadType: 1, auth: publicAuth }, policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'group-1', threadType: 0, auth: publicAuth }, policyOptions).code, 'cross_thread_denied');
  assert.equal(authorizeBridgeCommand({ type: 'history', threadId: 'any-thread', threadType: 1, auth: ownerAuth }, policyOptions).allowed, true);
});
```

Trong `hermes-bridge.test.js`, thêm ngay sau test `'bridge audits successful and failed owner administration without payload secrets'` (kết thúc ở dòng 798):

```js
test('tin system (kết quả cron) gửi được vào nhóm không phải kênh nhà', async (t) => {
  const store = testStore(t);
  const sent = [];
  const api = {
    sendMessage: (content, threadId, type) => {
      sent.push([content.msg, threadId, type]);
      return Promise.resolve({ message: { msgId: 'cron-m', cliMsgId: 'cron-c' } });
    },
  };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'send', reqId: 'cron-send', threadId: 'group-9', threadType: 1, text: 'Nhắc họp',
      auth: { actorUid: '', actorRole: 'system', sourceThreadId: '', sourceThreadType: 0, confirmed: false },
    }));
    const ack = await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'cron-send');
    assert.equal(ack.ok, true);
    assert.deepEqual(sent, [['Nhắc họp', 'group-9', 1]]);
  } finally {
    ws.close();
    stopHermesBridge();
  }
});

test('audit ghi mã cron khi lệnh do một việc hẹn giờ phát ra', async (t) => {
  const store = testStore(t);
  const api = { changeGroupName: () => Promise.resolve({ ok: true }) };
  const server = startHermesBridge({ api, profile: { user_id: 'bot' }, port: 0, store, ownerUids: ['owner'] });
  await new Promise((resolve) => server.once('listening', resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}`);

  try {
    const hello = onceMessage(ws, (msg) => msg.type === 'hello');
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await hello;
    ws.send(JSON.stringify({
      type: 'invoke', reqId: 'cron-admin', method: 'changeGroupName', args: ['Tên mới', 'group-1'],
      auth: { ...auth('owner', 0, { confirmed: true }), cronJobId: 'job-9' },
    }));
    assert.equal((await onceMessage(ws, (msg) => msg.type === 'ack' && msg.reqId === 'cron-admin')).ok, true);
    assert.equal(store.getAuditTrail('cron-admin')[0].targetSummary.cronJobId, 'job-9');
  } finally {
    ws.close();
    stopHermesBridge();
  }
});
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `node --test zalo-policy.test.js hermes-bridge.test.js`
Expected: FAIL — `group-1` của `system` trả `auth_required`; `history` của public trả `owner_required`; hai test bridge hỏng (`ack.ok` false, `cronJobId` undefined).

- [ ] **Step 3: Sửa `zalo-policy.js`**

Trong `classify`, đổi dòng `history`:

```js
  if (command.type === 'history') return { minimumRole: 'public', category: 'read', dangerous: false };
```

Thay chữ ký và nhánh `system` của `authorizeBridgeCommand`:

```js
export function authorizeBridgeCommand(command, { ownerUids = new Set() } = {}) {
  const rule = classify(command || {});
  if (!rule) return denied('public', 'command_denied', 'unknown');
  if (rule.minimumRole === 'system') return allowed('system', rule.category);

  const auth = command?.auth;
  const owners = ownerUids instanceof Set ? ownerUids : new Set(ownerUids || []);
  if (auth?.actorRole === 'system') {
    // Ngoài lượt chat (cron, gửi bù sau khi gateway khởi động lại, thông báo)
    // không có người gửi. Cầu nối chỉ nhận kết nối có token từ chính Hermes,
    // nên vai trò này tới được mọi hội thoại — nhưng chỉ để gửi chữ hoặc báo
    // đang gõ, không gọi hàm Zalo, không đọc lịch sử, không thu hồi.
    return ['send', 'typing'].includes(command.type)
      ? allowed('system', rule.category)
      : denied('system', 'auth_required', rule.category);
  }
```

(Phần còn lại của hàm giữ nguyên.)

- [ ] **Step 4: Sửa `hermes-bridge.js`**

1. Xoá dòng `let activeHomeChannel = '';` (dòng 110).
2. Trong tham số `startHermesBridge`, xoá dòng `  homeChannel = process.env.ZALO_HOME_CHANNEL,` (dòng 314).
3. Xoá dòng `  activeHomeChannel = String(homeChannel || '').trim();` (dòng 325).
4. Dòng 664 đổi thành:

```js
  const authorization = authorizeBridgeCommand(cmd, { ownerUids: activeOwnerUids });
```

5. Trong `auditTargetSummary`, thêm trường `cronJobId` vào object `summary`:

```js
  const summary = {
    commandType: String(cmd.type || ''),
    method: cmd.type === 'invoke' ? String(cmd.method || '') : undefined,
    threadId: cmd.threadId == null
      ? (invokeThreadId == null ? undefined : String(invokeThreadId))
      : String(cmd.threadId),
    threadType: cmd.threadType == null
      ? (invokeThreadId == null ? undefined : 1)
      : Number(cmd.threadType),
    cronJobId: cmd.auth?.cronJobId ? String(cmd.auth.cronJobId) : undefined,
  };
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `node --test`
Expected: PASS toàn bộ — `# tests 116`, `# fail 0` (mốc 113, thay 1 test system bằng 2 test policy, thêm 2 test bridge).

Run: `grep -n "homeChannel" zalo-policy.js hermes-bridge.js zalo-policy.test.js`
Expected: không còn dòng nào.

- [ ] **Step 6: Commit**

```bash
git add zalo-policy.js hermes-bridge.js zalo-policy.test.js hermes-bridge.test.js
git commit -m "fix(sidecar): cho tin system tới mọi hội thoại, mở history trong đúng hội thoại

Cron và câu trả lời gửi bù sau khi gateway khởi động lại không có người gửi
nên mang vai trò system; luật cũ chỉ cho system tới chủ nhân hoặc kênh nhà,
làm 18 lần gửi vào nhóm bị chặn (audit_log Lăng Tiêu 08-11/09). Audit ghi
thêm mã cron phát lệnh.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Adapter — bỏ khung tiếng Anh của cron, lỗi gắn danh tính rơi về `public`, nhớ tên người gửi

**Files:**
- Modify: `hermes-plugin/zalo/adapter.py` (hằng số gần `HERMES_PLAIN_FALLBACK_MARKER`, `_on_message` dict `turn`, `_bind_turn_for_source` nhánh `except`, `send`)
- Modify: `hermes-plugin/zalo_tools/tools.py` (`set_turn_context`)
- Test: `test_zalo_adapter.py` (lớp `ZaloAdapterMediaContextTest`)

**Interfaces:**
- Consumes: không có.
- Produces: turn dict có thêm khoá `"sender_name"` (chuỗi); `set_turn_context(..., sender_name: str = "")`.

- [ ] **Step 1: Viết test hỏng**

Thêm vào lớp `ZaloAdapterMediaContextTest`, ngay sau `test_send_strips_hermes_plain_text_fallback_marker`:

```python
    async def test_send_strips_hermes_cron_wrapper_but_keeps_normal_text(self):
        adapter = self.make_adapter()
        sent = []

        async def fake_command(command, expect_ack=False):
            sent.append(command)
            return {"ok": True, "msgId": "cron-1"}

        adapter._command = fake_command
        wrapped = (
            "Cronjob Response: Nhắc họp\n(job_id: abc123)\n-------------\n\n"
            "Mai 7h30 họp chi đoàn nhé!\n\n"
            'To stop or manage this job, send me a new message (e.g. "stop reminder Nhắc họp").'
        )
        await adapter.send("9133571695356732407", wrapped, metadata={"chat_type": "group", "job_id": "abc123"})
        await adapter.send(
            "9133571695356732407", "Cronjob Response: là tên một mục trong báo cáo",
            metadata={"chat_type": "group"},
        )

        self.assertEqual(sent[0]["text"], "Mai 7h30 họp chi đoàn nhé!")
        self.assertEqual(sent[1]["text"], "Cronjob Response: là tên một mục trong báo cáo")

    async def test_turn_binding_failure_falls_back_to_public_not_system(self):
        adapter = self.make_adapter()

        class ExplodingTurns(dict):
            def get(self, *_args, **_kwargs):
                raise RuntimeError("hỏng bảng lượt")

        adapter._turns = ExplodingTurns()
        source = adapter.build_source(
            chat_id="group-1", chat_name="group-1", chat_type="group",
            user_id="2222222222222222222", user_name="M", message_id="m-x",
        )
        with patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            toolsets = adapter.toolsets_for_source(source)
            auth = zalo_tools.current_authorization()

        self.assertEqual(toolsets, [zalo_adapter.TOOLSET_PUBLIC])
        self.assertEqual(auth["actorRole"], "public")
        self.assertEqual(auth["actorUid"], "2222222222222222222")
        self.assertEqual(auth["sourceThreadId"], "group-1")

    async def test_turn_remembers_sender_display_name(self):
        adapter = self.make_adapter()
        adapter.handle_message = lambda _event: asyncio.sleep(0)
        frame = {**self.group_frame("m-name", "2222222222222222222", "@Lăng Tiêu nhắc họp"), "senderName": "Hoàng Yến"}
        with patch.object(adapter, "_is_owner", return_value=False), \
                patch.object(zalo_adapter, "_zalo_tools", return_value=zalo_tools):
            await adapter._on_message(frame)

        self.assertEqual(zalo_tools._turn()["sender_name"], "Hoàng Yến")
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter.ZaloAdapterMediaContextTest -v`
Expected: FAIL ở 3 test mới (text còn khung tiếng Anh; `actorRole` là `system`; `KeyError: 'sender_name'`).

- [ ] **Step 3: Sửa `tools.py` — `set_turn_context` nhận tên người gửi**

```python
def set_turn_context(*, sender_uid: str, thread_id: str, is_group: bool,
                     is_owner: bool, text: str = "", reply_msg_id: str = "",
                     reply_cli_msg_id: str = "", reply_is_own: bool = False,
                     msg_id: str = "", sender_name: str = "") -> None:
```

và trong dict `_TURN.set({...})` thêm dòng:

```python
        "sender_name": str(sender_name or ""),
```

- [ ] **Step 4: Sửa `adapter.py`**

1. Ngay dưới `HERMES_PLAIN_FALLBACK_MARKER = "(Response formatting failed, plain text:)"` thêm:

```python
# Lõi Hermes bọc kết quả cron trong một khung tiếng Anh (cron.wrap_response,
# mặc định bật cho mọi nền tảng). Trong nhóm Zalo khung đó chỉ là chữ lạ kèm mã
# job — bỏ ở đây để Telegram vẫn giữ nguyên cấu hình chung. Bắt cả dòng
# "(job_id: …)" để không cắt nhầm tin thường tình cờ mở đầu bằng cùng chữ.
_CRON_WRAPPER_RE = re.compile(
    r"\ACronjob Response: [^\n]*\n\(job_id: [^)\n]*\)\n-{5,}\n\n(?P<body>.*?)"
    r"(?:\n\nTo stop or manage this job, send me a new message[^\n]*)?\Z",
    re.DOTALL,
)
```

2. Trong `send`, ngay sau khối bỏ `HERMES_PLAIN_FALLBACK_MARKER`:

```python
        if content:
            wrapped = _CRON_WRAPPER_RE.match(content)
            if wrapped:
                content = wrapped.group("body").strip()
```

3. Trong `_on_message`, dict `turn` thêm khoá (đặt ngay sau `"sender_uid": sender_uid,`):

```python
            "sender_name": sender_name,
```

4. Thay nhánh `except` của `_bind_turn_for_source`:

```python
        except Exception as exc:
            # Gateway nuốt ngoại lệ của toolsets_for_source rồi rơi về bộ công
            # cụ mặc định — không được để chuyện đó xảy ra vì lỗi ở đây.
            logger.warning("[zalo] không gắn được danh tính lượt: %s", exc)
            try:
                # Rơi về quyền công khai của đúng người và hội thoại này, KHÔNG
                # rơi về lượt rỗng: lượt rỗng mang vai trò system, mà system gửi
                # được tới mọi hội thoại.
                _zalo_tools().bind_turn({
                    "sender_uid": uid,
                    "thread_id": str(getattr(source, "chat_id", "") or ""),
                    "is_group": str(getattr(source, "chat_type", "") or "") == "group",
                    "is_owner": False,
                    "text": "",
                })
            except Exception:
                pass
            return False
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter -v`
Expected: PASS toàn bộ (48 test).

- [ ] **Step 6: Commit**

```bash
git add hermes-plugin/zalo/adapter.py hermes-plugin/zalo_tools/tools.py test_zalo_adapter.py
git commit -m "fix(adapter): bỏ khung tiếng Anh của tin cron, lỗi gắn danh tính rơi về public

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Gắn danh tính cho lượt chạy cron

**Files:**
- Modify: `hermes-plugin/zalo_tools/tools.py` (mục mới sau `clear_active_adapter`; `current_authorization`; `register_tools`)
- Test: `test_zalo_adapter.py` (import + lớp dùng chung + lớp `ZaloCronTurnTest` mới)

**Interfaces:**
- Consumes: turn dict có `sender_name` (Task 2).
- Produces:
  - `GROUP_CRON_SCOPE = "group"`
  - `_cron_jobs()` → module `cron.jobs` (test thay bằng `FakeCronJobs`)
  - `_cron_job_id(kw: Dict[str, Any]) -> str`
  - `_cron_target(job: Dict[str, Any]) -> str`
  - `_is_group_cron(job: Dict[str, Any]) -> bool`
  - `_allowed_owner_uids() -> List[str]`
  - `_cron_turn(kw: Dict[str, Any]) -> Optional[Dict[str, Any]]` — turn có khoá `cron_job_id`
  - `_with_cron_turn(handler, tool_name: str)` — lớp bọc async ngoài cùng
  - `current_authorization()` thêm `cronJobId` khi turn có `cron_job_id`
  - Trong test: `FakeCronJobs`, `FakeToolContext` ở cấp module

- [ ] **Step 1: Thêm lớp giả dùng chung vào `test_zalo_adapter.py`**

Ngay dưới `from plugins.zalo_tools import tools as zalo_tools` thêm:

```python
from cron import jobs as real_cron_jobs
```

Ngay dưới lớp `CapturingSocket` thêm:

```python
class FakeToolContext:
    def __init__(self):
        self.handlers = {}

    def register_tool(self, **kwargs):
        self.handlers[kwargs["name"]] = kwargs["handler"]


class FakeCronJobs:
    """Thay module cron.jobs của Hermes trong test — giữ job trong bộ nhớ."""

    parse_schedule = staticmethod(real_cron_jobs.parse_schedule)
    is_terminal_job = staticmethod(real_cron_jobs.is_terminal_job)
    effective_job_state = staticmethod(real_cron_jobs.effective_job_state)
    _ensure_croniter = staticmethod(real_cron_jobs._ensure_croniter)

    def __init__(self, jobs=None):
        self.jobs = [dict(job) for job in (jobs or [])]
        self.created = []
        self.removed = []

    @property
    def croniter(self):
        return real_cron_jobs.croniter

    def get_job(self, job_id):
        return next((job for job in self.jobs if job["id"] == job_id), None)

    def list_jobs(self, include_disabled=False):
        return [job for job in self.jobs if include_disabled or job.get("enabled", True)]

    def create_job(self, **kwargs):
        self.created.append(kwargs)
        job = {
            "id": f"new-{len(self.created)}", "enabled": True, "name": kwargs.get("name"),
            "schedule_display": kwargs["schedule"], "next_run_at": None,
            "prompt": kwargs["prompt"], "deliver": kwargs["deliver"], "origin": kwargs["origin"],
        }
        self.jobs.append(job)
        return job

    def remove_job(self, job_id):
        self.removed.append(job_id)
        before = len(self.jobs)
        self.jobs = [job for job in self.jobs if job["id"] != job_id]
        return len(self.jobs) < before
```

- [ ] **Step 2: Viết test hỏng**

Thêm lớp mới ngay trước `if __name__ == "__main__":`:

```python
class ZaloCronTurnTest(unittest.IsolatedAsyncioTestCase):
    OWNER = "9200000000000000001"
    GROUP = "9133000000000000001"
    MEMBER = "3900000000000000001"

    def setUp(self):
        self.turn_token = zalo_tools._TURN.set(None)
        self.previous_adapter = zalo_tools._ACTIVE_ADAPTER
        zalo_tools._ACTIVE_ADAPTER = None
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": self.OWNER}))

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)
        zalo_tools._ACTIVE_ADAPTER = self.previous_adapter

    def fake_jobs(self):
        return FakeCronJobs([
            {"id": "owner-job", "deliver": f"zalo:{self.GROUP}",
             "origin": {"platform": "zalo", "chat_id": self.GROUP, "user_id": "someone-else"}},
            {"id": "group-job", "deliver": f"zalo:{self.GROUP}",
             "origin": {"platform": "zalo", "chat_id": self.GROUP, "chat_type": "group",
                        "zalo_scope": "group", "zalo_creator_uid": self.MEMBER, "zalo_creator_name": "Yến"}},
            {"id": "telegram-job", "deliver": "telegram:8617174143",
             "origin": {"platform": "telegram", "chat_id": "8617174143"}},
        ])

    @staticmethod
    async def probe(_args, **_kw):
        return json.dumps({"turn": zalo_tools._turn(), "auth": zalo_tools.current_authorization()})

    async def call(self, task_id, jobs):
        guarded = zalo_tools._with_cron_turn(self.probe, "probe")
        with patch.object(zalo_tools, "_cron_jobs", return_value=jobs):
            return json.loads(await guarded({}, task_id=task_id))

    async def test_owner_created_cron_runs_as_owner_in_its_target_chat(self):
        seen = await self.call("cron:owner-job:run-1", self.fake_jobs())

        self.assertTrue(seen["turn"]["is_owner"])
        self.assertEqual(seen["turn"]["sender_uid"], self.OWNER)
        self.assertEqual(seen["turn"]["thread_id"], self.GROUP)
        self.assertTrue(seen["turn"]["is_group"])
        self.assertEqual(seen["turn"]["text"], "")
        self.assertEqual(seen["auth"]["actorRole"], "owner")
        self.assertEqual(seen["auth"]["sourceThreadType"], zalo_tools.THREAD_GROUP)
        self.assertEqual(seen["auth"]["cronJobId"], "owner-job")

    async def test_group_cron_runs_as_its_creator_locked_to_that_group(self):
        seen = await self.call("cron:group-job:run-1", self.fake_jobs())

        self.assertFalse(seen["turn"]["is_owner"])
        self.assertEqual(seen["turn"]["sender_uid"], self.MEMBER)
        self.assertEqual(seen["turn"]["sender_name"], "Yến")
        self.assertEqual(seen["auth"]["actorRole"], "public")
        self.assertEqual(seen["auth"]["sourceThreadId"], self.GROUP)
        self.assertEqual(seen["auth"]["cronJobId"], "group-job")

    async def test_non_cron_task_missing_job_or_non_zalo_job_get_no_turn(self):
        jobs = self.fake_jobs()
        for task_id in ("session-abc", "cron:missing:run-1", "cron:telegram-job:run-1", ""):
            with self.subTest(task_id=task_id):
                seen = await self.call(task_id, jobs)
                self.assertEqual(seen["turn"], {})
                self.assertEqual(seen["auth"]["actorRole"], "system")

    async def test_owner_cron_without_allowlist_gets_no_owner_turn(self):
        with patch.dict(os.environ, {"ZALO_ALLOWED_USERS": ""}):
            seen = await self.call("cron:owner-job:run-1", self.fake_jobs())

        self.assertEqual(seen["turn"], {})

    async def test_existing_chat_turn_is_never_replaced(self):
        chat = zalo_tools._TURN.set({
            "sender_uid": self.MEMBER, "thread_id": "other", "is_group": True, "is_owner": False, "text": "hi",
        })
        try:
            seen = await self.call("cron:owner-job:run-1", self.fake_jobs())
        finally:
            zalo_tools._TURN.reset(chat)

        self.assertFalse(seen["turn"]["is_owner"])
        self.assertEqual(seen["turn"]["thread_id"], "other")

    async def test_turn_is_restored_after_the_cron_call(self):
        await self.call("cron:owner-job:run-1", self.fake_jobs())

        self.assertEqual(zalo_tools._turn(), {})

    async def test_registered_owner_tool_works_inside_owner_cron(self):
        class FakeAdapter:
            async def read_history(self, chat_id, count, metadata=None):
                self.call = (chat_id, count, metadata)
                return {"ok": True, "result": {"messages": []}}

        ctx, fake = FakeToolContext(), FakeAdapter()
        zalo_tools.register_tools(ctx)
        zalo_tools._ACTIVE_ADAPTER = fake
        with patch.object(zalo_tools, "_cron_jobs", return_value=self.fake_jobs()):
            response = await ctx.handlers["zalo_read_history"](
                {"thread_id": self.GROUP, "thread_kind": "group", "count": 5},
                task_id="cron:owner-job:run-1",
            )

        self.assertTrue(json.loads(response)["success"], response)
        self.assertEqual(fake.call, (self.GROUP, 5, {"chat_type": "group"}))
```

- [ ] **Step 3: Chạy test, xác nhận hỏng**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter.ZaloCronTurnTest -v`
Expected: FAIL — `AttributeError: module ... has no attribute '_with_cron_turn'`.

- [ ] **Step 4: Viết mục gắn danh tính cron trong `tools.py`**

Chèn ngay sau hàm `clear_active_adapter` (trước `def _err`):

```python
# =====================================================================
#  Lượt chạy cron — gắn danh tính khi không có tin nhắn nào
# =====================================================================
#
# Cron chạy không kèm tin nhắn nên _TURN rỗng và mọi công cụ Zalo tự chặn.
# Hermes truyền `task_id = "cron:<job_id>:<lần chạy>"` vào từng lời gọi công
# cụ (cron/scheduler.py), nên đọc lại job là biết cron này gửi về đâu, do ai tạo.
#
# Job tạo bằng công cụ cron gốc của Hermes — chỉ chủ nhân cầm công cụ đó — chạy
# với quyền chủ nhân. Job do zalo_group_cron tạo mang `origin.zalo_scope =
# "group"` và chạy với quyền công khai của người tạo, khoá trong đúng nhóm.
# KHÔNG dựa vào origin.user_id: trong nhóm dùng chung phiên, Hermes có thể ghi
# vào đó UID của một thành viên khác.

GROUP_CRON_SCOPE = "group"


def _cron_jobs():
    """Module quản lý job cron của Hermes — tách thành hàm để test thay được."""
    from cron import jobs
    return jobs


def _cron_job_id(kw: Dict[str, Any]) -> str:
    parts = str(kw.get("task_id") or "").split(":")
    return parts[1] if len(parts) >= 2 and parts[0] == "cron" and parts[1] else ""


def _cron_target(job: Dict[str, Any]) -> str:
    """Hội thoại Zalo mà job gửi kết quả về; rỗng nếu job không gửi về Zalo."""
    for part in str(job.get("deliver") or "").split(","):
        part = part.strip()
        if part.startswith("zalo:"):
            return part[len("zalo:"):].split(":", 1)[0]
    origin = job.get("origin")
    if isinstance(origin, dict) and str(origin.get("platform") or "") == "zalo":
        return str(origin.get("chat_id") or "")
    return ""


def _is_group_cron(job: Dict[str, Any]) -> bool:
    origin = job.get("origin")
    return isinstance(origin, dict) and origin.get("zalo_scope") == GROUP_CRON_SCOPE


def _allowed_owner_uids() -> List[str]:
    from agent.secret_scope import UnscopedSecretError, get_secret
    try:
        raw = get_secret("ZALO_ALLOWED_USERS", "")
    except UnscopedSecretError:
        raw = os.getenv("ZALO_ALLOWED_USERS", "")
    return [uid.strip() for uid in str(raw or "").split(",") if uid.strip()]


def _cron_is_group(target: str, origin: Dict[str, Any], owners: List[str]) -> bool:
    known = getattr(_ACTIVE_ADAPTER, "_known_thread_types", None) or {}
    if target in known:
        return known[target] == THREAD_GROUP
    chat_type = str(origin.get("chat_type") or "").lower()
    if chat_type in {"group", "dm"}:
        return chat_type == "group"
    if target in owners:
        return False
    return len(target) >= 19


def _cron_turn(kw: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Dựng turn cho lời gọi công cụ đến từ cron; None nghĩa là không gắn gì."""
    job_id = _cron_job_id(kw)
    if not job_id:
        return None
    try:
        job = _cron_jobs().get_job(job_id)
    except Exception as exc:
        logger.warning("[zalo] không đọc được job cron %s: %s", job_id, exc)
        return None
    if not job:
        return None
    target = _cron_target(job)
    if not target:
        return None
    origin = job.get("origin") if isinstance(job.get("origin"), dict) else {}

    if _is_group_cron(job):
        creator = str(origin.get("zalo_creator_uid") or "")
        if not creator:
            return None
        return {
            "sender_uid": creator,
            "sender_name": str(origin.get("zalo_creator_name") or ""),
            "thread_id": target,
            "is_group": True,
            "is_owner": False,
            "text": "",
            "cron_job_id": job_id,
        }

    owners = _allowed_owner_uids()
    if not owners:
        return None
    return {
        "sender_uid": owners[0],
        "sender_name": "",
        "thread_id": target,
        "is_group": _cron_is_group(target, origin, owners),
        "is_owner": True,
        # Không có tin người thật gõ: mã duyệt đăng Fanpage không bao giờ khớp.
        "text": "",
        "cron_job_id": job_id,
    }


def _with_cron_turn(handler, tool_name: str):
    """Lớp bọc ngoài cùng: gắn danh tính cho lời gọi công cụ từ một lượt cron.

    Lượt chat đang có thì giữ nguyên — không bao giờ ghi đè người gửi thật.
    """
    async def guarded(args: Dict[str, Any], **kw) -> str:
        if _turn():
            return await handler(args, **kw)
        turn = _cron_turn(kw)
        if turn is None:
            return await handler(args, **kw)
        token = _TURN.set(turn)
        try:
            return await handler(args, **kw)
        finally:
            _TURN.reset(token)

    guarded.__name__ = getattr(handler, "__name__", tool_name)
    guarded.__doc__ = getattr(handler, "__doc__", None)
    return guarded
```

- [ ] **Step 5: `current_authorization` mang mã cron**

Thay phần `return {...}` cuối của `current_authorization`:

```python
    auth = {
        "actorUid": str(turn.get("sender_uid") or ""),
        "actorRole": "owner" if turn.get("is_owner") else "public",
        "sourceThreadId": str(turn.get("thread_id") or ""),
        "sourceThreadType": THREAD_GROUP if turn.get("is_group") else THREAD_USER,
        "confirmed": bool(confirmed),
    }
    if turn.get("cron_job_id"):
        auth["cronJobId"] = str(turn["cron_job_id"])
    return auth
```

- [ ] **Step 6: `register_tools` bọc mọi công cụ bằng `_with_cron_turn`**

Thay thân vòng lặp trong `register_tools`:

```python
    counts = {TOOLSET_PUBLIC: 0, TOOLSET_OWNER: 0}
    for name, emoji, schema, handler, toolset in TOOLS:
        guarded = handler
        if toolset == TOOLSET_OWNER:
            guarded = _owner_only(
                _confirmed_action(
                    _dm_only(handler, name) if name in DM_ONLY_TOOLS else handler,
                    name,
                ),
                name,
            )
        try:
            ctx.register_tool(
                name=name,
                toolset=toolset,
                schema=schema,
                handler=_with_cron_turn(guarded, name),
                is_async=True,
                description=schema["description"],
                emoji=emoji,
            )
            counts[toolset] = counts.get(toolset, 0) + 1
        except Exception as exc:  # pragma: no cover — đăng ký hỏng không được làm chết plugin
            logger.warning("[zalo] không đăng ký được công cụ %s: %s", name, exc)
```

(Dòng `logger.info("[zalo] đã đăng ký ...")` phía sau giữ nguyên.)

- [ ] **Step 7: Chạy test, xác nhận xanh**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter -v`
Expected: PASS toàn bộ (55 test).

- [ ] **Step 8: Commit**

```bash
git add hermes-plugin/zalo_tools/tools.py test_zalo_adapter.py
git commit -m "feat(zalo-tools): gắn danh tính cho lượt chạy cron qua task_id

Job từ công cụ cron gốc chạy với quyền chủ nhân; job zalo_scope=group chạy
với quyền công khai của người tạo, khoá trong nhóm. Auth mang cronJobId.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `zalo_group_history`, toolset `zalo_cron` / `zalo_cron_member`, trình cài biết toolset mới

**Files:**
- Modify: `hermes-plugin/zalo_tools/tools.py` (hằng số toolset, hàm `zalo_group_history`, mục `TOOLS`, hàm `define_cron_member_toolset`, log trong `register_tools`)
- Modify: `hermes-plugin/zalo_tools/__init__.py`
- Modify: `scripts/hermes-install-lib.js` (`mergeHermesConfig`, `doctorHermes`)
- Test: `test_zalo_adapter.py`, `scripts/hermes-install-lib.test.js`

**Interfaces:**
- Consumes: `_with_cron_turn`, `_cron_jobs`, `FakeCronJobs`, `FakeToolContext`, lớp `ZaloCronTurnTest` (Task 3).
- Produces:
  - `TOOLSET_CRON = "zalo_cron"`, `TOOLSET_CRON_MEMBER = "zalo_cron_member"`
  - `CRON_MEMBER_TOOLS = ("zalo_web_search", "zalo_web_read", "zalo_kb_list", "zalo_kb_read", "zalo_group_history")`
  - `async zalo_group_history(args, **_kw) -> str`
  - `define_cron_member_toolset() -> None`

- [ ] **Step 1: Viết test hỏng**

Trong `ZaloToolSchemaTest.test_every_zalo_tool_has_one_unique_public_or_owner_assignment`, thay hai khẳng định cuối:

```python
        self.assertEqual(set(assignments), {
            zalo_tools.TOOLSET_PUBLIC, zalo_tools.TOOLSET_OWNER, zalo_tools.TOOLSET_CRON,
        })
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_PUBLIC), 14)
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_OWNER), 31)
        self.assertEqual(assignments.count(zalo_tools.TOOLSET_CRON), 1)
```

Thêm vào `ZaloToolSchemaTest`:

```python
    def test_cron_member_toolset_holds_only_safe_group_tools(self):
        from toolsets import resolve_toolset

        zalo_tools.define_cron_member_toolset()

        self.assertEqual(set(resolve_toolset(zalo_tools.TOOLSET_CRON_MEMBER, include_registry=False)), {
            "zalo_web_search", "zalo_web_read", "zalo_kb_list", "zalo_kb_read", "zalo_group_history",
        })
```

Thêm vào `ZaloCronTurnTest`:

```python
    async def test_group_history_reads_only_the_cron_group_and_ignores_model_thread_id(self):
        class FakeAdapter:
            async def read_history(self, chat_id, count, metadata=None):
                self.call = (chat_id, count, metadata)
                return {"ok": True, "result": {"messages": [{"msgId": "m1"}]}}

        ctx, fake = FakeToolContext(), FakeAdapter()
        zalo_tools.register_tools(ctx)
        zalo_tools._ACTIVE_ADAPTER = fake
        with patch.object(zalo_tools, "_cron_jobs", return_value=self.fake_jobs()):
            response = await ctx.handlers["zalo_group_history"](
                {"count": 500, "thread_id": "other-group"}, task_id="cron:group-job:run-1",
            )

        self.assertTrue(json.loads(response)["success"], response)
        self.assertEqual(fake.call, (self.GROUP, 100, {"chat_type": "group"}))

    async def test_group_history_refuses_outside_cron(self):
        chat = zalo_tools._TURN.set({
            "sender_uid": self.MEMBER, "thread_id": self.GROUP, "is_group": True, "is_owner": False, "text": "đọc nhóm",
        })
        try:
            response = await zalo_tools.zalo_group_history({})
        finally:
            zalo_tools._TURN.reset(chat)

        self.assertFalse(json.loads(response)["success"])
```

Trong `scripts/hermes-install-lib.test.js`, test `'mergeHermesConfig adds safe defaults and preserves customer values'`, đổi dòng 74:

```js
  assert.deepEqual(config.known_plugin_toolsets.zalo, ['customer_tool', 'zalo_owner', 'zalo_public', 'zalo_cron']);
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter -v`
Expected: FAIL — `AttributeError: ... 'TOOLSET_CRON'`.

Run: `node --test scripts/hermes-install-lib.test.js`
Expected: FAIL ở test `mergeHermesConfig adds safe defaults...` (thiếu `zalo_cron`).

- [ ] **Step 3: Hằng số toolset trong `tools.py`**

Ngay sau dòng `TOOLSET_OWNER = "zalo_owner"` thêm:

```python
# Công cụ chỉ có nghĩa trong lượt chạy cron. Không nằm trong bộ nào
# toolsets_for_source trả về, nên chat thường không bao giờ thấy.
TOOLSET_CRON = "zalo_cron"
# Toolset ghép cho việc hẹn giờ do thành viên nhóm tạo: tra cứu và đọc lịch sử
# chính nhóm đó, không có gì khác. Xem define_cron_member_toolset().
TOOLSET_CRON_MEMBER = "zalo_cron_member"
CRON_MEMBER_TOOLS = (
    "zalo_web_search", "zalo_web_read", "zalo_kb_list", "zalo_kb_read", "zalo_group_history",
)
```

- [ ] **Step 4: Hàm `zalo_group_history`**

Chèn ngay sau hàm `zalo_read_history`:

```python
async def zalo_group_history(args: Dict[str, Any], **_kw) -> str:
    """Đọc lịch sử của đúng hội thoại mà lượt cron này gửi kết quả về.

    Không nhận `thread_id` từ mô hình: hội thoại lấy từ turn do _with_cron_turn
    dựng từ job, nên prompt của thành viên có viết gì cũng không đọc được nhóm khác.
    """
    turn = _turn()
    if not turn.get("cron_job_id"):
        return _err("công cụ này chỉ dùng trong việc hẹn giờ của nhóm")
    thread_id = str(turn.get("thread_id") or "")
    if not thread_id:
        return _err("không xác định được nhóm của việc hẹn giờ")
    adapter = _ACTIVE_ADAPTER
    if adapter is None:
        return _err("Zalo chưa kết nối")
    count = max(1, min(int(args.get("count", 30) or 30), 100))
    ack = await adapter.read_history(
        thread_id, count, metadata={"chat_type": "group" if turn.get("is_group") else "dm"}
    )
    if not ack or not ack.get("ok"):
        return _err((ack or {}).get("error", "không đọc được lịch sử Zalo"))
    return _ok(ack.get("result"))
```

- [ ] **Step 5: Khai báo công cụ trong `TOOLS`**

Chèn ngay sau mục `zalo_read_history` trong danh sách `TOOLS`:

```python
    ("zalo_group_history", "🗒️", _schema(
        "zalo_group_history",
        "Chỉ dùng trong việc hẹn giờ của nhóm: đọc các tin gần đây của chính nhóm "
        "mà việc hẹn giờ này gửi kết quả về, để tóm tắt hay nhắc lại cho đúng.",
        {"count": {"type": "integer", "description": "Số tin muốn đọc (tối đa 100, mặc định 30)."}},
        [],
    ), zalo_group_history, TOOLSET_CRON),
```

- [ ] **Step 6: Hàm `define_cron_member_toolset` và log đăng ký**

Chèn ngay sau hàm `define_platform_composite`:

```python
def define_cron_member_toolset() -> None:
    """Định nghĩa toolset ``zalo_cron_member`` cho việc hẹn giờ do thành viên tạo.

    Job của thành viên ghim ``enabled_toolsets = [zalo_cron_member, no_mcp]``,
    nên lúc chạy agent chỉ cầm đúng CRON_MEMBER_TOOLS — không terminal, không
    đọc tệp, không MCP, không nhắm hội thoại khác.
    """
    try:
        from toolsets import create_custom_toolset
    except ImportError as exc:
        logger.warning("[zalo] không định nghĩa được %s: %s", TOOLSET_CRON_MEMBER, exc)
        return

    create_custom_toolset(
        name=TOOLSET_CRON_MEMBER,
        description="Công cụ cho việc hẹn giờ do thành viên nhóm Zalo tạo.",
        tools=list(CRON_MEMBER_TOOLS),
        includes=[],
    )
    try:
        import toolsets as _ts
        _ts._resolve_toolset_memo.clear()
    except Exception:
        pass
```

Trong `register_tools`, đổi `counts` và dòng log:

```python
    counts = {TOOLSET_PUBLIC: 0, TOOLSET_OWNER: 0, TOOLSET_CRON: 0}
```

```python
    logger.info(
        "[zalo] đã đăng ký %d công cụ — %d công khai, %d chỉ chủ nhân, %d cho cron",
        sum(counts.values()), counts.get(TOOLSET_PUBLIC, 0), counts.get(TOOLSET_OWNER, 0),
        counts.get(TOOLSET_CRON, 0),
    )
```

- [ ] **Step 7: `__init__.py` gọi định nghĩa toolset mới**

```python
from .tools import define_cron_member_toolset, define_platform_composite, register_tools

__all__ = ["register"]


def register(ctx) -> None:
    """Điểm vào plugin — Hermes gọi lúc khám phá."""
    register_tools(ctx)
    # Phải chạy sau register_tools: định nghĩa dựa trên bộ công cụ lõi và
    # cần dọn bộ nhớ đệm của resolve_toolset sau khi registry đã đổi.
    define_platform_composite()
    define_cron_member_toolset()
```

(Giữ nguyên docstring đầu tệp.)

- [ ] **Step 8: Trình cài biết `zalo_cron`**

Trong `scripts/hermes-install-lib.js`, `mergeHermesConfig`:

```js
  ensureListItems(['known_plugin_toolsets', 'zalo'], ['zalo_owner', 'zalo_public', 'zalo_cron']);
```

Trong `doctorHermes`, mục `config`:

```js
  add('config', Boolean(config) && enabled.includes(PLATFORM_KEY) && enabled.includes(TOOLS_KEY)
    && known.includes('zalo_owner') && known.includes('zalo_public') && known.includes('zalo_cron'));
```

- [ ] **Step 9: Chạy test, xác nhận xanh**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter -v`
Expected: PASS toàn bộ (58 test).

Run: `node --test scripts/hermes-install-lib.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 10: Commit**

```bash
git add hermes-plugin/zalo_tools/tools.py hermes-plugin/zalo_tools/__init__.py scripts/hermes-install-lib.js scripts/hermes-install-lib.test.js test_zalo_adapter.py
git commit -m "feat(zalo-tools): zalo_group_history và toolset zalo_cron_member cho cron nhóm

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Công cụ `zalo_group_cron` (tạo, xem, xoá)

**Files:**
- Modify: `hermes-plugin/zalo_tools/tools.py` (mục "Nhóm 11" trước `def _schema`; mục `TOOLS`)
- Test: `test_zalo_adapter.py` (lớp `ZaloGroupCronTest` mới; số công cụ công khai 14 → 15)

**Interfaces:**
- Consumes: `_cron_jobs`, `_cron_target`, `_is_group_cron`, `GROUP_CRON_SCOPE`, `TOOLSET_CRON_MEMBER` (Task 3–4); `tools.cronjob_tools._scan_cron_prompt(prompt: str) -> str` (Hermes; chuỗi khác rỗng = bị chặn); `cron.jobs.create_job(**kwargs) -> dict`, `list_jobs(include_disabled: bool) -> list`, `get_job(job_id) -> dict | None`, `remove_job(job_id) -> bool`, `parse_schedule(str) -> dict`, `is_terminal_job(job) -> bool`, `effective_job_state(job) -> str`.
- Produces: `async zalo_group_cron(args, **_kw) -> str`; `_group_cron_schedule_problem(schedule: dict) -> str`; `_cron_min_gap_minutes(expr: str) -> Optional[float]`.

- [ ] **Step 1: Viết test hỏng**

Trong `test_every_zalo_tool_has_one_unique_public_or_owner_assignment` đổi `14` thành `15`.

Thêm lớp mới ngay trước `if __name__ == "__main__":`:

```python
class ZaloGroupCronTest(unittest.IsolatedAsyncioTestCase):
    OWNER = "9200000000000000001"
    GROUP = "9133000000000000001"
    OTHER_GROUP = "9133000000000000002"
    MEMBER = "3900000000000000001"
    OTHER_MEMBER = "3900000000000000002"

    def setUp(self):
        self.turn_token = zalo_tools._TURN.set(None)
        self.enterContext(patch.dict(os.environ, {"ZALO_ALLOWED_USERS": self.OWNER}))

    def tearDown(self):
        zalo_tools._TURN.reset(self.turn_token)

    def member_turn(self, uid=None, *, is_owner=False, is_group=True, group=None, **extra):
        return {
            "sender_uid": uid or self.MEMBER, "sender_name": "Yến", "thread_id": group or self.GROUP,
            "is_group": is_group, "is_owner": is_owner, "text": "hẹn giờ", **extra,
        }

    async def run_tool(self, args, jobs, turn):
        token = zalo_tools._TURN.set(turn)
        try:
            with patch.object(zalo_tools, "_cron_jobs", return_value=jobs):
                return json.loads(await zalo_tools.zalo_group_cron(args))
        finally:
            zalo_tools._TURN.reset(token)

    @staticmethod
    def group_job(job_id, group, creator, **extra):
        return {
            "id": job_id, "enabled": True, "name": job_id, "deliver": f"zalo:{group}",
            "prompt": "Việc hẹn giờ do Yến tạo\n---\nNhắc họp",
            "origin": {"platform": "zalo", "chat_id": group, "chat_type": "group",
                       "zalo_scope": "group", "zalo_creator_uid": creator, "zalo_creator_name": "Yến"},
            **extra,
        }

    async def test_create_locks_every_dangerous_field(self):
        jobs = FakeCronJobs()
        result = await self.run_tool({
            "action": "create", "prompt": "Tóm tắt các việc cả nhóm đã hẹn trong ngày",
            "schedule": "every day at 9pm", "name": "Tóm tắt tối",
        }, jobs, self.member_turn())

        self.assertTrue(result["success"], result)
        created = jobs.created[0]
        self.assertEqual(set(created), {"prompt", "schedule", "name", "repeat", "deliver", "origin", "enabled_toolsets"})
        self.assertEqual(created["deliver"], f"zalo:{self.GROUP}")
        self.assertEqual(created["enabled_toolsets"], ["zalo_cron_member", "no_mcp"])
        self.assertIsNone(created["repeat"])
        self.assertEqual(created["origin"]["zalo_scope"], "group")
        self.assertEqual(created["origin"]["zalo_creator_uid"], self.MEMBER)
        self.assertEqual(created["origin"]["zalo_creator_name"], "Yến")
        self.assertEqual(created["origin"]["chat_id"], self.GROUP)
        self.assertTrue(created["prompt"].endswith("Tóm tắt các việc cả nhóm đã hẹn trong ngày"))

    async def test_create_rejects_schedules_more_often_than_daily(self):
        for schedule in ("every 30m", "every 12h", "0 9,10 * * *", "*/30 * * * *"):
            with self.subTest(schedule=schedule):
                jobs = FakeCronJobs()
                result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": schedule}, jobs, self.member_turn())
                self.assertFalse(result["success"])
                self.assertEqual(jobs.created, [])

    async def test_create_accepts_daily_weekly_and_one_shot_schedules(self):
        for schedule in ("every 1d", "every day at 7am", "0 7 * * 1", "in 2h"):
            with self.subTest(schedule=schedule):
                jobs = FakeCronJobs()
                result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": schedule}, jobs, self.member_turn())
                self.assertTrue(result["success"], result)
        one_shot = FakeCronJobs()
        await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "in 2h"}, one_shot, self.member_turn())
        self.assertEqual(one_shot.created[0]["repeat"], 1)

    async def test_create_rejects_past_one_shot_long_prompt_and_bad_schedule(self):
        cases = (
            {"prompt": "Nhắc họp", "schedule": "2020-01-01T07:30"},
            {"prompt": "x" * 1001, "schedule": "every day at 7am"},
            {"prompt": "Nhắc họp", "schedule": "hôm nào đó"},
            {"prompt": "", "schedule": "every day at 7am"},
        )
        for case in cases:
            with self.subTest(case=case["schedule"]):
                jobs = FakeCronJobs()
                result = await self.run_tool({"action": "create", **case}, jobs, self.member_turn())
                self.assertFalse(result["success"])
                self.assertEqual(jobs.created, [])

    async def test_create_enforces_quota_per_member_and_per_group_but_not_for_owner(self):
        mine = FakeCronJobs([self.group_job(f"m{i}", self.OTHER_GROUP, self.MEMBER) for i in range(3)])
        result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}, mine, self.member_turn())
        self.assertFalse(result["success"])
        self.assertIn("3", result["error"])

        crowded = [self.group_job(f"g{i}", self.GROUP, f"39000000000000001{i:02d}") for i in range(10)]
        result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}, FakeCronJobs(crowded), self.member_turn())
        self.assertFalse(result["success"])
        self.assertIn("10", result["error"])

        finished = FakeCronJobs([
            self.group_job("m0", self.OTHER_GROUP, self.MEMBER),
            self.group_job("m1", self.OTHER_GROUP, self.MEMBER),
            self.group_job("m2", self.OTHER_GROUP, self.MEMBER, state="completed"),
        ])
        result = await self.run_tool({"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}, finished, self.member_turn())
        self.assertTrue(result["success"], result)

        owner = await self.run_tool(
            {"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"},
            FakeCronJobs(crowded), self.member_turn(self.OWNER, is_owner=True),
        )
        self.assertTrue(owner["success"], owner)

    async def test_tool_works_only_in_groups_and_never_inside_cron(self):
        args = {"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}
        dm = await self.run_tool(args, FakeCronJobs(), self.member_turn(is_group=False))
        in_cron = await self.run_tool(args, FakeCronJobs(), self.member_turn(cron_job_id="group-job"))
        listing_in_cron = await self.run_tool({"action": "list"}, FakeCronJobs(), self.member_turn(cron_job_id="group-job"))

        self.assertFalse(dm["success"])
        self.assertFalse(in_cron["success"])
        self.assertFalse(listing_in_cron["success"])

    async def test_create_uses_hermes_prompt_scanner_and_refuses_when_it_is_missing(self):
        args = {"action": "create", "prompt": "Nhắc họp", "schedule": "every day at 7am"}
        with patch("tools.cronjob_tools._scan_cron_prompt", return_value="Blocked: threat"):
            blocked = await self.run_tool(args, FakeCronJobs(), self.member_turn())
        with patch.dict(sys.modules, {"tools.cronjob_tools": None}):
            missing = await self.run_tool(args, FakeCronJobs(), self.member_turn())

        self.assertFalse(blocked["success"])
        self.assertIn("Blocked", blocked["error"])
        self.assertFalse(missing["success"])

    async def test_list_shows_this_group_and_hides_owner_prompts(self):
        jobs = FakeCronJobs([
            {"id": "owner-job", "enabled": True, "name": "Bản tin", "deliver": f"zalo:{self.GROUP}",
             "prompt": "bí mật của chủ nhân", "origin": {"platform": "zalo", "chat_id": self.GROUP}},
            self.group_job("group-job", self.GROUP, self.MEMBER),
            self.group_job("elsewhere", self.OTHER_GROUP, self.MEMBER),
        ])
        result = await self.run_tool({"action": "list"}, jobs, self.member_turn(self.OTHER_MEMBER))

        self.assertTrue(result["success"], result)
        items = {item["job_id"]: item for item in result["result"]["jobs"]}
        self.assertEqual(set(items), {"owner-job", "group-job"})
        self.assertEqual(items["owner-job"]["nguoi_tao"], "chủ nhân")
        self.assertNotIn("noi_dung", items["owner-job"])
        self.assertEqual(items["group-job"]["noi_dung"], "Nhắc họp")
        self.assertNotIn("bí mật", json.dumps(result, ensure_ascii=False))

    async def test_remove_follows_creator_or_owner_rule(self):
        def jobs():
            return FakeCronJobs([
                {"id": "owner-job", "enabled": True, "deliver": f"zalo:{self.GROUP}",
                 "origin": {"platform": "zalo", "chat_id": self.GROUP}},
                self.group_job("group-job", self.GROUP, self.MEMBER),
                self.group_job("elsewhere", self.OTHER_GROUP, self.MEMBER),
            ])

        other = jobs()
        self.assertFalse((await self.run_tool({"action": "remove", "job_id": "group-job"}, other, self.member_turn(self.OTHER_MEMBER)))["success"])
        self.assertEqual(other.removed, [])

        creator = jobs()
        self.assertTrue((await self.run_tool({"action": "remove", "job_id": "group-job"}, creator, self.member_turn()))["success"])
        self.assertEqual(creator.removed, ["group-job"])

        member_vs_owner = jobs()
        self.assertFalse((await self.run_tool({"action": "remove", "job_id": "owner-job"}, member_vs_owner, self.member_turn()))["success"])
        self.assertEqual(member_vs_owner.removed, [])

        owner = jobs()
        self.assertTrue((await self.run_tool({"action": "remove", "job_id": "owner-job"}, owner, self.member_turn(self.OWNER, is_owner=True)))["success"])
        self.assertEqual(owner.removed, ["owner-job"])

        wrong_group = jobs()
        self.assertFalse((await self.run_tool({"action": "remove", "job_id": "elsewhere"}, wrong_group, self.member_turn()))["success"])
        self.assertEqual(wrong_group.removed, [])
```

- [ ] **Step 2: Chạy test, xác nhận hỏng**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter.ZaloGroupCronTest -v`
Expected: FAIL — `AttributeError: ... 'zalo_group_cron'`.

- [ ] **Step 3: Viết mục "Nhóm 11" trong `tools.py`**

Chèn ngay trước `def _schema(`:

```python
# =====================================================================
#  Nhóm 11 — Việc hẹn giờ do thành viên nhóm tạo
# =====================================================================
#
# Công cụ cron gốc của Hermes nhận script, thư mục làm việc, bộ công cụ tuỳ ý —
# đưa cho người ngoài là cho chạy lệnh trên máy. Công cụ này chỉ mở đúng một
# việc: hẹn giờ để bot soạn nội dung rồi gửi vào chính nhóm đang trò chuyện.
# Mọi trường nguy hiểm của job bị khoá cứng ở đây, không nhận từ mô hình.

GROUP_CRON_PROMPT_MAX = 1000
GROUP_CRON_NAME_MAX = 80
GROUP_CRON_MIN_GAP_MINUTES = 1440
GROUP_CRON_PER_CREATOR = 3
GROUP_CRON_PER_GROUP = 10
GROUP_CRON_LOOKAHEAD = 20
_GROUP_CRON_PROMPT_SEPARATOR = "\n---\n"
_GROUP_CRON_TOO_OFTEN = "việc hẹn giờ của nhóm chỉ được lặp tối đa 1 lần mỗi ngày"


def _group_cron_prompt(prompt: str, creator_name: str) -> str:
    who = creator_name or "một thành viên"
    header = (
        f"Việc hẹn giờ do {who} tạo trong nhóm Zalo này. Chỉ viết đúng nội dung "
        "sẽ gửi vào nhóm, không chào hỏi thừa, không nhắc tới việc hẹn giờ."
    )
    return f"{header}{_GROUP_CRON_PROMPT_SEPARATOR}{prompt}"


def _cron_min_gap_minutes(expr: str) -> Optional[float]:
    """Khoảng cách ngắn nhất (phút) giữa hai lần chạy liền nhau của biểu thức cron.

    Đo nhiều lần chứ không chỉ hai lần đầu: `0 9,10 * * *` có lần cách 23 giờ
    nhưng cũng có lần cách 1 giờ.
    """
    from datetime import datetime

    jobs = _cron_jobs()
    if not jobs._ensure_croniter():
        return None
    try:
        it = jobs.croniter(expr, datetime.now())
        times = [it.get_next(datetime) for _ in range(GROUP_CRON_LOOKAHEAD)]
    except Exception:
        return None
    gaps = [(later - earlier).total_seconds() / 60 for earlier, later in zip(times, times[1:])]
    return min(gaps) if gaps else None


def _group_cron_schedule_problem(schedule: Dict[str, Any]) -> str:
    """Lịch này có vượt giới hạn của việc hẹn giờ nhóm không. Rỗng là hợp lệ."""
    from datetime import datetime

    kind = schedule.get("kind")
    if kind == "once":
        try:
            run_at = datetime.fromisoformat(str(schedule.get("run_at")))
        except ValueError:
            return "không đọc được thời điểm hẹn"
        now = datetime.now(run_at.tzinfo) if run_at.tzinfo else datetime.now()
        return "" if run_at > now else "thời điểm hẹn đã qua — chọn một giờ trong tương lai"
    if kind == "interval":
        minutes = float(schedule.get("minutes") or 0)
        return "" if minutes >= GROUP_CRON_MIN_GAP_MINUTES else _GROUP_CRON_TOO_OFTEN
    if kind == "cron":
        gap = _cron_min_gap_minutes(str(schedule.get("expr") or ""))
        if gap is None:
            return "không đọc được lịch lặp này"
        return "" if gap >= GROUP_CRON_MIN_GAP_MINUTES else _GROUP_CRON_TOO_OFTEN
    return "không hỗ trợ kiểu lịch này"


def _group_cron_create(args: Dict[str, Any], turn: Dict[str, Any]) -> str:
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return _err("cần `prompt` — việc bot sẽ làm khi đến giờ")
    if len(prompt) > GROUP_CRON_PROMPT_MAX:
        return _err(f"`prompt` dài quá {GROUP_CRON_PROMPT_MAX} ký tự")
    raw_schedule = str(args.get("schedule") or "").strip()
    if not raw_schedule:
        return _err("cần `schedule`, ví dụ 'every day at 7am' hoặc '2026-09-18T07:30'")
    creator = str(turn.get("sender_uid") or "")
    if not creator:
        return _err("không xác định được người tạo")

    jobs = _cron_jobs()
    try:
        schedule = jobs.parse_schedule(raw_schedule)
    except ValueError as exc:
        return _err(str(exc))
    problem = _group_cron_schedule_problem(schedule)
    if problem:
        return _err(problem)

    # Cùng bộ quét công cụ cron gốc dùng. Không import được thì từ chối, không
    # bỏ qua: đây là lớp chặn prompt cài lệnh ẩn.
    try:
        from tools.cronjob_tools import _scan_cron_prompt
    except ImportError:
        return _err("bản Hermes này không kiểm được nội dung việc hẹn giờ nên chưa tạo")
    blocked = _scan_cron_prompt(prompt)
    if blocked:
        return _err(blocked)

    group = str(turn.get("thread_id") or "")
    if not turn.get("is_owner"):
        active = [
            job for job in jobs.list_jobs(include_disabled=False)
            if _is_group_cron(job) and not jobs.is_terminal_job(job)
        ]
        mine = sum(1 for job in active if str(job["origin"].get("zalo_creator_uid") or "") == creator)
        if mine >= GROUP_CRON_PER_CREATOR:
            return _err(f"bạn đã có {mine} việc hẹn giờ đang bật — tối đa {GROUP_CRON_PER_CREATOR}. Xoá bớt rồi tạo lại")
        here = sum(1 for job in active if _cron_target(job) == group)
        if here >= GROUP_CRON_PER_GROUP:
            return _err(f"nhóm này đã có {here} việc hẹn giờ đang bật — tối đa {GROUP_CRON_PER_GROUP}")

    creator_name = str(turn.get("sender_name") or "")
    name = str(args.get("name") or "").strip()[:GROUP_CRON_NAME_MAX] or prompt[:40]
    job = jobs.create_job(
        prompt=_group_cron_prompt(prompt, creator_name),
        schedule=raw_schedule,
        name=name,
        repeat=1 if schedule.get("kind") == "once" else None,
        deliver=f"zalo:{group}",
        origin={
            "platform": "zalo",
            "chat_id": group,
            "chat_name": group,
            "chat_type": "group",
            "thread_id": None,
            "user_id": creator,
            "zalo_scope": GROUP_CRON_SCOPE,
            "zalo_creator_uid": creator,
            "zalo_creator_name": creator_name,
        },
        enabled_toolsets=[TOOLSET_CRON_MEMBER, "no_mcp"],
    )
    return _ok({
        "job_id": job.get("id"),
        "ten": job.get("name"),
        "lich": job.get("schedule_display") or schedule.get("display"),
        "lan_toi": job.get("next_run_at"),
    })


def _group_cron_list(turn: Dict[str, Any]) -> str:
    group = str(turn.get("thread_id") or "")
    jobs = _cron_jobs()
    items = []
    for job in jobs.list_jobs(include_disabled=True):
        if _cron_target(job) != group:
            continue
        item = {
            "job_id": job.get("id"),
            "ten": job.get("name"),
            "lich": job.get("schedule_display"),
            "lan_toi": job.get("next_run_at"),
            "trang_thai": jobs.effective_job_state(job),
        }
        if _is_group_cron(job):
            origin = job["origin"]
            item["nguoi_tao"] = origin.get("zalo_creator_name") or origin.get("zalo_creator_uid")
            item["noi_dung"] = str(job.get("prompt") or "").split(_GROUP_CRON_PROMPT_SEPARATOR, 1)[-1]
        else:
            # Việc của chủ nhân: cho biết là có, không lộ nội dung giao việc.
            item["nguoi_tao"] = "chủ nhân"
        items.append(item)
    return _ok({"count": len(items), "jobs": items})


def _group_cron_remove(args: Dict[str, Any], turn: Dict[str, Any]) -> str:
    job_id = str(args.get("job_id") or "").strip()
    if not job_id:
        return _err("cần `job_id` — lấy từ action 'list'")
    group = str(turn.get("thread_id") or "")
    jobs = _cron_jobs()
    job = jobs.get_job(job_id)
    if not job or _cron_target(job) != group:
        return _err("nhóm này không có việc hẹn giờ đó")
    if _is_group_cron(job):
        creator = str(job["origin"].get("zalo_creator_uid") or "")
        if not (turn.get("is_owner") or creator == str(turn.get("sender_uid") or "")):
            return _err("chỉ người tạo hoặc chủ nhân được xoá việc hẹn giờ này")
    elif not turn.get("is_owner"):
        return _err("việc hẹn giờ của chủ nhân chỉ chủ nhân xoá được")
    return _ok({"job_id": job["id"], "da_xoa": bool(jobs.remove_job(job["id"]))})


async def zalo_group_cron(args: Dict[str, Any], **_kw) -> str:
    turn = _turn()
    if turn.get("cron_job_id"):
        return _err("việc hẹn giờ không được tự tạo, xem hay xoá việc hẹn giờ khác")
    if not turn.get("is_group") or not turn.get("thread_id"):
        return _err("chỉ dùng được trong nhóm Zalo")
    action = str(args.get("action") or "").strip().lower()
    if action == "create":
        return _group_cron_create(args, turn)
    if action == "list":
        return _group_cron_list(turn)
    if action == "remove":
        return _group_cron_remove(args, turn)
    return _err("`action` phải là create, list hoặc remove")
```

- [ ] **Step 4: Khai báo công cụ trong `TOOLS`**

Chèn ngay trước mục `# --- Nhóm 1: gửi nội dung ---`:

```python
    # --- Nhóm 11: việc hẹn giờ của nhóm ---
    ("zalo_group_cron", "⏲️", _schema(
        "zalo_group_cron",
        "Hẹn giờ cho nhóm Zalo đang trò chuyện: đến giờ bot tự soạn và gửi nội "
        "dung vào nhóm (nhắc họp, bản tin, tóm tắt nhóm). `create` tạo việc mới, "
        "`list` xem các việc của nhóm, `remove` xoá theo `job_id`. Lặp tối đa 1 "
        "lần mỗi ngày; mỗi người tối đa 3 việc, mỗi nhóm tối đa 10.",
        {
            "action": {"type": "string", "enum": ["create", "list", "remove"]},
            "prompt": {"type": "string", "description":
                       "Việc bot làm khi đến giờ, tối đa 1000 ký tự. Viết đủ ý vì lúc "
                       "chạy bot không nhớ cuộc trò chuyện này."},
            "schedule": {"type": "string", "description":
                         "Lịch: 'every day at 7am', 'every monday 9am', '0 7 * * *', "
                         "'2026-09-18T07:30' (một lần), 'in 2h' (một lần)."},
            "name": {"type": "string", "description": "Tên ngắn cho việc hẹn giờ."},
            "job_id": {"type": "string", "description": "Mã việc hẹn giờ cần xoá, lấy từ action 'list'."},
        },
        ["action"],
    ), zalo_group_cron, TOOLSET_PUBLIC),
```

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `E:/Hermes/hermes-agent/venv/Scripts/python.exe -m unittest test_zalo_adapter -v`
Expected: PASS toàn bộ (67 test).

- [ ] **Step 6: Commit**

```bash
git add hermes-plugin/zalo_tools/tools.py test_zalo_adapter.py
git commit -m "feat(zalo-tools): zalo_group_cron cho thành viên tạo, xem, xoá cron của nhóm

Khoá cứng deliver, toolset và mọi trường nguy hiểm của job; lặp tối đa 1
lần/ngày, 3 việc/người, 10 việc/nhóm; dùng bộ quét prompt cron của Hermes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Tài liệu, phiên bản 1.4.0, chạy toàn bộ test

**Files:**
- Modify: `README.md:163-176`, `README.vi.md:73-105` (+ mục mới), `.env.example:52-53`
- Modify: `hermes-plugin/zalo_tools/plugin.yaml`, `hermes-plugin/zalo/plugin.yaml`, `package.json:3`, `package-lock.json:3` và `:9` (chỉ hai dòng này — các dòng `1.3.0` khác là của gói phụ thuộc)
- Modify: `CHANGELOG.md`, `docs/superpowers/specs/2026-09-11-zalo-cron-nhom-design.md` (mục 5.2.1)

**Interfaces:**
- Consumes: toàn bộ Task 1–5.
- Produces: bản phát hành 1.4.0.

- [ ] **Step 1: README.md**

Dòng 163 thay bằng:

```markdown
47 tools total, split into three toolsets: 31 owner-only, 15 shared with everyone in a group, and 1 (`zalo_group_history`) that only exists inside group cron jobs. `ZALO_ALLOWED_USERS` decides who counts as the owner.
```

Thêm dòng cuối bảng (sau `| People notebook | ... |`):

```markdown
| Group cron jobs | `zalo_group_cron` `zalo_group_history` |
```

Ngay sau đoạn "The bridge accepts only allowlisted `zca-js` operations..." thêm:

```markdown
### Group cron jobs

Anyone in a group can ask the bot to schedule a job for that group ("remind everyone at 7am every Monday", "summarize today's chat at 9pm"). `zalo_group_cron` creates the Hermes cron job itself and locks every dangerous field: results go only to that group, the job runs with `zalo_cron_member` (web search/read, knowledge base, and that group's own history — no terminal, no files, no MCP), and scripts, working directories, skills and model overrides are never accepted. Limits: repeats at most once a day, 3 active jobs per person, 10 per group. Only the creator or the owner can remove a job. Cron jobs the owner creates with Hermes' own cron tool keep full owner authority and can now deliver to any group.
```

- [ ] **Step 2: README.vi.md**

Dòng 73: `**47 công cụ cho agent** — thay cho trang quản trị. Nói bằng lời thay vì bấm nút:`

Thêm dòng cuối bảng (sau `| Sổ người quen | ... |`):

```markdown
| Hẹn giờ cho nhóm | `zalo_group_cron` `zalo_group_history` |
```

Dòng 94: `47 công cụ chia làm ba nhóm, quyết định bằng `ZALO_ALLOWED_USERS` (riêng `zalo_group_history` chỉ tồn tại trong việc hẹn giờ của nhóm):`

Dòng 99: `| Số công cụ Zalo | 46 | 15 |`

Dòng 105:

```markdown
**15 công cụ công khai:** gửi tệp · gửi thoại · gửi sticker · gửi liên kết · đặt lời nhắc · xem lời nhắc · xoá lời nhắc · xem thành viên nhóm · liệt kê kho tài liệu · đọc tài liệu · nhớ người quen · tra sổ người quen · **tìm kiếm web · đọc trang web · hẹn giờ cho nhóm**.
```

Ngay trước dòng `### Tra cứu Internet` thêm:

```markdown
### Hẹn giờ cho nhóm

Ai trong nhóm cũng nhờ bot hẹn giờ được: *"7h sáng thứ Hai hằng tuần nhắc cả nhóm nộp báo cáo"*, *"9h tối nay tóm tắt những gì nhóm đã chốt"*. `zalo_group_cron` tự tạo job cron của Hermes và khoá cứng mọi trường nguy hiểm:

- Kết quả chỉ gửi vào **đúng nhóm** đó.
- Lúc chạy chỉ cầm toolset `zalo_cron_member`: tra web, đọc web, đọc kho tài liệu, đọc lịch sử **của chính nhóm đó** — không terminal, không đọc tệp, không MCP.
- Không nhận script, thư mục làm việc, skill hay đổi model.
- Lặp tối đa **1 lần mỗi ngày**; mỗi người tối đa **3** việc đang bật, mỗi nhóm tối đa **10**.
- Ai trong nhóm cũng xem được danh sách; chỉ **người tạo hoặc chủ nhân** được xoá.

Cron chủ nhân tạo bằng công cụ cron gốc của Hermes vẫn giữ nguyên quyền chủ nhân, và nay gửi được vào mọi nhóm.
```

- [ ] **Step 3: `.env.example` dòng 52-53**

```
# zalo_public (15 công cụ, không có terminal / read_file / browser),
# còn chủ nhân vẫn giữ đủ 31 công cụ owner cộng thêm 15 công cụ public đó.
```

- [ ] **Step 4: Phiên bản 1.4.0**

- `package.json` dòng 3: `"version": "1.4.0",`
- `package-lock.json` dòng 3 và dòng 9: `"version": "1.4.0",`
- `hermes-plugin/zalo/plugin.yaml` dòng 4: `version: 1.4.0`
- `hermes-plugin/zalo_tools/plugin.yaml` dòng 4: `version: 1.4.0`; trong khối mô tả, đoạn `known_plugin_toolsets` thay bằng:

```yaml
      known_plugin_toolsets:
        zalo:
          - zalo_owner
          - zalo_public
          - zalo_cron
```

Run: `grep -n '"version": "1.4.0"' package.json package-lock.json`
Expected: đúng 3 dòng (package.json:3, package-lock.json:3, package-lock.json:9).

- [ ] **Step 5: CHANGELOG.md**

Chèn ngay dưới dòng `Theo chuẩn [Keep a Changelog]...`:

```markdown
## [1.4.0] — 2026-09-11

### Sửa

- **Cron và câu trả lời gửi bù không tới được nhóm.** Tin gửi ngoài lượt chat
  mang vai trò `system`, mà sidecar chỉ cho `system` tới chủ nhân hoặc kênh nhà
  — kết quả cron gửi vào nhóm và câu trả lời gửi bù sau khi gateway khởi động
  lại đều bị chặn (`auth_required`, 18 lần trên máy chạy thật 08–11/09). Nay
  `system` gửi chữ và báo đang gõ được tới mọi hội thoại, vẫn không gọi hàm
  Zalo, không đọc lịch sử, không thu hồi.
- **Cron không dùng được công cụ Zalo nào.** Công cụ nay đọc `task_id` của lượt
  cron để biết job: job tạo bằng công cụ cron gốc (chỉ chủ nhân có) chạy với
  quyền chủ nhân trong hội thoại đích; audit ghi mã cron phát lệnh.
- **Tin cron trong nhóm có khung tiếng Anh** `Cronjob Response… (job_id…)`.
  Adapter Zalo bỏ khung này; nền tảng khác giữ nguyên.
- Gắn danh tính lượt chat bị lỗi thì rơi về quyền công khai của đúng người đó,
  không rơi về `system`.

### Thêm

- **`zalo_group_cron` — thành viên tự hẹn giờ cho nhóm.** Tạo, xem, xoá việc hẹn
  giờ của nhóm đang trò chuyện. Job khoá cứng đích gửi, toolset
  `zalo_cron_member` (tra web, kho tài liệu, `zalo_group_history` của chính
  nhóm), không script/thư mục/skill/model; lặp tối đa 1 lần/ngày, 3 việc/người,
  10 việc/nhóm; chỉ người tạo hoặc chủ nhân xoá được. Prompt qua bộ quét cron
  của Hermes.
- Trình cài khai thêm `zalo_cron` vào `known_plugin_toolsets.zalo`; `doctor`
  kiểm cả toolset này.
```

- [ ] **Step 6: Spec mục 5.2.1 khớp code**

Trong `docs/superpowers/specs/2026-09-11-zalo-cron-nhom-design.md`, thay đoạn đầu mục 5.2 bước 1 (`Khi metadata có job_id và nội dung mở đầu bằng...`) bằng:

```markdown
1. **Bỏ đầu–đuôi tiếng Anh của tin cron.** Khi nội dung khớp đúng khung Hermes
   (dòng `Cronjob Response: …`, dòng `(job_id: …)`, dòng gạch ngang, và tuỳ chọn
   dòng cuối `To stop or manage this job…`), chỉ giữ phần thân trước khi chia
   tin. Nhận diện theo cả hai dòng đầu chứ không dựa vào `metadata`, để tin
   thường tình cờ mở đầu bằng cùng chữ không bị cắt. Chỉ áp cho Zalo; Telegram
   giữ nguyên (`cron.wrap_response` là cấu hình chung, không đụng).
```

- [ ] **Step 7: Chạy toàn bộ test**

Run: `HERMES_HOME=E:/Hermes npm test`
Expected: JS `# tests 116`, `# fail 0`; `[test:py] Tổng số test Python đã chạy: 74` (67 adapter + 5 + 2) và `Tất cả test Python đều xanh.`

- [ ] **Step 8: Commit**

```bash
git add README.md README.vi.md .env.example package.json package-lock.json hermes-plugin/zalo/plugin.yaml hermes-plugin/zalo_tools/plugin.yaml CHANGELOG.md docs/superpowers/specs/2026-09-11-zalo-cron-nhom-design.md
git commit -m "docs: cron cho mọi nhóm và zalo_group_cron (v1.4.0)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Cài vào Lăng Tiêu và kiểm thật

**Files (máy Lăng Tiêu, ngoài repo):**
- Replace: `E:\Hermes\zca-test\zalo-policy.js`, `E:\Hermes\zca-test\hermes-bridge.js`
- Replace: `E:\Hermes\hermes-agent\plugins\platforms\zalo\adapter.py`, `flood.py`, `__init__.py`
- Modify: `E:\Hermes\hermes-agent\plugins\platforms\zalo\plugin.yaml` (chỉ dòng `version`)
- Replace: `E:\Hermes\hermes-agent\plugins\zalo_tools\tools.py`, `__init__.py`, `people.py`, `facebook.py`, `plugin.yaml`
- Modify: `E:\Hermes\config.yaml` (`known_plugin_toolsets.zalo`)

**Interfaces:**
- Consumes: repo đã xanh ở Task 6.
- Produces: Lăng Tiêu chạy v1.4.0.

- [ ] **Step 1: Sao lưu bản đang chạy**

```bash
STAMP=$(date +%Y%m%d-%H%M%S); B="E:/Hermes/backups/zalo-before-1.4.0-$STAMP"; mkdir -p "$B"
cp E:/Hermes/zca-test/zalo-policy.js E:/Hermes/zca-test/hermes-bridge.js "$B/"
cp -r E:/Hermes/hermes-agent/plugins/platforms/zalo "$B/platform-zalo"
cp -r E:/Hermes/hermes-agent/plugins/zalo_tools "$B/zalo_tools"
cp E:/Hermes/config.yaml "$B/config.yaml"
ls -la "$B"
```

Expected: thư mục sao lưu có đủ 2 tệp JS, 2 thư mục plugin, `config.yaml`.

- [ ] **Step 2: Chép tệp**

```bash
R=E:/2anh-zalo-bot
cp $R/zalo-policy.js $R/hermes-bridge.js E:/Hermes/zca-test/
cp $R/hermes-plugin/zalo/adapter.py $R/hermes-plugin/zalo/flood.py $R/hermes-plugin/zalo/__init__.py E:/Hermes/hermes-agent/plugins/platforms/zalo/
sed -i 's/^version: 1\.3\.0$/version: 1.4.0/' E:/Hermes/hermes-agent/plugins/platforms/zalo/plugin.yaml
cp $R/hermes-plugin/zalo_tools/tools.py $R/hermes-plugin/zalo_tools/__init__.py $R/hermes-plugin/zalo_tools/people.py $R/hermes-plugin/zalo_tools/facebook.py $R/hermes-plugin/zalo_tools/plugin.yaml E:/Hermes/hermes-agent/plugins/zalo_tools/
```

- [ ] **Step 3: Thêm `zalo_cron` vào `known_plugin_toolsets.zalo`**

Trong `E:\Hermes\config.yaml`, khối:

```yaml
known_plugin_toolsets:
  cli:
    - a2a
    - spotify
  zalo:
    - zalo_owner
    - zalo_public
```

thêm dòng `    - zalo_cron` ngay dưới `    - zalo_public`. **Không** đổi `platforms.zalo.extra.bridge_token`.

- [ ] **Step 4: Đối chiếu bản cài với repo**

```bash
R=E:/2anh-zalo-bot
for f in zalo-policy.js hermes-bridge.js; do diff -q --strip-trailing-cr $R/$f E:/Hermes/zca-test/$f && echo "$f same"; done
for f in adapter.py flood.py __init__.py; do diff -q --strip-trailing-cr $R/hermes-plugin/zalo/$f E:/Hermes/hermes-agent/plugins/platforms/zalo/$f && echo "zalo/$f same"; done
for f in tools.py __init__.py people.py facebook.py plugin.yaml; do diff -q --strip-trailing-cr $R/hermes-plugin/zalo_tools/$f E:/Hermes/hermes-agent/plugins/zalo_tools/$f && echo "zalo_tools/$f same"; done
diff --strip-trailing-cr $R/hermes-plugin/zalo/plugin.yaml E:/Hermes/hermes-agent/plugins/platforms/zalo/plugin.yaml
grep -n -A4 '^known_plugin_toolsets:' E:/Hermes/config.yaml
```

Expected: 10 dòng `same`; `plugin.yaml` của platform chỉ lệch dòng đường dẫn `server.js` đã render; `known_plugin_toolsets.zalo` có `zalo_cron`.

- [ ] **Step 5: Khởi động lại sidecar rồi gateway**

**Báo trước chủ nhân** — `Hermes-Offline.vbs`/`Hermes-Online.vbs` hiện hộp thoại và ngắt lượt bot đang trả lời. Chờ chủ nhân chọn giờ ít tin nhắn, rồi chạy `E:\Hermes\Hermes-Offline.vbs`, sau đó `E:\Hermes\Hermes-Online.vbs`.

Kiểm tra:

```bash
curl -s http://127.0.0.1:3872/api/health -H "Host: 127.0.0.1:3872" | head -c 600; echo
grep -E "\[zalo\] (đã đăng ký|hermes-zalo|connected|tự kiểm quyền)" E:/Hermes/logs/agent.log | tail -5
```

Expected: health có `"listener":"connected"` và Hermes đã nối; log có `đã đăng ký 47 công cụ — 15 công khai, 31 chỉ chủ nhân, 1 cho cron`.

- [ ] **Step 6: Kiểm thật 1 — cron của chủ nhân gửi vào nhóm**

Chủ nhân nhắn trong nhóm test (chủ nhân chỉ định): `@Lăng Tiêu tạo cron chạy sau 2 phút, gửi vào nhóm này câu "Thử cron chủ nhân 1.4.0"`. Sau 3 phút:

```bash
cd E:/Hermes/zca-test && node --no-warnings -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/zalo.sqlite', { readOnly: true });
for (const r of db.prepare(\"select actor_role, action, thread_id, status, error, target_summary, datetime(created_at_ms/1000,'unixepoch','localtime') t from audit_log order by id desc limit 6\").all()) console.log(JSON.stringify(r));
"
```

Expected: tin tới nhóm, **không** có dòng `Cronjob Response`; audit có dòng `system` · `send` · nhóm test · `succeeded`.

- [ ] **Step 7: Kiểm thật 2 — thành viên tạo cron dùng lịch sử nhóm**

Một thành viên (không phải chủ nhân) nhắn trong nhóm test: `@Lăng Tiêu hẹn giờ sau 2 phút tóm tắt 10 tin gần nhất của nhóm này`. Sau 3 phút chạy lại lệnh audit ở Step 6, và:

```bash
grep -E "zalo_group_cron|zalo_group_history|\[zalo\] không đọc được job cron|different loop" E:/Hermes/logs/agent.log | tail -10
```

Expected: bot trả lời đã tạo (có `job_id`); đến giờ tin tóm tắt tới nhóm; không có lỗi `different loop`. Nếu treo hoặc có lỗi vòng lặp sự kiện: dừng, báo lại, xử lý theo spec mục 9.1 thành task bổ sung (có test) trước khi đi tiếp.

- [ ] **Step 8: Kiểm thật 3 — thành viên bị chặn đúng chỗ**

Cùng thành viên đó nhắn: `@Lăng Tiêu hẹn giờ mỗi 30 phút nhắc uống nước`. Expected: bot từ chối, nói lặp tối đa 1 lần mỗi ngày. Sau đó `@Lăng Tiêu xem các việc hẹn giờ của nhóm` → thấy việc ở Step 7; cron của chủ nhân ghi "chủ nhân", không lộ nội dung.

---

### Task 8: Gộp vào `main`, đẩy GitHub

**Files:** không sửa tệp.

**Interfaces:**
- Consumes: Task 7 kiểm thật đạt.
- Produces: `main` và thẻ `v1.4.0` trên GitHub.

- [ ] **Step 1: Test lần cuối và gộp**

```bash
cd E:/2anh-zalo-bot
HERMES_HOME=E:/Hermes npm test 2>&1 | grep -E "^# fail|\[test:py\] (Tất cả|Có test)"
git checkout main && git pull --ff-only origin main && git merge --ff-only feat/zalo-cron-nhom
```

Expected: `# fail 0`, `Tất cả test Python đều xanh.`; merge fast-forward.

- [ ] **Step 2: Gắn thẻ và đẩy**

```bash
git tag v1.4.0
git push origin main
git push origin v1.4.0
git log --oneline -8
```

Expected: `origin/main` trỏ commit docs 1.4.0; thẻ `v1.4.0` có trên GitHub.
