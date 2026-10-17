# 数据库设计文档 —— 远程天文台使用申请审批及统计系统

## 1. 概述

| 项 | 内容 |
| --- | --- |
| 数据库 | SQLite 3 |
| 驱动 | Node.js 内置 `node:sqlite`（`DatabaseSync`，同步 API） |
| 文件位置 | `data/observatory.db`（首次启动自动创建，已加入 .gitignore） |
| 建表方式 | 启动时幂等执行 `CREATE TABLE IF NOT EXISTS` |
| 外键 | 启动时执行 `PRAGMA foreign_keys = ON` 开启 |
| 字符集 | UTF-8 |
| 时间存储 | 统一使用 TEXT 字符串（详见第 5 节） |

选择 SQLite 的理由：本项目数据量级为中小规模，单文件部署免去数据库服务安装与运维；`node:sqlite` 为 Node 内置模块，**零原生依赖**，无需编译即可跨平台运行。备份即复制文件，迁移即拷贝文件。

## 2. ER 关系

```text
                          ┌───────────────────┐
                          │      users        │
                          │───────────────────│
                          │ id (PK)           │
                          │ username (UNIQUE) │
                          │ password_hash     │
                          │ name              │
                          │ role              │
                          │ created_at        │
                          └─────────┬─────────┘
                                    │ 1
                                    │
                     ┌──────────────┴───────────────┐
                     │ N                            │ N
        user_id（申请人）                  reviewed_by（审批人，可空）
                     │                              │
                     ▼                              │
         ┌───────────────────────────┐              │
         │       applications        │◄─────────────┘
         │───────────────────────────│
         │ id (PK)                   │
         │ app_no (UNIQUE)           │
         │ user_id (FK → users.id)   │
         │ applicant_name            │
         │ applicant_contact         │
         │ device  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┼─ ─ ─ ┐ 按名称关联（非外键）
         │ start_time / end_time     │      │
         │ target / purpose          │      │
         │ status                    │      │
         │ created_at                │      │
         │ reviewed_at               │      │
         │ reviewed_by (FK users.id) │      │
         │ review_comment            │      │
         └─────────────┬─────────────┘      │
                       │ 1                  │
                       │                    ▼
                       │ N          ┌───────────────┐
         ┌─────────────▼───────────┐  │   devices     │
         │     status_history      │  │───────────────│
         │─────────────────────────│  │ id (PK)       │
         │ id (PK)                 │  │ name (UNIQUE) │
         │ application_id (FK)     │  │ created_at    │
         │ from_status/to_status   │  └───────────────┘
         │ action                  │
         │ operator_id/operator_name│
         │ comment                 │
         │ created_at              │
         └─────────────────────────┘

         ┌─────────────────────────┐
         │       audit_logs        │   独立流水表，无外键约束
         │─────────────────────────│   （即使账号被清理也保留痕迹）
         │ id / user_id / username │
         │ action / detail         │
         │ created_at              │
         └─────────────────────────┘
```

关系说明：

| 关系 | 基数 | 约束 |
| --- | --- | --- |
| users → applications（申请人） | 1 : N | `applications.user_id` 外键，非空 |
| users → applications（审批人） | 1 : N | `applications.reviewed_by` 外键，可空（未审批时为 NULL） |
| applications → status_history | 1 : N | 外键 + `ON DELETE CASCADE` |
| devices → applications | 1 : N | **非外键**，按设备名称字符串关联（见第 6 节） |
| audit_logs | 独立 | 不设外键，保证审计流水不因业务数据变动而丢失 |

## 3. 表结构明细

### 3.1 users —— 用户表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 用户主键 |
| username | TEXT | NOT NULL, UNIQUE | 登录名，3-20 位，仅字母 / 数字 / 下划线 |
| password_hash | TEXT | NOT NULL | 密码哈希，格式 `salt:hash` |
| name | TEXT | NOT NULL | 显示名称，注册未填时默认取 username |
| role | TEXT | NOT NULL, DEFAULT 'user' | 角色：`user` / `admin` |
| created_at | TEXT | NOT NULL | 注册时间（ISO 8601 UTC） |

密码字段说明：`password_hash` 存储的是 `<16 字节随机盐 hex>:<64 字节 scrypt 摘要 hex>`。校验时按存储的盐重新派生并做常量时间比较，**数据库中不存在明文或可逆密码**。

### 3.2 applications —— 观测申请表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 申请主键 |
| app_no | TEXT | NOT NULL, UNIQUE | 申请编号，格式 `TEL-<年>-<4位序号>` |
| user_id | INTEGER | NOT NULL, FK → users(id) | 提交人 |
| applicant_name | TEXT | NOT NULL | 申请人姓名 |
| applicant_contact | TEXT | NOT NULL | 联系方式（手机号 / 邮箱） |
| device | TEXT | NOT NULL | 观测设备名称（按名称关联 devices.name） |
| start_time | TEXT | NOT NULL | 使用时段开始，格式 `YYYY-MM-DDTHH:mm` |
| end_time | TEXT | NOT NULL | 使用时段结束，同上；允许跨日 |
| target | TEXT | NOT NULL | 拍摄目标 |
| purpose | TEXT | NOT NULL | 拍摄目的 |
| status | TEXT | NOT NULL, DEFAULT 'pending' | 申请状态，见第 4 节 |
| created_at | TEXT | NOT NULL | 提交时间（ISO 8601 UTC） |
| reviewed_at | TEXT | 可空 | 审批时间，未审批为 NULL |
| reviewed_by | INTEGER | 可空, FK → users(id) | 审批人，未审批为 NULL |
| review_comment | TEXT | 可空 | 审批意见；拒绝时由业务层强制必填 |

### 3.3 status_history —— 申请状态变更历史表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| application_id | INTEGER | NOT NULL, FK → applications(id) ON DELETE CASCADE | 所属申请 |
| from_status | TEXT | 可空 | 变更前状态；提交时为 NULL |
| to_status | TEXT | NOT NULL | 变更后状态 |
| action | TEXT | NOT NULL | 操作类型，见第 4 节 |
| operator_id | INTEGER | 可空 | 操作人 ID |
| operator_name | TEXT | 可空 | 操作人显示名（冗余快照） |
| comment | TEXT | 可空 | 操作备注（审批意见） |
| created_at | TEXT | NOT NULL | 操作时间（ISO 8601 UTC） |

设计说明：

- 该表是**只追加**的流水表，每条状态变更产生一行，永不更新或删除。
- `operator_name` 冗余存储操作人姓名，属于有意的快照设计：即便用户改名，历史记录仍能还原当时的操作人称呼。
- 外键设为 `ON DELETE CASCADE`：申请被删除时其历史一并清理（业务上不提供删除申请的入口，此为兜底）。

### 3.4 audit_logs —— 系统操作审计表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| user_id | INTEGER | 可空 | 操作人 ID |
| username | TEXT | 可空 | 操作人登录名（冗余快照） |
| action | TEXT | NOT NULL | 操作类型，见第 4 节 |
| detail | TEXT | 可空 | 操作详情描述 |
| created_at | TEXT | NOT NULL | 操作时间（ISO 8601 UTC） |

与 `status_history` 的区别：`status_history` 面向**单条申请**的业务轨迹，`audit_logs` 面向**整个系统**的操作流水（含登录、设备维护等与具体申请无关的动作）。接口只返回最近 200 条。

### 3.5 devices —— 观测设备表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| name | TEXT | NOT NULL, UNIQUE | 设备名称，最长 50 字，全局唯一 |
| created_at | TEXT | NOT NULL | 创建时间（ISO 8601 UTC） |

### 3.6 sessions —— 登录会话表

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| token | TEXT | PK | Bearer Token（32 字节随机数的十六进制） |
| user_id | INTEGER | NOT NULL | 所属用户 |
| created_at | TEXT | NOT NULL | 创建时间 |
| expires_at | TEXT | NOT NULL | 过期时间（24 小时），过期即删除 |

### 3.7 cover_devices —— 已接入远程控制的观测站

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键，接口中的 `:id` |
| device | TEXT | NOT NULL, UNIQUE | 设备名称，与 `devices.name` 逻辑关联 |
| token | TEXT | NOT NULL, UNIQUE | 设备令牌，形如 `cov_` + 48 位十六进制 |
| enabled | INTEGER | NOT NULL DEFAULT 1 | 是否启用远程控制（0/1） |
| position | TEXT | NOT NULL DEFAULT 'unknown' | 顶盖位置，见 §4.5 |
| moving | INTEGER | NOT NULL DEFAULT 0 | 是否正在动作 |
| limit_open | INTEGER | 可空 | 开到位限位状态（NULL 表示设备从未上报） |
| limit_close | INTEGER | 可空 | 关到位限位状态 |
| rain | INTEGER | NOT NULL DEFAULT 0 | 是否检测到降雨 |
| wind | REAL | 可空 | 风速 m/s |
| temperature | REAL | 可空 | 温度 ℃ |
| humidity | REAL | 可空 | 相对湿度 % |
| current_ma | INTEGER | 可空 | 电机电流 mA |
| fault | TEXT | 可空 | 故障码，非空即禁止开盖 |
| firmware | TEXT | 可空 | 固件版本 |
| ip | TEXT | 可空 | 设备来源 IP |
| rssi | INTEGER | 可空 | WiFi 信号强度 dBm |
| last_seen | TEXT | 可空 | 最后一次心跳（ISO 8601 UTC），在线判定依据 |
| created_at / updated_at | TEXT | NOT NULL | 创建 / 更新时间 |

在线状态**不落库**，由 `last_seen` 与 `COVER_OFFLINE_SEC` 在读取时实时计算，避免出现「库里写着在线但设备早就没了」的脏状态。

### 3.8 cover_commands —— 顶盖指令队列

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| req_id | TEXT | NOT NULL, UNIQUE | 指令 ID，形如 `c-` + 16 位十六进制，回执时回传 |
| device | TEXT | NOT NULL | 目标设备名称 |
| action | TEXT | NOT NULL | `open` / `close` / `stop` / `clear-fault` |
| source | TEXT | NOT NULL | 来源，见 §4.6 |
| user_id | INTEGER | 可空 | 发起用户（自动策略为 NULL） |
| username | TEXT | 可空 | 发起用户登录名快照 |
| status | TEXT | NOT NULL DEFAULT 'pending' | 生命周期状态，见 §4.7 |
| detail | TEXT | 可空 | 备注 / 失败原因 |
| created_at | TEXT | NOT NULL | 入队时间 |
| delivered_at | TEXT | 可空 | 被设备取走的时间 |
| acked_at | TEXT | 可空 | 设备回执时间 |
| expires_at | TEXT | 可空 | 排队有效期（**开盖短、关盖长**，见 HARDWARE_DESIGN.md §5） |

### 3.9 cover_events —— 设备事件流水

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| device | TEXT | NOT NULL | 设备名称 |
| level | TEXT | NOT NULL DEFAULT 'info' | `info` / `warn` / `error`（`error` 同时写入 `audit_logs`） |
| code | TEXT | NOT NULL | 事件码，如 `STALL_OPEN`、`TIMEOUT`、`RAIN`、`AUTO_CLOSE_SCHEDULE` |
| message | TEXT | 可空 | 可读描述 |
| created_at | TEXT | NOT NULL | 服务器接收时间 |

### 3.10 cover_telemetry —— 环境采样历史

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK, AUTOINCREMENT | 主键 |
| device | TEXT | NOT NULL | 设备名称 |
| rain | INTEGER | 可空 | 是否降雨 |
| wind | REAL | 可空 | 风速 m/s |
| temperature | REAL | 可空 | 温度 ℃ |
| humidity | REAL | 可空 | 相对湿度 % |
| created_at | TEXT | NOT NULL | 采样时间 |

按 `COVER_TELEMETRY_MIN_SEC`（默认 120 秒）节流入库，避免高频上报撑爆数据库。

## 4. 枚举值约定

系统使用 TEXT 存储枚举，未使用数据库级 CHECK 约束，取值由应用层保证。

### 4.1 applications.status

| 值 | 中文 | 是否终态 | 是否占用设备时段 |
| --- | --- | --- | --- |
| `pending` | 待审批 | 否 | 是 |
| `approved` | 已通过 | 是 | 是 |
| `rejected` | 未通过 | 是 | 否 |
| `withdrawn` | 已撤回 | 是 | 否 |

### 4.2 users.role

| 值 | 说明 |
| --- | --- |
| `user` | 普通用户，可注册 |
| `admin` | 管理员，仅系统预设 |

### 4.3 status_history.action

| 值 | 说明 | from → to |
| --- | --- | --- |
| `submit` | 提交申请 | NULL → pending |
| `approve` | 审批通过 | pending → approved |
| `reject` | 审批拒绝 | pending → rejected |
| `withdraw` | 用户撤回 | pending → withdrawn |

### 4.4 audit_logs.action

| 类别 | 取值 |
| --- | --- |
| 账号 | `register`、`login`、`logout`、`change_password` |
| 申请 | `submit_application`、`withdraw_application`、`approve_application`、`reject_application` |
| 设备 | `add_device`、`rename_device`、`delete_device` |
| 顶盖控制 | `cover_open`、`cover_close`、`cover_stop`、`cover_clear-fault`、`cover_emergency_close` |
| 顶盖接入 | `cover_bind`、`cover_unbind`、`cover_enable`、`cover_override`、`cover_device_error` |

### 4.5 cover_devices.position

| 值 | 中文 | 说明 |
| --- | --- | --- |
| `unknown` | 状态未知 | 设备从未上报，或重启后未确认位置 |
| `open` | 已开启 | 开到位限位触发 |
| `closed` | 已关闭 | 关到位限位触发 |
| `partial` | 半开 | 中途停止、超时或受阻退让后的状态 |
| `moving` | 动作中 | 正在开合 |

### 4.6 cover_commands.source

| 值 | 说明 |
| --- | --- |
| `user` | 登录用户通过小程序 / API 下发 |
| `admin-override` | 管理员强制通道，绕过前置校验 |
| `emergency` | 紧急关盖 |
| `auto-rain` | 服务器兜底：检测到降雨 |
| `auto-schedule` | 服务器兜底：申请时段结束（含宽限） |
| `api` | 预留：外部系统直接调用 |

### 4.7 cover_commands.status

| 值 | 中文 | 是否终态 |
| --- | --- | --- |
| `pending` | 待设备取走 | 否 |
| `delivered` | 已下发 | 否 |
| `acked` | 设备已接收 | 是 |
| `failed` | 执行失败 | 是 |
| `rejected` | 设备拒绝 | 是 |
| `expired` | 已过期（设备未取走） | 是 |
| `timeout` | 未回执 | 是 |
| `superseded` | 已被新指令取代 | 是 |

## 5. 时间字段约定

| 字段 | 格式 | 生成方式 | 用途 |
| --- | --- | --- | --- |
| `applications.start_time` / `end_time` | `YYYY-MM-DDTHH:mm` | 前端 `datetime-local` 控件直接提交 | 时段比较、冲突判定、界面展示 |
| `applications.created_at` / `reviewed_at` | ISO 8601 UTC，如 `2026-08-25T08:13:07.459Z` | 服务端 `new Date().toISOString()` | 排序、审计留痕 |
| `status_history.created_at` | 同上 | 同上 | 时间线展示 |
| `audit_logs.created_at` | 同上 | 同上 | 流水排序 |

两条重要约定：

1. **时段字段用本地时间字符串**：直接沿用 `datetime-local` 的值（不含时区），因此「北京时间 22:00」就是字面量 `22:00`，比较与展示都无歧义。
2. **ISO 字符串可按字典序比较**：ISO 8601 格式的时间字符串，其字典序与时间先后一致，因此排序（`ORDER BY created_at`）与区间比较可直接使用字符串比较，无需解析为日期对象。

示例：`substr(created_at,1,7)` 可直接截取到 `YYYY-MM` 用于月度趋势统计。

## 6. 外键与级联

| 外键 | 指向 | 删除行为 |
| --- | --- | --- |
| `applications.user_id` | `users.id` | 默认（RESTRICT），用户被引用时不可删除 |
| `applications.reviewed_by` | `users.id` | 默认（RESTRICT） |
| `status_history.application_id` | `applications.id` | `ON DELETE CASCADE`，随申请级联删除 |

前两项外键之所以采用默认严格模式，是因为系统**不提供删除用户或删除申请的入口**，外键在此主要起数据完整性兜底作用。

### 关于 applications.device 不设外键

`applications.device` 存储设备**名称**而非 `devices.id`，两者之间没有外键约束。这是一个有意的设计权衡：

| 维度 | 说明 |
| --- | --- |
| 收益 | ① 历史申请保留「当时的设备名」，即使设备被重命名或删除，历史记录依然可读；② 查询与导出无需 JOIN，统计口径直观 |
| 代价 | 需要应用层保证一致性 |

应用层的两条补偿规则（见 [TECH_DESIGN.md](./TECH_DESIGN.md) 7.4）：

1. **重命名级联**：修改设备名时，同步执行 `UPDATE applications SET device = ? WHERE device = ?`，使历史申请跟随更新。
2. **删除保护**：删除设备前先统计引用条数，存在引用则拒绝删除（返回 400 与引用条数），避免历史数据成为无法解释的「孤儿设备」。

### 关于 cover_devices.device 不设外键

`cover_devices.device` 同样存储设备**名称**，理由与 `applications.device` 一致。级联规则：

| 操作 | 处理 |
| --- | --- |
| 重命名设备 | 同步 `UPDATE` `cover_devices` / `cover_commands` / `cover_events` / `cover_telemetry` 的 `device` 列 |
| 删除设备 | 删除 `cover_devices` 中的绑定；`cover_commands` / `cover_events` / `cover_telemetry` 作为历史保留 |

## 7. 种子数据

服务启动时自动执行，且均为**幂等**操作：

| 种子 | 触发条件 | 内容 |
| --- | --- | --- |
| 管理员账号 | `users` 中不存在 `admin` | 创建 `admin`，密码取环境变量 `ADMIN_PASSWORD`，未设置则用 `admin123` |
| 管理员密码同步 | 已存在 `admin` 且设置了 `ADMIN_PASSWORD` 且当前密码不一致 | 将管理员密码更新为 `ADMIN_PASSWORD` 的值 |
| 默认设备 | `devices` 表为空 | 写入 4 台默认设备（望远镜A 0.5 米、望远镜B 0.8 米、望远镜C 1.2 米、射电望远镜） |

管理员密码以环境变量为准的设计，保证了「配置即事实」：只要在启动命令里给出 `ADMIN_PASSWORD`，无论数据库处于何种历史状态，管理员密码都会被同步为该值。

## 8. 索引与性能

**现有索引**：除主键自增索引外，额外的索引来自两类——`UNIQUE` 约束（`users.username`、`applications.app_no`、`devices.name`、`sessions.token`、`cover_devices.device`、`cover_devices.token`、`cover_commands.req_id`），以及顶盖控制为高频轮询显式建立的三个索引：

| 索引 | 表 | 服务的查询 |
| --- | --- | --- |
| `idx_cover_commands_device_status` | `(device, status, id)` | 长轮询取待执行指令、自动策略判断在途指令 |
| `idx_cover_events_device` | `(device, id)` | 设备事件流水倒序查询 |
| `idx_cover_telemetry_device` | `(device, id)` | 环境采样倒序查询与节流判定 |

**数据规模评估**：目标场景为数十至数百用户、千级申请量。该规模下全表扫描的成本极低，因此未额外建立索引。顶盖控制不同——设备**每 4 秒**轮询一次指令、每 15 秒上报一次状态，属于高频路径，因此显式建了索引。

**潜在优化点**（数据量增长后可考虑）：

| 场景 | 建议索引 |
| --- | --- |
| 按设备查冲突（高频） | `(device, status, start_time)` |
| 待审批队列排序 | `(status, created_at)` |
| 我的申请列表 | `(user_id, created_at)` |
| 状态历史时间线 | `(application_id, created_at)` |
| 审计日志倒序 | `(created_at)` |

**查询层优化措施**（已实施）：

1. 申请列表统一分页（`LIMIT / OFFSET`），单页上限 50 条。
2. 审计日志接口限制返回最近 200 条。
3. 统计接口使用 `GROUP BY` 在数据库侧聚合，避免把明细拉到应用层计算。
4. 设备列表的「关联申请数」使用相关子查询一次取回，避免 N+1 查询。

## 9. 数据字典汇总

```text
users             用户
├─ id               主键
├─ username         登录名（唯一）
├─ password_hash    密码哈希（salt:hash）
├─ name             显示名
├─ role             角色（user / admin）
└─ created_at       注册时间

applications      观测申请
├─ id               主键
├─ app_no           申请编号（唯一，TEL-YYYY-NNNN）
├─ user_id          申请人（→ users.id）
├─ applicant_name   申请人姓名
├─ applicant_contact联系方式
├─ device           设备名称（按名称关联 devices.name）
├─ start_time       时段开始（YYYY-MM-DDTHH:mm）
├─ end_time         时段结束（YYYY-MM-DDTHH:mm）
├─ target           拍摄目标
├─ purpose          拍摄目的
├─ status           状态（pending/approved/rejected/withdrawn）
├─ created_at       提交时间
├─ reviewed_at      审批时间
├─ reviewed_by      审批人（→ users.id）
└─ review_comment   审批意见

status_history    申请状态历史（只追加）
├─ id               主键
├─ application_id   所属申请（→ applications.id，级联删除）
├─ from_status      变更前状态
├─ to_status        变更后状态
├─ action           操作（submit/approve/reject/withdraw）
├─ operator_id      操作人 ID
├─ operator_name    操作人姓名（快照）
├─ comment          备注 / 审批意见
└─ created_at       操作时间

audit_logs        系统操作审计（只追加，无外键）
├─ id               主键
├─ user_id          操作人 ID
├─ username         操作人登录名（快照）
├─ action           操作类型
├─ detail           详情描述
└─ created_at       操作时间

devices           观测设备
├─ id               主键
├─ name             设备名称（唯一，≤50 字）
└─ created_at       创建时间

sessions          登录会话
├─ token            主键（Bearer Token）
├─ user_id          所属用户
├─ created_at       创建时间
└─ expires_at       过期时间

cover_devices     已接入远程控制的观测站
├─ id               主键
├─ device           设备名称（唯一，按名称关联 devices.name）
├─ token            设备令牌（唯一，cov_ + 48 位十六进制）
├─ enabled          是否启用远程控制
├─ position         顶盖位置（unknown/open/closed/partial/moving）
├─ moving           是否正在动作
├─ limit_open       开到位限位状态
├─ limit_close      关到位限位状态
├─ rain             是否检测到降雨
├─ wind             风速 m/s
├─ temperature      温度 ℃
├─ humidity         相对湿度 %
├─ current_ma       电机电流 mA
├─ fault            故障码（非空即禁止开盖）
├─ firmware         固件版本
├─ ip               设备来源 IP
├─ rssi             WiFi 信号强度 dBm
├─ last_seen        最后心跳（在线判定依据，不落库在线标志）
├─ created_at       接入时间
└─ updated_at       最后更新时间

cover_commands    顶盖指令队列
├─ id               主键
├─ req_id           指令 ID（唯一，c- + 16 位十六进制）
├─ device           目标设备名称
├─ action           open / close / stop / clear-fault
├─ source           来源（user/admin-override/emergency/auto-rain/auto-schedule/api）
├─ user_id          发起用户（自动策略为空）
├─ username         发起用户登录名（快照）
├─ status           生命周期（pending/delivered/acked/failed/rejected/expired/timeout/superseded）
├─ detail           备注 / 失败原因
├─ created_at       入队时间
├─ delivered_at     被设备取走时间
├─ acked_at         设备回执时间
└─ expires_at       排队有效期（开盖短、关盖长）

cover_events      设备事件流水（只追加）
├─ id               主键
├─ device           设备名称
├─ level            info / warn / error
├─ code             事件码
├─ message          可读描述
└─ created_at       服务器接收时间

cover_telemetry   环境采样历史（只追加，按 120 秒节流）
├─ id               主键
├─ device           设备名称
├─ rain             是否降雨
├─ wind             风速 m/s
├─ temperature      温度 ℃
├─ humidity         相对湿度 %
└─ created_at       采样时间
```

## 10. 数据库运维

| 操作 | 方法 |
| --- | --- |
| 备份 | 停止服务后复制 `data/observatory.db`；运行中可用 SQLite 在线备份接口 |
| 恢复 | 停止服务，用备份文件覆盖 `data/observatory.db` 后重启 |
| 重置 | 删除 `data/observatory.db` 后重启，将自动重建表结构与种子数据 |
| 查看数据 | 使用任意 SQLite 客户端打开该文件（如 `sqlite3 data/observatory.db`） |
| 迁移 | 直接拷贝文件到新环境，注意保持文件权限可写 |
