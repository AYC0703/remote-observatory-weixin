const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    username: '',
    name: '',
    password: '',
    confirm: '',
    loading: false,
    error: ''
  },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field;
    const patch = { error: '' };
    patch[field] = e.detail.value;
    this.setData(patch);
  },

  onSubmit: function () {
    const app = getApp();
    const username = (this.data.username || '').trim();
    const name = (this.data.name || '').trim();
    const password = this.data.password || '';
    const confirm = this.data.confirm || '';

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      this.setData({ error: '用户名需为 3-20 位字母、数字或下划线' });
      return;
    }
    if (password.length < 6) {
      this.setData({ error: '密码至少 6 位' });
      return;
    }
    if (password !== confirm) {
      this.setData({ error: '两次输入的密码不一致' });
      return;
    }

    const self = this;
    this.setData({ loading: true, error: '' });
    api.register({ username: username, password: password, name: name }).then(function (res) {
      app.setSession(res.user, res.token);
      util.toast('注册成功', 'success');
      setTimeout(function () { wx.reLaunch({ url: '/pages/home/home' }); }, 400);
    }).catch(function (err) {
      self.setData({ loading: false, error: err.message || '注册失败' });
    });
  },

  goBack: function () {
    wx.navigateBack({
      fail: function () { wx.reLaunch({ url: '/pages/login/login' }); }
    });
  }
});
