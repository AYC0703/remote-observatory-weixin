const chart = require('../../utils/chart');

Component({
  properties: {
    type: { type: String, value: 'bar' },
    chartData: {
      type: null,
      value: null,
      observer: function () { this.scheduleDraw(); }
    },
    height: { type: Number, value: 220 }
  },

  lifetimes: {
    ready: function () { this.initCanvas(); }
  },

  methods: {
    initCanvas: function () {
      const self = this;
      this.createSelectorQuery()
        .select('#chart')
        .fields({ node: true, size: true })
        .exec(function (res) {
          if (!res || !res[0] || !res[0].node) return;
          const canvas = res[0].node;
          const ctx = canvas.getContext('2d');
          let dpr = 1;
          try {
            const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            dpr = info.pixelRatio || 1;
          } catch (e) { dpr = 1; }
          self._canvas = canvas;
          self._ctx = ctx;
          self._w = res[0].width;
          self._h = res[0].height;
          canvas.width = res[0].width * dpr;
          canvas.height = res[0].height * dpr;
          ctx.scale(dpr, dpr);
          self.scheduleDraw();
        });
    },

    scheduleDraw: function () {
      const self = this;
      if (!this._ctx) return;
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(function () { self.draw(); }, 30);
    },

    draw: function () {
      if (!this._ctx) return;
      chart.render(this._ctx, this._w, this._h, this.data.type, this.data.chartData || {});
    }
  }
});
