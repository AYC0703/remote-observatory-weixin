const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    groups: [],
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
    return api.adminCalendar().then(function (res) {
      const map = {};
      (res.slots || []).forEach(function (slot) {
        if (!map[slot.device]) map[slot.device] = [];
        map[slot.device].push({
          id: slot.id,
          app_no: slot.app_no,
          status: slot.status,
          startText: util.fmtSlot(slot.start_time),
          endText: util.fmtSlot(slot.end_time)
        });
      });
      const groups = Object.keys(map).map(function (device) {
        return { device: device, slots: map[device] };
      });
      self.setData({ groups: groups, loading: false });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  }
});
