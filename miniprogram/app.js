const api = require('./utils/api');

App({
  globalData: {
    user: null,
    token: ''
  },

  onLaunch: function () {
    this.globalData.token = wx.getStorageSync('token') || '';
    this.globalData.user = wx.getStorageSync('user') || null;
  },

  setSession: function (user, token) {
    this.globalData.user = user;
    this.globalData.token = token;
    wx.setStorageSync('token', token);
    wx.setStorageSync('user', user);
  },

  setUser: function (user) {
    this.globalData.user = user;
    wx.setStorageSync('user', user);
  },

  clearSession: function () {
    this.globalData.user = null;
    this.globalData.token = '';
    wx.removeStorageSync('token');
    wx.removeStorageSync('user');
  },

  isLoggedIn: function () {
    return !!this.globalData.token;
  },

  isAdmin: function () {
    return !!(this.globalData.user && this.globalData.user.role === 'admin');
  },

  goLogin: function () {
    wx.reLaunch({ url: '/pages/login/login' });
  },

  /** 页面 onShow 通用守卫：未登录则跳转登录页 */
  guard: function () {
    if (!this.isLoggedIn()) {
      this.goLogin();
      return false;
    }
    return true;
  },

  /** 刷新当前登录用户（用于恢复登录态 / 角色变化） */
  refreshUser: function () {
    const app = this;
    return api.me().then(function (res) {
      if (res && res.user) {
        app.setUser(res.user);
        return res.user;
      }
      app.clearSession();
      return null;
    });
  }
});
