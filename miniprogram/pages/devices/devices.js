const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    list: [],
    newName: '',
    error: '',
    loading: true,
    adding: false
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
    return api.devices().then(function (res) {
      self.setData({ list: res.devices || [], loading: false });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  },

  onNewNameInput: function (e) {
    this.setData({ newName: e.detail.value, error: '' });
  },

  addDevice: function () {
    const name = (this.data.newName || '').trim();
    if (!name) { this.setData({ error: '请输入设备名称' }); return; }
    if (name.length > 50) { this.setData({ error: '设备名称过长（最多 50 字）' }); return; }
    const self = this;
    this.setData({ adding: true, error: '' });
    api.addDevice(name).then(function () {
      self.setData({ adding: false, newName: '' });
      util.toast('新增成功', 'success');
      self.load();
    }).catch(function (err) {
      self.setData({ adding: false, error: err.message || '新增失败' });
    });
  },

  renameDevice: function (e) {
    const id = e.currentTarget.dataset.id;
    const current = e.currentTarget.dataset.name;
    const self = this;
    wx.showModal({
      title: '重命名设备',
      editable: true,
      placeholderText: '请输入新的设备名称',
      content: current,
      success: function (res) {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name || name === current) return;
        if (name.length > 50) { util.toast('设备名称过长（最多 50 字）'); return; }
        api.renameDevice(id, name).then(function () {
          util.toast('重命名成功', 'success');
          self.load();
        }).catch(util.errorToast);
      }
    });
  },

  deleteDevice: function (e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    const count = Number(e.currentTarget.dataset.count) || 0;
    if (count > 0) {
      util.toast('该设备已被申请引用，无法删除');
      return;
    }
    const self = this;
    util.confirm('确定删除设备「' + name + '」吗？', '删除设备').then(function (ok) {
      if (!ok) return;
      api.deleteDevice(id).then(function () {
        util.toast('删除成功', 'success');
        self.load();
      }).catch(util.errorToast);
    });
  }
});
