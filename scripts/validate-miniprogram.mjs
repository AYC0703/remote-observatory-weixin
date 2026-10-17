import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MP = path.join(ROOT, 'miniprogram');
let errors = 0;
let warnings = 0;
const err = (m) => { errors++; console.log('  \u2717 ' + m); };
const warn = (m) => { warnings++; console.log('  ! ' + m); };
const ok = (m) => console.log('  \u2713 ' + m);

function walk(dir, ext, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, cb);
    else if (entry.name.endsWith(ext)) cb(full);
  }
}

const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'));
const pages = appJson.pages || [];

console.log('\n== 页面文件完整性 ==');
for (const p of pages) {
  for (const ext of ['js', 'json', 'wxml']) {
    if (!fs.existsSync(path.join(MP, p + '.' + ext))) err('缺少文件: ' + p + '.' + ext);
  }
}
ok(pages.length + ' 个页面检查完成');

console.log('\n== tabBar 页面注册 ==');
for (const t of ((appJson.tabBar && appJson.tabBar.list) || []).map((x) => x.pagePath)) {
  if (pages.indexOf(t) === -1) err('tabBar 页面未注册: ' + t);
}
ok('tabBar 页面已注册');

console.log('\n== usingComponents 路径 ==');
function checkComponents(jsonPath) {
  if (!fs.existsSync(jsonPath)) return;
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  Object.keys(json.usingComponents || {}).forEach((name) => {
    const rel = json.usingComponents[name];
    const base = rel.startsWith('/') ? path.join(MP, rel.slice(1)) : path.resolve(path.dirname(jsonPath), rel);
    for (const ext of ['js', 'json', 'wxml']) {
      if (!fs.existsSync(base + '.' + ext)) err('组件缺失: ' + rel + '.' + ext + '（' + path.relative(MP, jsonPath) + '）');
    }
  });
}
checkComponents(path.join(MP, 'app.json'));
for (const p of pages) checkComponents(path.join(MP, p + '.json'));
ok('组件路径检查完成');

console.log('\n== WXML 标签配平 ==');
function stripInterpolations(src) {
  return src.replace(/\{\{[\s\S]*?\}\}/g, (m) => m.replace(/>/g, '\u0001').replace(/</g, '\u0002'));
}
const VOID = new Set(['input', 'image', 'img', 'br', 'hr', 'meta', 'link', 'import', 'include', 'wxs']);
function checkWxml(file) {
  let src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  src = stripInterpolations(src);
  const re = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const stack = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (m[0].startsWith('</')) {
      const top = stack.pop();
      if (top !== name) { err('标签不匹配: ' + path.relative(MP, file) + ' 期望 </' + (top || '?') + '> 实际 </' + name + '>'); return; }
    } else if (m[3] !== '/' && !VOID.has(name)) {
      stack.push(name);
    }
  }
  if (stack.length) err('未闭合标签: ' + path.relative(MP, file) + ' -> ' + stack.join(', '));
}
walk(MP, '.wxml', checkWxml);
ok('WXML 标签配平检查完成');

console.log('\n== WXML 事件处理函数存在性 ==');
function collectHandlers(js) {
  const names = new Set();
  const re = /(?:^|\n)\s{0,6}([A-Za-z_$][\w$]*)\s*:\s*function/g;
  let m;
  while ((m = re.exec(js)) !== null) names.add(m[1]);
  return names;
}
function checkHandlers(wxmlFile) {
  const jsFile = wxmlFile.replace(/\.wxml$/, '.js');
  if (!fs.existsSync(jsFile)) return;
  const handlers = collectHandlers(fs.readFileSync(jsFile, 'utf8'));
  const wxml = fs.readFileSync(wxmlFile, 'utf8');
  const re = /(?:bind|catch):?[a-zA-Z]+\s*=\s*"([^"{}]+)"/g;
  let m;
  while ((m = re.exec(wxml)) !== null) {
    const h = m[1].trim();
    if (!h || !/^[A-Za-z_$][\w$]*$/.test(h)) continue;
    if (!handlers.has(h)) err('事件处理函数未定义: ' + h + '（' + path.relative(MP, wxmlFile) + '）');
  }
}
walk(MP, '.wxml', checkHandlers);
ok('事件处理函数检查完成');

console.log('\n== 页面跳转目标 ==');
const pageSet = new Set(pages);
function checkNavJs(file) {
  const js = fs.readFileSync(file, 'utf8');
  const re = /url:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    let u = m[1];
    if (u.startsWith('http')) continue;
    if (u.indexOf('/api/') === 0) continue;
    u = u.split('?')[0];
    if (u.startsWith('/')) u = u.slice(1);
    if (u && !pageSet.has(u)) err('跳转目标未注册: ' + m[1] + '（' + path.relative(MP, file) + '）');
  }
}
walk(path.join(MP, 'pages'), '.js', checkNavJs);
checkNavJs(path.join(MP, 'app.js'));
ok('页面跳转目标检查完成');

console.log('\n== api.js 接口与 server 路由一致性 ==');
function extractUrlExprs(js) {
  const results = [];
  let idx = 0;
  while ((idx = js.indexOf('url:', idx)) !== -1) {
    let i = idx + 4;
    while (js[i] === ' ') i++;
    let expr = '';
    let depth = 0;
    let inStr = false;
    let q = '';
    for (; i < js.length; i++) {
      const ch = js[i];
      if (inStr) {
        expr += ch;
        if (ch === '\\') { expr += js[++i]; continue; }
        if (ch === q) inStr = false;
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = true; q = ch; expr += ch; continue; }
      if (ch === '(' || ch === '{' || ch === '[') { depth++; expr += ch; continue; }
      if (ch === ',' && depth === 0) break;
      if (ch === '}' && depth === 0) break;
      if (ch === ')' || ch === '}' || ch === ']') { depth--; expr += ch; continue; }
      expr += ch;
    }
    results.push(expr.trim());
    idx = i;
  }
  return results;
}
function normalizeExpr(expr) {
  return expr.split('+').map((part) => {
    const p = part.trim();
    if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) return p.slice(1, -1);
    if (/^[A-Za-z_$][\w$.]*\s*\(/.test(p)) return '';
    if (p === '') return '';
    return ':param';
  }).join('');
}
const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const routePatterns = [];
{
  const re = /app\.(?:get|post|put|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(serverSrc)) !== null) routePatterns.push(m[1]);
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}
function matchesServer(apiPath) {
  const clean = apiPath.split('?')[0];
  return routePatterns.some((pattern) => {
    const rx = new RegExp('^' + escapeRegExp(pattern).replace(/:[\w]+/g, '[^/]+') + '$');
    return rx.test(clean);
  });
}
const apiSrc = fs.readFileSync(path.join(MP, 'utils', 'api.js'), 'utf8');
const apiPaths = extractUrlExprs(apiSrc).map(normalizeExpr).filter((p) => p.indexOf('/api/') === 0);
const apiUnique = Array.from(new Set(apiPaths));
let unmatched = 0;
for (const p of apiUnique) {
  if (!matchesServer(p)) { unmatched++; err('api.js 调用了后端不存在的接口: ' + p); }
}
if (!unmatched) ok(apiUnique.length + ' 个小程序接口均匹配后端路由');
console.log('  后端路由数: ' + routePatterns.length);

console.log('\n== app.json 页面均存在 WXML ==');
for (const p of pages) {
  if (!fs.existsSync(path.join(MP, p + '.wxml'))) err('页面缺 WXML: ' + p);
}
ok('页面清单检查完成');

console.log('\n----------------------------------------');
console.log('错误: ' + errors + '  警告: ' + warnings);
console.log('----------------------------------------');
process.exit(errors > 0 ? 1 : 0);
