const api = require('../../utils/api');
const util = require('../../utils/util');

const app = getApp();

Page({
  data: {
    statusOptions: [
      { label: '全部', value: '' },
      { label: '待审批', value: 'pending' },
      { label: '已通过', value: 'approved' },
      { label: '未通过', value: 'rejected' },
      { label: '已撤回', value: 'withdrawn' }
    ],
    activeStatus: '',
    search: '',
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
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

  load: function () {
    const self = this;
    this.setData({ loading: true });
    return api.adminApplications({
      status: this.data.activeStatus,
      search: this.data.search,
      page: this.data.page,
      pageSize: this.data.pageSize
    }).then(function (res) {
      const total = res.total || 0;
      self.setData({
        list: (res.applications || []).map(util.decorateApplication),
        total: total,
        totalPages: Math.max(1, Math.ceil(total / self.data.pageSize)),
        loading: false
      });
    }).catch(function (err) {
      self.setData({ loading: false });
      util.errorToast(err);
    });
  },

  onStatusTap: function (e) {
    this.setData({ activeStatus: e.currentTarget.dataset.value, page: 1 });
    this.load();
  },

  onSearchInput: function (e) {
    this.setData({ search: e.detail.value });
  },

  onSearchConfirm: function () {
    this.setData({ page: 1 });
    this.load();
  },

  prevPage: function () {
    if (this.data.page <= 1) return;
    this.setData({ page: this.data.page - 1 });
    this.load();
  },

  nextPage: function () {
    if (this.data.page >= this.data.totalPages) return;
    this.setData({ page: this.data.page + 1 });
    this.load();
  },

  goDetail: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  }
});
