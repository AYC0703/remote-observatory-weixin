const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    error: ''
  },

  onLoad: function () {
    const app = getApp();
    if (app.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/home/home' });
    }
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field;
    const patch = { error: '' };
    patch[field] = e.detail.value;
    this.setData(patch);
  },

  onLogin: function () {
    const app = getApp();
    const username = (this.data.username || '').trim();
    const password = this.data.password || '';
    if (!username || !password) {
      this.setData({ error: '请输入用户名和密码' });
      return;
    }
    const self = this;
    this.setData({ loading: true, error: '' });
    api.login(username, password).then(function (res) {
      app.setSession(res.user, res.token);
      util.toast('登录成功', 'success');
      setTimeout(function () { wx.reLaunch({ url: '/pages/home/home' }); }, 400);
    }).catch(function (err) {
      self.setData({ loading: false, error: err.message || '登录失败' });
    });
  },

  goRegister: function () {
    wx.navigateTo({ url: '/pages/register/register' });
  }
});
