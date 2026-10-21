export const SESSION_COOKIE = 'zd_session';

export function securityHeaders() {
  return (req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  };
}

// So theo origin chuẩn hoá (chữ thường, bỏ cổng mặc định, bỏ đường dẫn) — publicUrl có thể là "https://D.vn:443/".
const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

export function checkOrigin({ publicUrl, port }) {
  const allowed = new Set([publicUrl, `http://localhost:${port}`, `http://127.0.0.1:${port}`].map(originOf).filter((o) => o && o !== 'null'));
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin ? allowed.has(originOf(origin)) : req.get('x-requested-with') === 'zalo-dashboard') return next();
    return res.status(403).json({ ok: false, error: 'Yêu cầu không hợp lệ — tải lại trang rồi thử lại.' });
  };
}

export function readCookie(req, name) {
  for (const part of String(req.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return null; }
    }
  }
  return null;
}

export function setSessionCookie(res, req, token) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: 7 * 24 * 3600_000 });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function sessionMiddleware({ sessions, users }) {
  return (req, res, next) => {
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? sessions.get(token, req.ip) : null;
    const user = session ? users.get(session.username) : null;
    req.sessionToken = token;
    req.sessionId = session?.id || null;
    req.user = user && !user.disabled ? { username: user.username, role: user.role, zaloUid: user.zaloUid } : null;
    next();
  };
}

export const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ ok: false, error: 'Phiên đăng nhập đã hết — đăng nhập lại.' }));

export const requireRole = (role) => (req, res, next) => (req.user?.role === role ? next()
  : res.status(403).json({ ok: false, error: 'Tài khoản của bạn không có quyền làm việc này.' }));
