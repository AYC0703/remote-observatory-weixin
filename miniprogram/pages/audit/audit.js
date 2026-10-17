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
    return api.audit().then(function (res) {
      self.setData({
        list: (res.logs || []).map(function (log) {
          return {
            id: log.id,
            username: log.username,
            detail: log.detail,
            actionText: util.auditActionLabel(log.action),
            timeText: util.fmtDateTime(log.created_at)
          };
        }),
        loading: false
      });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  }
});
