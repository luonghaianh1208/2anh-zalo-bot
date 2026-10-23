// Khoá API & Model — chỉ Quản trị. Model: xem theo chức năng, đổi model chính (hiệu lực ngay, như /model), thử gọi.
// Khoá: xem trạng thái (4 ký tự cuối), kiểm tra, thay/gỡ (ghi .env hoặc config.yaml có .bak; cần khởi động lại trợ lý).
// Nhật ký chỉ ghi TÊN khoá, không bao giờ ghi giá trị.
import express from 'express';
import { requireAuth, requireRole } from '../lib/http-guards.js';

export function aiConfigRoutes({ aiKeys, aiModels, agentConfig, mediaEngines, restartFlags, activity }) {
  const r = express.Router();
  const guard = [requireAuth, requireRole('admin')];
  const fail = (res, err, fallback) => {
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    if (status !== 500) return res.status(status).json({ ok: false, error: err.message });
    console.error('[dashboard]', err?.message || err);
    return res.status(500).json({ ok: false, error: fallback });
  };
  const log = (req, action, detail) => { try { activity.append({ actor: req.user.username, action, detail }); } catch (e) { console.error('[dashboard] không ghi được Nhật ký:', e); } };

  r.get('/admin/ai/models', ...guard, async (req, res) => {
    try {
      let list = []; let listError = ''; let prices = {};
      try {
        const info = agentConfig.modelsInfo ? await agentConfig.modelsInfo() : (await agentConfig.models()).map((id) => ({ id }));
        list = info.map((m) => m.id);
        prices = Object.fromEntries(info.filter((m) => m.pricing).map((m) => [m.id, { ...m.pricing, name: m.name || '' }]));
      } catch (e) { listError = e.message; }
      const v = agentConfig.view();
      res.json({ ok: true, ...aiModels.view(), models: list, prices, listError, choices: v.choices, defaultModel: v.defaultModel });
    } catch (err) { fail(res, err, 'Chưa đọc được cấu hình model.'); }
  });
  r.put('/admin/ai/model', ...guard, async (req, res) => {
    try {
      const before = agentConfig.view().model;
      if (await agentConfig.setModel(req.body?.model)) log(req, 'agent_model', `${before} → ${req.body.model}`);
      res.json({ ok: true, ...aiModels.view() });
    } catch (err) { fail(res, err, 'Chưa đổi được model — thử lại.'); }
  });
  r.post('/admin/ai/test', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...(await aiModels.test(req.body?.model)) }); } catch (err) { fail(res, err, 'Chưa thử được model.'); }
  });

  r.get('/admin/ai/keys', ...guard, (req, res) => {
    try { res.json({ ok: true, ...aiKeys.list() }); } catch (err) { fail(res, err, 'Chưa đọc được danh sách khoá.'); }
  });
  r.put('/admin/ai/keys/:key', ...guard, (req, res) => {
    try {
      const key = String(req.params.key);
      const value = String(req.body?.value ?? '');
      if (aiKeys.set(key, value)) {
        if (aiKeys.needsRestart(key)) restartFlags?.mark('assistant', 'Khoá API');
        log(req, value ? 'ai_key_set' : 'ai_key_remove', key);
      }
      res.json({ ok: true, ...aiKeys.list() });
    } catch (err) { fail(res, err, 'Chưa lưu được khoá — thử lại.'); }
  });
  // Kho khoá dự phòng: thêm / dùng / đổi thứ tự / xoá / kiểm tra từng khoá. Plugin tự đổi khi khoá đang dùng lỗi.
  const poolAction = (path, action, fn) => r.post(path, ...guard, async (req, res) => {
    try {
      const out = await fn(req);
      if (action) log(req, action, String(req.params.key));
      res.json({ ok: true, ...(out && typeof out === 'object' ? out : {}), ...aiKeys.list() });
    } catch (err) { fail(res, err, 'Chưa làm được — thử lại.'); }
  });
  poolAction('/admin/ai/keys/:key/pool', 'ai_key_add', (req) => aiKeys.addBackup(String(req.params.key), req.body?.value, req.body?.label));
  poolAction('/admin/ai/keys/:key/pool/:id/activate', 'ai_key_activate', (req) => aiKeys.activate(String(req.params.key), String(req.params.id)));
  poolAction('/admin/ai/keys/:key/pool/:id/move', null, (req) => aiKeys.move(String(req.params.key), String(req.params.id), req.body?.dir));
  poolAction('/admin/ai/keys/:key/pool/:id/remove', 'ai_key_remove_backup', (req) => aiKeys.removeEntry(String(req.params.key), String(req.params.id)));
  poolAction('/admin/ai/keys/:key/pool/:id/test', null, async (req) => ({ result: await aiKeys.testEntry(String(req.params.key), String(req.params.id)) }));
  r.post('/admin/ai/keys/:key/test', ...guard, async (req, res) => {
    try { res.json({ ok: true, ...(await aiKeys.test(String(req.params.key))) }); } catch (err) { fail(res, err, 'Chưa kiểm tra được khoá.'); }
  });

  // Tạo ảnh & video: nguồn ảnh xếp ưu tiên (Stali / 9router / ChatGPT) + video Stali. Plugin đọc lại tệp — áp dụng ngay.
  if (mediaEngines) {
    r.get('/admin/ai/media', ...guard, (req, res) => {
      try { res.json({ ok: true, ...mediaEngines.view() }); } catch (err) { fail(res, err, 'Chưa đọc được cài đặt tạo ảnh.'); }
    });
    r.put('/admin/ai/media', ...guard, (req, res) => {
      try {
        const { changedProviders } = mediaEngines.save(req.body?.settings);
        if (changedProviders) restartFlags?.mark('assistant', 'Tạo ảnh & video');
        log(req, 'media_engines', '');
        res.json({ ok: true, ...mediaEngines.view() });
      } catch (err) { fail(res, err, 'Chưa lưu được — thử lại.'); }
    });
    r.get('/admin/ai/media/models/:engine', ...guard, async (req, res) => {
      try { res.json({ ok: true, models: await mediaEngines.models(String(req.params.engine)) }); } catch (err) { fail(res, err, 'Chưa lấy được danh sách model.'); }
    });
    r.post('/admin/ai/media/test', ...guard, async (req, res) => {
      try { res.json({ ok: true, result: await mediaEngines.test(String(req.body?.kind || 'image'), String(req.body?.engine || '')) }); } catch (err) { fail(res, err, 'Chưa thử được.'); }
    });
    r.post('/admin/ai/media/draw', ...guard, async (req, res) => {
      try {
        const engine = String(req.body?.engine || '');
        const result = await mediaEngines.draw(engine);
        log(req, 'media_draw_test', engine);
        res.json({ ok: true, result });
      } catch (err) { fail(res, err, 'Chưa vẽ thử được.'); }
    });
  }
  return r;
}
