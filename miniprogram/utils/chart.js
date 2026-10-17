/**
 * 轻量 Canvas 2D 图表渲染（环形图 / 柱状图 / 折线图）。
 * 不依赖任何第三方图表库，适配小程序 <canvas type="2d">。
 */

const COLORS = {
  axis: '#2a3f66',
  grid: '#1e3357',
  text: '#c7d5ee',
  subText: '#93a6c8',
  accent: '#4da3ff',
  hole: '#12203a'
};

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function truncate(text, max) {
  const s = String(text === null || text === undefined ? '' : text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function drawEmpty(ctx, w, h) {
  ctx.fillStyle = COLORS.subText;
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('暂无数据', w / 2, h / 2);
}

function renderDoughnut(ctx, w, h, data) {
  const items = (data && data.items) || [];
  let total = 0;
  items.forEach(function (it) { total += Number(it.value) || 0; });
  if (!total) { drawEmpty(ctx, w, h); return; }

  const cx = w * 0.29;
  const cy = h / 2;
  const r = Math.min(w * 0.27, h / 2 - 12);
  const inner = r * 0.62;
  let start = -Math.PI / 2;

  items.forEach(function (it) {
    const angle = ((Number(it.value) || 0) / total) * Math.PI * 2;
    if (angle <= 0) return;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = it.color || COLORS.accent;
    ctx.fill();
    start += angle;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.hole;
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(String(total), cx, cy - 8);
  ctx.fillStyle = COLORS.subText;
  ctx.font = '11px sans-serif';
  ctx.fillText('总申请', cx, cy + 14);

  const lx = w * 0.57;
  let ly = cy - (items.length * 24) / 2 + 12;
  ctx.textAlign = 'left';
  items.forEach(function (it) {
    ctx.fillStyle = it.color || COLORS.accent;
    roundRect(ctx, lx, ly - 6, 12, 12, 3);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.font = '12px sans-serif';
    ctx.fillText(it.label + '  ' + (it.value || 0), lx + 20, ly);
    ly += 24;
  });
}

function renderBar(ctx, w, h, data) {
  const items = (data && data.items) || [];
  if (!items.length) { drawEmpty(ctx, w, h); return; }

  const padL = 36;
  const padR = 14;
  const padT = 18;
  const padB = 38;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  let max = 0;
  items.forEach(function (it) { max = Math.max(max, Number(it.value) || 0); });
  if (max <= 0) max = 1;

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.subText;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round((max * g) / 4)), padL - 6, y);
  }

  const slot = plotW / items.length;
  const bw = Math.min(30, slot * 0.55);
  items.forEach(function (it, i) {
    const value = Number(it.value) || 0;
    const bh = Math.max(2, (value / max) * plotH);
    const x = padL + slot * i + (slot - bw) / 2;
    const y = padT + plotH - bh;
    ctx.fillStyle = data.color || COLORS.accent;
    roundRect(ctx, x, y, bw, bh, 4);
    ctx.fill();

    ctx.textAlign = 'center';
    if (value > 0) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '10px sans-serif';
      ctx.fillText(String(value), x + bw / 2, y - 9);
    }
    ctx.fillStyle = COLORS.subText;
    ctx.font = '9px sans-serif';
    ctx.fillText(truncate(it.label, 5), x + bw / 2, padT + plotH + 16);
  });
}

function renderLine(ctx, w, h, data) {
  const items = (data && data.items) || [];
  if (!items.length) { drawEmpty(ctx, w, h); return; }

  const padL = 36;
  const padR = 18;
  const padT = 20;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  let max = 0;
  items.forEach(function (it) { max = Math.max(max, Number(it.value) || 0); });
  if (max <= 0) max = 1;

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.subText;
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.round((max * g) / 4)), padL - 6, y);
  }

  const n = items.length;
  const step = n > 1 ? plotW / (n - 1) : 0;
  const points = items.map(function (it, i) {
    const value = Number(it.value) || 0;
    return {
      x: padL + (n > 1 ? step * i : plotW / 2),
      y: padT + plotH - (value / max) * plotH,
      label: it.label,
      value: value
    };
  });

  // 面积填充
  ctx.beginPath();
  ctx.moveTo(points[0].x, padT + plotH);
  points.forEach(function (p) { ctx.lineTo(p.x, p.y); });
  ctx.lineTo(points[points.length - 1].x, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = 'rgba(77, 163, 255, 0.18)';
  ctx.fill();

  // 折线
  ctx.beginPath();
  points.forEach(function (p, i) {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  // 数据点与 X 轴标签
  ctx.textAlign = 'center';
  points.forEach(function (p) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.accent;
    ctx.fill();
    ctx.fillStyle = COLORS.subText;
    ctx.font = '9px sans-serif';
    ctx.fillText(truncate(p.label, 8), p.x, padT + plotH + 15);
  });
}

function render(ctx, w, h, type, data) {
  ctx.clearRect(0, 0, w, h);
  if (type === 'doughnut') renderDoughnut(ctx, w, h, data);
  else if (type === 'bar') renderBar(ctx, w, h, data);
  else if (type === 'line') renderLine(ctx, w, h, data);
}

module.exports = {
  render: render,
  COLORS: COLORS
};
