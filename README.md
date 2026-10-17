# 远程天文台使用申请审批及统计系统（微信小程序版）

本项目是「远程天文台使用申请审批及统计系统」的**微信小程序实现**：在保留原网页版全部业务能力的基础上，将前端由 Vue 3 单页应用改写为原生微信小程序，并配套 Node.js + SQLite 后端 API。

> 原网页版功能与设计见 `docs/` 目录下的产品、技术、数据库、接口、部署与测试文档。本版本在其基础上做了小程序化改造，改造要点见 `docs/MINIPROGRAM_DESIGN.md`。

> **仓库**：<https://github.com/AYC0703/remote-observatory-weixin>（公开）
>
> 🔒 **本仓库为匿名化公开版**：人名、校名、楼名均已替换为占位符（如「学生 A」「指导教师 A」
> 「某中学」「教学楼」）；含真实姓名的立项书 PDF 原件未予收录。
> 替换范围与还原方式见 [`docs/ANONYMIZATION.md`](docs/ANONYMIZATION.md)，协作规范见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 功能一览

| 角色 | 功能 |
| --- | --- |
| 未登录 | 注册（自动登录）、账号密码登录 |
| 普通用户 | 提交观测申请（设备、跨日时段、目标、目的、申请人信息）、实时冲突检测、我的申请、状态时间线、撤回待审批申请、修改密码、**在获批时段内远程开合顶盖** |
| 管理员 | 待审批队列（按提交时间升序）、同意 / 不同意（拒绝必填意见）、审批冲突检测与强制通过、全部申请筛选 / 搜索 / 分页、设备时段日历、设备管理（增删改 + 重命名级联）、统计图表、CSV 导出、审计日志、**观测站远程控制接入管理** |
| 通用 | 按角色渲染入口，权限以后端校验为准（401 / 403） |
| 硬件（ESP32） | 主动长轮询取指令、上报顶盖位置与环境数据、回执执行结果；本地雨感硬逻辑、限位、过流与防夹保护 |

## 观测站远程控制

系统可为指定的观测设备接入 **ESP32 顶盖控制器**，用户在**本人已批准的申请时段内**即可在微信小程序中远程开合顶盖。

| 设计原则 | 说明 |
| --- | --- |
| 开门要权限，关门要自由 | 开盖受审批时段约束；关盖是安全方向操作，任何登录用户随时可执行 |
| 失效即安全 | 限位常闭接法、断线停机、控制器掉线保持位置 |
| 失联不关门 | 通信中断时绝不自动关盖（避免毁掉整晚曝光），只告警 |
| 降雨兜底 | 雨感走设备本地硬逻辑，不依赖网络与服务器 |
| 零新增依赖 | 设备主动 HTTP 长轮询，不需要 MQTT broker、公网 IP 或端口映射 |

- 通信协议、权限矩阵、指令生命周期详见 [`docs/HARDWARE_DESIGN.md`](docs/HARDWARE_DESIGN.md)
- 接线表、标定步骤、烧录方法详见 [`firmware/cover-controller/README.md`](firmware/cover-controller/README.md)

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 小程序 | 原生 WXML / WXSS / JS | 无第三方 UI 库、无第三方图表库 |
| 图表 | 自研 Canvas 2D 组件 `components/mini-chart` | 环形图 / 柱状图 / 折线图 |
| 后端 | Node.js + Express | 复用原 REST API 设计 |
| 数据库 | SQLite（Node 内置 `node:sqlite`） | 零原生依赖，单文件，易备份 |
| 鉴权 | Bearer Token（兼容 Cookie）+ scrypt 哈希 | 小程序用 Token，网页端仍可用 Cookie |
| 硬件 | ESP32 + Arduino 框架 | 主动 HTTP 长轮询，无需 MQTT broker 或公网 IP |

## 目录结构

```
remote-observatory-weixin/
├── project.config.json        # 微信开发者工具项目配置（miniprogramRoot = miniprogram/）
├── package.json               # 根级快捷脚本（启动 / 测试 / 校验）
├── README.md
├── docs/                      # 项目文档（PRD / 技术设计 / 数据库 / API / 部署 / 测试 / 小程序改造 / 硬件接入）
├── firmware/
│   └── cover-controller/      # ESP32 顶盖控制器固件
│       ├── cover-controller.ino
│       ├── config.example.h   # 复制为 config.h 后填写 Wi-Fi 与设备令牌
│       ├── platformio.ini
│       └── README.md          # 接线表 / 标定步骤 / 烧录方法
├── scripts/
│   └── validate-miniprogram.mjs   # 小程序结构与接口一致性校验
├── server/                    # 后端 API
│   ├── server.js              # Express 应用、全部路由与中间件
│   ├── db.js                  # 建表、密码哈希、种子数据
│   ├── hardware.js            # 顶盖控制桥接层：安全联锁 / 指令队列 / 长轮询 / 自动关盖
│   ├── package.json
│   ├── test/e2e.mjs           # 112 项接口端到端测试
│   └── data/                  # SQLite 数据库（运行时生成，不入库）
└── miniprogram/               # 微信小程序
    ├── app.js / app.json / app.wxss
    ├── config.js              # 后端 baseUrl 配置
    ├── sitemap.json
    ├── utils/                 # request / api / util / chart
    ├── components/mini-chart/ # 自研 Canvas 2D 图表组件
    └── pages/                 # 15 个页面
        ├── login/ register/ home/ profile/
        ├── submit/ mine/ detail/
        ├── pending/ review/ all/ calendar/
        ├── stats/ audit/ devices/
        └── console/           # 观测站控制台（含接入管理）
```

## 快速开始

### 0. 获取代码

```bash
git clone https://github.com/AYC0703/remote-observatory-weixin.git
cd remote-observatory-weixin
```

> 公开仓库，可直接克隆。提交代码需要仓库写权限。

### 1. 启动后端

```bash
cd server
npm install --cache ./.npm-cache   # 全局 npm 缓存不可写时使用项目内缓存
npm start
```

启动后监听 `http://localhost:3000`，首次启动会自动建库并写入管理员与默认设备。

### 2. 用微信开发者工具导入小程序

1. 打开「微信开发者工具」→ **导入项目**；
2. 项目目录选择本仓库**根目录**（即包含 `project.config.json` 的目录）；
3. AppID 可用「测试号」，或把 `project.config.json` 中的 `appid` 换成你自己的小程序 AppID；
4. 进入「详情 → 本地设置」，勾选 **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**；
5. 点击编译，即可在模拟器中完成「注册 → 提交申请 → 查看状态」全流程。

### 3. 演示账号

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 管理员 | admin | admin123（可用环境变量 `ADMIN_PASSWORD` 覆盖） |
| 普通用户 | alice | 123456 |

也可以在登录页进入「立即注册」自助创建普通用户。

## 配置后端地址

编辑 `miniprogram/config.js`：

```js
module.exports = {
  baseUrl: 'http://127.0.0.1:3000',  // 开发者工具（本机后端）
  timeout: 15000,
  version: '1.1.0'
};
```

- **开发者工具**：保持 `http://127.0.0.1:3000` 即可；
- **真机预览**：改为电脑的局域网地址，例如 `http://192.168.1.10:3000`，并确保手机与电脑同一网段；
- **正式发布**：必须使用 `https://` 域名，并在「小程序后台 → 开发管理 → 服务器域名 → request 合法域名」中登记该域名。

## 接入 ESP32 顶盖控制器

```bash
# 1. 后端启动后，用管理员账号登录小程序 → 「观测站控制」
# 2. 在「接入管理」中选择设备，生成并复制设备令牌（形如 cov_xxxxxxxx，仅显示一次）

# 3. 配置并烧录固件
cd firmware/cover-controller
cp config.example.h config.h
#    编辑 config.h：WIFI_SSID / WIFI_PASS / BASE / DEVICE_TOKEN
pio run -t upload && pio device monitor
```

烧录后设备会主动长轮询后端，串口应与小程序中的在线状态同步。完整接线表、标定步骤与安全注意事项见 [`firmware/cover-controller/README.md`](firmware/cover-controller/README.md)。

> ⚠️ 顶盖是会夹伤人、会被雨淋坏设备的机械结构。**上电前请务必读完硬件文档中的安全设计章节**：限位开关必须常闭接法、必须有机械硬限位、雨感必须走本地硬逻辑、必须有急停按钮与手动应急方式。

## 测试与校验

```bash
npm run validate        # 小程序结构校验：页面文件、tabBar、组件路径、WXML 配平、事件处理函数、跳转目标、接口一致性
npm run test:server     # 后端 112 项接口端到端测试（含权限、冲突、统计、导出、限速、顶盖联锁与长轮询）
npm run check           # 依次执行以上两项
```

## 设计文档

| 文档 | 内容 |
| --- | --- |
| `docs/MINIPROGRAM_DESIGN.md` | **微信小程序改造设计**：架构、页面映射、鉴权、图表与导出方案 |
| `docs/HARDWARE_DESIGN.md` | **观测站顶盖远程控制**：架构、安全联锁、通信协议、指令生命周期、自动策略、配置项 |
| `docs/PRD.md` | 产品需求文档 |
| `docs/TECH_DESIGN.md` | 技术架构与关键流程 |
| `docs/DATABASE_DESIGN.md` | 数据模型与表结构 |
| `docs/API.md` | REST API 接口清单 |
| `docs/DEPLOYMENT.md` | 部署运维手册 |
| `docs/TESTING.md` | 测试与验收文档 |
| `docs/CHANGELOG.md` | 变更记录 |

> S50 校园智能天文台（立项材料）相关的转写稿、审阅问题清单与附件索引，见 [`docs/README.md`](docs/README.md) 的「S50 校园智能天文台」小节。

## 与原网页版的主要差异

| 维度 | 网页版 | 小程序版 |
| --- | --- | --- |
| 页面载体 | Vue 3 单页应用（`index.html` + `app.js`） | 15 个原生小程序页面，`wx.navigateTo` 跳转 |
| 布局 | 顶栏 + 视图切换 | 底部 tabBar（首页 / 我的）+ 功能卡片入口 |
| 鉴权 | Cookie 会话（`observatory.sid`） | Bearer Token（新增 `sessions` 表），同时兼容 Cookie |
| 图表 | Chart.js | 自研 Canvas 2D 组件（无 DOM 依赖） |
| 反馈 | 自定义 Toast / `confirm` | `wx.showToast` / `wx.showModal` |
| 导出 | 浏览器直接下载 CSV | 写入本地文件后转发或复制内容（后端接口不变） |
| 移动端适配 | CSS 媒体查询 | 天然移动端，使用 `rpx` 单位 |
