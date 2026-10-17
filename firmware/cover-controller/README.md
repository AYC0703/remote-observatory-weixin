# ESP32 顶盖控制器固件

ESP32 通过 HTTP 长轮询主动连接后端，接收开合指令并上报顶盖状态、环境数据与故障事件。

## 一、文件说明

| 文件 | 说明 |
| --- | --- |
| `cover-controller.ino` | 主固件（Arduino 框架） |
| `config.example.h` | 配置模板，复制为 `config.h` 后填写 |
| `platformio.ini` | PlatformIO 工程配置 |
| `config.h` | **不提交仓库**，含 Wi-Fi 密码与设备令牌 |

## 二、接线表

| ESP32 引脚 | 接到 | 说明 |
| --- | --- | --- |
| GPIO25 | 驱动器 RPWM | LEDC PWM 通道 0（正转） |
| GPIO26 | 驱动器 LPWM | LEDC PWM 通道 1（反转） |
| GPIO27 | 驱动器 EN | 使能，低电平关闭 |
| GPIO32 | 开到位限位开关 | **常闭(NC)** 接法，另一端接 GND，内部上拉 |
| GPIO33 | 关到位限位开关 | 同上 |
| GPIO34 | 电流采样输出 | ACS712 / INA226，ADC1，输入专用脚 |
| GPIO35 | 雨感模块模拟输出 | ADC1 |
| GPIO2 | 蜂鸣器 / 状态 LED | 动作中与故障时鸣响 |
| GPIO4 | 本地开盖按钮 | 另一端接 GND |
| GPIO5 | 本地关盖按钮 | 另一端接 GND |

> ⚠️ **限位开关必须用常闭（NC）接法。** 这样断线时固件读到"已到位"→ 停机；
> 若用常开，断线会变成"永远不到位"→ 一直撞，这是最危险的反模式。

## 三、烧录步骤

### PlatformIO（推荐）

```bash
cd firmware/cover-controller
cp config.example.h config.h
# 编辑 config.h：填 WIFI_SSID / WIFI_PASS / BASE / DEVICE_TOKEN

pio run -t upload
pio device monitor        # 115200
```

### Arduino IDE

1. 安装 **ArduinoJson 6.x**（库管理器搜索 `ArduinoJson`，选 6.21.x）
2. 开发板选择 `ESP32 Dev Module`（或 `ESP32S3 Dev Module`）
3. 把 `cover-controller/` 整个文件夹放入 Arduino 草图目录，打开 `.ino`
4. 确保 `config.h` 与 `.ino` 在同一目录
5. 上传

> **Arduino-ESP32 核心版本**：固件使用 `ledcSetup` / `ledcAttachPin`，兼容 2.x 与 3.x。
> 若在 3.x 上遇到 LEDC 相关编译告警，可换成新 API `ledcAttach(pin, freq, res)` +
> `ledcWrite(pin, duty)`（注意参数由「通道号」变为「引脚号」）。

## 四、获取设备令牌

1. 用管理员账号登录小程序 → **观测站控制**
2. 在「接入管理」中点「选择设备并生成令牌」
3. 复制返回的 `cov_...` 令牌，填入 `config.h` 的 `DEVICE_TOKEN`

> 令牌只在生成时显示一次。遗失或泄漏只能重置，重置后原固件立即失效。

## 五、上电自检与标定

### 1. 上电自检

串口应输出：

```
=== 远程天文台顶盖控制器 1.0.0 ===
[WiFi] 已连接 192.168.1.57
```

若打印 `[FAULT] LIMIT_CONFLICT`，说明开、关限位同时触发——先查线路再接电机。

### 2. 标定雨感阈值

用串口观察干燥与淋湿时的 ADC 读数，修改代码中的：

```cpp
static const uint16_t RAIN_ADC_DRY = 3000;   // 干燥读数
static const uint16_t RAIN_ADC_WET = 1500;   // 淋湿读数
```

固件取两者中值作为阈值。**这一项必须实测**，不同雨感模块差异很大。

### 3. 标定堵转电流阈值

1. 在 `readCurrentMA()` 里临时加一行 `Serial.println(readCurrentMA());`
2. 记录：空载运行电流、正常负载电流、人为堵住时的电流
3. 把 `STALL_MA` 设为「正常负载电流 × 2」，且明显低于堵转电流的数值

## 六、安全设计说明（改代码前请先读）

| 机制 | 行为 |
| --- | --- |
| 雨感 | **本地硬逻辑**，不依赖网络、不依赖服务器，检测到降雨立即关盖 |
| 限位开关 | 常闭接法，断线即停机（失效安全） |
| 运行超时 | 超过 `MOVE_TIMEOUT_MS`（默认 45s）未到位 → 停机并报故障 |
| 堵转保护 | 开盖堵转 → 停机报故障；**关盖堵转 → 反转退让 3 秒**（防夹） |
| 软启动 | 800ms PWM 斜坡，减小机械冲击与电流尖峰 |
| 动作期间不联网 | 移动时完全不做 HTTP 请求，保证状态机实时性 |
| 通信失联 | **保持位置并告警，绝不自动关门** |
| 故障锁存 | 进入 `ST_FAULT` 后拒绝一切动作，需通过小程序下发「复位故障」 |

> 失联不自动关门是刻意设计：观测中途断网就关盖会毁掉整晚的曝光，
> 还可能撞到正在使用的望远镜。真正需要兜底的是降雨，而降雨由本地硬逻辑处理。

## 七、协议速查

```
GET  {BASE}/api/observatory/device/poll?wait=4     → { "command": {...} | null }
POST {BASE}/api/observatory/device/state           ← 状态与环境
POST {BASE}/api/observatory/device/ack             ← { reqId, status, detail }
POST {BASE}/api/observatory/device/event           ← { level, code, message }
请求头：X-Device-Token: cov_xxxxxxxx
```

可用 curl 手工模拟一台设备，便于联调：

```bash
TOKEN=cov_xxxxxxxx
BASE=http://127.0.0.1:3000

curl -s "$BASE/api/observatory/device/poll?wait=0" -H "X-Device-Token: $TOKEN"
curl -s -X POST "$BASE/api/observatory/device/state" -H "X-Device-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"position":"closed","limitClose":true,"rain":false,"wind":3.2}'
```

## 八、已知限制与改进方向

- 轮询等待为 4 秒，指令延迟在空闲时最长约 4 秒。若需更低延迟，可把
  网络轮询与电机状态机拆到两个 FreeRTOS 任务（`xTaskCreatePinnedToCore`）并加互斥锁。
- 未实现 OTA 远程升级。建议后续接入 ArduinoOTA 或 ESP-IDF 的 `esp_ota`，
  否则每次改固件都要上屋顶。
- 未启用 TLS 证书校验。公网部署时建议把 `HTTPClient` 换成
  `WiFiClientSecure` + `setCACert()`，避免令牌被中间人窃取。
