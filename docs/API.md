# API 接口文档 —— 远程天文台使用申请审批及统计系统

## 1. 通用约定

| 项 | 说明 |
| --- | --- |
| Base URL | 与服务同源，如 `http://localhost:3000` |
| 数据格式 | 请求与响应均为 JSON（CSV 导出接口除外） |
| 请求头 | 含请求体时需带 `Content-Type: application/json` |
| 认证方式 | Cookie 会话（`observatory.sid`），登录后由浏览器自动携带 |
| 请求体上限 | 1 MB |
| 时间格式 | 时段为 `YYYY-MM-DDTHH:mm`；时间戳为 ISO 8601 UTC |

### 1.1 认证与角色

| 标记 | 含义 | 未满足时的响应 |
| --- | --- | --- |
| 公开 | 无需登录 | — |
| 需登录 | `requireAuth` | 401 `{"error":"未登录"}` |
| 需管理员 | `requireAdmin` | 未登录 401；已登录但非管理员 403 `{"error":"需要管理员权限"}` |

### 1.2 错误响应格式

所有错误统一返回：

```json
{ "error": "错误描述（中文，可直接展示给用户）" }
```

冲突类接口（提交申请、审批）在 409 时会额外带上冲突明细：

```json
{
  "error": "该设备在所选时段已被占用",
  "conflicts": [
    {
      "id": 12,
      "app_no": "TEL-2026-0007",
      "start_time": "2027-03-20T22:00",
      "end_time": "2027-03-21T02:00",
      "status": "pending"
    }
  ]
}
```

### 1.3 通用状态码

| 状态码 | 含义 | 典型场景 |
| --- | --- | --- |
| 200 | 成功 | 查询、更新、审批成功 |
| 201 | 创建成功 | 注册、提交申请、新增设备 |
| 400 | 参数错误 | 字段缺失、格式非法、业务规则不满足 |
| 401 | 未认证 | 未登录、用户名或密码错误 |
| 403 | 无权限 | 非管理员访问管理接口、访问他人申请 |
| 404 | 资源不存在 | 申请 / 设备不存在，或未知接口路径 |
| 409 | 冲突 | 用户名已存在、设备重名、时段冲突 |
| 429 | 请求过于频繁 | 认证接口 15 分钟内超过 20 次 |
| 500 | 服务器内部错误 | 未预期异常（不返回堆栈） |

### 1.4 申请对象结构

多数接口返回的申请对象具有统一结构（由后端共享投影生成，已连带审批人姓名与申请人账号）：

```json
{
  "id": 1,
  "app_no": "TEL-2026-0001",
  "user_id": 2,
  "applicant_name": "张天文",
  "applicant_contact": "13800000000",
  "device": "望远镜A（0.5米）",
  "start_time": "2027-03-20T22:00",
  "end_time": "2027-03-21T02:00",
  "target": "M31 仙女座星系",
  "purpose": "深空天体拍摄",
  "status": "pending",
  "created_at": "2026-08-25T08:13:07.459Z",
  "reviewed_at": null,
  "reviewed_by": null,
  "review_comment": null,
  "reviewer_name": null,
  "applicant_username": "alice"
}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `pending` 待审批 / `approved` 已通过 / `rejected` 未通过 / `withdrawn` 已撤回 |
| `reviewed_at`、`reviewed_by`、`review_comment`、`reviewer_name` | 未审批时均为 `null` |
| `applicant_username` | 申请人登录名（由后端关联查询带出） |
| `reviewer_name` | 审批人显示名（由后端关联查询带出） |

## 2. 接口总览

| # | 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | POST | `/api/auth/register` | 公开（限速） | 注册并自动登录 |
| 2 | POST | `/api/auth/login` | 公开（限速） | 登录 |
| 3 | POST | `/api/auth/logout` | 公开 | 退出登录 |
| 4 | GET | `/api/auth/me` | 公开 | 获取当前登录用户 |
| 5 | POST | `/api/auth/change-password` | 需登录（限速） | 修改自己的密码 |
| 6 | GET | `/api/devices` | 公开 | 设备列表（含引用计数） |
| 7 | POST | `/api/admin/devices` | 需管理员 | 新增设备 |
| 8 | PUT | `/api/admin/devices/:id` | 需管理员 | 重命名设备 |
| 9 | DELETE | `/api/admin/devices/:id` | 需管理员 | 删除设备 |
| 10 | GET | `/api/applications/conflicts` | 需登录 | 时段冲突预检 |
| 11 | POST | `/api/applications` | 需登录 | 提交申请 |
| 12 | GET | `/api/applications/mine` | 需登录 | 我的申请列表 |
| 13 | GET | `/api/applications/:id` | 需登录（本人或管理员） | 申请详情 + 状态历史 |
| 14 | POST | `/api/applications/:id/withdraw` | 需登录（仅本人） | 撤回申请 |
| 15 | GET | `/api/admin/applications` | 需管理员 | 全部申请（筛选/搜索/分页） |
| 16 | GET | `/api/admin/pending` | 需管理员 | 待审批队列 |
| 17 | GET | `/api/admin/calendar` | 需管理员 | 设备时段占用 |
| 18 | POST | `/api/admin/applications/:id/review` | 需管理员 | 审批申请 |
| 19 | GET | `/api/admin/stats` | 需管理员 | 统计数据 |
| 20 | GET | `/api/admin/export.csv` | 需管理员 | 导出 CSV 报表 |
| 21 | GET | `/api/admin/audit` | 需管理员 | 审计日志 |
| 22 | GET | `/api/observatory/covers` | 需登录 | 已接入远程控制的观测站列表（含本人开盖权限） |
| 23 | GET | `/api/observatory/covers/:id` | 需登录 | 单台观测站详情 + 指令流水 + 事件流水 |
| 24 | POST | `/api/observatory/covers/:id/command` | 需登录 | 下发开盖 / 关盖 / 停止 / 复位故障 |
| 25 | POST | `/api/observatory/covers/:id/emergency-close` | 需登录 | 紧急关盖（取代队列中全部指令） |
| 26 | GET | `/api/admin/observatory` | 需管理员 | 接入总览（已接入 + 未接入设备） |
| 27 | POST | `/api/admin/observatory/bind` | 需管理员 | 接入设备 / 重置设备令牌 |
| 28 | POST | `/api/admin/observatory/:id/enabled` | 需管理员 | 启用 / 停用远程控制 |
| 29 | DELETE | `/api/admin/observatory/:id` | 需管理员 | 解除接入 |
| 30 | POST | `/api/admin/observatory/:id/command` | 需管理员 | 管理员强制指令（绕过前置校验） |
| 31 | GET | `/api/observatory/device/poll` | **设备令牌** | 设备长轮询取指令 |
| 32 | POST | `/api/observatory/device/state` | **设备令牌** | 设备上报顶盖与环境状态 |
| 33 | POST | `/api/observatory/device/ack` | **设备令牌** | 设备回执指令执行结果 |
| 34 | POST | `/api/observatory/device/event` | **设备令牌** | 设备上报告警 / 故障事件 |

> 第 22–30 项为用户与管理端接口，使用已有的 `Authorization: Bearer <token>`。
> 第 31–34 项为 **ESP32 设备端接口**，使用请求头 `X-Device-Token: cov_xxxxxxxx`
> （兼容 `?token=` 便于浏览器调试），与用户令牌完全隔离。
> 详细设计见 `HARDWARE_DESIGN.md`。

## 3. 认证接口

### 3.1 注册

```http
POST /api/auth/register
Content-Type: application/json
```

| 参数 | 类型 | 必填 | 校验规则 |
| --- | --- | --- | --- |
| `username` | string | 是 | 3-20 字符，仅字母、数字、下划线，全局唯一 |
| `password` | string | 是 | 至少 6 位 |
| `name` | string | 否 | 显示名称，缺省取 `username` |

注册成功即建立会话（服务端会重建会话 ID），响应 201：

```json
{ "user": { "id": 2, "username": "alice", "name": "张天文", "role": "user" } }
```

| 状态码 | 场景 |
| --- | --- |
| 400 | 用户名长度或字符不合法、密码少于 6 位 |
| 409 | 用户名已存在 |
| 429 | 触发认证限速 |

### 3.2 登录

```http
POST /api/auth/login
Content-Type: application/json

{ "username": "admin", "password": "admin123" }
```

成功响应 200：

```json
{ "user": { "id": 1, "username": "admin", "name": "系统管理员", "role": "admin" } }
```

失败统一返回 401 `{"error":"用户名或密码错误"}`，**不区分账号不存在与密码错误**，避免账号枚举。

### 3.3 退出登录

```http
POST /api/auth/logout
```

销毁会话，返回 200 `{"ok":true}`。无需登录也可调用。

### 3.4 获取当前用户

```http
GET /api/auth/me
```

```json
{ "user": { "id": 2, "username": "alice", "name": "张天文", "role": "user" } }
```

未登录时返回 `{"user": null}`（状态码 200），前端据此判断是否需要展示登录页。

### 3.5 修改密码

```http
POST /api/auth/change-password
Content-Type: application/json

{ "old_password": "123456", "new_password": "newpass789" }
```

| 参数 | 必填 | 校验规则 |
| --- | --- | --- |
| `old_password` | 是 | 必须与当前密码一致 |
| `new_password` | 是 | 至少 6 位 |

成功返回 200 `{"ok":true}`。当前密码错误返回 400 `{"error":"当前密码错误"}`。

## 4. 设备接口

### 4.1 设备列表（公开）

```http
GET /api/devices
```

```json
{
  "devices": [
    { "id": 1, "name": "望远镜A（0.5米）", "count": 3 },
    { "id": 2, "name": "望远镜B（0.8米）", "count": 0 }
  ]
}
```

`count` 为该设备被历史申请引用的条数，用于管理端判断能否删除。此接口无需登录，因为注册页与登录后的申请表单都需要设备选项。

### 4.2 新增设备

```http
POST /api/admin/devices
Content-Type: application/json

{ "name": "望远镜D（2.0米）" }
```

成功返回 201 `{"ok":true,"id":5,"name":"望远镜D（2.0米）"}`。

| 状态码 | 场景 |
| --- | --- |
| 400 | 名称为空或超过 50 字 |
| 409 | 同名设备已存在 |

### 4.3 重命名设备

```http
PUT /api/admin/devices/5
Content-Type: application/json

{ "name": "望远镜D（2.4米）" }
```

重命名会**级联更新所有历史申请中的设备名**，保证统计与日历口径一致。成功返回 200 `{"ok":true,"id":5,"name":"望远镜D（2.4米）"}`。

| 状态码 | 场景 |
| --- | --- |
| 400 | 名称为空或超过 50 字 |
| 404 | 设备不存在 |
| 409 | 新名称与其他设备重名 |

### 4.4 删除设备

```http
DELETE /api/admin/devices/5
```

成功返回 200 `{"ok":true}`。若该设备已被申请引用，返回 400 并说明引用条数：

```json
{ "error": "该设备已有 3 条申请记录，无法删除" }
```

## 5. 申请接口（普通用户）

### 5.1 时段冲突预检

```http
GET /api/applications/conflicts?device=望远镜A（0.5米）&start=2027-03-20T22:00&end=2027-03-21T02:00
```

| 查询参数 | 必填 | 说明 |
| --- | --- | --- |
| `device` | 是 | 设备名称 |
| `start` | 是 | 时段开始 |
| `end` | 是 | 时段结束 |

```json
{ "conflicts": [ { "id": 1, "app_no": "TEL-2026-0001", "start_time": "2027-03-20T22:00", "end_time": "2027-03-21T02:00", "status": "pending" } ] }
```

参数缺失时返回空冲突列表。该接口仅用于前端实时提示，**不作为准入依据**——提交时服务端会再次强制校验。

### 5.2 提交申请

```http
POST /api/applications
Content-Type: application/json

{
  "device": "望远镜A（0.5米）",
  "start_time": "2027-03-20T22:00",
  "end_time": "2027-03-21T02:00",
  "target": "M31 仙女座星系",
  "purpose": "深空天体拍摄",
  "applicant_name": "张天文",
  "applicant_contact": "13800000000"
}
```

全部字段必填。校验规则：

| 校验项 | 失败响应 |
| --- | --- |
| 设备存在 | 400 `请选择有效的观测设备` |
| 时段完整 | 400 `请填写完整的使用时段` |
| 结束晚于开始 | 400 `结束时间必须晚于开始时间` |
| 不得选择过去时段 | 400 `不能选择过去的时段` |
| 目标 / 目的 / 姓名 / 联系方式非空 | 400 对应提示 |

成功返回 201：

```json
{ "ok": true, "id": 1, "app_no": "TEL-2026-0001" }
```

时段冲突返回 409 及冲突明细（见 1.2 节）。提交成功后自动生成编号、写入状态历史（`submit`）与审计日志。

### 5.3 我的申请

```http
GET /api/applications/mine
```

返回当前登录用户的全部申请，按提交时间倒序：

```json
{ "applications": [ /* 申请对象数组，结构见 1.4 节 */ ] }
```

### 5.4 申请详情与状态历史

```http
GET /api/applications/1
```

```json
{
  "application": { /* 申请对象，结构见 1.4 节 */ },
  "history": [
    {
      "id": 1,
      "application_id": 1,
      "from_status": null,
      "to_status": "pending",
      "action": "submit",
      "operator_id": 2,
      "operator_name": "张天文",
      "comment": null,
      "created_at": "2026-08-25T08:13:07.469Z"
    },
    {
      "id": 5,
      "application_id": 1,
      "from_status": "pending",
      "to_status": "approved",
      "action": "approve",
      "operator_id": 1,
      "operator_name": "系统管理员",
      "comment": "时段空闲，同意",
      "created_at": "2026-08-25T08:13:59.952Z"
    }
  ]
}
```

权限：仅申请本人或管理员可访问，其他人返回 403。

### 5.5 撤回申请

```http
POST /api/applications/1/withdraw
```

成功返回 200 `{"ok":true}`。

| 状态码 | 场景 |
| --- | --- |
| 400 | 申请不是「待审批」状态 |
| 403 | 非本人申请 |

撤回后状态变为 `withdrawn`，该时段随即释放，可被其他申请占用。

## 6. 管理员接口

### 6.1 全部申请（筛选 / 搜索 / 分页）

```http
GET /api/admin/applications?status=pending&search=M31&page=1&pageSize=20
```

| 查询参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `status` | 否 | 全部 | `pending` / `approved` / `rejected` / `withdrawn` |
| `search` | 否 | — | 模糊匹配申请编号、申请人、拍摄目标、设备 |
| `page` | 否 | 1 | 页码，从 1 开始 |
| `pageSize` | 否 | 20 | 每页条数，上限 50 |

```json
{
  "applications": [ /* 申请对象数组 */ ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

### 6.2 待审批队列

```http
GET /api/admin/pending
```

返回全部待审批申请，**按提交时间升序**（先到先审），不分页：

```json
{ "applications": [ /* 申请对象数组 */ ] }
```

### 6.3 设备时段占用

```http
GET /api/admin/calendar
```

返回所有占用时段的精简信息（状态为 `pending` 或 `approved`），按开始时间升序：

```json
{
  "slots": [
    { "id": 1, "app_no": "TEL-2026-0001", "device": "望远镜A（0.5米）", "start_time": "2027-03-20T22:00", "end_time": "2027-03-21T02:00", "status": "approved" }
  ]
}
```

前端按设备分组展示，形成占用日历；审批弹窗也复用该接口做冲突预判。

### 6.4 审批申请

```http
POST /api/admin/applications/1/review
Content-Type: application/json

{ "action": "approve", "comment": "时段空闲，同意", "force": false }
```

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | `approve` 同意 / `reject` 不同意 |
| `comment` | string | 条件必填 | `reject` 时必填；`approve` 时可选 |
| `force` | boolean | 否 | 仅 `approve` 有效；存在冲突时需置 `true` 才能强制通过 |

成功返回 200：

```json
{ "ok": true, "status": "approved" }
```

审批会写入审批时间、审批人、审批意见，并追加状态历史与审计日志。

| 状态码 | 场景 |
| --- | --- |
| 400 | action 非法、申请已处理、拒绝时未填意见 |
| 404 | 申请不存在 |
| 409 | 同意时存在时段冲突且未携带 `force: true` |

409 响应体：

```json
{
  "error": "该申请与以下已占用时段冲突",
  "conflicts": [ /* 冲突申请明细 */ ]
}
```

### 6.5 统计数据

```http
GET /api/admin/stats
```

```json
{
  "counts": { "pending": 2, "approved": 5, "rejected": 1, "withdrawn": 1 },
  "total": 9,
  "byDevice": [
    { "device": "望远镜A（0.5米）", "c": 4 },
    { "device": "望远镜B（0.8米）", "c": 3 }
  ],
  "byMonthRaw": [
    { "ym": "2026-07", "c": 3 },
    { "ym": "2026-08", "c": 6 }
  ],
  "approveRate": 83
}
```

| 字段 | 说明 |
| --- | --- |
| `counts` | 各状态申请数（四种状态恒存在，无数据时为 0） |
| `total` | 申请总数 |
| `byDevice` | 按设备的申请量，降序 |
| `byMonthRaw` | 按月的申请量，`ym` 为 `YYYY-MM`，升序 |
| `approveRate` | 通过率百分比（已通过 /（已通过 + 未通过）× 100，四舍五入） |

### 6.6 导出 CSV 报表

```http
GET /api/admin/export.csv
```

响应为文件下载：

```text
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="observatory-report-2026-08-26.csv"
```

文件特性：

- 前置 UTF-8 BOM，Excel / WPS 打开中文不乱码
- 行分隔符为 `CRLF`
- 含表头，列为：申请编号、申请人、申请人账号、联系方式、观测设备、开始时间、结束时间、拍摄目标、拍摄目的、状态、提交时间、审批时间、审批人、审批意见
- 字段按 RFC 4180 转义；以 `=`、`+`、`-`、`@` 开头的字段会加单引号前缀，防止表格软件将其作为公式执行
- 导出全部申请（不受分页限制）

### 6.7 审计日志

```http
GET /api/admin/audit
```

返回最近 200 条操作流水，按时间倒序：

```json
{
  "logs": [
    {
      "id": 8,
      "user_id": 1,
      "username": "admin",
      "action": "approve_application",
      "detail": "通过申请 TEL-2026-0001",
      "created_at": "2026-08-25T08:13:59.966Z"
    }
  ]
}
```

`action` 取值见 [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) 第 4.4 节。

## 7. 调用示例（完整流程）

以下示例使用 `curl` 的 Cookie 罐（`-c` 保存、`-b` 发送）维持会话。

```bash
BASE=http://localhost:3000

# 1. 管理员登录，保存会话
curl -s -c admin.cookie -X POST $BASE/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'

# 2. 注册普通用户，保存会话
curl -s -c user.cookie -X POST $BASE/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"123456","name":"张天文"}'

# 3. 查看可用设备
curl -s $BASE/api/devices

# 4. 提交申请
curl -s -b user.cookie -X POST $BASE/api/applications \
  -H 'Content-Type: application/json' \
  -d '{"device":"望远镜A（0.5米）","start_time":"2027-03-20T22:00","end_time":"2027-03-21T02:00","target":"M31 仙女座星系","purpose":"深空天体拍摄","applicant_name":"张天文","applicant_contact":"13800000000"}'

# 5. 提交重叠时段，应返回 409 与冲突明细
curl -s -b user.cookie -X POST $BASE/api/applications \
  -H 'Content-Type: application/json' \
  -d '{"device":"望远镜A（0.5米）","start_time":"2027-03-20T23:00","end_time":"2027-03-21T01:00","target":"M42","purpose":"冲突测试","applicant_name":"张天文","applicant_contact":"13800000000"}'

# 6. 管理员查看待审批队列
curl -s -b admin.cookie $BASE/api/admin/pending

# 7. 管理员审批通过（id 为第 4 步返回的 id）
curl -s -b admin.cookie -X POST $BASE/api/admin/applications/1/review \
  -H 'Content-Type: application/json' \
  -d '{"action":"approve","comment":"时段空闲，同意"}'

# 8. 查看统计
curl -s -b admin.cookie $BASE/api/admin/stats

# 9. 导出报表
curl -s -b admin.cookie $BASE/api/admin/export.csv -o report.csv
```

## 8. 观测站顶盖远程控制接口

> 完整设计（权限矩阵、指令生命周期、自动策略、配置项）见 `HARDWARE_DESIGN.md`。

### 8.1 观测站列表

```http
GET /api/observatory/covers
Authorization: Bearer <user-token>
```

```json
{
  "covers": [
    {
      "id": 1,
      "device": "望远镜A（0.5米）",
      "enabled": true,
      "position": "closed",
      "position_text": "已关闭",
      "moving": false,
      "online": true,
      "online_text": "在线",
      "last_seen": "2026-10-02T14:22:21.276Z",
      "rain": false,
      "wind": 3.4,
      "temperature": 18.2,
      "humidity": 71,
      "current_ma": 0,
      "fault": null,
      "firmware": "1.0.0",
      "rssi": -58,
      "limits": { "open": null, "close": true },
      "can_open": true,
      "open_reason": "申请 TEL-2026-0001 生效中",
      "can_close": false,
      "close_reason": "顶盖已处于关闭状态",
      "elevated": false,
      "active_application": { "app_no": "TEL-2026-0001", "start_time": "…", "end_time": "…" },
      "occupancy": [ { "app_no": "TEL-2026-0001", "applicant_name": "张天文", "start_time": "…", "end_time": "…", "target": "M31" } ],
      "wind_limit": 12,
      "offline_sec": 45,
      "open_grace_min": 10,
      "close_grace_min": 15
    }
  ],
  "policy": {
    "wind_limit": 12, "offline_sec": 45, "open_grace_min": 10,
    "close_grace_min": 15, "auto_close": true
  }
}
```

- `can_open` / `can_close` 与 `*_reason` 是**后端算好的授权结论**，小程序直接据此置灰按钮并展示原因，不要把判定逻辑复制到前端。
- 响应中**永不包含** `token` 字段。

### 8.2 单台详情

```http
GET /api/observatory/covers/:id
```

返回 `{ cover, commands, events }`，其中 `commands` 为最近 30 条指令、`events` 为最近 30 条设备事件。

### 8.3 下发指令

```http
POST /api/observatory/covers/:id/command
Content-Type: application/json

{ "action": "open" }
```

`action` 取值：`open` / `close` / `stop` / `clear-fault`。

成功返回 **202**：

```json
{
  "ok": true,
  "delivered": true,
  "message": "指令已下发",
  "command": { "req_id": "c-…", "action": "open", "status": "pending", "…": "…" },
  "cover": { "…": "…" }
}
```

当设备离线时，`delivered` 为 `false`、`message` 为「观测站离线，指令已排队，设备恢复连接后执行」，状态码仍为 202。

失败情形：

| 状态码 | 场景 | 响应片段 |
| --- | --- | --- |
| 400 | 非法 `action` | `{"error":"不支持的指令：explode"}` |
| 403 | 开盖被拒 | `{"error":"当前时刻你没有该设备已批准的观测申请","code":"OPEN_DENIED"}` |
| 409 | 关盖被拒（已关闭） | `{"error":"顶盖已处于关闭状态","code":"CLOSE_DENIED"}` |
| 409 | 离线时下发 stop / clear-fault | `{"error":"观测站离线，无法下发停止指令"}` |
| 404 | 未接入 | `{"error":"该观测站未接入远程控制"}` |

### 8.4 紧急关盖

```http
POST /api/observatory/covers/:id/emergency-close
```

任何登录用户均可调用。会先把队列中所有 `pending` / `delivered` 指令置为 `superseded`，再以 `source = "emergency"` 下发关盖。

### 8.5 接入管理（管理员）

```http
GET    /api/admin/observatory              # { covers, unbound, policy }
POST   /api/admin/observatory/bind         # { "device": "望远镜A（0.5米）" }
POST   /api/admin/observatory/:id/enabled  # { "enabled": false }
DELETE /api/admin/observatory/:id
POST   /api/admin/observatory/:id/command  # { "action": "open" }  强制通道
```

绑定成功返回 **201**（令牌**仅此一次**返回）：

```json
{
  "ok": true, "id": 1, "device": "望远镜A（0.5米）",
  "token": "cov_4e85a4d95706806bc02a24aaf0b74246ddeab57fc77bb39b",
  "rebound": false,
  "warning": "设备令牌仅本次返回，请立即写入 ESP32 固件；遗失只能重置。"
}
```

对已绑定的设备重复调用 `bind` 即为**重置令牌**（`rebound: true`），原令牌立即失效。

### 8.6 设备端接口

设备令牌通过请求头传递：`X-Device-Token: cov_xxxxxxxx`。

```http
# 长轮询取指令（wait 上限见 COVER_POLL_MAX_SEC）
GET /api/observatory/device/poll?wait=4
→ { "device": "…", "serverTime": "…", "command": { "reqId": "c-…", "action": "open", … } | null }

# 上报状态（部分更新语义，未提供的字段沿用原值）
POST /api/observatory/device/state
{ "position": "closed", "moving": false, "limitOpen": false, "limitClose": true,
  "rain": false, "wind": 3.4, "temperature": 18.2, "humidity": 71,
  "current": 320, "fault": "", "rssi": -58, "firmware": "1.0.0" }

# 回执
POST /api/observatory/device/ack
{ "reqId": "c-…", "status": "acked", "detail": "已接收，开始开盖" }

# 事件上报
POST /api/observatory/device/event
{ "level": "error", "code": "STALL_OPEN", "message": "开盖堵转" }
```

设备端鉴权失败返回 **401** `{"error":"设备令牌无效"}`；远程控制被停用返回 **403**。

### 8.7 顶盖控制调用示例

```bash
BASE=http://localhost:3000

# 1. 管理员登录并取出 token
TOKEN=$(curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')

# 2. 为设备生成令牌（只显示一次，请立即保存）
curl -s -X POST $BASE/api/admin/observatory/bind \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"device":"望远镜A（0.5米）"}'

# 3. 用 curl 模拟一台 ESP32 设备
DEV=cov_xxxxxxxxxxxxxxxx
curl -s -X POST $BASE/api/observatory/device/state -H "X-Device-Token: $DEV" \
  -H 'Content-Type: application/json' \
  -d '{"position":"closed","limitClose":true,"rain":false,"wind":3.4}'

# 4. 把设备端轮询挂在后台，模拟真实固件
curl -s "$BASE/api/observatory/device/poll?wait=4" -H "X-Device-Token: $DEV" &

# 5. 小程序侧下发开盖
curl -s -X POST $BASE/api/observatory/covers/1/command \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"action":"open"}'

# 6. 查看权限判定结果
curl -s $BASE/api/observatory/covers -H "Authorization: Bearer $TOKEN"
```

## 9. 限速说明

`register`、`login`、`change-password` 三个接口受认证限速保护：

| 项 | 值 |
| --- | --- |
| 窗口 | 15 分钟 |
| 上限 | 20 次 |
| 计数维度 | 客户端 IP |
| 超限响应 | 429 `{"error":"尝试次数过多，请 15 分钟后再试"}` |

三个接口**共享同一计数窗口**。响应头会携带标准的限速信息（`RateLimit-*`）。

需要注意的是：若系统部署在反向代理之后，默认按直连 IP 计数会导致所有用户共享同一配额，此时需要通过 `trust proxy` 配置并确保代理正确传递客户端 IP。
