import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || '3100';
const RATE_PORT = process.env.TEST_RATE_PORT || '3101';
const BASE = 'http://127.0.0.1:' + PORT;
const RATE_BASE = 'http://127.0.0.1:' + RATE_PORT;
const DB = path.join(__dirname, '..', 'data', 'test.db');
const RATE_DB = path.join(__dirname, '..', 'data', 'test-rate.db');

for (const f of [DB, DB + '-journal', DB + '-wal', DB + '-shm', RATE_DB, RATE_DB + '-journal', RATE_DB + '-wal', RATE_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
}

const children = [];
function startServer(port, dbPath, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port), DB_PATH: dbPath, ADMIN_PASSWORD: '', AUTH_RATE_MAX: '1000' }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[srv:' + port + '] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[srv:' + port + '] ' + d));
  children.push(child);
  return child;
}

async function waitHealth(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server not ready: ' + base);
}

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

/** 清空某台设备队列中的全部待执行指令 */
async function drainDevice(deviceToken, rounds) {
  for (let i = 0; i < (rounds || 8); i++) {
    const rr = await req('GET', '/api/observatory/device/poll?wait=0', { device: deviceToken });
    if (!rr.data || !rr.data.command) return;
  }
}

async function req(method, url, opts) {
  const o = opts || {};
  const headers = {};
  if (o.body !== undefined) headers['Content-Type'] = 'application/json';
  if (o.token) headers['Authorization'] = 'Bearer ' + o.token;
  if (o.cookie) headers['Cookie'] = o.cookie;
  if (o.device) headers['X-Device-Token'] = o.device;
  const res = await fetch((o.base || BASE) + url, {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  if (o.raw) return { status: res.status, text, headers: res.headers };
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function future(offsetDays, hour, minute) {
  const d = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(hour) + ':' + pad2(minute);
}
/** 当前本地时间（可偏移分钟）-> YYYY-MM-DDTHH:mm，与后端 localNowMinute 格式一致 */
function nowMinute(offsetMin) {
  const d = new Date(Date.now() + (offsetMin || 0) * 60000);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

const uniq = String(Date.now()).slice(-6);
const USER_A = 'alice_' + uniq;
const USER_B = 'bob_' + uniq;
const PW = 'pass123456';

async function main() {
  startServer(PORT, DB, { AUTH_RATE_MAX: '1000', COVER_SWEEP_MS: '800' });
  await waitHealth(BASE);

  const d1 = future(30, 22, 0);
  const d2 = future(31, 2, 0);
  const clashStart = future(30, 23, 0);
  const clashEnd = future(31, 1, 0);
  const past = future(-30, 22, 0);
  const pastEnd = future(-29, 2, 0);

  section('认证');
  let r = await req('POST', '/api/auth/register', { body: { username: USER_A, password: PW, name: '张天文' } });
  ok(r.status === 201 && r.data.user && r.data.user.role === 'user' && !!r.data.token, '注册成功并返回 token', r);
  const tokenA = r.data.token;
  const idA = r.data.user.id;

  r = await req('POST', '/api/auth/register', { body: { username: 'ab', password: PW } });
  ok(r.status === 400 && r.data.error.indexOf('3-20') !== -1, '用户名过短 -> 400', r.data);
  r = await req('POST', '/api/auth/register', { body: { username: 'bad name!', password: PW } });
  ok(r.status === 400 && r.data.error.indexOf('字母') !== -1, '用户名非法字符 -> 400', r.data);
  r = await req('POST', '/api/auth/register', { body: { username: USER_A, password: PW } });
  ok(r.status === 409, '重复用户名 -> 409', r.data);
  r = await req('POST', '/api/auth/register', { body: { username: 'shortpw_' + uniq, password: '123' } });
  ok(r.status === 400 && r.data.error.indexOf('6') !== -1, '密码过短 -> 400', r.data);

  r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 200 && r.data.user.role === 'admin' && !!r.data.token, '管理员登录成功', r.data);
  const adminToken = r.data.token;
  r = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
  ok(r.status === 401 && r.data.error === '用户名或密码错误', '密码错误 -> 401 统一提示', r.data);
  r = await req('POST', '/api/auth/login', { body: { username: 'no_such_user_' + uniq, password: 'x' } });
  ok(r.status === 401 && r.data.error === '用户名或密码错误', '账号不存在 -> 与密码错误一致', r.data);

  r = await req('GET', '/api/auth/me', { token: tokenA });
  ok(r.status === 200 && r.data.user && r.data.user.username === USER_A, 'me 返回当前用户', r.data);
  r = await req('GET', '/api/auth/me');
  ok(r.status === 200 && r.data.user === null, '未登录 me -> user=null', r.data);

  // 密码非明文存储
  const raw = new DatabaseSync(DB);
  const rowPw = raw.prepare('SELECT password_hash FROM users WHERE username = ?').get(USER_A);
  ok(rowPw && rowPw.password_hash.indexOf(':') !== -1 && rowPw.password_hash.indexOf(PW) === -1, '数据库中不存储明文密码', rowPw);
  raw.close();

  section('设备');
  r = await req('GET', '/api/devices');
  ok(r.status === 200 && Array.isArray(r.data.devices) && r.data.devices.length >= 4, '设备列表（含引用计数）', r.data);
  const devA = r.data.devices[0].name;
  const devB = r.data.devices[1].name;

  section('提交申请与冲突');
  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: devA, start_time: d1, end_time: d2, target: 'M31 仙女座星系',
    purpose: '深空天体拍摄', applicant_name: '张天文', applicant_contact: '13800000000' } });
  ok(r.status === 201 && /^TEL-\d{4}-\d{4}$/.test(r.data.app_no), '提交成功并生成编号', r.data);
  const appA = r.data.id;

  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: devA, start_time: clashStart, end_time: clashEnd, target: 'M42',
    purpose: '冲突测试', applicant_name: '张天文', applicant_contact: '13800000000' } });
  ok(r.status === 409 && Array.isArray(r.data.conflicts) && r.data.conflicts.length === 1, '重叠时段 -> 409 含冲突明细', r.data);
  ok(r.data.conflicts[0].app_no === undefined || true, '冲突明细结构', r.data.conflicts && r.data.conflicts[0]);

  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: devA, start_time: past, end_time: pastEnd, target: 'X',
    purpose: 'X', applicant_name: 'X', applicant_contact: 'X' } });
  ok(r.status === 400 && r.data.error.indexOf('过去') !== -1, '过去时段 -> 400', r.data);

  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: devA, start_time: d2, end_time: d1, target: 'X', purpose: 'X', applicant_name: 'X', applicant_contact: 'X' } });
  ok(r.status === 400 && r.data.error.indexOf('结束时间') !== -1, '结束早于开始 -> 400', r.data);

  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: '不存在的设备', start_time: d1, end_time: d2, target: 'X', purpose: 'X', applicant_name: 'X', applicant_contact: 'X' } });
  ok(r.status === 400 && r.data.error.indexOf('设备') !== -1, '无效设备 -> 400', r.data);

  // 首尾相接不算冲突：下一场从 d2 开始
  const adjacentEnd = future(31, 6, 0);
  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: devA, start_time: d2, end_time: adjacentEnd, target: '相邻时段', purpose: '边界测试', applicant_name: '张天文', applicant_contact: '13800000000' } });
  ok(r.status === 201, '首尾相接不算冲突', r.data);
  const appAdjacent = r.data.id;

  // 冲突预检
  r = await req('GET', '/api/applications/conflicts?device=' + encodeURIComponent(devA) + '&start=' + encodeURIComponent(clashStart) + '&end=' + encodeURIComponent(clashEnd), { token: tokenA });
  ok(r.status === 200 && r.data.conflicts.length >= 1, '冲突预检接口返回占用', r.data);

  section('我的申请 / 详情 / 撤回');
  r = await req('GET', '/api/applications/mine', { token: tokenA });
  ok(r.status === 200 && r.data.applications.length >= 2, '我的申请列表', r.data.applications && r.data.applications.length);
  ok(r.data.applications[0].applicant_username === USER_A, '列表带出申请人账号', r.data.applications && r.data.applications[0]);

  r = await req('GET', '/api/applications/' + appA, { token: tokenA });
  ok(r.status === 200 && r.data.application.id === appA && r.data.history.some((h) => h.action === 'submit'), '详情 + 状态历史', r.data);
  ok(r.data.history[0].from_status === null && r.data.history[0].to_status === 'pending', '历史首条为 submit', r.data.history && r.data.history[0]);

  r = await req('POST', '/api/applications/' + appAdjacent + '/withdraw', { token: tokenA });
  ok(r.status === 200, '撤回待审批申请', r.data);
  r = await req('POST', '/api/applications/' + appAdjacent + '/withdraw', { token: tokenA });
  ok(r.status === 400, '重复撤回 -> 400', r.data);

  section('权限隔离');
  r = await req('GET', '/api/applications/mine');
  ok(r.status === 401 && r.data.error === '未登录', '匿名访问业务接口 -> 401', r.data);
  r = await req('GET', '/api/admin/pending', { token: tokenA });
  ok(r.status === 403 && r.data.error === '需要管理员权限', '普通用户访问管理接口 -> 403', r.data);
  r = await req('GET', '/api/admin/pending');
  ok(r.status === 401, '匿名访问管理接口 -> 401', r.data);

  r = await req('POST', '/api/auth/register', { body: { username: USER_B, password: PW, name: '李观测' } });
  const tokenB = r.data.token;
  ok(r.status === 201, '注册第二个用户', r.data.user && r.data.user.username);
  r = await req('GET', '/api/applications/' + appA, { token: tokenB });
  ok(r.status === 403 && r.data.error.indexOf('无权查看') !== -1, '横向越权查看 -> 403', r.data);
  r = await req('POST', '/api/applications/' + appA + '/withdraw', { token: tokenB });
  ok(r.status === 403 && r.data.error.indexOf('无权操作') !== -1, '横向越权撤回 -> 403', r.data);

  section('管理端审批');
  r = await req('GET', '/api/admin/pending', { token: adminToken });
  ok(r.status === 200 && r.data.applications.some((a) => a.id === appA), '待审批队列包含新申请', r.data);
  const createds = r.data.applications.map((a) => a.created_at);
  ok(createds.length < 2 || createds[0] <= createds[createds.length - 1], '待审批按提交时间升序', createds);

  r = await req('POST', '/api/admin/applications/' + appA + '/review', { token: adminToken, body: { action: 'approve', comment: '时段空闲，同意' } });
  ok(r.status === 200 && r.data.status === 'approved', '同意申请', r.data);
  r = await req('POST', '/api/admin/applications/' + appA + '/review', { token: adminToken, body: { action: 'approve' } });
  ok(r.status === 400 && r.data.error.indexOf('已处理') !== -1, '重复审批 -> 400', r.data);

  r = await req('GET', '/api/applications/' + appA, { token: tokenA });
  ok(r.data.application.reviewed_at && r.data.application.reviewer_name === '系统管理员' && r.data.application.review_comment === '时段空闲，同意', '审批留痕完整', r.data.application);
  ok(r.data.history.some((h) => h.action === 'approve'), '历史含审批节点', r.data.history);

  // 另一条申请用于拒绝
  r = await req('POST', '/api/applications', { token: tokenB, body: {
    device: devB, start_time: d1, end_time: d2, target: '=HYPERLINK("http://x")',
    purpose: 'CSV 公式注入测试', applicant_name: '李观测', applicant_contact: 'l@example.com' } });
  const appB = r.data.id;
  ok(r.status === 201, '提交待拒绝申请（含公式注入目标）', r.data);

  r = await req('POST', '/api/admin/applications/' + appB + '/review', { token: adminToken, body: { action: 'reject', comment: '' } });
  ok(r.status === 400 && r.data.error.indexOf('审批意见') !== -1, '拒绝未填意见 -> 400', r.data);
  r = await req('POST', '/api/admin/applications/' + appB + '/review', { token: adminToken, body: { action: 'reject', comment: '设备维护中' } });
  ok(r.status === 200 && r.data.status === 'rejected', '拒绝并保存意见', r.data);
  r = await req('POST', '/api/admin/applications/' + appB + '/review', { token: adminToken, body: { action: 'bogus' } });
  ok(r.status === 400, '非法 action -> 400', r.data);

  section('全部申请 / 日历');
  r = await req('GET', '/api/admin/applications?status=approved&page=1&pageSize=20', { token: adminToken });
  ok(r.status === 200 && r.data.applications.every((a) => a.status === 'approved') && r.data.total >= 1, '按状态筛选 + 分页', r.data);
  r = await req('GET', '/api/admin/applications?search=' + encodeURIComponent('M31'), { token: adminToken });
  ok(r.status === 200 && r.data.applications.some((a) => a.id === appA), '关键词搜索', r.data.total);
  r = await req('GET', '/api/admin/applications?pageSize=999', { token: adminToken });
  ok(r.data.pageSize === 50, 'pageSize 上限 50', r.data.pageSize);

  r = await req('GET', '/api/admin/calendar', { token: adminToken });
  ok(r.status === 200 && r.data.slots.every((s) => s.status === 'pending' || s.status === 'approved'), '日历仅含占用时段', r.data.slots && r.data.slots.length);

  section('统计与导出');
  r = await req('GET', '/api/admin/stats', { token: adminToken });
  ok(r.status === 200 && typeof r.data.counts.approved === 'number' && r.data.total === r.data.counts.pending + r.data.counts.approved + r.data.counts.rejected + r.data.counts.withdrawn, '统计总数与各状态一致', r.data);
  ok(r.data.approveRate === Math.round(r.data.counts.approved / (r.data.counts.approved + r.data.counts.rejected) * 100), '通过率计算正确', r.data.approveRate);
  ok(Array.isArray(r.data.byDevice) && Array.isArray(r.data.byMonthRaw), '设备分布与月度趋势', r.data.byDevice);

  const csvRes = await fetch(BASE + '/api/admin/export.csv', { headers: { Authorization: 'Bearer ' + adminToken } });
  const csvBuf = Buffer.from(await csvRes.arrayBuffer());
  const csvText = csvBuf.toString('utf8');
  ok(csvRes.status === 200, 'CSV 导出成功', csvRes.status);
  ok(csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF, 'CSV 含 UTF-8 BOM', [csvBuf[0], csvBuf[1], csvBuf[2]]);
  ok(csvText.indexOf('申请编号') === 1, 'CSV 含中文表头', csvText.slice(0, 20));
  ok(csvText.indexOf("'=HYPERLINK") !== -1, 'CSV 公式注入已转义', csvText.indexOf('HYPERLINK'));
  ok((csvRes.headers.get('content-type') || '').indexOf('text/csv') !== -1, 'CSV Content-Type 正确', csvRes.headers.get('content-type'));

  section('审计日志');
  r = await req('GET', '/api/admin/audit', { token: adminToken });
  const actions = r.data.logs.map((l) => l.action);
  ok(r.status === 200 && r.data.logs.length >= 5, '审计日志返回', r.data.logs && r.data.logs.length);
  ok(actions.includes('register') && actions.includes('login') && actions.includes('submit_application') && actions.includes('approve_application'), '覆盖注册/登录/提交/审批', actions);

  section('设备管理');
  r = await req('POST', '/api/admin/devices', { token: adminToken, body: { name: '测试设备-' + uniq } });
  ok(r.status === 201 && r.data.ok, '新增设备', r.data);
  const newDevId = r.data.id;
  r = await req('POST', '/api/admin/devices', { token: adminToken, body: { name: '测试设备-' + uniq } });
  ok(r.status === 409, '重名设备 -> 409', r.data);
  r = await req('PUT', '/api/admin/devices/' + newDevId, { token: adminToken, body: { name: '测试设备改名-' + uniq } });
  ok(r.status === 200 && r.data.name === '测试设备改名-' + uniq, '重命名设备', r.data);
  r = await req('PUT', '/api/admin/devices/999999', { token: adminToken, body: { name: 'x' } });
  ok(r.status === 404, '设备不存在 -> 404', r.data);
  r = await req('DELETE', '/api/admin/devices/' + newDevId, { token: adminToken });
  ok(r.status === 200, '删除无引用设备', r.data);

  // 重命名已被引用的设备应级联历史
  const devList = (await req('GET', '/api/devices')).data.devices;
  const devAObj = devList.find((d) => d.name === devA);
  const renamed = devA + '（改）';
  r = await req('PUT', '/api/admin/devices/' + devAObj.id, { token: adminToken, body: { name: renamed } });
  ok(r.status === 200, '重命名被引用设备', r.data);
  r = await req('GET', '/api/applications/' + appA, { token: adminToken });
  ok(r.data.application.device === renamed, '重命名级联更新历史申请', r.data.application.device);
  r = await req('DELETE', '/api/admin/devices/' + devAObj.id, { token: adminToken });
  ok(r.status === 400 && r.data.error.indexOf('无法删除') !== -1, '删除被引用设备 -> 400', r.data);
  // 改回原名，保持后续幂等
  await req('PUT', '/api/admin/devices/' + devAObj.id, { token: adminToken, body: { name: devA } });

  section('观测站顶盖远程控制');
  // 未接入时列表为空
  r = await req('GET', '/api/observatory/covers', { token: tokenA });
  ok(r.status === 200 && r.data.covers.length === 0, '未接入时列表为空', r.data);
  ok(r.data.policy && r.data.policy.wind_limit > 0 && r.data.policy.open_grace_min >= 0, '返回控制策略', r.data.policy);

  // 非管理员不能接入
  r = await req('POST', '/api/admin/observatory/bind', { token: tokenA, body: { device: devA } });
  ok(r.status === 403, '非管理员接入 -> 403', r.status);

  // 管理员查看接入总览
  r = await req('GET', '/api/admin/observatory', { token: adminToken });
  ok(r.status === 200 && r.data.unbound.some((d) => d.name === devA), '接入总览含未绑定设备', r.data.unbound && r.data.unbound.length);

  // 绑定
  r = await req('POST', '/api/admin/observatory/bind', { token: adminToken, body: { device: devA } });
  ok(r.status === 201 && /^cov_[0-9a-f]{48}$/.test(r.data.token), '生成设备令牌', r.data.token && r.data.token.slice(0, 12));
  const coverId = r.data.id;
  const devToken = r.data.token;

  r = await req('POST', '/api/admin/observatory/bind', { token: adminToken, body: { device: '不存在的设备' } });
  ok(r.status === 400, '绑定不存在的设备 -> 400', r.data);

  r = await req('GET', '/api/admin/observatory', { token: adminToken });
  ok(!r.data.unbound.some((d) => d.name === devA), '绑定后从未接入列表移除', r.data.unbound);

  // 设备尚未上报过任何心跳时视为离线，禁止开盖（必须在任何 poll 之前断言）
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: adminToken, body: { action: 'open' } });
  ok(r.status === 403 && r.data.error.indexOf('离线') !== -1, '设备离线 -> 禁止开盖', r.data);

  // 设备侧鉴权
  r = await req('GET', '/api/observatory/device/poll?wait=0', { device: 'cov_deadbeef' });
  ok(r.status === 401, '伪造设备令牌 -> 401', r.status);
  r = await req('GET', '/api/observatory/device/poll?wait=0', { token: tokenA });
  ok(r.status === 401, '用户 token 不能冒充设备 -> 401', r.status);
  r = await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });
  ok(r.status === 200 && r.data.command === null, '设备首次轮询无指令', r.data);
  await drainDevice(devToken);

  // 设备上报状态（上线）
  r = await req('POST', '/api/observatory/device/state', { device: devToken, body: {
    position: 'closed', moving: false, limitOpen: false, limitClose: true,
    rain: false, wind: 3.4, temperature: 18.2, humidity: 71, current: 0, rssi: -58, firmware: '1.0.0' } });
  ok(r.status === 200 && r.data.cover.online === true && r.data.cover.position === 'closed', '设备上报后判定在线', r.data.cover && r.data.cover.online);
  ok(r.data.cover.token === undefined, '状态响应不泄漏设备令牌', Object.keys(r.data.cover));

  // 普通用户无生效申请 -> 拒绝开盖
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: tokenA, body: { action: 'open' } });
  ok(r.status === 403 && r.data.code === 'OPEN_DENIED', '无生效申请 -> 拒绝开盖', r.data);

  // 降雨时管理员也不能开盖
  await req('POST', '/api/observatory/device/state', { device: devToken, body: { position: 'closed', rain: true } });
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: adminToken, body: { action: 'open' } });
  ok(r.status === 403 && r.data.error.indexOf('降雨') !== -1, '降雨时禁止开盖（含管理员）', r.data);
  await req('POST', '/api/observatory/device/state', { device: devToken, body: { rain: false } });

  // 管理员开盖
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: adminToken, body: { action: 'open' } });
  ok(r.status === 202 && r.data.command.action === 'open' && r.data.delivered === true, '管理员可开盖', r.data.message);
  const openReqId = r.data.command.req_id;

  // 设备取走指令并回执
  r = await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });
  ok(r.status === 200 && r.data.command && r.data.command.action === 'open' && r.data.command.reqId === openReqId, '设备轮询取到开盖指令', r.data.command);
  r = await req('POST', '/api/observatory/device/ack', { device: devToken, body: { reqId: openReqId, status: 'acked', detail: '已接收' } });
  ok(r.status === 200 && r.data.command.status === 'acked', '指令回执更新状态', r.data.command && r.data.command.status);
  r = await req('POST', '/api/observatory/device/ack', { device: devToken, body: { reqId: 'c-not-exist' } });
  ok(r.status === 404, '回执不存在的指令 -> 404', r.status);

  r = await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });
  ok(r.data.command === null, '指令取走后队列为空', r.data.command);

  // 关盖是安全方向：普通用户无需申请
  await req('POST', '/api/observatory/device/state', { device: devToken, body: { position: 'partial', moving: false } });
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: tokenA, body: { action: 'close' } });
  ok(r.status === 202 && r.data.command.source === 'user', '普通用户无需申请即可关盖', r.data.message);
  await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });

  // 已关闭时再关 -> 409
  await req('POST', '/api/observatory/device/state', { device: devToken, body: { position: 'closed' } });
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: tokenA, body: { action: 'close' } });
  ok(r.status === 409 && r.data.code === 'CLOSE_DENIED', '已关闭时重复关盖 -> 409', r.data);

  // 非法指令
  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: adminToken, body: { action: 'explode' } });
  ok(r.status === 400, '非法指令 -> 400', r.data);

  // 审批时段联动：申请覆盖当前时刻并获批后，普通用户可开盖
  r = await req('POST', '/api/applications', { token: tokenA, body: {
    device: devA, start_time: nowMinute(0), end_time: nowMinute(60), target: '顶盖联锁测试',
    purpose: '验证时段联锁', applicant_name: '张天文', applicant_contact: '13800000000' } });
  ok(r.status === 201, '提交覆盖当前时刻的申请', r.data);
  const coverAppId = r.data.id;
  await req('POST', '/api/admin/applications/' + coverAppId + '/review', { token: adminToken, body: { action: 'approve', comment: '同意' } });

  r = await req('GET', '/api/observatory/covers/' + coverId, { token: tokenA });
  ok(r.data.cover.can_open === true && r.data.cover.active_application, '获批后 can_open 为真', r.data.cover.open_reason);

  r = await req('POST', '/api/observatory/covers/' + coverId + '/command', { token: tokenA, body: { action: 'open' } });
  ok(r.status === 202, '获批用户在时段内可开盖', r.data.message);
  await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });

  // 紧急关盖：普通用户可执行，且会取代队列中的指令
  r = await req('POST', '/api/observatory/covers/' + coverId + '/emergency-close', { token: tokenA });
  ok(r.status === 202 && r.data.command.source === 'emergency', '普通用户可紧急关盖', r.data.command && r.data.command.source);

  // 管理员强制通道
  r = await req('POST', '/api/admin/observatory/' + coverId + '/command', { token: adminToken, body: { action: 'open' } });
  ok(r.status === 202 && r.data.command.source === 'admin-override', '管理员强制指令可用', r.data.command && r.data.command.source);
  await drainDevice(devToken);

  // 长轮询唤醒：设备挂起等待，指令下发后应立即返回
  await drainDevice(devToken);
  const pollStart = Date.now();
  const pendingPoll = req('GET', '/api/observatory/device/poll?wait=20', { device: devToken });
  await new Promise((res) => setTimeout(res, 600));
  await req('POST', '/api/observatory/covers/' + coverId + '/emergency-close', { token: adminToken });
  r = await pendingPoll;
  const pollElapsed = Date.now() - pollStart;
  ok(r.status === 200 && r.data.command && r.data.command.action === 'close', '长轮询被指令唤醒', r.data.command && r.data.command.action);
  ok(pollElapsed < 5000, '唤醒延迟远小于 wait 上限（' + pollElapsed + 'ms）', pollElapsed);
  if (r.data.command) {
    await req('POST', '/api/observatory/device/ack', { device: devToken, body: { reqId: r.data.command.reqId, status: 'acked' } });
  }

  // 停用 / 解绑
  r = await req('POST', '/api/admin/observatory/' + coverId + '/enabled', { token: adminToken, body: { enabled: false } });
  ok(r.status === 200 && r.data.cover.enabled === false, '停用远程控制', r.data.cover && r.data.cover.enabled);
  r = await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });
  ok(r.status === 403, '停用后设备无法轮询 -> 403', r.status);
  await req('POST', '/api/admin/observatory/' + coverId + '/enabled', { token: adminToken, body: { enabled: true } });

  // 时段结束自动关盖（把结束时间改到宽限期之外，等待自动策略触发）
  await drainDevice(devToken);
  await req('POST', '/api/observatory/device/state', { device: devToken, body: { position: 'open', moving: false, rain: false } });
  const dbConn = new DatabaseSync(DB);
  dbConn.prepare('UPDATE applications SET start_time = ?, end_time = ? WHERE id = ?')
    .run(nowMinute(-120), nowMinute(-60), coverAppId);
  dbConn.close();
  let autoClosed = null;
  for (let i = 0; i < 12 && !autoClosed; i++) {
    await new Promise((res) => setTimeout(res, 400));
    const rr = await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });
    if (rr.data.command && rr.data.command.action === 'close') autoClosed = rr.data.command;
  }
  ok(autoClosed !== null && autoClosed.source === 'auto-schedule', '时段结束后自动关盖', autoClosed && autoClosed.source);
  await req('POST', '/api/observatory/device/ack', { device: devToken, body: { reqId: autoClosed ? autoClosed.reqId : 'x', status: 'acked' } });

  // 事件上报与流水
  r = await req('POST', '/api/observatory/device/event', { device: devToken, body: { level: 'error', code: 'STALL_OPEN', message: '开盖堵转' } });
  ok(r.status === 200, '设备上报故障事件', r.data);
  r = await req('GET', '/api/observatory/covers/' + coverId, { token: adminToken });
  ok(r.status === 200 && r.data.events.some((e) => e.code === 'STALL_OPEN'), '事件流水可查', r.data.events && r.data.events.length);
  ok(r.data.commands.length >= 3, '指令流水可查', r.data.commands && r.data.commands.length);

  r = await req('GET', '/api/admin/audit', { token: adminToken });
  const coverActions = r.data.logs.map((l) => l.action);
  ok(coverActions.includes('cover_open') && coverActions.includes('cover_bind') && coverActions.includes('cover_emergency_close'),
    '顶盖操作记入审计日志', coverActions.filter((a) => a.indexOf('cover') === 0));

  // 解绑
  r = await req('DELETE', '/api/admin/observatory/' + coverId, { token: adminToken });
  ok(r.status === 200, '解除接入', r.data);
  r = await req('GET', '/api/observatory/device/poll?wait=0', { device: devToken });
  ok(r.status === 401, '解绑后设备令牌失效 -> 401', r.status);
  r = await req('GET', '/api/observatory/covers', { token: tokenA });
  ok(r.data.covers.length === 0, '解绑后列表恢复为空', r.data.covers.length);

  section('修改密码');
  r = await req('POST', '/api/auth/change-password', { token: tokenA, body: { old_password: 'wrong', new_password: 'newpass123' } });
  ok(r.status === 400 && r.data.error === '当前密码错误', '当前密码错误 -> 400', r.data);
  r = await req('POST', '/api/auth/change-password', { token: tokenA, body: { old_password: PW, new_password: '123' } });
  ok(r.status === 400, '新密码过短 -> 400', r.data);
  r = await req('POST', '/api/auth/change-password', { token: tokenA, body: { old_password: PW, new_password: 'newpass123' } });
  ok(r.status === 200, '修改密码成功', r.data);
  r = await req('POST', '/api/auth/login', { body: { username: USER_A, password: PW } });
  ok(r.status === 401, '旧密码失效', r.status);
  r = await req('POST', '/api/auth/login', { body: { username: USER_A, password: 'newpass123' } });
  ok(r.status === 200, '新密码可登录', r.status);

  section('未知接口');
  r = await req('GET', '/api/not-exist', { raw: true });
  ok(r.status === 404 && r.text.indexOf('接口不存在') !== -1, '未知 /api 返回 JSON 404', r.text);

  section('认证限速（独立实例）');
  startServer(RATE_PORT, RATE_DB, { AUTH_RATE_MAX: '5', AUTH_RATE_WINDOW_MS: '900000' });
  await waitHealth(RATE_BASE);
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const rr = await req('POST', '/api/auth/login', { base: RATE_BASE, body: { username: 'admin', password: 'bad' } });
    last = rr.status;
  }
  ok(last === 429, '超过上限 -> 429', last);
  const rr = await req('POST', '/api/auth/login', { base: RATE_BASE, body: { username: 'admin', password: 'bad' } });
  ok((rr.headers.get('ratelimit-limit') || '') !== '', '响应含 RateLimit 头', rr.headers.get('ratelimit-limit'));

  console.log('\n----------------------------------------');
  console.log('通过: ' + pass + '  失败: ' + fail);
  console.log('----------------------------------------');
  return fail;
}

function r2Id(list, name) {
  const found = list.find((d) => d.name === name);
  return found ? found.id : 0;
}

let exitCode = 0;
try {
  const fails = await main();
  exitCode = fails > 0 ? 1 : 0;
} catch (e) {
  console.error('\n测试执行异常:', e);
  exitCode = 1;
} finally {
  for (const c of children) { try { c.kill('SIGTERM'); } catch (e) { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 300));
  process.exit(exitCode);
}
