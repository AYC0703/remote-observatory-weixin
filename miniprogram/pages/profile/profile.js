const api = require('../../utils/api');
const util = require('../../utils/util');
const config = require('../../config');

const app = getApp();

Page({
  data: {
    user: {},
    isAdmin: false,
    initial: '?',
    version: config.version,
    showPwd: false,
    pwd: { old: '', new: '', confirm: '' },
    pwdError: '',
    pwdLoading: false
  },

  onShow: function () {
    if (!app.guard()) return;
    this.sync();
    const self = this;
    app.refreshUser().then(function (user) {
      if (!user) { app.goLogin(); return; }
      self.sync();
    }).catch(function () {});
  },

  sync: function () {
    const user = app.globalData.user || {};
    this.setData({
      user: user,
      isAdmin: user.role === 'admin',
      initial: (user.name || user.username || '?').slice(0, 1)
    });
  },

  openChangePwd: function () {
    if (this.data.isAdmin) {
      util.toast('管理员密码由环境变量 ADMIN_PASSWORD 管理');
      return;
    }
    this.setData({ showPwd: true, pwd: { old: '', new: '', confirm: '' }, pwdError: '' });
  },

  closePwd: function () {
    this.setData({ showPwd: false, pwdError: '' });
  },

  onPwdInput: function (e) {
    const field = e.currentTarget.dataset.field;
    const pwd = Object.assign({}, this.data.pwd);
    pwd[field] = e.detail.value;
    this.setData({ pwd: pwd, pwdError: '' });
  },

  submitPwd: function () {
    const pwd = this.data.pwd;
    if (!pwd.old) { this.setData({ pwdError: '请输入当前密码' }); return; }
    if (!pwd.new || pwd.new.length < 6) { this.setData({ pwdError: '新密码至少 6 位' }); return; }
    if (pwd.new !== pwd.confirm) { this.setData({ pwdError: '两次输入的新密码不一致' }); return; }

    const self = this;
    this.setData({ pwdLoading: true, pwdError: '' });
    api.changePassword(pwd.old, pwd.new).then(function () {
      self.setData({ pwdLoading: false, showPwd: false });
      util.toast('密码修改成功', 'success');
    }).catch(function (err) {
      self.setData({ pwdLoading: false, pwdError: err.message || '修改失败' });
    });
  },

  onLogout: function () {
    util.confirm('确定要退出登录吗？', '退出登录').then(function (ok) {
      if (!ok) return;
      api.logout().catch(function () {}).then(function () {
        app.clearSession();
        wx.reLaunch({ url: '/pages/login/login' });
      });
    });
  }
});
