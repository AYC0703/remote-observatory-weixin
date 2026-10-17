# 技术设计文档 —— 远程天文台使用申请审批及统计系统

## 1. 文档信息

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 对应代码版本 | 1.0.0 |
| 更新日期 | 2026-08-26 |
| 关联文档 | [PRD.md](./PRD.md)、[DATABASE_DESIGN.md](./DATABASE_DESIGN.md)、[API.md](./API.md) |

## 2. 架构总览

系统为典型的**前后端分离的单体应用**：后端提供 JSON API 与静态资源，前端为单页应用（SPA）。

```text
┌─────────────────────────────────────────────────────────┐
│                      浏览器（客户端）                      │
│  index.html + Vue 3（Options API）+ Chart.js             │
│  ├─ 视图路由 currentView：submit/mine/pending/all/...     │
│  ├─ 弹窗：详情 / 审批 / 修改密码                           │
│  └─ fetch 封装 api()：统一 JSON 与错误处理                 │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP / JSON（同源，Cookie 会话）
┌───────────────────────────▼─────────────────────────────┐
│                     Node.js 服务进程                       │
│  Express 应用（server.js）                                │
│  ├─ 中间件：express.json → session → 权限 → 限速           │
│  ├─ 路由层：认证 / 设备 / 申请 / 管理员                     │
│  └─ 工具：申请编号、冲突检测、状态历史、审计日志             │
│                          │                                │
│  数据访问（db.js）────────┘                                │
│  └─ node:sqlite DatabaseSync（同步 API）                   │
└───────────────────────────┬─────────────────────────────┘
                            │ 文件读写
                  ┌─────────▼─────────┐
                  │ data/observatory.db│  SQLite 单文件
                  └───────────────────┘
```

架构特点：

- **无构建步骤**：前端不经过打包，Vue 与 Chart.js 以本地化文件形式放在 `public/vendor/`，直接由浏览器加载。
- **零原生依赖**：SQLite 使用 Node 内置的 `node:sqlite` 模块，无需编译，`npm install` 仅安装纯 JS 依赖。
- **同源部署**：前后端同源，会话基于 Cookie，无需处理跨域。

## 3. 技术选型

| 层次 | 选型 | 版本 | 选型理由 |
| --- | --- | --- | --- |
| 运行时 | Node.js | 26.x（依赖内置 SQLite，建议 22.5+） | 提供稳定的内置 SQLite 支持 |
| Web 框架 | Express | ^4.19.2 | 生态成熟、中间件模型简单，适合中小型单体 |
| 会话 | express-session | ^1.18.0 | 与 Express 集成度高，Cookie 会话即可满足需求 |
| 限速 | express-rate-limit | ^8.6.2 | 纯 JS 实现，按 IP 维度限流，配置简单 |
| 数据库 | SQLite（node:sqlite） | Node 内置 | 零配置、单文件、易备份，规模匹配；免原生编译 |
| 前端框架 | Vue 3 | 3.5.13 | 声明式模板 + 响应式状态，适合表单/列表密集的管理系统 |
| 图表 | Chart.js | 4.4.7 | 轻量，覆盖环形图/柱状图/折线图需求 |
| 密码哈希 | node:crypto scrypt | Node 内置 | 抗 GPU 暴力破解，无需引入 bcrypt 等原生依赖 |

**为什么不用前端构建工具（Vite/Webpack）**：本项目页面数量与组件规模有限，采用「CDN 文件本地化 + 单文件脚本」可以做到**下载即运行、改完即生效**，省去构建与产物管理成本。若后续前端复杂度上升，可平滑迁移到 Vite + 单文件组件。

## 4. 目录结构

```text
remote-observatory/
├── server.js              # 后端入口：Express 应用、全部路由、中间件
├── db.js                  # 数据库：连接、建表、密码哈希、种子数据
├── package.json           # 依赖与启动脚本
├── data/
│   └── observatory.db     # SQLite 数据库（运行时自动创建，不入库）
├── docs/                  # 项目文档（本目录）
└── public/                # 前端静态资源
    ├── index.html         # 单页应用：模板 + 视图 + 弹窗
    ├── css/style.css      # 样式（含移动端媒体查询）
    ├── js/app.js          # Vue 应用：状态、方法、图表渲染
    └── vendor/            # 本地化的第三方库
        ├── vue.global.prod.js
        └── chart.umd.js
```

## 5. 后端设计

### 5.1 模块划分

后端刻意保持为**两个文件**，按职责而非按技术分层切分：

| 文件 | 职责 | 说明 |
| --- | --- | --- |
| `db.js` | 数据层 | 建立连接、建表（幂等）、密码哈希与校验、种子数据（管理员、默认设备），导出 `db / now / hashPassword / verifyPassword` |
| `server.js` | 应用层 | 中间件装配、全部路由、业务工具函数、静态资源、错误处理与启动 |

### 5.2 db.js 数据访问层

- **连接**：`new DatabaseSync(path)`，数据库文件位于 `data/observatory.db`，目录不存在时自动创建。
- **建表**：建表语句集中在一个字符串数组中，启动时一次性执行；全部使用 `CREATE TABLE IF NOT EXISTS`，因此**重复启动是幂等的**。
- **外键**：启动时执行 `PRAGMA foreign_keys = ON` 开启外键约束。
- **密码哈希**：`hashPassword` 生成 16 字节随机盐，使用 `scryptSync(pw, salt, 64)` 派生 64 字节摘要，以 `salt:hash` 形式存储；`verifyPassword` 重新派生后使用 `timingSafeEqual` 做常量时间比较，避免时序侧信道。
- **种子数据**（启动时执行）：
  - `seedAdmin()`：管理员不存在则创建，密码取 `ADMIN_PASSWORD` 或默认 `admin123`；**若管理员已存在且设置了 `ADMIN_PASSWORD` 且当前密码不一致，则同步更新密码**（保证环境变量始终是管理员密码的权威来源）。
  - `seedDevices()`：设备表为空时写入 4 台默认设备。

### 5.3 server.js 路由层

路由按业务域分组，共 4 组：

| 分组 | 前缀 | 说明 |
| --- | --- | --- |
| 认证 | `/api/auth/*` | 注册、登录、退出、当前用户、修改密码 |
| 设备 | `/api/devices`、`/api/admin/devices*` | 设备查询（公开）与设备维护（管理员） |
| 申请 | `/api/applications*` | 冲突预检、提交、我的申请、详情、撤回 |
| 管理 | `/api/admin/*` | 申请列表、待审批、日历、审批、统计、导出、审计 |

完整的接口清单见 [API.md](./API.md)。

静态资源与兜底：

```js
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
```

即：静态文件优先命中；其余 GET 请求一律回落到 `index.html`（支持前端刷新任意路径）；但未知的 `/api/*` 返回 JSON 404 而非 HTML，避免前端解析错误。

### 5.4 中间件

| 中间件 | 作用 | 行为 |
| --- | --- | --- |
| `express.json({ limit: '1mb' })` | 解析 JSON 请求体 | 限制报文体积，降低滥用风险 |
| `session(...)` | Cookie 会话 | `httpOnly`、`sameSite` 可配、`secure` 可配、有效期 1 天、`resave:false`、`saveUninitialized:false` |
| `requireAuth` | 登录校验 | 未登录返回 401 |
| `requireAdmin` | 角色校验 | 未登录 401；非管理员 403 |
| `authLimiter` | 认证接口限速 | 15 分钟 20 次，超限 429 |

会话密钥策略：优先使用环境变量 `SESSION_SECRET`；未设置时启动生成 32 字节随机密钥并打印警告。这样既避免把密钥硬编码进代码仓库，又保证本地开发开箱可用（代价是重启后旧会话失效）。

### 5.5 核心工具函数

| 函数 | 职责 |
| --- | --- |
| `genAppNo()` | 生成申请编号 |
| `findConflicts(device, start, end, excludeId)` | 冲突检测，支持排除自身 |
| `addHistory(...)` | 追加一条状态历史 |
| `addAudit(user, action, detail)` | 追加一条审计日志 |

#### 统一数据投影

为避免在每个查询里重复书写字段与关联，定义了共享的投影片段：

```js
const APP_COLS = [
  'a.id', 'a.app_no', 'a.user_id', 'a.applicant_name', 'a.applicant_contact',
  'a.device', 'a.start_time', 'a.end_time', 'a.target', 'a.purpose', 'a.status',
  'a.created_at', 'a.reviewed_at', 'a.reviewed_by', 'a.review_comment',
  'r.name AS reviewer_name', 'u.username AS applicant_username'
].join(', ');
const APP_FROM = 'FROM applications a LEFT JOIN users r ON a.reviewed_by = r.id LEFT JOIN users u ON a.user_id = u.id';
```

所有申请查询都以 `SELECT + APP_COLS + ' ' + APP_FROM` 组装，从而**统一携带审批人姓名与申请人账号**，前端无需二次请求。

## 6. 前端设计

### 6.1 单页应用结构

前端为**一个 Vue 根实例 + 模板内联在 index.html**：

- `index.html`：页面骨架、全部视图模板（`section`）、三个弹窗、Toast 容器
- `js/app.js`：Vue 应用定义（data / computed / methods / mounted）与 `fetch` 封装
- `css/style.css`：主题变量、组件样式、移动端媒体查询

选择「模板写在 HTML 中」而非「模板字符串写在 JS 中」，是为了让页面结构保持可读、便于直接改样式与文案。

### 6.2 状态（data）

Vue 实例状态按业务域分组：

| 分组 | 字段 |
| --- | --- |
| 用户与认证 | `user`、`authMode`、`loginForm`、`registerForm`、`authError`、`authLoading` |
| 导航 | `currentView`、`devices` |
| 申请表单 | `form`、`formError`、`submitting`、`conflicts`、`conflictTimer` |
| 列表数据 | `mineList`、`pendingList`、`allList`、`allTotal`、`allPage`、`allPageSize`、`allFilter` |
| 日历与统计 | `calendarSlots`、`stats`、`charts` |
| 弹窗 | `detailApp`、`detailHistory`、`reviewApp`、`showPwdModal`、`pwdForm`、`pwdError`、`pwdSubmitting` |
| 审计与设备管理 | `auditLogs`、`newDeviceName`、`editName`、`editingId`、`addingDevice`、`deviceError` |
| 全局反馈 | `toast` |

计算属性：`minDateTime`（时间选择器最小值，禁止选过去）、`totalPages`（分页总页数）。

### 6.3 视图路由

项目未引入 vue-router，而是用 `currentView` + `v-if / v-else-if` 实现轻量视图切换。切换时由 `go(view)` 顺带触发数据加载：

```js
go: function (view) {
  this.currentView = view;
  if (view === 'mine') this.loadMine();
  else if (view === 'pending') this.loadPending();
  else if (view === 'all') this.loadAll();
  else if (view === 'calendar') this.loadCalendar();
  else if (view === 'stats') { const self = this; this.loadStats().then(function () { self.renderCharts(); }); }
  else if (view === 'audit') this.loadAudit();
  else if (view === 'devices') this.loadDevices();
},
```

视图与角色的对应关系：

| 角色 | 视图 |
| --- | --- |
| 普通用户 | `submit`、`mine` |
| 管理员 | `pending`、`all`、`calendar`、`stats`、`audit`、`devices` |

### 6.4 方法清单

| 类别 | 方法 |
| --- | --- |
| 格式化 | `fmtDateTime`、`statusLabel`、`actionLabel`、`auditActionLabel` |
| 反馈 | `showToast` |
| 认证 | `checkMe`、`switchAuth`、`login`、`register`、`logout`、`openPwdModal`、`closePwdModal`、`changePassword` |
| 导航与设备 | `go`、`loadDevices` |
| 申请表单 | `checkConflictNow`、`checkConflict`、`resetForm`、`submitApplication` |
| 用户列表 | `loadMine`、`withdraw`、`openDetail` |
| 管理列表 | `loadPending`、`loadAll`、`resetAllPage`、`changePage`、`loadCalendar`、`slotsForDevice` |
| 审批 | `openReview`、`loadReviewConflicts`、`closeReview`、`doReview` |
| 统计与导出 | `loadStats`、`renderCharts`、`exportCsv` |
| 审计与设备管理 | `loadAudit`、`addDevice`、`startRename`、`cancelEdit`、`saveRename`、`deleteDevice` |

生命周期：`mounted` 调用 `checkMe()`，用于刷新页面后恢复登录态。

### 6.5 弹窗与反馈

| 弹窗 | 触发 | 内容 |
| --- | --- | --- |
| 详情弹窗 | 列表「详情」按钮 | 申请全字段 + 状态变更时间线 |
| 审批弹窗 | 待审批「同意 / 不同意」 | 申请摘要、冲突警告与「强制通过」勾选、审批意见 |
| 修改密码弹窗 | 顶栏「修改密码」（仅普通用户） | 当前密码 / 新密码 / 确认新密码 |

反馈采用 **Toast**：`showToast(message, type)` 以 3 秒自动消失的浮层提示，成功 / 失败 / 提示三种配色。删除类操作额外使用浏览器原生 `confirm` 二次确认。

### 6.6 图表

统计视图渲染 3 张 Chart.js 图表，均使用深色主题配色：

| 图表 | 类型 | 数据 |
| --- | --- | --- |
| 状态分布 | 环形图（doughnut） | 待审批 / 已通过 / 未通过 / 已撤回数量 |
| 各设备申请量 | 柱状图（bar） | 按设备的申请计数 |
| 月度申请趋势 | 折线图（line，带填充） | 按月的申请计数 |

实现要点：图表实例保存在 `charts` 对象中，重绘前先 `destroy()` 旧实例，避免重复渲染导致内存泄漏与画布叠加。渲染时机为 `loadStats()` 完成后在 `$nextTick` 中执行，确保 `v-if` 已把 canvas 挂载到 DOM。

### 6.7 响应式断点

| 断点 | 主要调整 |
| --- | --- |
| 默认（≥ 721px） | 桌面布局：双列表单、多列统计卡、宽表格 |
| ≤ 720px | 表单 / 详情 / 图表单列；表格改为横向滑动（`display:block + overflow-x:auto`）；导航横向滑动；输入框字号 16px（避免 iOS 聚焦自动缩放）；弹窗近全宽 |
| ≤ 480px | 隐藏顶栏用户名、统计卡两列、工具栏控件整行 |

## 7. 关键流程

### 7.1 注册 / 登录与防会话固定

```text
客户端                    服务端
  │  POST /api/auth/login   │
  ├────────────────────────►│
  │                         │ 1. authLimiter 限速校验
  │                         │ 2. 查询用户 + verifyPassword（常量时间比较）
  │                         │ 3. session.regenerate()  ← 重建会话 ID
  │                         │ 4. 写入 session.user
  │                         │ 5. 记录审计日志（login）
  │◄────────────────────────┤ 200 { user }
  │  Set-Cookie: 新的会话 ID │
```

**为什么必须 regenerate**：若沿用登录前的会话 ID，攻击者可预先诱导受害者使用一个已知会话 ID，待其登录后直接复用该 ID 劫持会话（会话固定攻击）。登录 / 注册成功后重建会话 ID 可消除该风险。

### 7.2 提交申请与冲突检测

冲突检测经历**两次**：前端预检（体验）+ 服务端强校验（正确性）。

```text
用户选择设备与时段
   │
   ├─ 前端 debounce 300ms 调用 GET /api/applications/conflicts
   │     └─ 有冲突 → 展示占用明细 + 禁用提交按钮
   │
   └─ 提交 POST /api/applications
         ├─ 字段校验（设备有效 / 时间合法 / 必填）
         ├─ 服务端 findConflicts 再次检测
         │     └─ 有冲突 → 409 + 冲突明细（不落库）
         ├─ genAppNo() 生成编号
         ├─ INSERT applications（状态 pending）
         ├─ addHistory(submit)
         └─ addAudit(submit_application)
```

时间校验规则：结束时间必须晚于开始时间、开始时间不得早于当前时间（比较到分钟）。

### 7.3 审批与强制通过

```text
管理员点击同意/不同意
   │
   ├─ 校验：申请存在 → 状态为 pending → 不同意时意见必填
   │
   ├─ 若为「同意」：findConflicts(..., excludeId=本申请)
   │     └─ 存在冲突且未勾选「强制通过」 → 409 + 冲突明细
   │
   ├─ UPDATE applications
   │     status = approved/rejected
   │     reviewed_at = 当前时间
   │     reviewed_by = 管理员 ID
   │     review_comment = 审批意见
   ├─ addHistory(pending → approved/rejected)
   └─ addAudit(approve_application / reject_application)
```

审批前的二次冲突检测是**防御性设计**：正常情况下待审批申请之间不会互相冲突（提交时已拦截），但强制通过、并发提交或历史数据导入等场景仍可能产生重叠，因此审批作为最后一道闸门再次校验，并把决定权显式交还给管理员。

### 7.4 设备重命名级联

`applications.device` 存储的是设备**名称**而非外键 ID。这是一个有意的反规范化选择：历史申请即使设备被改名，也应保留当时可读的设备名。由此带来的约束是——重命名必须级联更新历史数据，否则统计与日历会因名称不一致而丢数据。

```js
// 先改历史申请，再改设备表，两步在同一请求内完成
db.prepare('UPDATE applications SET device = ? WHERE device = ?').run(name, row.name);
db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id);
```

删除设备时则反向保护：若仍有申请引用该设备名，则拒绝删除并提示引用条数，避免历史数据成为「孤儿」。

## 8. 核心算法与约定

### 8.1 申请编号生成

格式：`TEL-<年份>-<4 位序号>`，例如 `TEL-2026-0001`。

```js
const row = db.prepare('SELECT COUNT(*) AS c FROM applications WHERE app_no LIKE ?').get('TEL-' + year + '-%');
const seq = (row ? row.c : 0) + 1;   // 同年已有数量 + 1
return 'TEL-' + year + '-' + String(seq).padStart(4, '0');
```

说明：编号按自然年重新计数；`app_no` 上有唯一约束，可作为编号冲突的最终兜底。单进程同步写库的场景下，计数法不产生竞态。

### 8.2 时间表示与比较

系统内存在**两种时间字符串**，用途不同：

| 字段 | 格式 | 示例 | 说明 |
| --- | --- | --- | --- |
| `start_time` / `end_time` | `YYYY-MM-DDTHH:mm` | `2027-03-20T22:00` | 直接来自 HTML `datetime-local` 控件，按用户本地时间理解 |
| `created_at` / `reviewed_at` | ISO 8601 UTC | `2026-08-25T08:13:07.459Z` | 服务端 `now()` 生成，用于审计与排序 |

关键设计：ISO 风格的时间字符串，其**字典序与时间先后顺序一致**。因此冲突检测、区间比较、排序都可以直接用字符串比较完成，无需解析为 Date 对象，既简洁又避免了时区换算带来的歧义。

### 8.3 冲突判定

```js
SELECT id, app_no, start_time, end_time, status FROM applications
WHERE device = ?
  AND status IN ('pending','approved')
  AND start_time < ?   -- 传入本申请的结束时间
  AND end_time   > ?   -- 传入本申请的开始时间
ORDER BY start_time
```

判定语义为**半开区间重叠**：两个区间 `[s1, e1)` 与 `[s2, e2)` 重叠当且仅当 `s1 < e2` 且 `s2 < e1`。

由此得出两个业务结论：

1. **首尾相接不算冲突**：前一场 22:00-24:00 与后一场 24:00-02:00 可以同时存在。
2. **只有「待审批」与「已通过」占用时段**：已撤回、未通过的申请不占用设备时间。

### 8.4 CSV 导出

导出实现关注三件事：

1. **中文编码**：输出前置 UTF-8 BOM（`\uFEFF`），保证 Excel / WPS 双击打开不乱码。
2. **标准转义**：字段含逗号、引号或换行时，用双引号包裹并把内部引号翻倍（RFC 4180）。
3. **公式注入防护**：若字段以 `=`、`+`、`-`、`@` 或制表符 / 回车开头，前置一个单引号，使其在表格软件中被当作纯文本而非公式执行。

```js
const esc = function (v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // 公式注入防护
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';  // RFC 4180 转义
  return s;
};
```

行分隔符使用 `\r\n`，兼容各版本 Excel。

## 9. 安全设计

| 风险 | 现有措施 | 说明 |
| --- | --- | --- |
| SQL 注入 | 全参数化查询 | 所有 SQL 均使用 `prepare() + ?` 占位符；动态拼接部分只拼固定常量片段，用户输入一律走参数绑定 |
| 密码泄露 | scrypt + 随机盐 + 常量时间比较 | 数据库不存明文；即使库文件泄露也难以离线爆破 |
| 暴力破解 | 认证接口限速 | 登录 / 注册 / 改密 15 分钟 20 次，按 IP 计数 |
| 会话固定 | 登录 / 注册后 regenerate | 重建会话 ID，使旧 ID 失效 |
| 会话窃取 | httpOnly Cookie | 禁止 JS 读取 Cookie，降低 XSS 窃取会话的可能 |
| CSRF | sameSite Cookie | 默认 `lax`，阻断跨站 POST 携带 Cookie；可切 `strict` |
| 传输窃听 | Cookie `secure` 开关 | 生产环境设置 `COOKIE_SECURE=true` 并启用 HTTPS |
| XSS | Vue 模板插值 | 全站使用 `{{ }}{F} 插值，Vue 自动转义；未使用 `v-html``` |
| CSV 公式注入 | 危险首字符前缀转义 | 见 8.4 |
| 越权访问 | 中间件 + 资源属主校验 | 管理员接口统一 `requireAdmin`；申请详情校验属主或管理员 |
| 凭据硬编码 | 环境变量注入 | `SESSION_SECRET`、`ADMIN_PASSWORD` 均可由环境变量提供，未设置时给出明确警告 |
| 信息泄露 | 统一错误文案 | 登录失败不区分「用户不存在」与「密码错误」；500 响应不返回堆栈 |

**尚未实施、生产环境建议补充**（详见 [DEPLOYMENT.md](./DEPLOYMENT.md)）：

1. 全站 HTTPS 与 HSTS。
2. 安全响应头（helmet：CSP、X-Frame-Options、X-Content-Type-Options）。
3. 会话持久化存储（当前为进程内存，重启即失效且不支持多进程）。
4. CSRF Token 作为 sameSite 之外的第二道防线。
5. 登录失败审计与异常频率告警。

## 10. 已知限制与演进方向

| 限制 | 影响 | 演进方向 |
| --- | --- | --- |
| 会话存于进程内存 | 重启后需重新登录；无法水平扩容 | 引入 SQLite / Redis 会话存储 |
| 冲突检测为串行逻辑 | 极高并发下理论上存在竞态窗口 | 为设备 + 时段建立唯一约束或使用事务加锁 |
| 时间无时区信息 | 跨时区使用需自行约定 | 统一存 UTC 并显式标注时区 |
| 审计日志无分页 | 仅展示最近 200 条 | 增加时间范围筛选与分页 |
| 单进程、无任务队列 | 无法承载大规模并发 | 引入进程管理器与只读副本 |
| 无通知能力 | 用户需主动查看结果 | 接入邮件 / 站内信 |
