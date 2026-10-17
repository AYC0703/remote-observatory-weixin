'use strict';

/**
 * 数据访问层 —— 与网页版设计保持一致，并新增 sessions 表以支持
 * 微信小程序的 Bearer Token 鉴权（小程序不依赖 Cookie）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'observatory.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'username TEXT NOT NULL UNIQUE, ' +
    'password_hash TEXT NOT NULL, ' +
    'name TEXT NOT NULL, ' +
    'role TEXT NOT NULL DEFAULT \'user\', ' +
    'created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS applications (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'app_no TEXT NOT NULL UNIQUE, ' +
    'user_id INTEGER NOT NULL REFERENCES users(id), ' +
    'applicant_name TEXT NOT NULL, ' +
    'applicant_contact TEXT NOT NULL, ' +
    'device TEXT NOT NULL, ' +
    'start_time TEXT NOT NULL, ' +
    'end_time TEXT NOT NULL, ' +
    'target TEXT NOT NULL, ' +
    'purpose TEXT NOT NULL, ' +
    'status TEXT NOT NULL DEFAULT \'pending\', ' +
    'created_at TEXT NOT NULL, ' +
    'reviewed_at TEXT, ' +
    'reviewed_by INTEGER REFERENCES users(id), ' +
    'review_comment TEXT)',
  'CREATE TABLE IF NOT EXISTS status_history (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE, ' +
    'from_status TEXT, ' +
    'to_status TEXT NOT NULL, ' +
    'action TEXT NOT NULL, ' +
    'operator_id INTEGER, ' +
    'operator_name TEXT, ' +
    'comment TEXT, ' +
    'created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS audit_logs (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'user_id INTEGER, ' +
    'username TEXT, ' +
    'action TEXT NOT NULL, ' +
    'detail TEXT, ' +
    'created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS devices (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'name TEXT NOT NULL UNIQUE, ' +
    'created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (' +
    'token TEXT PRIMARY KEY, ' +
    'user_id INTEGER NOT NULL, ' +
    'created_at TEXT NOT NULL, ' +
    'expires_at TEXT NOT NULL)',

  /* ---------- 观测站顶盖控制（硬件接入） ---------- */
  // 一台已接入的观测站顶盖控制器（ESP32）。device 与 devices.name 关联。
  'CREATE TABLE IF NOT EXISTS cover_devices (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'device TEXT NOT NULL UNIQUE, ' +
    'token TEXT NOT NULL UNIQUE, ' +
    'enabled INTEGER NOT NULL DEFAULT 1, ' +
    'position TEXT NOT NULL DEFAULT \'unknown\', ' +
    'moving INTEGER NOT NULL DEFAULT 0, ' +
    'limit_open INTEGER, ' +
    'limit_close INTEGER, ' +
    'rain INTEGER NOT NULL DEFAULT 0, ' +
    'wind REAL, ' +
    'temperature REAL, ' +
    'humidity REAL, ' +
    'current_ma INTEGER, ' +
    'fault TEXT, ' +
    'firmware TEXT, ' +
    'ip TEXT, ' +
    'rssi INTEGER, ' +
    'last_seen TEXT, ' +
    'created_at TEXT NOT NULL, ' +
    'updated_at TEXT NOT NULL)',
  // 指令队列：服务器下发 → 设备长轮询取走 → 设备 ack 回执
  'CREATE TABLE IF NOT EXISTS cover_commands (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'req_id TEXT NOT NULL UNIQUE, ' +
    'device TEXT NOT NULL, ' +
    'action TEXT NOT NULL, ' +
    'source TEXT NOT NULL, ' +
    'user_id INTEGER, ' +
    'username TEXT, ' +
    'status TEXT NOT NULL DEFAULT \'pending\', ' +
    'detail TEXT, ' +
    'created_at TEXT NOT NULL, ' +
    'delivered_at TEXT, ' +
    'acked_at TEXT, ' +
    'expires_at TEXT)',
  // 设备侧事件流水（堵转、超时、降雨触发、限位冲突……）
  'CREATE TABLE IF NOT EXISTS cover_events (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'device TEXT NOT NULL, ' +
    'level TEXT NOT NULL DEFAULT \'info\', ' +
    'code TEXT NOT NULL, ' +
    'message TEXT, ' +
    'created_at TEXT NOT NULL)',
  // 环境采样历史（雨/风/温湿度），用于事后复盘
  'CREATE TABLE IF NOT EXISTS cover_telemetry (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'device TEXT NOT NULL, ' +
    'rain INTEGER, ' +
    'wind REAL, ' +
    'temperature REAL, ' +
    'humidity REAL, ' +
    'created_at TEXT NOT NULL)',
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_cover_commands_device_status ON cover_commands (device, status, id)',
  'CREATE INDEX IF NOT EXISTS idx_cover_events_device ON cover_events (device, id)',
  'CREATE INDEX IF NOT EXISTS idx_cover_telemetry_device ON cover_telemetry (device, id)',
];
SCHEMA.forEach(function (sql) { db.exec(sql); });
INDEXES.forEach(function (sql) { db.exec(sql); });

function now() {
  return new Date().toISOString();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || stored.indexOf(':') === -1) return false;
  const parts = stored.split(':');
  const salt = parts[0];
  const expected = parts[1];
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(derived, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------- 种子数据（幂等） ------------------- */
function seedAdmin() {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get('admin');
  if (!row) {
    db.prepare('INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?, ?, ?, \'admin\', ?)')
      .run('admin', hashPassword(adminPassword), '系统管理员', now());
    console.log('[seed] 已创建管理员账号 admin');
    return;
  }
  if (process.env.ADMIN_PASSWORD && !verifyPassword(adminPassword, row.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(adminPassword), row.id);
    console.log('[seed] 管理员密码已按 ADMIN_PASSWORD 同步更新');
  }
}

function seedDevices() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM devices').get();
  if (row.c === 0) {
    const defaults = ['望远镜A（0.5米）', '望远镜B（0.8米）', '望远镜C（1.2米）', '射电望远镜'];
    const stmt = db.prepare('INSERT INTO devices (name, created_at) VALUES (?, ?)');
    defaults.forEach(function (name) { stmt.run(name, now()); });
    console.log('[seed] 已写入 ' + defaults.length + ' 台默认设备');
  }
}

function seedDemoUser() {
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get('alice');
  if (!row) {
    db.prepare('INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?, ?, ?, \'user\', ?)')
      .run('alice', hashPassword('123456'), '张天文', now());
    console.log('[seed] 已创建演示用户 alice（密码 123456）');
  }
}

seedAdmin();
seedDevices();
seedDemoUser();

// 清理过期会话
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());

module.exports = { db, now, hashPassword, verifyPassword, DB_PATH };
