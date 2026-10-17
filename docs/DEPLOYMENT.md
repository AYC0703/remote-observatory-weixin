# 部署运维手册 —— 远程天文台使用申请审批及统计系统

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Linux / macOS / Windows |
| Node.js | **22.5 及以上**（依赖内置 `node:sqlite` 模块，推荐 24 LTS 或更高；开发环境验证版本为 26.x） |
| npm | 随 Node.js 安装 |
| 磁盘 | 建议预留 100 MB 以上（代码 + 依赖约 5 MB，数据库随业务量增长） |
| 内存 | 128 MB 以上即可满足中小规模使用 |
| 网络 | 默认监听 3000 端口，需确保该端口可达 |

无需单独安装数据库服务，也无需 C++ 编译工具链——所有依赖均为纯 JavaScript。

## 2. 安装与启动

### 2.1 标准安装

```bash
# 进入项目目录
cd remote-observatory

# 安装依赖
npm install

# 启动服务
npm start
```

启动成功后输出：

```text
远程天文台系统已启动: http://localhost:3000
管理员账号: admin / admin123（默认密码，生产请设置 ADMIN_PASSWORD）
```

浏览器访问 `http://localhost:3000` 即可。

### 2.2 关于 npm 缓存目录

若运行环境的全局 npm 缓存目录不可写（常见于沙箱、容器或受限账户），安装会报 `EROFS` 错误。此时把缓存重定向到项目内：

```bash
npm install --cache ./.npm-cache
```

`.npm-cache/` 已在 `.gitignore` 中排除，不会进入版本库。

### 2.3 开发与演示启动

```bash
PORT=3001 npm start
```

## 3. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PORT` | 否 | `3000` | HTTP 监听端口 |
| `SESSION_SECRET` | **生产必填** | 未设置时每次启动随机生成 | 会话签名密钥。未设置时重启会导致所有会话失效，并向日志输出警告 |
| `ADMIN_PASSWORD` | **生产必填** | `admin123` | 管理员密码。**每次启动都会同步**为该值：账号不存在则据此创建，已存在且密码不同则更新 |
| `COOKIE_SECURE` | 否 | `false` | 设为 `true` 后 Cookie 仅通过 HTTPS 传输。**启用 HTTPS 后应设为 true** |
| `COOKIE_SAMESITE` | 否 | `lax` | 同站策略，可设 `lax` / `strict`。设为 `strict` 可进一步降低 CSRF 风险 |

### 3.1 生成会话密钥

```bash
openssl rand -hex 32
```

### 3.2 生产启动示例

```bash
SESSION_SECRET=$(openssl rand -hex 32) \
ADMIN_PASSWORD='你的强密码' \
COOKIE_SECURE=true \
COOKIE_SAMESITE=strict \
PORT=3000 \
npm start
```

### 3.3 使用 .env 文件（可选）

项目未内置 dotenv 加载。若希望以文件方式管理配置，可用以下任一方式：

```bash
# 方式一：启动时导出
export $(grep -v '^#' .env | xargs) && npm start

# 方式二：使用 dotenv-cli
npx dotenv-cli -e .env -- npm start
```

`.env` 已在 `.gitignore` 中排除，切勿将密钥提交到版本库。

## 4. 生产部署建议

### 4.1 部署形态

推荐：**Node 服务监听本地端口 + 反向代理处理 HTTPS**。

```text
Internet
   │  HTTPS 443
   ▼
┌───────────────────┐
│  Nginx / Caddy    │  证书终止、静态缓存、压缩
└─────────┬─────────┘
          │ HTTP 127.0.0.1:3000
          ▼
┌───────────────────┐
│  Node (server.js) │  由进程管理器守护
└─────────┬─────────┘
          ▼
   data/observatory.db
```

### 4.2 反向代理配置参考

Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name observatory.example.com;

    ssl_certificate     /etc/letsencrypt/live/observatory.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/observatory.example.com/privkey.pem;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy（自动申请证书，配置更简）：

```caddy
observatory.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### 4.3 进程守护

使用 systemd：

```ini
[Unit]
Description=Remote Observatory Application System
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/remote-observatory
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=COOKIE_SECURE=true
EnvironmentFile=/etc/observatory.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

其中 `/etc/observatory.env` 存放敏感配置（权限建议 `600`）：

```text
SESSION_SECRET=用 openssl rand -hex 32 生成的值
ADMIN_PASSWORD=你的强密码
```

也可使用 pm2：

```bash
pm2 start server.js --name observatory
pm2 save
pm2 startup
```

### 4.4 生产环境注意事项

| 事项 | 说明 |
| --- | --- |
| `trust proxy` | 部署在反向代理后，若不配置 `trust proxy`，限速会按代理 IP 计数，导致所有用户共享配额。当前代码未开启该配置，反向代理场景下需按需调整 |
| 会话存储 | 当前使用内存存储：**重启后所有用户需重新登录，且无法多进程共享**。若需多实例或长会话，应替换为持久化存储（如 SQLite / Redis 存储） |
| 静态资源缓存 | `public/vendor/` 下的 Vue 与 Chart.js 可设置长缓存；`index.html` 与 `app.js` 建议不缓存或短缓存，便于发布即生效 |
| 文件权限 | `data/` 目录需对运行账户可写；`data/observatory.db` 建议权限 600 |

## 5. 数据备份与恢复

### 5.1 备份

数据库为单文件，备份即复制：

```bash
# 建议先停止服务，确保写入落盘
systemctl stop observatory
cp data/observatory.db /backup/observatory-$(date +%Y%m%d).db
systemctl start observatory
```

若不便停机，可使用 SQLite 在线备份（需要 sqlite3 CLI）：

```bash
sqlite3 data/observatory.db ".backup '/backup/observatory-$(date +%Y%m%d).db'"
```

### 5.2 恢复

```bash
systemctl stop observatory
cp /backup/observatory-20260826.db data/observatory.db
systemctl start observatory
```

### 5.3 自动备份示例（cron）

```bash
# 每天 03:30 备份，保留 30 天
30 3 * * * sqlite3 /opt/remote-observatory/data/observatory.db ".backup '/backup/obs-$(date +\%Y\%m\%d).db'" && find /backup -name 'obs-*.db' -mtime +30 -delete
```

## 6. 数据重置

删除数据库文件后重启即可得到全新环境：

```bash
rm -f data/observatory.db
npm start
```

重启后将自动：

1. 重建全部数据表；
2. 创建管理员账号（密码取 `ADMIN_PASSWORD`，未设置则 `admin123`）；
3. 写入 4 台默认设备。

**该操作不可逆，请务必先备份。**

## 7. 升级流程

```bash
# 1. 备份数据（重要）
cp data/observatory.db /backup/observatory-before-upgrade.db

# 2. 拉取新代码
git pull

# 3. 更新依赖（若 package.json 有变化）
npm install

# 4. 重启服务
systemctl restart observatory
```

说明：数据表结构变更采用 `CREATE TABLE IF NOT EXISTS` 的幂等建表方式，**新增表会在启动时自动创建**；若涉及已有表的字段变更，需要人工迁移（当前版本尚无此类变更）。

升级后建议做一次快速回归：登录 → 提交申请 → 审批 → 查看统计 → 导出报表。

## 8. 故障排查

### 8.1 端口被占用（EADDRINUSE）

现象：

```text
【错误】端口 3000 已被占用。
请先关闭占用该端口的进程，或使用其他端口启动，例如：
  PORT=3001 npm start
```

排查与处理：

```bash
# 查看占用进程
lsof -i :3000
# 或
ss -ltnp | grep :3000

# 结束进程
kill <PID>

# 或改用其他端口
PORT=3001 npm start
```

### 8.2 依赖安装失败（EROFS / 权限错误）

全局 npm 缓存不可写时，改用项目内缓存：

```bash
npm install --cache ./.npm-cache
```

### 8.3 管理员密码不生效

排查顺序：

1. 确认启动命令中确实带了 `ADMIN_PASSWORD`（注意不要写成 `ADMIN_PASSOWRD` 之类的拼写错误）。
2. 查看启动日志，若出现 `[seed] 管理员密码已按 ADMIN_PASSWORD 同步更新`，说明已生效。
3. 若日志显示 `管理员账号: admin / admin123（默认密码...)`，说明本次启动未传入该环境变量，密码保持为上一次的值。
4. 密码修改后需**重新登录**，旧会话不会自动失效（会话与密码相互独立）。

### 8.4 重启后所有人都要重新登录

这是**预期行为**：会话存储在进程内存中，且未设置 `SESSION_SECRET` 时，每次启动都会生成新的随机密钥，导致旧 Cookie 无法通过校验。

解决方式：将 `SESSION_SECRET` 固定为环境变量，重启后已有会话仍可复用（直至 1 天有效期到期）。若需重启后完全保留登录态，需改用持久化会话存储。

### 8.5 登录提示「尝试次数过多」

触发了认证限速（15 分钟 20 次，按 IP 计数）。等待窗口结束后自动恢复。若为误触发（例如多人共用出口 IP），可考虑放宽限速参数或改为按账号维度计数。

### 8.6 导出 CSV 中文乱码

系统已输出 UTF-8 BOM，正常情况下 Excel / WPS 双击即可正常显示。若仍乱码，请确认下载文件未被中间环节（代理、编辑器）转码，或用「数据 → 从文本导入」并指定 UTF-8 编码。

### 8.7 统计数字与预期不符

常见原因：

| 现象 | 原因 |
| --- | --- |
| 通过率异常 | 通过率分母为「已通过 + 未通过」，不含待审批与已撤回 |
| 设备申请量与实际不符 | 历史上的设备重命名已级联更新；若曾手工改库，可能出现名称不一致 |
| 月度趋势缺少某月 | 该月确实无申请（接口只返回有数据的月份，前端图表不补零） |

### 8.8 数据库文件损坏

```bash
# 检查完整性
sqlite3 data/observatory.db "PRAGMA integrity_check;"
```

若确认损坏且无备份，可尝试导出可读数据后重建库文件。

## 9. 运维检查清单

### 上线前

- [ ] 设置 `SESSION_SECRET` 为强随机值
- [ ] 设置 `ADMIN_PASSWORD` 为强密码，并确认启动日志显示已同步
- [ ] 启用 HTTPS，并设置 `COOKIE_SECURE=true`
- [ ] 视需要设置 `COOKIE_SAMESITE=strict`
- [ ] 配置反向代理的 `X-Forwarded-*` 头
- [ ] 确认 `data/` 目录权限正确且不在版本库中
- [ ] 配置进程守护与开机自启
- [ ] 配置数据库定时备份并验证恢复流程
- [ ] 确认 `.env` / 环境文件权限为 600 且未被提交

### 日常

- [ ] 检查服务进程与端口存活
- [ ] 检查磁盘空间（数据库与备份）
- [ ] 查看审计日志是否有异常操作
- [ ] 抽查备份文件可用性
- [ ] 关注依赖安全公告，定期 `npm audit`

### 发布后

- [ ] 冒烟测试：登录 → 提交申请 → 审批 → 统计 → 导出
- [ ] 确认移动端可正常访问
- [ ] 确认旧会话未异常中断（若未更换 `SESSION_SECRET`）

## 10. 性能与容量参考

| 指标 | 参考值 |
| --- | --- |
| 空载内存占用 | 约 60-90 MB |
| 静态资源总量 | 约 360 KB（Vue + Chart.js 占绝大部分，仅首次加载） |
| 单条申请写入 | 毫秒级（SQLite 同步写） |
| 建议数据量级 | 千级申请量内无需调优；万级以上建议为高频查询字段补索引 |

## 11. 安全建议（未实施项）

当前已实现的安全措施见 [TECH_DESIGN.md](./TECH_DESIGN.md) 第 9 节。以下为生产环境建议补充、但**当前版本尚未实现**的项：

| 项 | 说明 | 优先级 |
| --- | --- | --- |
| HTTPS + HSTS | 防止凭据在传输中泄露 | 高 |
| 会话持久化存储 | 当前内存存储不支持重启保留与多进程 | 中 |
| 安全响应头（helmet） | CSP、X-Frame-Options、X-Content-Type-Options 等 | 中 |
| CSRF Token | 在 sameSite 之外增加第二道防线 | 中 |
| 登录失败审计与告警 | 及时发现暴力破解尝试 | 低 |
| 依赖漏洞扫描 | 定期 `npm audit` 与依赖升级 | 低 |
