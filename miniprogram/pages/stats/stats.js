const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();
const STATUS_COLOR = util.STATUS_COLOR;

Page({
  data: {
    loading: true,
    stats: { total: 0, approveRate: 0, counts: { pending: 0, approved: 0, rejected: 0, withdrawn: 0 } },
    statusChart: null,
    deviceChart: null,
    monthChart: null
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
    return api.stats().then(function (res) {
      const counts = res.counts || {};
      self.setData({
        stats: res,
        loading: false,
        statusChart: {
          items: [
            { label: '待审批', value: counts.pending || 0, color: STATUS_COLOR.pending },
            { label: '已通过', value: counts.approved || 0, color: STATUS_COLOR.approved },
            { label: '未通过', value: counts.rejected || 0, color: STATUS_COLOR.rejected },
            { label: '已撤回', value: counts.withdrawn || 0, color: STATUS_COLOR.withdrawn }
          ]
        },
        deviceChart: {
          color: '#4da3ff',
          items: (res.byDevice || []).map(function (d) {
            return { label: d.device, value: d.c };
          })
        },
        monthChart: {
          items: (res.byMonthRaw || []).map(function (m) {
            return { label: m.ym, value: m.c };
          })
        }
      });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  },

  onExport: function () {
    wx.showLoading({ title: '生成报表中…', mask: true });
    api.exportCsv().then(function (text) {
      wx.hideLoading();
      const fs = wx.getFileSystemManager();
      const name = 'observatory-report-' + util.fmtDate(new Date()) + '.csv';
      const filePath = wx.env.USER_DATA_PATH + '/' + name;
      fs.writeFile({
        filePath: filePath,
        data: text,
        encoding: 'utf8',
        success: function () {
          wx.showModal({
            title: '导出成功',
            content: '报表已生成，可转发到聊天，或复制内容后在电脑端粘贴为 .csv 文件。',
            confirmText: '转发文件',
            cancelText: '复制内容',
            success: function (m) {
              if (m.confirm) {
                if (wx.shareFileMessage) {
                  wx.shareFileMessage({
                    filePath: filePath,
                    fileName: name,
                    fail: function () { util.toast('转发取消，可改用复制内容'); }
                  });
                } else {
                  wx.setClipboardData({ data: text });
                }
              } else {
                wx.setClipboardData({ data: text });
              }
            }
          });
        },
        fail: function () {
          wx.setClipboardData({ data: text });
        }
      });
    }).catch(function (err) {
      wx.hideLoading();
      util.errorToast(err);
    });
  }
});
