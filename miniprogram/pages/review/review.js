const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    id: 0,
    action: 'approve',
    isApprove: true,
    app: null,
    conflicts: [],
    force: false,
    comment: '',
    formError: '',
    submitting: false
  },

  onLoad: function (options) {
    if (!app.guard()) return;
    if (!app.isAdmin()) {
      util.toast('需要管理员权限');
      wx.navigateBack();
      return;
    }
    const action = options.action === 'reject' ? 'reject' : 'approve';
    this.setData({ id: Number(options.id || 0), action: action, isApprove: action === 'approve' });
    this.load();
  },

  load: function () {
    const self = this;
    api.applicationDetail(this.data.id).then(function (res) {
      self.setData({ app: util.decorateApplication(res.application) });
      if (self.data.isApprove) self.loadConflicts();
    }).catch(function (err) {
      util.errorToast(err);
      wx.navigateBack();
    });
  },

  loadConflicts: function () {
    const self = this;
    api.adminCalendar().then(function (res) {
      const application = self.data.app;
      if (!application) return;
      const conflicts = (res.slots || []).filter(function (s) {
        return s.id !== application.id &&
          s.device === application.device &&
          s.start_time < application.end_time &&
          s.end_time > application.start_time;
      });
      self.setData({ conflicts: conflicts });
    }).catch(function () {});
  },

  onForceChange: function (e) {
    this.setData({ force: e.detail.value });
  },

  onCommentInput: function (e) {
    this.setData({ comment: e.detail.value, formError: '' });
  },

  onCancel: function () {
    wx.navigateBack();
  },

  onSubmit: function () {
    const d = this.data;
    if (!d.isApprove && !(d.comment || '').trim()) {
      this.setData({ formError: '拒绝时必须填写审批意见' });
      return;
    }
    if (d.isApprove && d.conflicts.length && !d.force) {
      this.setData({ formError: '存在时段冲突，请开启「强制通过」后再提交' });
      return;
    }

    const self = this;
    this.setData({ submitting: true, formError: '' });
    api.review(d.id, {
      action: d.action,
      comment: (d.comment || '').trim(),
      force: d.force
    }).then(function (res) {
      self.setData({ submitting: false });
      util.toast(res.status === 'approved' ? '已通过' : '已拒绝', 'success');
      setTimeout(function () { wx.navigateBack(); }, 600);
    }).catch(function (err) {
      const conflicts = (err.data && err.data.conflicts) ? err.data.conflicts : [];
      self.setData({
        submitting: false,
        formError: err.message || '审批失败',
        conflicts: conflicts.length ? conflicts : self.data.conflicts
      });
    });
  }
});
