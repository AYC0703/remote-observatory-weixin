# 微信小程序改造设计

## 1. 文档信息

| 项 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 对应代码版本 | 1.0.0 |
| 改造起点 | 网页版 v1.0.0（Vue 3 单页应用 + Express API） |
| 目标形态 | 微信小程序 + Express API |

## 2. 改造目标与范围

将网页版前端由 Vue 3 单页应用改写为微信小程序，**完整保留业务语义与后端接口契约**：

- 双角色（普通用户 / 管理员）账号体系与权限隔离；
- 申请提交、实时冲突检测、撤回、状态时间线；
- 管理员待审批队列、审批（拒绝必填意见）、冲突检测与强制通过；
- 全部申请筛选 / 搜索 / 分页、设备时段日历；
- 设备管理（新增 / 重命名级联 / 删除保护）；
- 统计分析（状态数量、通过率、环形图 / 柱状图 / 折线图）与 CSV 导出；
- 审计日志。

不在本次改造范围：业务规则、数据库表结构（新增一张会话表除外）、接口路径与错误码。

## 3. 总体架构

```text
┌──────────────────────────────────────────────┐
│              微信小程序（miniprogram/）          │
│  pages/*  WXML + WXSS + JS                    │
│  utils/request.js  →  Authorization: Bearer   │
│  components/mini-chart  →  Canvas 2D 图表      │
└───────────────────────┬──────────────────────┘
                        │ HTTPS / JSON
┌───────────────────────▼──────────────────────┐
│            Node.js + Express（server/）         │
│  同一套 REST API                                │
│  attachUser：Bearer Token 或 Cookie             │
│  sessions 表：token → user，有效期 1 天          │
└───────────────────────┬──────────────────────┘
                        │ node:sqlite（同步 API）
                server/data/observatory.db
```

架构特点：

- **同一后端**：小程序与网页端共用同一套 API，仅鉴权方式扩展了 Bearer Token；
- **零第三方 UI / 图表依赖**：小程序端不引入任何 npm 包，图表自研，避免包体积与兼容问题；
- **零构建**：小程序原生工程，导入开发者工具即可编译。

## 4. 目录结构

```text
miniprogram/
├── app.js / app.json / app.wxss     # 应用入口、页面与 tabBar、全局主题
├── config.js                        # 后端 baseUrl / 超时 / 版本
├── sitemap.json
├── utils/
│   ├── request.js                   # wx.request 封装：Token、401 处理、错误归一
│   ├── api.js                       # 全部接口方法
│   ├── util.js                      # 状态/动作文案、时间格式化、Toast、装饰器
│   └── chart.js                     # Canvas 2D 绘图原语（环形/柱状/折线）
├── components/mini-chart/           # 图表组件（properties: type / chartData / height）
└── pages/
    ├── login/ register/             # 认证
    ├── home/ profile/               # tabBar 页面
    ├── submit/ mine/ detail/        # 普通用户
    ├── pending/ review/ all/ calendar/  # 管理员
    └── stats/ audit/ devices/       # 统计 / 审计 / 设备
```

## 5. 页面映射（Web 视图 → 小程序页面）

| 网页版视图 / 弹窗 | 小程序页面 | 说明 |
| --- | --- | --- |
| 登录 / 注册（同页切换） | `pages/login/login`、`pages/register/register` | 拆为两个页面，注册成功自动登录 |
| 提交申请 `submit` | `pages/submit/submit` | 设备 picker、日期 + 时间 picker、实时冲突预检 |
| 我的申请 `mine` | `pages/mine/mine` | 列表 + 撤回；下拉刷新 |
| 详情弹窗 | `pages/detail/detail` | 全字段 + 状态时间线 |
| 修改密码弹窗 | `pages/profile/profile` 内弹层 | 保留弹窗交互 |
| 待审批 `pending` | `pages/pending/pending` | 升序队列 |
| 审批弹窗 | `pages/review/review` | 冲突提示 + 强制通过开关 + 审批意见 |
| 全部申请 `all` | `pages/all/all` | 状态筛选 + 搜索 + 上一页/下一页 |
| 时段日历 `calendar` | `pages/calendar/calendar` | 按设备分组的占用时段 |
| 统计分析 `stats` | `pages/stats/stats` | 指标卡 + 三张图表 + 导出 |
| 审计日志 `audit` | `pages/audit/audit` | 最近 200 条 |
| 设备管理 `devices` | `pages/devices/devices` | 新增 / 重命名 / 删除 |
| 顶栏导航 | `pages/home/home` + tabBar | 按角色渲染功能卡片 |

小程序的静态 tabBar 无法按角色动态增删，因此采用「首页功能卡片 + 两个固定 tab（首页 / 我的）」的方式实现角色化入口：普通用户只有「提交申请 / 我的申请」，管理员只有六个管理入口，页面内部再做一次角色守卫。

## 6. 鉴权改造

网页版使用 `express-session` 的 Cookie 会话（`observatory.sid`）。小程序的 `wx.request` 对 Set-Cookie 的持久化并不可靠，因此改用 **Bearer Token**：

1. 新增数据表 `sessions`：

   ```sql
   CREATE TABLE IF NOT EXISTS sessions (
     token      TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL
   );
   ```

2. 登录 / 注册成功时：写入会话记录，响应体新增 `token` 字段，同时仍 `Set-Cookie` 以兼容网页端；
3. `attachUser` 中间件同时接受 `Authorization: Bearer <token>` 与 Cookie，二者任一有效即视为已登录；
4. 退出登录删除该 token（并清除 Cookie）；启动时清理过期会话；
5. 小程序端把 token 存入 `wx.setStorageSync('token')`，`request.js` 自动附带；收到 401 时清除本地会话并 `reLaunch` 到登录页。

安全性沿用网页版设计：scrypt + 随机盐 + 常量时间比较、统一登录失败文案、认证接口限速（15 分钟 20 次，共享窗口）。

## 7. 请求封装与错误处理

`utils/request.js` 统一处理：

- 自动注入 `Authorization` 头与 JSON Content-Type；
- 2xx 解析 `res.data` 并 resolve；非 2xx 抛出带 `statusCode` 与 `data` 的 Error，便于页面读取 `conflicts`；
- 401 且非登录相关接口：清会话 + 提示 + 跳登录；
- 网络失败给出「请确认后端服务已启动且域名已配置」的中文提示。

`utils/api.js` 集中声明全部接口，便于与 `docs/API.md` 对照，也便于自动化校验（见第 11 节）。

## 8. 图表方案

网页版使用 Chart.js，其依赖 DOM/Canvas，无法在小程序中运行。因此自研轻量图表：

| 图表 | 类型 | 数据来源 |
| --- | --- | --- |
| 状态分布 | 环形图 doughnut | `/api/admin/stats` 的 `counts` |
| 各设备申请量 | 柱状图 bar | `byDevice` |
| 月度申请趋势 | 折线图 line | `byMonthRaw` |

实现要点（`components/mini-chart` + `utils/chart.js`）：

- 使用 `<canvas type="2d">` 与 `wx.createSelectorQuery().fields({node:true,size:true})` 获取 Canvas 节点；
- 按设备像素比 `pixelRatio` 放大画布并 `ctx.scale`，避免高清屏模糊；
- 组件 `properties.chartData` 的 `observer` 触发重绘，配合 `setTimeout` 去抖，避免频繁重绘；
- 每次绘制先 `clearRect`，杜绝图表叠加；
- 无数据时绘制「暂无数据」占位。

## 9. CSV 导出方案

小程序无法像浏览器一样直接「下载」文件，且 `wx.openDocument` 不支持 CSV。改造方案：

1. **后端接口保持不变**：`GET /api/admin/export.csv` 仍输出 UTF-8 BOM、CRLF、RFC 4180 转义与公式注入防护；
2. **小程序侧**：以 `dataType: 'text'` 请求该接口取回 CSV 文本 → `wx.getFileSystemManager().writeFile` 写入 `wx.env.USER_DATA_PATH` → 通过 `wx.showModal` 让用户选择：
   - **转发文件**：调用 `wx.shareFileMessage` 转发到聊天（可在电脑端打开）；
   - **复制内容**：调用 `wx.setClipboardData` 复制，用户粘贴保存为 .csv 文件。

## 10. 交互与体验差异

| 项 | 网页版 | 小程序版 |
| --- | --- | --- |
| 二次确认 | `window.confirm` | `wx.showModal` |
| 轻提示 | 自定义 Toast | `wx.showToast` |
| 刷新 | 手动刷新 / 重新请求 | 下拉刷新（`enablePullDownRefresh`） |
| 分页 | 页码按钮 | 上一页 / 下一页 |
| 状态色 | CSS 类 | 全局 `tag-*` 类 + 状态色常量 |
| 尺寸单位 | px / 媒体查询 | `rpx`，天然适配 |

审批冲突采用**双重校验**：小程序先拉取 `/api/admin/calendar` 在本地预判并提示，服务端在审批时再次强制校验，若返回 409 则展示冲突明细并要求开启「强制通过」。

## 11. 校验与测试

### 11.1 小程序结构校验

`scripts/validate-miniprogram.mjs` 自动检查：

- `app.json` 中每个页面的 `js/json/wxml` 文件是否齐全；
- tabBar 页面是否已注册；
- `usingComponents` 组件路径是否存在；
- 每个 WXML 标签是否配平（自动忽略 `{{ }}` 内的比较符号）；
- WXML 中绑定的事件处理函数是否在同名 JS 中定义；
- 页面跳转目标是否已在 `app.json` 注册；
- `utils/api.js` 调用的每个接口是否都能在后端 `server.js` 中找到对应路由。

### 11.2 后端接口测试

`server/test/e2e.mjs` 覆盖 72 项断言：认证、权限隔离、申请与冲突、撤回、审批与留痕、筛选搜索分页、日历、统计与通过率、CSV（BOM / 表头 / 公式注入）、审计、设备管理、修改密码、未知接口、认证限速。

### 11.3 执行结果

| 校验 | 命令 | 结果 |
| --- | --- | --- |
| 小程序结构 | `npm run validate` | 0 错误 0 警告 |
| 后端接口 | `npm run test:server` | 72 通过 0 失败 |

## 12. 已知限制与后续方向

| 限制 | 说明 | 方向 |
| --- | --- | --- |
| 登录方式 | 仍为账号密码，未接入 `wx.login` / openid | 可增加微信一键登录并绑定账号 |
| 消息通知 | 状态变更需用户主动查看 | 可接入微信订阅消息推送审批结果 |
| 导出体验 | 依赖转发 / 剪贴板，非直接下载 | 可提供短链 H5 下载页 |
| 会话存储 | token 存于 SQLite，适合单机 | 多实例可换 Redis 或增加水平扩展方案 |
| 图表能力 | 仅实现三种基础图表 | 可按需扩展时间轴、堆叠图等 |
| 自动化 UI 测试 | 结构校验 + 人工真机验收 | 可接入小程序自动化测试框架 |
