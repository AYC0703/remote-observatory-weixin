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
    this.load();
  },

  onPullDownRefresh: function () {
    this.load().then(function () { wx.stopPullDownRefresh(); });
  },

  load: function () {
    const self = this;
    this.setData({ loading: true });
    return api.mine().then(function (res) {
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

  goSubmit: function () {
    wx.navigateTo({ url: '/pages/submit/submit' });
  },

  withdraw: function (e) {
    const id = e.currentTarget.dataset.id;
    const self = this;
    util.confirm('撤回后不可恢复，确定撤回该申请吗？', '撤回申请').then(function (ok) {
      if (!ok) return;
      api.withdraw(id).then(function () {
        util.toast('已撤回', 'success');
        self.load();
      }).catch(util.errorToast);
    });
  }
});
