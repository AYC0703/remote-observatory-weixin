const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

/** 实时状态轮询间隔（毫秒）——页面隐藏时自动停止 */
const POLL_MS = 5000;

Page({
  data: {
    isAdmin: false,
    loading: true,
    covers: [],
    policy: null,
    unbound: [],
    unboundNames: '',
    expandedId: 0,
    detail: null,
    detailLoading: false,
    binding: null,
    busyId: 0
  },

  onShow: function () {
    if (!app.guard()) return;
    const isAdmin = app.isAdmin();
    this.setData({ isAdmin: isAdmin });
    this.load();
    if (isAdmin) this.loadAdmin();
  },

  onHide: function () {
    this.stopTimer();
  },

  onUnload: function () {
    this.stopTimer();
  },

  onPullDownRefresh: function () {
    const self = this;
    this.load().then(function () {
      return self.data.isAdmin ? self.loadAdmin() : null;
    }).catch(function () {}).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  /* ---------------- 数据加载 ---------------- */

  load: function () {
    const self = this;
    return api.observatoryCovers().then(function (res) {
      self.applyCovers(res);
      self.setData({ loading: false });
      self.startTimer();
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  },

  refresh: function () {
    const self = this;
    return api.observatoryCovers().then(function (res) {
      self.applyCovers(res);
    }).catch(function () { /* 轮询失败静默 */ });
  },

  applyCovers: function (res) {
    const covers = (res.covers || []).map(util.decorateCover);
    this.setData({ covers: covers, policy: res.policy || null });
  },

  loadAdmin: function () {
    const self = this;
    return api.adminObservatory().then(function (res) {
      const unbound = res.unbound || [];
      self.setData({
        unbound: unbound,
        unboundNames: unbound.map(function (d) { return d.name; }).join('、')
      });
    }).catch(function (err) {
      util.errorToast(err);
    });
  },

  loadDetail: function (id) {
    const self = this;
    this.setData({ detailLoading: true });
    return api.observatoryCover(id).then(function (res) {
      self.setData({
        detailLoading: false,
        detail: {
          cover: util.decorateCover(res.cover),
          commands: util.decorateCommands(res.commands),
          events: util.decorateEvents(res.events)
        }
      });
    }).catch(function (err) {
      self.setData({ detailLoading: false });
      util.errorToast(err);
    });
  },

  startTimer: function () {
    const self = this;
    this.stopTimer();
    this._timer = setInterval(function () { self.refresh(); }, POLL_MS);
  },

  stopTimer: function () {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  },

  /* ---------------- 交互 ---------------- */

  toggleDetail: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    if (this.data.expandedId === id) {
      this.setData({ expandedId: 0, detail: null });
      return;
    }
    this.setData({ expandedId: id, detail: null });
    this.loadDetail(id);
  },

  runCommand: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    const action = e.currentTarget.dataset.action;
    const name = e.currentTarget.dataset.name;
    const self = this;
    const label = util.cmdActionLabel(action);
    util.confirm('确定对「' + name + '」执行「' + label + '」吗？', '远程' + label).then(function (ok) {
      if (!ok) return;
      self.setData({ busyId: id });
      api.coverCommand(id, action).then(function (res) {
        self.setData({ busyId: 0 });
        util.toast(res.message || '指令已下发', 'success');
        self.refresh();
        if (self.data.expandedId === id) self.loadDetail(id);
      }).catch(function (err) {
        self.setData({ busyId: 0 });
        util.errorToast(err);
        self.refresh();
      });
    });
  },

  forceCommand: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    const action = e.currentTarget.dataset.action;
    const name = e.currentTarget.dataset.name;
    const self = this;
    const label = util.cmdActionLabel(action);
    util.confirm(
      '将以管理员身份强制对「' + name + '」执行「' + label + '」，绕过在线、位置与故障校验。\n仅在应急时使用，操作会记入审计日志。',
      '管理员强制' + label
    ).then(function (ok) {
      if (!ok) return;
      self.setData({ busyId: id });
      api.adminObservatoryCommand(id, action).then(function (res) {
        self.setData({ busyId: 0 });
        util.toast(res.message || '强制指令已下发', 'success');
        self.refresh();
      }).catch(function (err) {
        self.setData({ busyId: 0 });
        util.errorToast(err);
      });
    });
  },

  emergencyClose: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    const name = e.currentTarget.dataset.name;
    const self = this;
    util.confirm(
      '紧急关盖会取消「' + name + '」队列中的全部指令，立即下发关盖。\n若顶盖正在打开或已打开，将直接反向关闭。',
      '紧急关盖'
    ).then(function (ok) {
      if (!ok) return;
      self.setData({ busyId: id });
      api.coverEmergencyClose(id).then(function () {
        self.setData({ busyId: 0 });
        util.toast('紧急关盖指令已下发', 'success');
        self.refresh();
        self.loadDetail(id);
      }).catch(function (err) {
        self.setData({ busyId: 0 });
        util.errorToast(err);
      });
    });
  },

  /* ---------------- 管理员：接入管理 ---------------- */

  bindNew: function () {
    const list = this.data.unbound || [];
    if (!list.length) {
      util.toast('所有设备均已接入远程控制');
      return;
    }
    const self = this;
    wx.showActionSheet({
      itemList: list.map(function (d) { return d.name; }).slice(0, 6),
      success: function (res) {
        const dev = list[res.tapIndex];
        if (!dev) return;
        util.confirm('为「' + dev.name + '」生成设备令牌？\n已有令牌的设备将被重置，原固件立即失效。', '接入远程控制')
          .then(function (ok) {
            if (!ok) return;
            api.adminObservatoryBind(dev.name).then(function (r) {
              self.setData({ binding: { device: r.device, token: r.token, rebound: r.rebound } });
              util.toast('令牌已生成', 'success');
              self.load();
              self.loadAdmin();
            }).catch(util.errorToast);
          });
      },
      fail: function () { /* 用户取消 */ }
    });
  },

  resetToken: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    const name = e.currentTarget.dataset.name;
    const self = this;
    util.confirm('重置「' + name + '」的设备令牌？\n原令牌立即失效，需要重新烧写 ESP32 固件。', '重置令牌')
      .then(function (ok) {
        if (!ok) return;
        api.adminObservatoryBind(name).then(function (r) {
          self.setData({ binding: { device: r.device, token: r.token, rebound: true } });
          util.toast('令牌已重置', 'success');
        }).catch(util.errorToast);
      });
  },

  toggleEnabled: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    const name = e.currentTarget.dataset.name;
    const current = e.currentTarget.dataset.enabled;
    const next = !current;
    const self = this;
    util.confirm(
      (next ? '启用' : '停用') + '「' + name + '」的远程控制？\n' +
      (next ? '' : '停用后 ESP32 将无法上报状态或接收指令。'),
      (next ? '启用' : '停用') + '远程控制'
    ).then(function (ok) {
      if (!ok) return;
      api.adminObservatoryEnabled(id, next).then(function () {
        util.toast(next ? '已启用' : '已停用', 'success');
        self.load();
        self.loadAdmin();
      }).catch(util.errorToast);
    });
  },

  unbind: function (e) {
    const id = Number(e.currentTarget.dataset.id);
    const name = e.currentTarget.dataset.name;
    const self = this;
    util.confirm('解除「' + name + '」的远程控制接入？\n历史指令与事件流水会保留。', '解除接入')
      .then(function (ok) {
        if (!ok) return;
        api.adminObservatoryUnbind(id).then(function () {
          util.toast('已解除接入', 'success');
          if (self.data.expandedId === id) self.setData({ expandedId: 0, detail: null });
          self.load();
          self.loadAdmin();
        }).catch(util.errorToast);
      });
  },

  copyToken: function () {
    const token = this.data.binding && this.data.binding.token;
    if (!token) return;
    wx.setClipboardData({
      data: token,
      success: function () { util.toast('令牌已复制', 'success'); }
    });
  },

  dismissBinding: function () {
    this.setData({ binding: null });
  }
});
