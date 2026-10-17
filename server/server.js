'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, now, hashPassword, verifyPassword, DB_PATH } = require('./db');
const hardware = require('./hardware');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

const COOKIE_NAME = 'observatory.sid';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'];
const RATE_WINDOW_MS = parseInt(process.env.AUTH_RATE_WINDOW_MS, 10) || 15 * 60 * 1000;
const RATE_MAX = parseInt(process.env.AUTH_RATE_MAX, 10) || 20;

/* ==================== 基础工具 ==================== */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function genToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userId) {
  const token = genToken();
  const createdAt = now();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, createdAt, expiresAt);
  return { token: token, expiresAt: expiresAt };
}

function findSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT token, user_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.indexOf('Bearer ') === 0) return auth.slice(7).trim();
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] || null;
}

function findUserById(id) {
  return db.prepare('SELECT id, username, name, role, created_at FROM users WHERE id = ?').get(id) || null;
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

function setSessionCookie(res, session) {
  const parts = [
    COOKIE_NAME + '=' + session.token,
    'Path=/',
    'HttpOnly',
    'SameSite=' + (process.env.COOKIE_SAMESITE || 'Lax'),
    'Max-Age=' + Math.floor(SESSION_TTL_MS / 1000),
  ];
  if (process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function attachUser(req, res, next) {
  const token = extractToken(req);
  const session = findSession(token);
  req.sessionToken = session ? token : null;
  req.user = session ? findUserById(session.user_id) : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

const rateBuckets = new Map();
function authLimiter(req, res, next) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const t = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || t - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: t, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  res.setHeader('RateLimit-Limit', String(RATE_MAX));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, RATE_MAX - bucket.count)));
  res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.start + RATE_WINDOW_MS) / 1000)));
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }
  next();
}

app.use(attachUser);

/* ==================== 业务工具 ==================== */
function addAudit(user, action, detail) {
  db.prepare('INSERT INTO audit_logs (user_id, username, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(user ? user.id : null, user ? user.username : null, action, detail || null, now());
}

function addHistory(applicationId, fromStatus, toStatus, action, operator, comment) {
  db.prepare('INSERT INTO status_history (application_id, from_status, to_status, action, operator_id, operator_name, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(applicationId, fromStatus, toStatus, action, operator ? operator.id : null, operator ? operator.name : null, comment || null, now());
}

function genAppNo() {
  const year = new Date().getFullYear();
  const prefix = 'TEL-' + year + '-';
  const row = db.prepare('SELECT COUNT(*) AS c FROM applications WHERE app_no LIKE ?').get(prefix + '%');
  const seq = (row ? row.c : 0) + 1;
  return prefix + String(seq).padStart(4, '0');
}

const APP_COLS = [
  'a.id', 'a.app_no', 'a.user_id', 'a.applicant_name', 'a.applicant_contact',
  'a.device', 'a.start_time', 'a.end_time', 'a.target', 'a.purpose', 'a.status',
  'a.created_at', 'a.reviewed_at', 'a.reviewed_by', 'a.review_comment',
  'r.name AS reviewer_name', 'u.username AS applicant_username'
].join(', ');
const APP_FROM = 'FROM applications a LEFT JOIN users r ON a.reviewed_by = r.id LEFT JOIN users u ON a.user_id = u.id';

function findConflicts(device, start, end, excludeId) {
  let sql = 'SELECT id, app_no, start_time, end_time, status FROM applications ' +
    'WHERE device = ? AND status IN (\'pending\', \'approved\') AND start_time < ? AND end_time > ?';
  const params = [device, end, start];
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  sql += ' ORDER BY start_time ASC, id ASC';
  return db.prepare(sql).all(...params);
}

function localNowMinute() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function isDeviceValid(name) {
  if (!name) return false;
  return !!db.prepare('SELECT id FROM devices WHERE name = ?').get(name);
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* ==================== 健康检查 ==================== */
app.get('/', function (req, res) {
  res.json({ name: '远程天文台使用申请审批及统计系统 API', version: '1.0.0', db: DB_PATH });
});
app.get('/api/health', function (req, res) {
  res.json({ ok: true, time: now() });
});

/* ==================== 认证 ==================== */
app.post('/api/auth/register', authLimiter, function (req, res) {
  const body = req.body || {};
  const username = asTrimmedString(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  const name = asTrimmedString(body.name) || username;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名需为 3-20 个字符' });
    }
    return res.status(400).json({ error: '用户名仅支持字母、数字、下划线' });
  }
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: '用户名已存在' });
  const info = db.prepare('INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?, ?, ?, \'user\', ?)')
    .run(username, hashPassword(password), name, now());
  const user = publicUser(findUserById(Number(info.lastInsertRowid)));
  const session = createSession(user.id);
  addAudit(user, 'register', '注册账号 ' + username);
  setSessionCookie(res, session);
  res.status(201).json({ user: user, token: session.token });
});

app.post('/api/auth/login', authLimiter, function (req, res) {
  const body = req.body || {};
  const username = asTrimmedString(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const user = publicUser(row);
  const session = createSession(row.id);
  addAudit(user, 'login', '登录系统');
  setSessionCookie(res, session);
  res.json({ user: user, token: session.token });
});

app.post('/api/auth/logout', function (req, res) {
  const token = extractToken(req);
  if (token) {
    const session = findSession(token);
    if (session) {
      const user = findUserById(session.user_id);
      if (user) addAudit(user, 'logout', '退出登录');
    }
    destroySession(token);
  }
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', function (req, res) {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/auth/change-password', authLimiter, requireAuth, function (req, res) {
  const body = req.body || {};
  const oldPassword = typeof body.old_password === 'string' ? body.old_password : '';
  const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(oldPassword, row.password_hash)) {
    return res.status(400).json({ error: '当前密码错误' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), req.user.id);
  addAudit(req.user, 'change_password', '修改密码');
  res.json({ ok: true });
});

/* ==================== 设备 ==================== */
app.get('/api/devices', function (req, res) {
  const rows = db.prepare(
    'SELECT d.id, d.name, (SELECT COUNT(*) FROM applications a WHERE a.device = d.name) AS count ' +
    'FROM devices d ORDER BY d.id ASC'
  ).all();
  res.json({ devices: rows });
});

app.post('/api/admin/devices', requireAdmin, function (req, res) {
  const name = asTrimmedString((req.body || {}).name);
  if (!name) return res.status(400).json({ error: '设备名称不能为空' });
  if (name.length > 50) return res.status(400).json({ error: '设备名称过长（最多 50 字）' });
  if (db.prepare('SELECT id FROM devices WHERE name = ?').get(name)) {
    return res.status(409).json({ error: '该设备已存在' });
  }
  const info = db.prepare('INSERT INTO devices (name, created_at) VALUES (?, ?)').run(name, now());
  addAudit(req.user, 'add_device', '新增设备 ' + name);
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid), name: name });
});

app.put('/api/admin/devices/:id', requireAdmin, function (req, res) {
  const id = Number(req.params.id);
  const name = asTrimmedString((req.body || {}).name);
  if (!name) return res.status(400).json({ error: '设备名称不能为空' });
  if (name.length > 50) return res.status(400).json({ error: '设备名称过长（最多 50 字）' });
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) return res.status(404).json({ error: '设备不存在' });
  if (db.prepare('SELECT id FROM devices WHERE name = ? AND id != ?').get(name, id)) {
    return res.status(409).json({ error: '该设备已存在' });
  }
  db.prepare('UPDATE applications SET device = ? WHERE device = ?').run(name, device.name);
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id);
  db.prepare('UPDATE cover_devices SET device = ?, updated_at = ? WHERE device = ?').run(name, now(), device.name);
  db.prepare('UPDATE cover_commands SET device = ? WHERE device = ?').run(name, device.name);
  db.prepare('UPDATE cover_events SET device = ? WHERE device = ?').run(name, device.name);
  db.prepare('UPDATE cover_telemetry SET device = ? WHERE device = ?').run(name, device.name);
  addAudit(req.user, 'rename_device', '设备重命名 ' + device.name + ' → ' + name);
  res.json({ ok: true, id: id, name: name });
});

app.delete('/api/admin/devices/:id', requireAdmin, function (req, res) {
  const id = Number(req.params.id);
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  if (!device) return res.status(404).json({ error: '设备不存在' });
  const row = db.prepare('SELECT COUNT(*) AS c FROM applications WHERE device = ?').get(device.name);
  if (row.c > 0) {
    return res.status(400).json({ error: '该设备已有 ' + row.c + ' 条申请记录，无法删除' });
  }
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  db.prepare('DELETE FROM cover_devices WHERE device = ?').run(device.name);
  addAudit(req.user, 'delete_device', '删除设备 ' + device.name);
  res.json({ ok: true });
});

/* ==================== 申请（普通用户） ==================== */
app.get('/api/applications/conflicts', requireAuth, function (req, res) {
  const device = typeof req.query.device === 'string' ? req.query.device : '';
  const start = typeof req.query.start === 'string' ? req.query.start : '';
  const end = typeof req.query.end === 'string' ? req.query.end : '';
  if (!device || !start || !end) return res.json({ conflicts: [] });
  res.json({ conflicts: findConflicts(device, start, end, null) });
});

app.post('/api/applications', requireAuth, function (req, res) {
  const body = req.body || {};
  const device = asTrimmedString(body.device);
  const start = typeof body.start_time === 'string' ? body.start_time : '';
  const end = typeof body.end_time === 'string' ? body.end_time : '';
  const target = asTrimmedString(body.target);
  const purpose = asTrimmedString(body.purpose);
  const applicantName = asTrimmedString(body.applicant_name);
  const applicantContact = asTrimmedString(body.applicant_contact);

  if (!device || !isDeviceValid(device)) return res.status(400).json({ error: '请选择有效的观测设备' });
  if (!start || !end) return res.status(400).json({ error: '请填写完整的使用时段' });
  if (end <= start) return res.status(400).json({ error: '结束时间必须晚于开始时间' });
  if (start < localNowMinute()) return res.status(400).json({ error: '不能选择过去的时段' });
  if (!target) return res.status(400).json({ error: '请填写拍摄目标' });
  if (!purpose) return res.status(400).json({ error: '请填写拍摄目的' });
  if (!applicantName) return res.status(400).json({ error: '请填写申请人姓名' });
  if (!applicantContact) return res.status(400).json({ error: '请填写联系方式' });

  const conflicts = findConflicts(device, start, end, null);
  if (conflicts.length > 0) {
    return res.status(409).json({ error: '该设备在所选时段已被占用', conflicts: conflicts });
  }

  const appNo = genAppNo();
  const info = db.prepare(
    'INSERT INTO applications (app_no, user_id, applicant_name, applicant_contact, device, start_time, end_time, target, purpose, status, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?)'
  ).run(appNo, req.user.id, applicantName, applicantContact, device, start, end, target, purpose, now());
  const id = Number(info.lastInsertRowid);
  addHistory(id, null, 'pending', 'submit', req.user, null);
  addAudit(req.user, 'submit_application', '提交申请 ' + appNo);
  res.status(201).json({ ok: true, id: id, app_no: appNo });
});

app.get('/api/applications/mine', requireAuth, function (req, res) {
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' WHERE a.user_id = ? ORDER BY a.created_at DESC, a.id DESC').all(req.user.id);
  res.json({ applications: rows });
});

app.get('/api/applications/:id', requireAuth, function (req, res) {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' WHERE a.id = ?').get(id);
  if (!row) return res.status(404).json({ error: '申请不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
    return res.status(403).json({ error: '无权查看该申请' });
  }
  const history = db.prepare('SELECT * FROM status_history WHERE application_id = ? ORDER BY created_at ASC, id ASC').all(id);
  res.json({ application: row, history: history });
});

app.post('/api/applications/:id/withdraw', requireAuth, function (req, res) {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '申请不存在' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: '无权操作该申请' });
  if (row.status !== 'pending') return res.status(400).json({ error: '仅待审批的申请可撤回' });
  db.prepare('UPDATE applications SET status = \'withdrawn\' WHERE id = ?').run(id);
  addHistory(id, 'pending', 'withdrawn', 'withdraw', req.user, null);
  addAudit(req.user, 'withdraw_application', '撤回申请 ' + row.app_no);
  res.json({ ok: true });
});

/* ==================== 管理端 ==================== */
app.get('/api/admin/applications', requireAdmin, function (req, res) {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const search = asTrimmedString(req.query.search);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let pageSize = parseInt(req.query.pageSize, 10) || 20;
  if (pageSize < 1) pageSize = 20;
  if (pageSize > 50) pageSize = 50;

  const where = [];
  const params = [];
  if (status && STATUSES.indexOf(status) !== -1) {
    where.push('a.status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(a.app_no LIKE ? OR a.applicant_name LIKE ? OR a.target LIKE ? OR a.device LIKE ?)');
    const like = '%' + search + '%';
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const totalRow = db.prepare('SELECT COUNT(*) AS c ' + APP_FROM + whereSql).get(...params);
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + whereSql + ' ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?')
    .all(...params, pageSize, (page - 1) * pageSize);
  res.json({ applications: rows, total: totalRow.c, page: page, pageSize: pageSize });
});

app.get('/api/admin/pending', requireAdmin, function (req, res) {
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' WHERE a.status = \'pending\' ORDER BY a.created_at ASC, a.id ASC').all();
  res.json({ applications: rows });
});

app.get('/api/admin/calendar', requireAdmin, function (req, res) {
  const rows = db.prepare(
    'SELECT id, app_no, device, start_time, end_time, status FROM applications ' +
    'WHERE status IN (\'pending\', \'approved\') ORDER BY start_time ASC, id ASC'
  ).all();
  res.json({ slots: rows });
});

app.post('/api/admin/applications/:id/review', requireAdmin, function (req, res) {
  const id = Number(req.params.id);
  const body = req.body || {};
  const action = body.action;
  const comment = asTrimmedString(body.comment);
  const force = body.force === true;
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: '审批操作不合法' });
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '申请不存在' });
  if (row.status !== 'pending') return res.status(400).json({ error: '该申请已处理' });
  if (action === 'reject' && !comment) return res.status(400).json({ error: '拒绝时必须填写审批意见' });
  if (action === 'approve') {
    const conflicts = findConflicts(row.device, row.start_time, row.end_time, id);
    if (conflicts.length > 0 && !force) {
      return res.status(409).json({ error: '该申请与以下已占用时段冲突', conflicts: conflicts });
    }
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE applications SET status = ?, reviewed_at = ?, reviewed_by = ?, review_comment = ? WHERE id = ?')
    .run(newStatus, now(), req.user.id, comment || null, id);
  addHistory(id, 'pending', newStatus, action, req.user, comment || null);
  addAudit(req.user, action === 'approve' ? 'approve_application' : 'reject_application',
    (action === 'approve' ? '通过申请 ' : '拒绝申请 ') + row.app_no);
  res.json({ ok: true, status: newStatus });
});

app.get('/api/admin/stats', requireAdmin, function (req, res) {
  const counts = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
  db.prepare('SELECT status, COUNT(*) AS c FROM applications GROUP BY status').all().forEach(function (r) {
    if (counts[r.status] !== undefined) counts[r.status] = r.c;
  });
  const total = counts.pending + counts.approved + counts.rejected + counts.withdrawn;
  const byDevice = db.prepare('SELECT device, COUNT(*) AS c FROM applications GROUP BY device ORDER BY c DESC, device ASC').all();
  const byMonthRaw = db.prepare('SELECT substr(created_at, 1, 7) AS ym, COUNT(*) AS c FROM applications GROUP BY ym ORDER BY ym ASC').all();
  const denom = counts.approved + counts.rejected;
  const approveRate = denom > 0 ? Math.round((counts.approved / denom) * 100) : 0;
  res.json({ counts: counts, total: total, byDevice: byDevice, byMonthRaw: byMonthRaw, approveRate: approveRate });
});

function csvEsc(value) {
  let s = (value === null || value === undefined) ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

app.get('/api/admin/export.csv', requireAdmin, function (req, res) {
  const rows = db.prepare('SELECT ' + APP_COLS + ' ' + APP_FROM + ' ORDER BY a.created_at DESC, a.id DESC').all();
  const header = ['申请编号', '申请人', '申请人账号', '联系方式', '观测设备', '开始时间', '结束时间', '拍摄目标', '拍摄目的', '状态', '提交时间', '审批时间', '审批人', '审批意见'];
  const statusMap = { pending: '待审批', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
  const lines = [header.map(csvEsc).join(',')];
  rows.forEach(function (r) {
    lines.push([
      r.app_no, r.applicant_name, r.applicant_username, r.applicant_contact, r.device,
      r.start_time, r.end_time, r.target, r.purpose, statusMap[r.status] || r.status,
      r.created_at, r.reviewed_at || '', r.reviewer_name || '', r.review_comment || ''
    ].map(csvEsc).join(','));
  });
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  const filename = 'observatory-report-' + new Date().toISOString().slice(0, 10) + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(csv);
});

app.get('/api/admin/audit', requireAdmin, function (req, res) {
  const rows = db.prepare('SELECT id, user_id, username, action, detail, created_at FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 200').all();
  res.json({ logs: rows });
});

/* ==================== 观测站顶盖远程控制 ==================== */

/** 设备侧鉴权：ESP32 用 X-Device-Token 头（也兼容 ?token=，方便浏览器调试） */
function requireDevice(req, res, next) {
  const header = req.headers['x-device-token'];
  const token = (typeof header === 'string' && header) ||
    (typeof req.query.token === 'string' ? req.query.token : '');
  const cover = hardware.getCoverByToken(token);
  if (!cover) return res.status(401).json({ error: '设备令牌无效' });
  if (!cover.enabled) return res.status(403).json({ error: '该设备的远程控制已停用' });
  req.cover = cover;
  next();
}

/** 该设备此刻的已批准占用情况 */
function currentOccupancy(device) {
  const t = hardware.nowMinute();
  return db.prepare(
    'SELECT a.id, a.app_no, a.applicant_name, a.start_time, a.end_time, a.target, u.username ' +
    'FROM applications a LEFT JOIN users u ON a.user_id = u.id ' +
    'WHERE a.device = ? AND a.status = \'approved\' AND a.start_time <= ? AND a.end_time >= ? ' +
    'ORDER BY a.start_time ASC'
  ).all(device, t, t);
}

function decorateCoverFor(row, user) {
  const o = hardware.decorate(row);
  const openVerdict = hardware.evaluateOpen(user, row);
  const closeVerdict = hardware.evaluateClose(row);
  o.can_open = openVerdict.allowed;
  o.open_reason = openVerdict.reason;
  o.can_close = closeVerdict.allowed;
  o.close_reason = closeVerdict.reason;
  o.active_application = openVerdict.application || null;
  o.elevated = !!openVerdict.elevated;
  o.occupancy = currentOccupancy(row.device);
  return o;
}

/* ---------- 用户端 ---------- */

app.get('/api/observatory/covers', requireAuth, function (req, res) {
  const rows = db.prepare('SELECT * FROM cover_devices ORDER BY id ASC').all();
  res.json({
    covers: rows.map(function (row) { return decorateCoverFor(row, req.user); }),
    policy: {
      wind_limit: hardware.WIND_LIMIT,
      offline_sec: hardware.OFFLINE_SEC,
      open_grace_min: hardware.OPEN_GRACE_MIN,
      close_grace_min: hardware.CLOSE_GRACE_MIN,
      auto_close: hardware.AUTO_CLOSE
    }
  });
});

app.get('/api/observatory/covers/:id', requireAuth, function (req, res) {
  const row = hardware.getCoverById(req.params.id);
  if (!row) return res.status(404).json({ error: '该观测站未接入远程控制' });
  res.json({
    cover: decorateCoverFor(row, req.user),
    commands: hardware.listCommands(row.device, 30),
    events: hardware.listEvents(row.device, 30)
  });
});

app.post('/api/observatory/covers/:id/command', requireAuth, function (req, res) {
  const cover = hardware.getCoverById(req.params.id);
  if (!cover) return res.status(404).json({ error: '该观测站未接入远程控制' });
  const action = asTrimmedString((req.body || {}).action);
  if (hardware.ACTIONS.indexOf(action) === -1) {
    return res.status(400).json({ error: '不支持的指令：' + (action || '(空)') });
  }

  if (action === 'open') {
    const verdict = hardware.evaluateOpen(req.user, cover);
    if (!verdict.allowed) {
      return res.status(403).json({ error: verdict.reason, code: 'OPEN_DENIED' });
    }
  } else if (action === 'close') {
    const verdict = hardware.evaluateClose(cover);
    if (!verdict.allowed) {
      return res.status(409).json({ error: verdict.reason, code: 'CLOSE_DENIED' });
    }
  } else if (!hardware.isOnline(cover)) {
    return res.status(409).json({ error: '观测站离线，无法下发' + (action === 'stop' ? '停止' : '复位') + '指令' });
  }

  const online = hardware.isOnline(cover);
  const cmd = hardware.queueCommand({
    device: cover.device,
    action: action,
    source: 'user',
    user: req.user,
    detail: '用户 ' + req.user.name + ' 通过小程序下发'
  });
  hardware.logEvent(cover.device, 'info', 'CMD_' + action.toUpperCase(),
    req.user.name + '(' + req.user.username + ') 下发 ' + action);
  addAudit(req.user, 'cover_' + action, '顶盖指令 ' + action + ' @ ' + cover.device + ' reqId=' + cmd.req_id);

  res.status(202).json({
    ok: true,
    delivered: online,
    message: online ? '指令已下发' : '观测站离线，指令已排队，设备恢复连接后执行',
    command: cmd,
    cover: decorateCoverFor(hardware.getCoverByDevice(cover.device), req.user)
  });
});

app.post('/api/observatory/covers/:id/emergency-close', requireAuth, function (req, res) {
  const cover = hardware.getCoverById(req.params.id);
  if (!cover) return res.status(404).json({ error: '该观测站未接入远程控制' });
  db.prepare('UPDATE cover_commands SET status = \'superseded\', detail = \'被紧急关盖指令取代\' ' +
    'WHERE device = ? AND status IN (\'pending\', \'delivered\')').run(cover.device);
  const cmd = hardware.queueCommand({
    device: cover.device, action: 'close', source: 'emergency', user: req.user,
    detail: '紧急关盖（' + req.user.name + '）'
  });
  hardware.logEvent(cover.device, 'warn', 'EMERGENCY_CLOSE', req.user.name + ' 触发紧急关盖');
  addAudit(req.user, 'cover_emergency_close', '紧急关盖 @ ' + cover.device + ' reqId=' + cmd.req_id);
  res.status(202).json({ ok: true, command: cmd, cover: decorateCoverFor(hardware.getCoverByDevice(cover.device), req.user) });
});

/* ---------- 管理端 ---------- */

app.get('/api/admin/observatory', requireAdmin, function (req, res) {
  const bound = db.prepare('SELECT * FROM cover_devices ORDER BY id ASC').all();
  const boundNames = bound.map(function (r) { return r.device; });
  const all = db.prepare('SELECT id, name FROM devices ORDER BY id ASC').all();
  const unbound = all.filter(function (d) { return boundNames.indexOf(d.name) === -1; });
  res.json({
    covers: bound.map(function (row) { return decorateCoverFor(row, req.user); }),
    unbound: unbound,
    policy: {
      wind_limit: hardware.WIND_LIMIT,
      offline_sec: hardware.OFFLINE_SEC,
      open_grace_min: hardware.OPEN_GRACE_MIN,
      close_grace_min: hardware.CLOSE_GRACE_MIN,
      auto_close: hardware.AUTO_CLOSE
    }
  });
});

app.post('/api/admin/observatory/bind', requireAdmin, function (req, res) {
  const device = asTrimmedString((req.body || {}).device);
  if (!device) return res.status(400).json({ error: '请选择要接入的设备' });
  let result;
  try {
    result = hardware.bindCover(device);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  addAudit(req.user, 'cover_bind', (result.rebound ? '重置令牌 ' : '接入远程控制 ') + device);
  res.status(201).json({
    ok: true,
    id: result.id,
    device: result.device,
    token: result.token,
    rebound: result.rebound,
    warning: '设备令牌仅本次返回，请立即写入 ESP32 固件；遗失只能重置。'
  });
});

app.post('/api/admin/observatory/:id/enabled', requireAdmin, function (req, res) {
  const enabled = (req.body || {}).enabled !== false;
  let row;
  try {
    row = hardware.setEnabled(req.params.id, enabled);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  addAudit(req.user, 'cover_enable', (enabled ? '启用' : '停用') + '远程控制 @ ' + row.device);
  res.json({ ok: true, cover: decorateCoverFor(row, req.user) });
});

app.delete('/api/admin/observatory/:id', requireAdmin, function (req, res) {
  let row;
  try {
    row = hardware.unbindCover(req.params.id);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  addAudit(req.user, 'cover_unbind', '解除远程控制 ' + row.device);
  res.json({ ok: true });
});

app.post('/api/admin/observatory/:id/command', requireAdmin, function (req, res) {
  const cover = hardware.getCoverById(req.params.id);
  if (!cover) return res.status(404).json({ error: '该观测站未接入远程控制' });
  const action = asTrimmedString((req.body || {}).action);
  if (hardware.ACTIONS.indexOf(action) === -1) {
    return res.status(400).json({ error: '不支持的指令：' + (action || '(空)') });
  }
  // 管理员强制通道：刻意绕过在线/位置/故障等前置校验，仅用于应急。
  // 离线时指令会排队（close 的排队有效期 1 小时），设备恢复连接后执行。
  const online = hardware.isOnline(cover);
  const cmd = hardware.queueCommand({
    device: cover.device, action: action, source: 'admin-override', user: req.user,
    detail: '管理员强制操作（绕过前置校验）'
  });
  hardware.logEvent(cover.device, 'warn', 'CMD_' + action.toUpperCase(),
    '管理员 ' + req.user.name + ' 强制下发 ' + action);
  addAudit(req.user, 'cover_override', '管理员强制 ' + action + ' @ ' + cover.device + ' reqId=' + cmd.req_id);
  res.status(202).json({
    ok: true,
    delivered: online,
    message: online ? '强制指令已下发' : '观测站离线，指令已排队，设备恢复连接后执行',
    command: cmd,
    cover: decorateCoverFor(hardware.getCoverByDevice(cover.device), req.user)
  });
});

/* ---------- 设备端（ESP32 调用） ---------- */

app.get('/api/observatory/device/poll', requireDevice, function (req, res) {
  const cover = req.cover;
  let wait = parseInt(req.query.wait, 10);
  if (!Number.isFinite(wait)) wait = 25;
  wait = Math.min(Math.max(wait, 0), hardware.POLL_MAX_SEC);

  hardware.touch(cover.device, { ip: req.ip });

  let finished = false;
  const send = function (cmd) {
    if (finished) return;
    finished = true;
    res.json({
      device: cover.device,
      serverTime: now(),
      command: hardware.publicCommand(cmd)
    });
  };

  if (wait === 0) return send(hardware.takePending(cover.device));
  hardware.waitForCommand(cover.device, wait * 1000).then(send).catch(function () { send(null); });
  req.on('close', function () { finished = true; });
});

app.post('/api/observatory/device/state', requireDevice, function (req, res) {
  let row;
  try {
    row = hardware.reportState(req.cover.device, req.body || {});
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  res.json({ ok: true, cover: hardware.decorate(row) });
});

app.post('/api/observatory/device/ack', requireDevice, function (req, res) {
  const body = req.body || {};
  const reqId = asTrimmedString(body.reqId);
  if (!reqId) return res.status(400).json({ error: '缺少 reqId' });
  let row;
  try {
    row = hardware.ackCommand(req.cover.device, reqId, asTrimmedString(body.status), asTrimmedString(body.detail));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  res.json({ ok: true, command: row });
});

app.post('/api/observatory/device/event', requireDevice, function (req, res) {
  const body = req.body || {};
  const code = asTrimmedString(body.code) || 'UNKNOWN';
  const level = ['info', 'warn', 'error'].indexOf(body.level) === -1 ? 'info' : body.level;
  hardware.logEvent(req.cover.device, level, code, asTrimmedString(body.message));
  if (level === 'error') {
    addAudit(null, 'cover_device_error', '[' + req.cover.device + '] ' + code + ' ' + (body.message || ''));
  }
  res.json({ ok: true });
});

/* ==================== 兜底与错误处理 ==================== */
app.use('/api', function (req, res) {
  res.status(404).json({ error: '接口不存在' });
});

app.use(function (err, req, res, next) {
  console.error('[error]', err && err.message ? err.message : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const server = app.listen(PORT, function () {
  console.log('远程天文台系统已启动（小程序后端）: http://localhost:' + PORT);
  console.log('管理员账号: admin / admin123（默认密码，生产请设置 ADMIN_PASSWORD）');
  hardware.startScheduler();
  const covers = db.prepare('SELECT COUNT(*) AS c FROM cover_devices').get();
  console.log('观测站远程控制: 已接入 ' + covers.c + ' 台设备' +
    (hardware.AUTO_CLOSE ? '，时段结束自动关盖已开启' : '，自动关盖已关闭'));
});

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('【错误】端口 ' + PORT + ' 已被占用。');
    console.error('请先关闭占用该端口的进程，或使用其他端口启动，例如：');
    console.error('  PORT=3001 npm start');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

module.exports = app;
