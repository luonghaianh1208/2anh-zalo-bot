import express from 'express';
import { createHash } from 'node:crypto';

// Nhận cảnh báo "đang đốt tiền model" từ bot trên máy khách rồi nhắn riêng chủ nhân của bot này.
// Bot khách không tự nhắn được: nó chạy trên tài khoản Zalo của khách. Xem hermes-plugin/zalo_tools/burn_alert.py.
const MIN_TOKEN = 16;
const MAX_PER_HOUR = 6;
const HOUR_MS = 3600_000;
const SAFE_NAME = /^[\w.:/-]{1,64}$/;

const hashOf = (token) => createHash('sha256').update(token).digest('hex');

/** ZALO_BURN_ALERT_TOKENS="chauhoa:<token>,duongtuan:<token>" → Map(hash token → nhãn máy). */
export function parseBurnAlertTokens(raw) {
  const out = new Map();
  for (const item of String(raw || '').split(',')) {
    const at = item.indexOf(':');
    const label = item.slice(0, at).trim();
    const token = item.slice(at + 1).trim();
    if (at > 0 && label && token.length >= MIN_TOKEN) out.set(hashOf(token), label);
  }
  return out;
}

const millions = (n) => (n / 1e6).toFixed(1).replace('.', ',');

function alertText(label, { kind, tool, count, model }) {
  const what = kind === 'tool_loop'
    ? `Tool ${tool} lỗi ${count} lần liên tiếp.`
    : `Đã dùng ${millions(count)} triệu token trong 1 giờ.`;
  return `🚨 Cảnh báo đốt tiền model — ${label}\n${what}\nModel: ${model}\nAnh vào kiểm tra ngay nhé.`;
}

function validBody(b) {
  if (!b || !['tool_loop', 'token_burn'].includes(b.kind)) return false;
  if (!Number.isSafeInteger(b.count) || b.count < 1 || !SAFE_NAME.test(String(b.model ?? ''))) return false;
  return b.kind === 'token_burn' || SAFE_NAME.test(String(b.tool ?? ''));
}

export function burnAlertRoutes({ burnAlertTokens, sidecar, owners }) {
  const r = express.Router();
  const recent = new Map();

  r.post('/hooks/burn-alert', async (req, res) => {
    const supplied = String(req.get('authorization') || '').replace(/^Bearer /, '');
    const label = burnAlertTokens.get(hashOf(supplied));
    if (!label) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!validBody(req.body)) return res.status(400).json({ ok: false, error: 'Dữ liệu cảnh báo không hợp lệ' });

    const now = Date.now();
    const sentAt = (recent.get(label) || []).filter((at) => now - at < HOUR_MS);
    if (sentAt.length >= MAX_PER_HOUR) return res.status(429).json({ ok: false, error: 'Quá nhiều cảnh báo' });
    const uids = owners.list();
    if (!uids.length) return res.status(503).json({ ok: false, error: 'Bot chưa có chủ nhân' });

    recent.set(label, [...sentAt, now]);
    try {
      const text = alertText(label, req.body);
      for (const uid of uids) await sidecar.send({ threadId: String(uid), threadType: 0, text, actor: 'burn-alert' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[dashboard] burn-alert:', err?.message);
      res.status(502).json({ ok: false, error: 'Chưa gửi được qua Zalo' });
    }
  });
  return r;
}
