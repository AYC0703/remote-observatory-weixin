const config = require('../config');

function makeError(res) {
  let message = '请求失败';
  if (res && res.data) {
    if (typeof res.data === 'object' && res.data.error) message = res.data.error;
    else if (typeof res.data === 'string' && res.data) message = res.data;
  }
  const err = new Error(message);
  err.statusCode = res ? res.statusCode : 0;
  err.data = res ? res.data : null;
  return err;
}

/**
 * 统一的网络请求封装。
 * options:
 *   url        相对路径，例如 /api/applications
 *   method     默认 GET
 *   body       请求体（自动 JSON 序列化）
 *   header     额外请求头
 *   dataType   默认 json；导出 CSV 时传 text
 *   skipAuthRedirect  401 时不跳转登录页（登录相关接口使用）
 */
function request(options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const token = wx.getStorageSync('token') || '';
    const header = {};
    const extra = opts.header || {};
    Object.keys(extra).forEach(function (k) { header[k] = extra[k]; });
    if (opts.body !== undefined) header['Content-Type'] = header['Content-Type'] || 'application/json';
    if (token) header.Authorization = 'Bearer ' + token;

    wx.request({
      url: config.baseUrl + opts.url,
      method: opts.method || 'GET',
      data: opts.body !== undefined ? opts.body : opts.data,
      header: header,
      dataType: opts.dataType || 'json',
      timeout: config.timeout,
      success: function (res) {
        if (res.statusCode === 401 && !opts.skipAuthRedirect) {
          const app = getApp();
          if (app && app.clearSession) app.clearSession();
          wx.showToast({ title: '登录已失效，请重新登录', icon: 'none' });
          setTimeout(function () { wx.reLaunch({ url: '/pages/login/login' }); }, 800);
          reject(makeError(res));
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(makeError(res));
        }
      },
      fail: function (err) {
        const e = new Error('网络请求失败，请确认后端服务已启动且域名已配置');
        e.raw = err;
        reject(e);
      }
    });
  });
}

module.exports = request;
