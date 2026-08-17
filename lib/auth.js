// 审批制认证系统：users / sessions / requireAuth / requireAdmin
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_DAYS = 7;
const USER_COOKIE = 'w1_session';
const ADMIN_COOKIE = 'w1_admin';

/* ---------------- 登录/注册限流（内存实现，单实例足够） ----------------
 * 登录：每 IP 15 分钟窗口内最多 10 次失败，超限锁定至窗口结束；成功即清零。
 * 注册：每 IP 每小时最多 5 次，防脚本批量注册。
 */
const loginAttempts = new Map(); // ip -> { fails, firstTs }
const regAttempts = new Map();   // ip -> { count, firstTs }
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REG_MAX = 5;
const REG_WINDOW_MS = 60 * 60 * 1000;

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || 'unknown';
}
function windowCheck(map, ip, max, windowMs) {
  const rec = map.get(ip);
  if (!rec) return { locked: false, retryAfterSec: 0 };
  if (Date.now() - rec.firstTs > windowMs) { map.delete(ip); return { locked: false, retryAfterSec: 0 }; }
  if (rec.count >= max) {
    return { locked: true, retryAfterSec: Math.ceil((rec.firstTs + windowMs - Date.now()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}
function windowRecord(map, ip, windowMs) {
  const rec = map.get(ip);
  if (!rec || Date.now() - rec.firstTs > windowMs) {
    map.set(ip, { count: 1, firstTs: Date.now() });
  } else {
    rec.count++;
  }
}
function windowClear(map, ip) { map.delete(ip); }

function newToken() { return crypto.randomBytes(32).toString('hex'); }

// users.bt_open：测试回测权限（后台按用户手动开放）
function ensureSchema(db) {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('bt_open')) {
    try { db.prepare("ALTER TABLE users ADD COLUMN bt_open INTEGER NOT NULL DEFAULT 0").run(); } catch (e) {}
  }
}

function createSession(db, kind, userId) {
  const token = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token,kind,user_id,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(token, kind, userId || null, now, now + SESSION_DAYS * 86400 * 1000);
  return { token, expires_at: now + SESSION_DAYS * 86400 * 1000 };
}
function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
function findSession(db, token, kind) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token=? AND kind=?').get(token, kind);
  if (!row) return null;
  if (row.expires_at < Date.now()) { destroySession(db, token); return null; }
  return row;
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, nickname: u.nickname || null, status: u.status, created_at: u.created_at, approved_at: u.approved_at, vip: vipOf(u), bt_open: u.bt_open ? 1 : 0, is_owner: u.is_owner ? 1 : 0 };
}

/* ---------------- 会员体系：等级 / 到期 / 永久 / 老板 ---------------- */
const DAY_MS = 86400000;
function vipOf(u) {
  if (!u) return null;
  const owner = u.is_owner;
  const permanent = !owner && u.permanent;
  const expiresAt = u.expires_at ? Number(u.expires_at) : 0;
  // ceil：当天充值当天算一天，避免设置后立即少显示一天
  const days = expiresAt ? Math.ceil((expiresAt - Date.now()) / DAY_MS) : 0;
  if (owner) return { level: 'owner', label: '老板', en: 'Owner', days: Infinity, desc: '无限', permanent: true };
  if (permanent) return { level: 'eternal', label: '至尊会员', en: 'Eternal', days: Infinity, desc: '永久', permanent: true };
  if (days > 90) return { level: 'gold', label: '黄金会员', en: 'Gold', days, desc: `${days} 天` };
  if (days >= 30) return { level: 'platinum', label: '白金会员', en: 'Platinum', days, desc: `${days} 天` };
  if (days >= 1) return { level: 'normal', label: '普通会员', en: 'Normal', days, desc: `${days} 天` };
  return { level: 'expired', label: '普通会员', en: 'Normal', days: 0, desc: '已到期', expired: true };
}
// 是否有会员权益（到期额度归零：非老板/非永久且天数<1 → 无权益）
function vipActive(vip) {
  return !!vip && !vip.expired;
}

function makeMiddleware(db) {
  function requireAuth(req, res, next) {
    const sess = findSession(db, req.cookies[USER_COOKIE], 'user');
    if (!sess) return res.status(401).json({ ok: false, need_login: true, error: 'login_required' });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(sess.user_id);
    if (!user || user.status !== 'approved') {
      return res.status(401).json({ ok: false, need_login: true, error: 'not_approved' });
    }
    req.user = user;
    next();
  }
  // 会员内容守卫：登录 + 会员权益有效（到期额度归零）
  function requireVip(req, res, next) {
    requireAuth(req, res, () => {
      const vip = vipOf(req.user);
      if (!vipActive(vip)) {
        return res.status(403).json({ ok: false, need_vip: true, error: 'membership_expired', message: '会员已到期，请联系管理员续费', vip });
      }
      next();
    });
  }
  function requireAdmin(req, res, next) {
    const sess = findSession(db, req.cookies[ADMIN_COOKIE], 'admin');
    if (!sess) return res.status(401).json({ ok: false, need_admin: true, error: 'admin_required' });
    req.admin = sess;
    next();
  }
  return { requireAuth, requireVip, requireAdmin };
}

function registerAuthRoutes(app, db, env) {
  ensureSchema(db);
  const cookieBase = { httpOnly: true, sameSite: 'lax', path: '/' };
  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === '1') cookieBase.secure = true;
  const { requireAuth, requireVip, requireAdmin } = makeMiddleware(db);

  app.post('/api/auth/register', (req, res) => {
    const ip = clientIp(req);
    const rl = windowCheck(regAttempts, ip, REG_MAX, REG_WINDOW_MS);
    if (rl.locked) {
      return res.status(429).json({ ok: false, error: 'too_many_registrations', retry_after_sec: rl.retryAfterSec, message: '注册太频繁，请稍后再试' });
    }
    const { username, password, nickname } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ ok: false, error: 'bad_request' });
    }
    const name = username.trim();
    if (!/^[A-Za-z0-9_\-一-龥]{2,24}$/.test(name)) {
      return res.status(400).json({ ok: false, error: 'username_invalid', message: '用户名需 2-24 位（字母/数字/_/-/中文）' });
    }
    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ ok: false, error: 'password_invalid', message: '密码需 6-72 位' });
    }
    // 昵称可选：2-24 位，去首尾空格，空则不设（默认显示用户名）
    let nick = (nickname || '').toString().trim();
    if (nick && !/^[A-Za-z0-9_\-一-龥]{2,24}$/.test(nick)) {
      return res.status(400).json({ ok: false, error: 'nickname_invalid', message: '昵称需 2-24 位（字母/数字/_/-/中文）' });
    }
    if (!nick) nick = null;
    const exists = db.prepare('SELECT id,status FROM users WHERE username=?').get(name);
    if (exists) return res.status(409).json({ ok: false, error: 'username_taken', message: '用户名已被占用' });
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users(username,nickname,password_hash,status,created_at) VALUES(?,?,?,?,?)')
      .run(name, nick, hash, 'pending', Date.now());
    windowRecord(regAttempts, ip, REG_WINDOW_MS);
    res.json({ ok: true, status: 'pending', id: info.lastInsertRowid, message: '注册成功，等待管理员审批后可登录' });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = clientIp(req);
    const rl = windowCheck(loginAttempts, ip, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS);
    if (rl.locked) {
      return res.status(429).json({ ok: false, error: 'too_many_attempts', retry_after_sec: rl.retryAfterSec, message: `尝试次数过多，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试` });
    }
    const { username, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
    if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
      windowRecord(loginAttempts, ip, LOGIN_WINDOW_MS);
      return res.status(401).json({ ok: false, error: 'bad_credentials', message: '用户名或密码错误' });
    }
    windowClear(loginAttempts, ip);
    if (user.status === 'pending') {
      return res.status(403).json({ ok: false, error: 'pending_approval', status: 'pending', message: '账号待管理员审批，请耐心等待' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ ok: false, error: 'rejected', status: 'rejected', message: '账号未通过审批' });
    }
    const sess = createSession(db, 'user', user.id);
    res.cookie(USER_COOKIE, sess.token, Object.assign({ maxAge: SESSION_DAYS * 86400 * 1000 }, cookieBase));
    res.json({ ok: true, user: publicUser(user), expires_at: sess.expires_at });
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(db, req.cookies[USER_COOKIE]);
    res.clearCookie(USER_COOKIE, cookieBase);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const sess = findSession(db, req.cookies[USER_COOKIE], 'user');
    if (!sess) return res.json({ ok: true, user: null });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(sess.user_id);
    res.json({ ok: true, user: publicUser(user), session_expires_at: sess.expires_at });
  });

  /* ---------------- 后台 ---------------- */
  app.post('/api/admin/login', (req, res) => {
    const ip = clientIp(req);
    const rl = windowCheck(loginAttempts, ip, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS);
    if (rl.locked) {
      return res.status(429).json({ ok: false, error: 'too_many_attempts', retry_after_sec: rl.retryAfterSec, message: `尝试次数过多，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试` });
    }
    const { password } = req.body || {};
    if (!env.ADMIN_PASSWORD || String(password) !== env.ADMIN_PASSWORD) {
      windowRecord(loginAttempts, ip, LOGIN_WINDOW_MS);
      return res.status(401).json({ ok: false, error: 'bad_admin_password' });
    }
    windowClear(loginAttempts, ip);
    const sess = createSession(db, 'admin', null);
    res.cookie(ADMIN_COOKIE, sess.token, Object.assign({ maxAge: 12 * 3600 * 1000 }, cookieBase));
    res.json({ ok: true, expires_at: sess.expires_at });
  });

  app.post('/api/admin/logout', (req, res) => {
    destroySession(db, req.cookies[ADMIN_COOKIE]);
    res.clearCookie(ADMIN_COOKIE, cookieBase);
    res.json({ ok: true });
  });

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const status = req.query.status;
    const rows = status && ['pending', 'approved', 'rejected'].includes(status)
      ? db.prepare('SELECT * FROM users WHERE status=? ORDER BY created_at DESC').all(status)
      : db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200').all();
    res.json({ ok: true, users: rows.map(publicUser) });
  });

  function setStatus(id, status, res) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
    db.prepare('UPDATE users SET status=?, approved_at=? WHERE id=?')
      .run(status, status === 'approved' ? Date.now() : u.approved_at, id);
    if (status !== 'approved') {
      db.prepare('DELETE FROM sessions WHERE user_id=? AND kind=\'user\'').run(id);
    }
    res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  }
  app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => setStatus(Number(req.params.id), 'approved', res));
  app.post('/api/admin/users/:id/reject', requireAdmin, (req, res) => setStatus(Number(req.params.id), 'rejected', res));
  app.post('/api/admin/users/:id/delete', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT id FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    res.json({ ok: true, deleted: id });
  });

  // 设置到期天数：days>0 设为 N 天；days=0 立即到期；days<0 清除到期限制（不设到期）
  app.post('/api/admin/users/:id/expiry', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
    const days = Number((req.body || {}).days);
    if (!Number.isFinite(days)) return res.status(400).json({ ok: false, error: 'bad_days' });
    const expiresAt = days < 0 ? null : Date.now() + days * DAY_MS;
    db.prepare('UPDATE users SET expires_at=? WHERE id=?').run(expiresAt, id);
    res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });
  // 永久会员开关（仅后台可操作）
  app.post('/api/admin/users/:id/permanent', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
    const on = !!(req.body || {}).on;
    db.prepare('UPDATE users SET permanent=? WHERE id=?').run(on ? 1 : 0, id);
    res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });
  // 老板开关（仅后台可操作，老板=无限）
  app.post('/api/admin/users/:id/bt-open', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const open = req.body && req.body.open ? 1 : 0;
    db.prepare('UPDATE users SET bt_open=? WHERE id=?').run(open, id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    res.json({ ok: true, user: publicUser(u) });
  });
  app.post('/api/admin/users/:id/owner', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) return res.status(404).json({ ok: false, error: 'not_found' });
    const on = !!(req.body || {}).on;
    db.prepare('UPDATE users SET is_owner=? WHERE id=?').run(on ? 1 : 0, id);
    res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  });

  return { requireAuth, requireVip, requireAdmin };
}

module.exports = { registerAuthRoutes, makeMiddleware, createSession, findSession, USER_COOKIE, ADMIN_COOKIE, vipOf, vipActive };
