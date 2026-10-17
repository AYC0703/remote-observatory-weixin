const request = require('./request');

function buildQuery(params) {
  if (!params) return '';
  const parts = [];
  Object.keys(params).forEach(function (key) {
    const value = params[key];
    if (value === undefined || value === null || value === '') return;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

module.exports = {
  /* 认证 */
  me: function () { return request({ url: '/api/auth/me', skipAuthRedirect: true }); },
  login: function (username, password) {
    return request({ url: '/api/auth/login', method: 'POST', body: { username: username, password: password }, skipAuthRedirect: true });
  },
  register: function (data) {
    return request({ url: '/api/auth/register', method: 'POST', body: data, skipAuthRedirect: true });
  },
  logout: function () { return request({ url: '/api/auth/logout', method: 'POST', skipAuthRedirect: true }); },
  changePassword: function (oldPassword, newPassword) {
    return request({ url: '/api/auth/change-password', method: 'POST', body: { old_password: oldPassword, new_password: newPassword } });
  },

  /* 设备 */
  devices: function () { return request({ url: '/api/devices', skipAuthRedirect: true }); },
  addDevice: function (name) { return request({ url: '/api/admin/devices', method: 'POST', body: { name: name } }); },
  renameDevice: function (id, name) { return request({ url: '/api/admin/devices/' + id, method: 'PUT', body: { name: name } }); },
  deleteDevice: function (id) { return request({ url: '/api/admin/devices/' + id, method: 'DELETE' }); },

  /* 申请 */
  conflicts: function (device, start, end) {
    return request({ url: '/api/applications/conflicts' + buildQuery({ device: device, start: start, end: end }) });
  },
  submitApplication: function (data) { return request({ url: '/api/applications', method: 'POST', body: data }); },
  mine: function () { return request({ url: '/api/applications/mine' }); },
  applicationDetail: function (id) { return request({ url: '/api/applications/' + id }); },
  withdraw: function (id) { return request({ url: '/api/applications/' + id + '/withdraw', method: 'POST' }); },

  /* 管理端 */
  adminPending: function () { return request({ url: '/api/admin/pending' }); },
  adminApplications: function (params) { return request({ url: '/api/admin/applications' + buildQuery(params) }); },
  adminCalendar: function () { return request({ url: '/api/admin/calendar' }); },
  review: function (id, body) { return request({ url: '/api/admin/applications/' + id + '/review', method: 'POST', body: body }); },
  stats: function () { return request({ url: '/api/admin/stats' }); },
  audit: function () { return request({ url: '/api/admin/audit' }); },
  exportCsv: function () { return request({ url: '/api/admin/export.csv', dataType: 'text' }); },

  /* 观测站顶盖远程控制 */
  observatoryCovers: function () { return request({ url: '/api/observatory/covers' }); },
  observatoryCover: function (id) { return request({ url: '/api/observatory/covers/' + id }); },
  coverCommand: function (id, action) {
    return request({ url: '/api/observatory/covers/' + id + '/command', method: 'POST', body: { action: action } });
  },
  coverEmergencyClose: function (id) {
    return request({ url: '/api/observatory/covers/' + id + '/emergency-close', method: 'POST' });
  },

  /* 观测站接入管理（管理员） */
  adminObservatory: function () { return request({ url: '/api/admin/observatory' }); },
  adminObservatoryBind: function (device) {
    return request({ url: '/api/admin/observatory/bind', method: 'POST', body: { device: device } });
  },
  adminObservatoryEnabled: function (id, enabled) {
    return request({ url: '/api/admin/observatory/' + id + '/enabled', method: 'POST', body: { enabled: enabled } });
  },
  adminObservatoryUnbind: function (id) { return request({ url: '/api/admin/observatory/' + id, method: 'DELETE' }); },
  adminObservatoryCommand: function (id, action) {
    return request({ url: '/api/admin/observatory/' + id + '/command', method: 'POST', body: { action: action } });
  }
};
