const app = getApp();

Page({
  data: {
    user: {},
    isAdmin: false,
    menus: []
  },

  onShow: function () {
    if (!app.guard()) return;
    this.buildMenus(app.globalData.user);
    const self = this;
    app.refreshUser().then(function (user) {
      if (!user) { app.goLogin(); return; }
      self.buildMenus(user);
    }).catch(function () { /* 网络异常时沿用本地缓存 */ });
  },

  onPullDownRefresh: function () {
    const self = this;
    app.refreshUser().then(function (user) {
      if (user) self.buildMenus(user);
    }).catch(function () {}).then(function () {
      wx.stopPullDownRefresh();
    });
  },

  buildMenus: function (user) {
    if (!user) return;
    const isAdmin = user.role === 'admin';
    const menus = isAdmin ? [
      { icon: '🛰️', name: '观测站控制', desc: '开合顶盖 / 实时状态 / 接入管理', url: '/pages/console/console' },
      { icon: '📋', name: '待审批', desc: '按提交时间先到先审', url: '/pages/pending/pending' },
      { icon: '🗂️', name: '全部申请', desc: '筛选 / 搜索 / 分页', url: '/pages/all/all' },
      { icon: '📅', name: '时段日历', desc: '设备占用时段一览', url: '/pages/calendar/calendar' },
      { icon: '📊', name: '统计分析', desc: '状态分布与趋势', url: '/pages/stats/stats' },
      { icon: '🛠️', name: '设备管理', desc: '新增 / 重命名 / 删除', url: '/pages/devices/devices' },
      { icon: '📜', name: '审计日志', desc: '最近 200 条操作流水', url: '/pages/audit/audit' }
    ] : [
      { icon: '🛰️', name: '观测站控制', desc: '申请时段内可远程开合顶盖', url: '/pages/console/console' },
      { icon: '📝', name: '提交申请', desc: '填写设备与使用时段', url: '/pages/submit/submit' },
      { icon: '📄', name: '我的申请', desc: '查看状态与变更历史', url: '/pages/mine/mine' }
    ];
    this.setData({ user: user, isAdmin: isAdmin, menus: menus });
  },

  goMenu: function (e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.navigateTo({ url: url });
  }
});
