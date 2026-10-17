const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    list: [],
    loading: true
  },

  onShow: function () {
    if (!app.guard()) return;
    if (!app.isAdmin()) {
      util.toast('需要管理员权限');
      wx.navigateBack();
      return;
    }
    this.load();
  },

  onPullDownRefresh: function () {
    this.load().then(function () { wx.stopPullDownRefresh(); });
  },

  load: function () {
    const self = this;
    this.setData({ loading: true });
    return api.adminPending().then(function (res) {
      self.setData({
        list: (res.applications || []).map(util.decorateApplication),
        loading: false
      });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  },

  goDetail: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goReview: function (e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action;
    wx.navigateTo({ url: '/pages/review/review?id=' + id + '&action=' + action });
  }
});
