const STATUS_LABEL = {
  pending: '待审批',
  approved: '已通过',
  rejected: '未通过',
  withdrawn: '已撤回'
};
const STATUS_COLOR = {
  pending: '#f5a623',
  approved: '#2ecc71',
  rejected: '#ff5c5c',
  withdrawn: '#8a94a6'
};
const ACTION_LABEL = {
  submit: '提交申请',
  approve: '审批通过',
  reject: '审批拒绝',
  withdraw: '撤回申请'
};
const AUDIT_LABEL = {
  register: '注册',
  login: '登录',
  logout: '退出',
  change_password: '修改密码',
  submit_application: '提交申请',
  withdraw_application: '撤回申请',
  approve_application: '审批通过',
  reject_application: '审批拒绝',
  add_device: '新增设备',
  rename_device: '重命名设备',
  delete_device: '删除设备',
  cover_open: '远程开盖',
  cover_close: '远程关盖',
  cover_stop: '远程停止',
  cover_emergency_close: '紧急关盖',
  cover_bind: '接入远程控制',
  cover_unbind: '解除远程控制',
  cover_enable: '启停远程控制',
  cover_override: '管理员强制操作',
  cover_device_error: '设备故障上报'
};

/* 观测站顶盖远程控制 */
const POSITION_LABEL = {
  unknown: '状态未知',
  open: '已开启',
  closed: '已关闭',
  partial: '半开',
  moving: '动作中'
};
const POSITION_CLASS = {
  open: 'tag-approved',
  closed: 'tag-default',
  moving: 'tag-pending',
  partial: 'tag-pending',
  unknown: 'tag-withdrawn'
};
const CMD_STATUS_LABEL = {
  pending: '待设备取走',
  delivered: '已下发',
  acked: '设备已接收',
  failed: '执行失败',
  rejected: '设备拒绝',
  expired: '已过期（设备未取走）',
  timeout: '未回执',
  superseded: '已被新指令取代'
};
const CMD_ACTION_LABEL = { open: '开盖', close: '关盖', stop: '停止', 'clear-fault': '复位故障' };
const EVENT_LEVEL_LABEL = { info: '信息', warn: '告警', error: '故障' };

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function statusLabel(status) { return STATUS_LABEL[status] || status || '未知'; }
function statusClass(status) { return 'tag tag-' + (STATUS_LABEL[status] ? status : 'default'); }
function statusColor(status) { return STATUS_COLOR[status] || '#8a94a6'; }
function actionLabel(action) { return ACTION_LABEL[action] || action; }
function auditActionLabel(action) { return AUDIT_LABEL[action] || action; }

/** ISO 8601 UTC -> 本地 YYYY-MM-DD HH:mm */
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** YYYY-MM-DDTHH:mm -> YYYY-MM-DD HH:mm */
function fmtSlot(value) {
  if (!value) return '—';
  return String(value).replace('T', ' ');
}

/** Date -> YYYY-MM-DD */
function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** Date -> HH:mm */
function fmtTime(d) {
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function toast(title, icon) {
  wx.showToast({ title: title, icon: icon || 'none', duration: 2000 });
}

function errorToast(err) {
  toast((err && err.message) ? err.message : '操作失败');
}

function confirm(content, title) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '提示',
      content: content,
      success: function (res) { resolve(!!res.confirm); },
      fail: function () { resolve(false); }
    });
  });
}

/** 为申请对象补充展示字段（状态文案 / 时间格式化） */
function decorateApplication(a) {
  if (!a) return a;
  const o = Object.assign({}, a);
  o.statusText = statusLabel(a.status);
  o.statusClass = statusClass(a.status);
  o.startText = fmtSlot(a.start_time);
  o.endText = fmtSlot(a.end_time);
  o.createdText = fmtDateTime(a.created_at);
  o.reviewedText = fmtDateTime(a.reviewed_at);
  return o;
}

/** 为状态历史补充展示字段 */
function decorateHistory(list) {
  return (list || []).map(function (h) {
    const o = Object.assign({}, h);
    o.actionText = actionLabel(h.action);
    o.timeText = fmtDateTime(h.created_at);
    o.toStatusText = statusLabel(h.to_status);
    return o;
  });
}

function positionLabel(p) { return POSITION_LABEL[p] || p || '状态未知'; }
function positionClass(p) { return POSITION_CLASS[p] || 'tag-default'; }
function cmdStatusLabel(s) { return CMD_STATUS_LABEL[s] || s || '未知'; }
function cmdActionLabel(a) { return CMD_ACTION_LABEL[a] || a || '—'; }
function eventLevelLabel(l) { return EVENT_LEVEL_LABEL[l] || l || '信息'; }

function round1(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * 补全观测站顶盖的展示字段。
 * @param {object} c 后端返回的 cover 对象
 */
function decorateCover(c) {
  if (!c) return c;
  const o = Object.assign({}, c);
  o.positionText = positionLabel(c.position);
  o.positionClass = positionClass(c.position);
  o.onlineClass = c.online ? 'tag-approved' : 'tag-rejected';
  o.onlineText = c.online ? '在线' : '离线';
  o.lastSeenText = fmtDateTime(c.last_seen);
  o.rainText = c.rain ? '检测到降雨' : '无雨';
  o.windText = round1(c.wind) === null ? '—' : round1(c.wind) + ' m/s';
  o.tempText = round1(c.temperature) === null ? '—' : round1(c.temperature) + ' ℃';
  o.humidityText = round1(c.humidity) === null ? '—' : round1(c.humidity) + ' %';
  o.currentText = (c.current_ma === null || c.current_ma === undefined) ? '—' : c.current_ma + ' mA';
  o.rssiText = (c.rssi === null || c.rssi === undefined) ? '—' : c.rssi + ' dBm';
  o.limitOpenText = c.limits && c.limits.open === true ? '已触发' : '未触发';
  o.limitCloseText = c.limits && c.limits.close === true ? '已触发' : '未触发';
  o.limitConflict = !!(c.limits && c.limits.open === true && c.limits.close === true);
  o.occupancy = (c.occupancy || []).map(function (a) {
    const x = Object.assign({}, a);
    x.startText = fmtSlot(a.start_time);
    x.endText = fmtSlot(a.end_time);
    return x;
  });
  return o;
}

/** 补全指令流水的展示字段 */
function decorateCommands(list) {
  return (list || []).map(function (cmd) {
    const o = Object.assign({}, cmd);
    o.actionText = cmdActionLabel(cmd.action);
    o.statusText = cmdStatusLabel(cmd.status);
    o.createdText = fmtDateTime(cmd.created_at);
    o.ackedText = fmtDateTime(cmd.acked_at);
    o.statusClass = cmd.status === 'acked' ? 'tag-approved'
      : (cmd.status === 'failed' || cmd.status === 'rejected' ? 'tag-rejected'
        : (cmd.status === 'pending' || cmd.status === 'delivered' ? 'tag-pending' : 'tag-withdrawn'));
    return o;
  });
}

/** 补全设备事件的展示字段 */
function decorateEvents(list) {
  return (list || []).map(function (ev) {
    const o = Object.assign({}, ev);
    o.levelText = eventLevelLabel(ev.level);
    o.createdText = fmtDateTime(ev.created_at);
    o.levelClass = ev.level === 'error' ? 'tag-rejected' : (ev.level === 'warn' ? 'tag-pending' : 'tag-default');
    return o;
  });
}

module.exports = {
  STATUS_LABEL: STATUS_LABEL,
  STATUS_COLOR: STATUS_COLOR,
  statusLabel: statusLabel,
  statusClass: statusClass,
  statusColor: statusColor,
  actionLabel: actionLabel,
  auditActionLabel: auditActionLabel,
  fmtDateTime: fmtDateTime,
  fmtSlot: fmtSlot,
  fmtDate: fmtDate,
  fmtTime: fmtTime,
  toast: toast,
  errorToast: errorToast,
  confirm: confirm,
  decorateApplication: decorateApplication,
  decorateHistory: decorateHistory,
  positionLabel: positionLabel,
  positionClass: positionClass,
  cmdStatusLabel: cmdStatusLabel,
  cmdActionLabel: cmdActionLabel,
  eventLevelLabel: eventLevelLabel,
  decorateCover: decorateCover,
  decorateCommands: decorateCommands,
  decorateEvents: decorateEvents
};
