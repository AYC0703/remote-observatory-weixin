const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    id: 0,
    app: null,
    history: [],
    isAdmin: false,
    loading: true
  },

  onLoad: function (options) {
    if (!app.guard()) return;
    this.setData({ id: Number(options.id || 0), isAdmin: app.isAdmin() });
    this.load();
  },

  onShow: function () {
    if (this.data.id) this.load();
  },

  load: function () {
    const self = this;
    api.applicationDetail(this.data.id).then(function (res) {
      const history = util.decorateHistory(res.history);
      history.forEach(function (h) {
        h.statusColor = util.statusColor(h.to_status);
      });
      self.setData({
        app: util.decorateApplication(res.application),
        history: history,
        isAdmin: app.isAdmin(),
        loading: false
      });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  },

  goReview: function (e) {
    const action = e.currentTarget.dataset.action;
    wx.navigateTo({ url: '/pages/review/review?id=' + this.data.id + '&action=' + action });
  }
});
