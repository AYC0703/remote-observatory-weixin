const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    devices: [],
    deviceNames: [],
    deviceIndex: -1,
    startDate: '',
    startTime: '22:00',
    endDate: '',
    endTime: '02:00',
    target: '',
    purpose: '',
    applicantName: '',
    applicantContact: '',
    conflicts: [],
    conflictLoaded: false,
    checking: false,
    submitting: false,
    formError: '',
    minDate: ''
  },

  onLoad: function () {
    if (!app.guard()) return;
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const user = app.globalData.user || {};
    this.setData({
      minDate: util.fmtDate(now),
      startDate: util.fmtDate(now),
      endDate: util.fmtDate(tomorrow),
      applicantName: user.name || ''
    });
    this.loadDevices();
  },

  loadDevices: function () {
    const self = this;
    api.devices().then(function (res) {
      const devices = res.devices || [];
      self.setData({
        devices: devices,
        deviceNames: devices.map(function (d) { return d.name; })
      });
    }).catch(util.errorToast);
  },

  onDeviceChange: function (e) {
    this.setData({ deviceIndex: Number(e.detail.value), formError: '' });
    this.scheduleCheck();
  },
  onStartDate: function (e) { this.setData({ startDate: e.detail.value, formError: '' }); this.scheduleCheck(); },
  onStartTime: function (e) { this.setData({ startTime: e.detail.value, formError: '' }); this.scheduleCheck(); },
  onEndDate: function (e) { this.setData({ endDate: e.detail.value, formError: '' }); this.scheduleCheck(); },
  onEndTime: function (e) { this.setData({ endTime: e.detail.value, formError: '' }); this.scheduleCheck(); },

  onInput: function (e) {
    const field = e.currentTarget.dataset.field;
    const patch = { formError: '' };
    patch[field] = e.detail.value;
    this.setData(patch);
  },

  scheduleCheck: function () {
    const self = this;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(function () { self.checkConflict(); }, 300);
  },

  buildTimes: function () {
    const d = this.data;
    return {
      start: d.startDate && d.startTime ? d.startDate + 'T' + d.startTime : '',
      end: d.endDate && d.endTime ? d.endDate + 'T' + d.endTime : ''
    };
  },

  checkConflict: function () {
    const times = this.buildTimes();
    const device = this.data.deviceNames[this.data.deviceIndex];
    if (!device || !times.start || !times.end || times.end <= times.start) {
      this.setData({ conflicts: [], conflictLoaded: false });
      return;
    }
    const self = this;
    this.setData({ checking: true });
    api.conflicts(device, times.start, times.end).then(function (res) {
      self.setData({ conflicts: res.conflicts || [], conflictLoaded: true, checking: false });
    }).catch(function () {
      self.setData({ checking: false, conflictLoaded: false });
    });
  },

  onSubmit: function () {
    const d = this.data;
    const device = d.deviceNames[d.deviceIndex];
    const times = this.buildTimes();
    if (!device) { this.setData({ formError: '请选择观测设备' }); return; }
    if (!times.start || !times.end) { this.setData({ formError: '请填写完整的使用时段' }); return; }
    if (times.end <= times.start) { this.setData({ formError: '结束时间必须晚于开始时间' }); return; }
    if (!(d.target || '').trim()) { this.setData({ formError: '请填写拍摄目标' }); return; }
    if (!(d.purpose || '').trim()) { this.setData({ formError: '请填写拍摄目的' }); return; }
    if (!(d.applicantName || '').trim()) { this.setData({ formError: '请填写申请人姓名' }); return; }
    if (!(d.applicantContact || '').trim()) { this.setData({ formError: '请填写联系方式' }); return; }
    if (d.conflicts.length) { this.setData({ formError: '所选时段存在冲突，无法提交' }); return; }

    const self = this;
    this.setData({ submitting: true, formError: '' });
    api.submitApplication({
      device: device,
      start_time: times.start,
      end_time: times.end,
      target: (d.target || '').trim(),
      purpose: (d.purpose || '').trim(),
      applicant_name: (d.applicantName || '').trim(),
      applicant_contact: (d.applicantContact || '').trim()
    }).then(function (res) {
      self.setData({ submitting: false });
      wx.showModal({
        title: '提交成功',
        content: '申请编号：' + res.app_no,
        cancelText: '继续提交',
        confirmText: '查看我的申请',
        success: function (m) {
          if (m.confirm) wx.navigateTo({ url: '/pages/mine/mine' });
          else self.resetForm();
        }
      });
    }).catch(function (err) {
      const conflicts = (err.data && err.data.conflicts) ? err.data.conflicts : [];
      self.setData({
        submitting: false,
        formError: err.message || '提交失败',
        conflicts: conflicts.length ? conflicts : self.data.conflicts
      });
    });
  },

  resetForm: function () {
    this.setData({
      target: '',
      purpose: '',
      conflicts: [],
      conflictLoaded: false,
      formError: ''
    });
  },

  goMine: function () {
    wx.navigateTo({ url: '/pages/mine/mine' });
  }
});
