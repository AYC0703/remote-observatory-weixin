'use strict';

/**
 * 观测站顶盖控制 —— 硬件桥接层
 *
 * 设计要点（务必先读）：
 *   1. 通信模型为「设备主动长轮询」，ESP32 主动外连服务器取指令。
 *      好处：不需要公网 IP、不需要端口映射、不引入任何新依赖（纯 HTTP）。
 *   2. 开盖受审批时段约束；关盖不设权限——安全方向的操作永远放行。
 *   3. 降雨 / 风速 / 故障 / 离线一律禁止开盖，但都不阻止关盖。
 *   4. 通信失联时绝不自动关盖（会毁掉正在进行的曝光），只告警。
 *   5. 时段结束宽限期过后才自动关盖，可用 COVER_AUTO_CLOSE=false 关闭。
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { db, now } = require('./db');

/* ==================== 可调参数（全部可用环境变量覆盖） ==================== */
function envInt(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}
function envNum(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

const OFFLINE_SEC = envInt('COVER_OFFLINE_SEC', 45);
const OPEN_GRACE_MIN = envInt('COVER_OPEN_GRACE_MIN', 10);
const CLOSE_GRACE_MIN = envInt('COVER_CLOSE_GRACE_MIN', 15);
const COMMAND_TTL_SEC = envInt('COVER_COMMAND_TTL_SEC', 90);
const CLOSE_TTL_SEC = envInt('COVER_CLOSE_TTL_SEC', 3600);
const POLL_MAX_SEC = envInt('COVER_POLL_MAX_SEC', 50);
const WIND_LIMIT = envNum('COVER_WIND_LIMIT', 12);
const AUTO_CLOSE = process.env.COVER_AUTO_CLOSE !== 'false';
const SWEEP_MS = envInt('COVER_SWEEP_MS', 30000);
const TELEMETRY_MIN_SEC = envInt('COVER_TELEMETRY_MIN_SEC', 120);

const ACTIONS = ['open', 'close', 'stop', 'clear-fault'];
const POSITION_TEXT = {
  unknown: '状态未知',
  open: '已开启',
  closed: '已关闭',
  partial: '半开',
  moving: '动作中'
};

const bus = new EventEmitter();
bus.setMaxListeners(0);

/* ==================== 时间工具（与 server.js 的本地分钟格式保持一致） ==================== */
function pad2(n) { return n < 10 ? '0' + n : String(n); }

function localMinute(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}
function nowMinute() { return localMinute(new Date()); }
function shiftMinute(deltaMin) { return localMinute(new Date(Date.now() + deltaMin * 60000)); }
function fmtSlot(v) { return v ? String(v).replace('T', ' ') : '—'; }

function error(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ==================== 绑定管理 ==================== */
function genToken() {
  return 'cov_' + crypto.randomBytes(24).toString('hex');
}

function getCoverByDevice(device) {
  if (!device) return null;
  return db.prepare('SELECT * FROM cover_devices WHERE device = ?').get(device) || null;
}

function getCoverById(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  return db.prepare('SELECT * FROM cover_devices WHERE id = ?').get(n) || null;
}

function getCoverByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM cover_devices WHERE token = ?').get(token) || null;
}

/** 绑定设备（重复绑定时重置令牌）。返回明文令牌，仅此一次可见。 */
function bindCover(device) {
  const exists = db.prepare('SELECT id FROM devices WHERE name = ?').get(device);
  if (!exists) throw error(400, '设备不存在：' + device);
  const token = genToken();
  const existing = getCoverByDevice(device);
  if (existing) {
    db.prepare('UPDATE cover_devices SET token = ?, enabled = 1, updated_at = ? WHERE id = ?')
      .run(token, now(), existing.id);
    return { id: existing.id, device: device, token: token, rebound: true };
  }
  const info = db.prepare(
    'INSERT INTO cover_devices (device, token, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(device, token, now(), now());
  return { id: Number(info.lastInsertRowid), device: device, token: token, rebound: false };
}

function unbindCover(id) {
  const cover = getCoverById(id);
  if (!cover) throw error(404, '该观测站未接入远程控制');
  db.prepare('DELETE FROM cover_devices WHERE id = ?').run(cover.id);
  return cover;
}

function setEnabled(id, enabled) {
  const cover = getCoverById(id);
  if (!cover) throw error(404, '该观测站未接入远程控制');
  db.prepare('UPDATE cover_devices SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, now(), cover.id);
  return getCoverById(id);
}

/* ==================== 状态 ==================== */
function isOnline(row) {
  if (!row || !row.last_seen) return false;
  return (Date.now() - new Date(row.last_seen).getTime()) < OFFLINE_SEC * 1000;
}

function decorate(row) {
  if (!row) return null;
  const o = Object.assign({}, row);
  delete o.token;
  o.device_id = row.id;
  o.online = isOnline(row);
  o.online_text = o.online ? '在线' : '离线';
  o.position_text = POSITION_TEXT[row.position] || row.position;
  o.enabled = !!row.enabled;
  o.moving = !!row.moving;
  o.rain = !!row.rain;
  o.limits = {
    open: row.limit_open === null ? null : !!row.limit_open,
    close: row.limit_close === null ? null : !!row.limit_close
  };
  o.wind_limit = WIND_LIMIT;
  o.offline_sec = OFFLINE_SEC;
  o.open_grace_min = OPEN_GRACE_MIN;
  o.close_grace_min = CLOSE_GRACE_MIN;
  return o;
}

/** 设备上报状态 */
function reportState(device, payload) {
  const cover = getCoverByDevice(device);
  if (!cover) throw error(404, '该设备未接入远程控制');
  const p = payload || {};
  const moving = p.moving === true || p.position === 'moving';

  db.prepare(
    'UPDATE cover_devices SET position = ?, moving = ?, limit_open = ?, limit_close = ?, ' +
    'rain = ?, wind = ?, temperature = ?, humidity = ?, current_ma = ?, fault = ?, ' +
    'firmware = COALESCE(?, firmware), ip = COALESCE(?, ip), rssi = ?, last_seen = ?, updated_at = ? ' +
    'WHERE id = ?'
  ).run(
    typeof p.position === 'string' && POSITION_TEXT[p.position] ? p.position : cover.position,
    moving ? 1 : 0,
    p.limitOpen === undefined ? cover.limit_open : (p.limitOpen ? 1 : 0),
    p.limitClose === undefined ? cover.limit_close : (p.limitClose ? 1 : 0),
    p.rain === undefined ? cover.rain : (p.rain ? 1 : 0),
    p.wind === undefined || p.wind === null ? cover.wind : Number(p.wind),
    p.temperature === undefined || p.temperature === null ? cover.temperature : Number(p.temperature),
    p.humidity === undefined || p.humidity === null ? cover.humidity : Number(p.humidity),
    p.current === undefined || p.current === null ? cover.current_ma : Math.round(Number(p.current)),
    typeof p.fault === 'string' && p.fault ? p.fault : (p.fault === null || p.fault === '' ? null : cover.fault),
    p.firmware || null,
    p.ip || null,
    p.rssi === undefined || p.rssi === null ? cover.rssi : Math.round(Number(p.rssi)),
    now(),
    now(),
    cover.id
  );

  // 环境采样节流入库
  const last = db.prepare('SELECT created_at FROM cover_telemetry WHERE device = ? ORDER BY id DESC LIMIT 1').get(device);
  if (!last || (Date.now() - new Date(last.created_at).getTime()) > TELEMETRY_MIN_SEC * 1000) {
    if (p.rain !== undefined || p.wind !== undefined || p.temperature !== undefined) {
      db.prepare('INSERT INTO cover_telemetry (device, rain, wind, temperature, humidity, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(device,
          p.rain === undefined ? null : (p.rain ? 1 : 0),
          p.wind === undefined ? null : Number(p.wind),
          p.temperature === undefined ? null : Number(p.temperature),
          p.humidity === undefined ? null : Number(p.humidity),
          now());
    }
  }
  return getCoverByDevice(device);
}

/** 设备心跳（长轮询本身也算心跳） */
function touch(device, extra) {
  const p = Object.assign({}, extra || {});
  reportState(device, p);
}

function logEvent(device, level, code, message) {
  db.prepare('INSERT INTO cover_events (device, level, code, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(device, level || 'info', code, message || null, now());
}

function listEvents(device, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db.prepare('SELECT * FROM cover_events WHERE device = ? ORDER BY id DESC LIMIT ?').all(device, n);
}

function listCommands(device, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return db.prepare('SELECT * FROM cover_commands WHERE device = ? ORDER BY id DESC LIMIT ?').all(device, n);
}

/* ==================== 审批联锁 ==================== */
/** 该用户此刻（含提前量）是否有生效中的已批准申请 */
function activeApplication(userId, device, graceMin) {
  const upper = shiftMinute(graceMin || 0);
  const lower = nowMinute();
  return db.prepare(
    'SELECT id, app_no, start_time, end_time, target FROM applications ' +
    'WHERE user_id = ? AND device = ? AND status = \'approved\' ' +
    'AND start_time <= ? AND end_time >= ? ORDER BY start_time ASC LIMIT 1'
  ).get(userId, device, upper, lower) || null;
}

/** 该设备此刻是否还有生效中的申请（用于自动关盖判定） */
function hasActiveBooking(device, graceMin) {
  const lower = shiftMinute(-(graceMin || 0));
  return !!db.prepare(
    'SELECT id FROM applications WHERE device = ? AND status = \'approved\' ' +
    'AND start_time <= ? AND end_time >= ? LIMIT 1'
  ).get(device, nowMinute(), lower);
}

/** 权限判定：能否开盖。返回 { allowed, reason, application } */
function evaluateOpen(user, cover) {
  if (!cover) return { allowed: false, reason: '该设备未接入远程控制' };
  if (!cover.enabled) return { allowed: false, reason: '该设备的远程控制已停用' };
  if (!isOnline(cover)) return { allowed: false, reason: '观测站离线（超过 ' + OFFLINE_SEC + ' 秒无心跳），无法下发指令' };
  if (cover.rain) return { allowed: false, reason: '当前检测到降雨，禁止开盖' };
  if (cover.wind !== null && cover.wind !== undefined && cover.wind > WIND_LIMIT) {
    return { allowed: false, reason: '风速 ' + cover.wind + ' m/s 超过上限 ' + WIND_LIMIT + ' m/s' };
  }
  if (cover.fault) return { allowed: false, reason: '设备故障：' + cover.fault };
  if (cover.moving) return { allowed: false, reason: '设备正在动作中，请稍候' };
  if (cover.position === 'open') return { allowed: false, reason: '顶盖已处于开启状态' };

  if (user && user.role === 'admin') {
    return { allowed: true, reason: '管理员权限', application: null, elevated: true };
  }
  const app = activeApplication(user.id, cover.device, OPEN_GRACE_MIN);
  if (app) {
    return { allowed: true, reason: '申请 ' + app.app_no + ' 生效中', application: app };
  }
  const upcoming = db.prepare(
    'SELECT app_no, start_time FROM applications WHERE user_id = ? AND device = ? ' +
    'AND status = \'approved\' AND end_time >= ? ORDER BY start_time ASC LIMIT 1'
  ).get(user.id, cover.device, nowMinute());
  return {
    allowed: false,
    reason: upcoming
      ? '你的申请 ' + upcoming.app_no + ' 于 ' + fmtSlot(upcoming.start_time) + ' 开始，最早可提前 ' + OPEN_GRACE_MIN + ' 分钟开盖'
      : '当前时刻你没有该设备已批准的观测申请',
    upcoming: upcoming || null
  };
}

/** 权限判定：能否关盖。安全方向永不放行条件，只有"未接入/已停用"才拒绝。 */
function evaluateClose(cover) {
  if (!cover) return { allowed: false, reason: '该设备未接入远程控制' };
  if (!cover.enabled) return { allowed: false, reason: '该设备的远程控制已停用' };
  if (cover.position === 'closed') return { allowed: false, reason: '顶盖已处于关闭状态' };
  return { allowed: true, reason: '关盖为安全方向操作，不设权限限制' };
}

/* ==================== 指令队列 ==================== */
function commandTtlSec(action) {
  if (action === 'close') return CLOSE_TTL_SEC;
  if (action === 'stop' || action === 'clear-fault') return CLOSE_TTL_SEC;
  return COMMAND_TTL_SEC;
}

function wake(device) { bus.emit('cmd:' + device); }

function queueCommand(opts) {
  const action = opts.action;
  if (ACTIONS.indexOf(action) === -1) throw error(400, '不支持的指令：' + action);
  const reqId = 'c-' + crypto.randomBytes(8).toString('hex');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + commandTtlSec(action) * 1000).toISOString();
  db.prepare(
    'INSERT INTO cover_commands (req_id, device, action, source, user_id, username, status, detail, created_at, expires_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?)'
  ).run(
    reqId, opts.device, action, opts.source || 'api',
    opts.user ? opts.user.id : null,
    opts.user ? opts.user.username : null,
    opts.detail || null, createdAt, expiresAt
  );
  wake(opts.device);
  return db.prepare('SELECT * FROM cover_commands WHERE req_id = ?').get(reqId);
}

function expireStaleCommands() {
  const t = now();
  db.prepare(
    'UPDATE cover_commands SET status = \'expired\', detail = COALESCE(detail, \'设备未在有效期内取走指令\') ' +
    'WHERE status = \'pending\' AND expires_at IS NOT NULL AND expires_at < ?'
  ).run(t);
  db.prepare(
    'UPDATE cover_commands SET status = \'timeout\', detail = COALESCE(detail, \'设备取走指令后未回执\') ' +
    'WHERE status = \'delivered\' AND delivered_at IS NOT NULL AND delivered_at < ?'
  ).run(new Date(Date.now() - commandTtlSec('open') * 2 * 1000).toISOString());
}

/** 设备取走一条待执行指令（最长轮询被唤醒后调用） */
function takePending(device) {
  expireStaleCommands();
  const row = db.prepare(
    'SELECT * FROM cover_commands WHERE device = ? AND status = \'pending\' ORDER BY id ASC LIMIT 1'
  ).get(device);
  if (!row) return null;
  db.prepare('UPDATE cover_commands SET status = \'delivered\', delivered_at = ? WHERE id = ?').run(now(), row.id);
  row.status = 'delivered';
  return row;
}

function ackCommand(device, reqId, status, detail) {
  const row = db.prepare('SELECT * FROM cover_commands WHERE req_id = ? AND device = ?').get(reqId, device);
  if (!row) throw error(404, '指令不存在');
  const allowed = ['acked', 'failed', 'rejected'];
  const st = allowed.indexOf(status) === -1 ? 'acked' : status;
  db.prepare('UPDATE cover_commands SET status = ?, acked_at = ?, detail = COALESCE(?, detail) WHERE id = ?')
    .run(st, now(), detail || null, row.id);
  return db.prepare('SELECT * FROM cover_commands WHERE id = ?').get(row.id);
}

/** 生成下发给设备的最小指令体 */
function publicCommand(row) {
  if (!row) return null;
  return {
    reqId: row.req_id,
    action: row.action,
    issuedAt: row.created_at,
    expiresAt: row.expires_at,
    source: row.source
  };
}

/* ==================== 自动策略 ==================== */
function sweep() {
  expireStaleCommands();
  if (!AUTO_CLOSE) return;
  const covers = db.prepare('SELECT * FROM cover_devices WHERE enabled = 1').all();
  covers.forEach(function (cover) {
    if (!isOnline(cover)) return;                       // 失联设备不下发（避免恢复后误动）
    if (cover.position !== 'open' && !cover.moving) return;

    // 队列中仍有未取走的指令，或刚下发不足 60 秒 —— 先不叠加新指令。
    // 注意：只把「刚下发」的 delivered 视为在途，否则设备失联后
    // 一条无人回执的指令会把自动关盖卡住好几分钟，那是不可接受的。
    const inflight = db.prepare(
      'SELECT id FROM cover_commands WHERE device = ? AND ' +
      '(\'pending\' = status OR (status = \'delivered\' AND delivered_at > ?)) LIMIT 1'
    ).get(cover.device, new Date(Date.now() - 60000).toISOString());
    if (inflight) return;

    // ① 降雨兜底：设备本地也有关雨硬逻辑，这里是第二道防线
    if (cover.rain) {
      queueCommand({
        device: cover.device, action: 'close', source: 'auto-rain',
        detail: '检测到降雨，服务器兜底关盖'
      });
      logEvent(cover.device, 'warn', 'AUTO_CLOSE_RAIN', '降雨触发服务器兜底关盖');
      return;
    }

    // ② 时段结束后自动关盖（含宽限）
    if (hasActiveBooking(cover.device, CLOSE_GRACE_MIN)) return;
    queueCommand({
      device: cover.device, action: 'close', source: 'auto-schedule',
      detail: '申请时段结束 ' + CLOSE_GRACE_MIN + ' 分钟后自动关盖'
    });
    logEvent(cover.device, 'warn', 'AUTO_CLOSE_SCHEDULE', '时段结束，系统自动关盖');
  });
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(function () {
    try { sweep(); } catch (e) { console.error('[cover] 自动策略执行异常:', e.message); }
  }, SWEEP_MS);
  if (timer.unref) timer.unref();
}
function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** 长轮询：等待该设备的指令，最多 waitMs 毫秒 */
function waitForCommand(device, waitMs) {
  const immediate = takePending(device);
  if (immediate) return Promise.resolve(immediate);
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timerId);
      bus.removeListener('cmd:' + device, onWake);
      resolve(takePending(device));
    };
    const onWake = function () { finish(); };
    const timerId = setTimeout(finish, waitMs);
    bus.once('cmd:' + device, onWake);
  });
}

module.exports = {
  ACTIONS: ACTIONS,
  POSITION_TEXT: POSITION_TEXT,
  WIND_LIMIT: WIND_LIMIT,
  OFFLINE_SEC: OFFLINE_SEC,
  OPEN_GRACE_MIN: OPEN_GRACE_MIN,
  CLOSE_GRACE_MIN: CLOSE_GRACE_MIN,
  POLL_MAX_SEC: POLL_MAX_SEC,
  AUTO_CLOSE: AUTO_CLOSE,

  genToken: genToken,
  bindCover: bindCover,
  unbindCover: unbindCover,
  setEnabled: setEnabled,
  getCoverByDevice: getCoverByDevice,
  getCoverById: getCoverById,
  getCoverByToken: getCoverByToken,

  decorate: decorate,
  isOnline: isOnline,
  reportState: reportState,
  touch: touch,
  logEvent: logEvent,
  listEvents: listEvents,
  listCommands: listCommands,

  evaluateOpen: evaluateOpen,
  evaluateClose: evaluateClose,
  activeApplication: activeApplication,
  hasActiveBooking: hasActiveBooking,
  nowMinute: nowMinute,

  queueCommand: queueCommand,
  takePending: takePending,
  ackCommand: ackCommand,
  publicCommand: publicCommand,
  expireStaleCommands: expireStaleCommands,
  waitForCommand: waitForCommand,

  sweep: sweep,
  startScheduler: startScheduler,
  stopScheduler: stopScheduler
};
