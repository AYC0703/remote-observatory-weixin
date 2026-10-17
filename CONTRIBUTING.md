# 协作与提交规范

本文件适用于「远程天文台使用申请审批及统计系统（微信小程序版）」仓库。

> **仓库**：<https://github.com/AYC0703/remote-observatory-weixin>（公开）
> **默认分支**：`main`

---

## 1. 环境要求

| 项 | 版本 / 说明 |
| --- | --- |
| Node.js | **≥ 22.5.0**（后端使用内置 `node:sqlite`，低版本会直接报错） |
| npm | 随 Node 附带 |
| 微信开发者工具 | 稳定版即可，AppID 可用测试号 |
| PlatformIO | 仅改 ESP32 固件时需要 |

验证：`node -v` 应输出 `v22.5.0` 或更高。

---

## 2. 本地开发

```bash
git clone https://github.com/AYC0703/remote-observatory-weixin.git
cd remote-observatory-weixin

# 后端
cd server
npm install --cache ./.npm-cache    # 全局 npm 缓存不可写时用项目内缓存
npm start                           # http://localhost:3000
```

小程序用微信开发者工具**导入仓库根目录**（含 `project.config.json` 的那一层），
并在「详情 → 本地设置」勾选 **不校验合法域名**。

演示账号：`admin / admin123`、`alice / 123456`。

---

## 3. 提交规范

### 3.1 提交信息格式

```
<type>: <一句话摘要，不超过 50 字>

<正文：改了什么、为什么改，可分行分点>
```

**type 取值**

| type | 用于 |
| --- | --- |
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 只改文档 |
| `refactor` | 重构，行为不变 |
| `test` | 增删改测试 |
| `chore` | 构建、依赖、配置、忽略规则等杂项 |
| `hw` | **硬件相关**：固件、接线、标定、安全阈值 |

> 摘要用**中文**，句末不加句号；正文说明「为什么」比罗列「改了什么」更有价值。

### 3.2 提交粒度

**按逻辑单元拆分，不要把所有改动堆成一个巨型提交。**

反例：一个提交里同时改了后端接口、小程序页面和文档。
正例：

```
feat: 观测站控制台支持紧急关盖
docs: 补充顶盖指令生命周期说明
fix: 修正 README 中过期的版本号
```

### 3.3 示例

```
fix: 自动关盖被无人回执的指令阻塞

自动策略原先把「任意已下发未回执的指令」都视为在途，导致设备失联后遗留的
delivered 指令会把自动关盖卡住长达 3 分钟。

改为只把「60 秒内下发的」视为在途；pending 仍始终视为在途。
```

---

## 4. 分支与推送

| 场景 | 做法 |
| --- | --- |
| 小改动、文档修正 | 直接提交到 `master` 并推送 |
| 新功能 / 重构 / 会影响他人的改动 | 开 `feature/xxx` 分支，自测通过后再合并 |
| 安全相关改动（见 §7、§8） | **必须**走分支 + 至少一人复核，不要直接推 `master` |

```bash
git checkout -b feature/xxx
# ...改动...
git add -A && git commit
git push -u origin feature/xxx
```

推送前请先 `git pull --rebase origin main`，避免产生无意义的合并提交。

---

## 5. 推送前自检

**必须做**——本仓库已有自动化校验，改完不跑等于裸奔：

| 改动类型 | 需要执行 |
| --- | --- |
| 小程序页面 / 组件 / `utils/api.js` | `npm run validate` |
| 后端 `server/*.js` | `npm run test:server` |
| 上面两类都动了 | **`npm run check`**（两项依次执行） |
| 只改 Markdown | 检查内部相对链接是否可解析 |
| 只改固件 | 至少编译通过：`cd firmware/cover-controller && pio run` |

```bash
npm run validate        # 小程序结构校验
npm run test:server     # 112 项后端端到端测试
npm run check           # = validate + test:server
```

**校验不通过就不要推。** 这些检查覆盖了页面注册、WXML 配平、事件处理函数存在性、
跳转目标合法性，以及「`api.js` 调用的接口在后端是否存在」——最后这项能拦掉大部分低级错误。

---

## 6. 目录与代码约定

### 6.1 新增一个小程序页面

四步，缺一不可，否则 `npm run validate` 会报错：

1. 建 `miniprogram/pages/<name>/` 目录，放 `<name>.js` / `.json` / `.wxml`（`.wxss` 可选）
2. 在 `miniprogram/app.json` 的 `pages` 数组里注册
3. 页面的 `json` 里写 `navigationBarTitleText`；用到自定义组件时在 `usingComponents` 声明
4. **所有 `bindtap` / `bindinput` 等事件处理函数必须在 `.js` 里定义**，且写成
   `name: function () {}` 的形式（校验脚本按这个模式匹配）

### 6.2 新增一个后端接口

1. 在 `server/server.js` 里加路由，放在对应分段内（用 `/* ===== 分段 ===== */` 组织）
2. 需要鉴权的加 `requireAuth` / `requireAdmin`；设备端接口用 `requireDevice`
3. 在 `miniprogram/utils/api.js` 里加对应的封装函数
4. 在 `server/test/e2e.mjs` 里补测试用例
5. 更新 `docs/API.md` 的接口总览表

> `api.js` 里的路径会被校验脚本拿去和 `server.js` 的路由做正则匹配，**两边必须对得上**。

### 6.3 其他约定

- 后端**不引入新的 npm 依赖**，除非有充分理由——目前只有 `express` 一个，这是刻意的
- 小程序**不引入第三方 UI 库与图表库**，图表用自研的 `components/mini-chart`
- 代码风格跟随现有文件：2 空格缩进、`function` 而非箭头函数（小程序侧）、单引号
- 所有 SQL 使用参数化查询

---

## 7. 敏感信息（红线）

以下内容**绝对不能提交**，`.gitignore` 已覆盖，请不要用 `git add -f` 绕过：

| 路径 | 原因 |
| --- | --- |
| `firmware/**/config.h` | 含 Wi-Fi 密码与设备令牌 |
| `.env` | 环境变量，可能含 `ADMIN_PASSWORD` |
| `server/data/`、`*.db` | SQLite 运行时数据 |
| `node_modules/`、`.npm-cache/`、`.pio/` | 依赖与构建产物 |
| `.work/` | 临时工作目录 |

**新增任何含口令、令牌、密钥的文件前，先加进 `.gitignore`。**

模板文件请用 `*.example.*` 命名（如 `config.example.h`），里面只放占位值。

### 仓库可见性

本仓库为**匿名化公开版**：

- 人名、校名、楼名已统一替换为占位符（`学生 A`~`D`、`指导教师 A/B`、`某中学`、`教学楼`）
- 含真实姓名的立项书 PDF 原件**未收录**（二进制内容无法脱敏）
- 提交历史为重建的干净历史，不含原始作者信息

**新增内容时请沿用同样的匿名化约定**：不要在文档、代码注释、提交信息或 issue 中
写入真实姓名、学校名称、楼宇名称或联系方式。详见 [`docs/ANONYMIZATION.md`](docs/ANONYMIZATION.md)。

---

## 8. 硬件相关改动的额外要求

顶盖控制器是**会夹伤人、会被雨淋坏设备的机械装置**。改动 `firmware/` 或
`server/hardware.js` 时，除了跑测试，还必须遵守：

### 8.1 不可动摇的安全红线

以下设计**不得为了"方便"或"响应更快"而移除或弱化**，改任何一条都要走分支 + 复核：

| 红线 | 原因 |
| --- | --- |
| **限位开关用常闭（NC）接法** | 断线即等效"已到位"→ 停机；用常开则断线会一直撞 |
| **必须有机械硬限位** | 软件会跑飞、MOSFET 会击穿短路 |
| **雨感走本地硬逻辑** | 不经过 MCU、不经过网络；MCU 死机时它仍要有效 |
| **关门受阻必须反转退让** | 防夹。不要为了"关得干脆"删掉 |
| **通信失联时保持位置，不自动关盖** | 自动关盖会毁掉正在进行的整晚曝光，还可能撞到望远镜 |
| **开盖受审批时段约束，关盖不设权限** | 开门要权限，关门要自由 |
| **急停按钮串在驱动器供电回路** | 软件卡死时物理断电是唯一可靠手段 |

### 8.2 安全阈值的修改

`MOVE_TIMEOUT_MS`、`STALL_MA`、`RAIN_ADC_*`、`WIND_LIMIT` 这类阈值**必须实测标定**，
不能凭感觉调。改动的提交信息里要写清**实测依据**（测了几次、实测值多少）。

### 8.3 硬件改动不能只靠 CI

自动化测试只能验证软件逻辑。涉及真实机械的改动，**必须台架实测**后才算完成，
并在提交信息里记录测试条件与结果。

---

## 9. 文档同步

改了行为就要同步文档，否则文档比代码更害人：

| 改动 | 需要更新 |
| --- | --- |
| 新增/修改接口 | `docs/API.md` |
| 新增/修改数据表 | `docs/DATABASE_DESIGN.md` |
| 顶盖控制相关 | `docs/HARDWARE_DESIGN.md` |
| 任何面向用户的变更 | `docs/CHANGELOG.md` |
| 新增文档 | `docs/README.md` 的文档清单 |

---

## 10. 版本号

版本号在 `package.json`、`server/package.json`、`miniprogram/config.js` 三处，
**必须保持一致**，同时更新 `docs/CHANGELOG.md`。

| 情形 | 递增 |
| --- | --- |
| 不兼容的接口/数据变更 | 主版本 |
| 新增功能 | 次版本 |
| 修复、文档、重构 | 修订号 |

---

## 11. 遇到问题

- 端口被占用：`PORT=3001 npm start`
- 小程序调不通后端：确认 `miniprogram/config.js` 的 `baseUrl`，真机预览要用局域网 IP
- 校验脚本报"接口不匹配"：说明 `api.js` 调了后端不存在的路由，或路径写法与 `server.js` 不一致
- 更多排查见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
