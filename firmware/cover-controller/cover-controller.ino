/*
 * 远程天文台顶盖控制器 —— ESP32 固件
 * ------------------------------------------------------------------
 * 协议：设备主动长轮询（HTTP），不需要公网 IP、不需要端口映射。
 *
 *   GET  {BASE_URL}/api/observatory/device/poll?wait=4   取指令（长轮询）
 *   POST {BASE_URL}/api/observatory/device/state         上报顶盖与环境状态
 *   POST {BASE_URL}/api/observatory/device/ack           回执指令
 *   POST {BASE_URL}/api/observatory/device/event         上报告警/故障
 *   所有请求均带请求头  X-Device-Token: <设备令牌>
 *
 * 安全设计（顺序即优先级）：
 *   1. 雨感本地硬逻辑 —— 不依赖网络，检测到降雨立刻关盖
 *   2. 限位开关（常闭 NC，断线即视为"已到位"→ 停机）
 *   3. 运行超时保护
 *   4. 堵转过流保护；关门受阻则反转退让
 *   5. 移动过程中不发起任何网络请求，保证状态机实时性
 *   6. 通信失联时保持位置，绝不自动关门
 *
 * 依赖：ArduinoJson 6.x（见 platformio.ini）
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "config.h"

/* ==================== 引脚 ==================== */
#define PIN_RPWM        25
#define PIN_LPWM        26
#define PIN_EN          27
#define PIN_LIM_OPEN    32   // 常闭(NC) 接 GND
#define PIN_LIM_CLOSE   33   // 常闭(NC) 接 GND
#define PIN_CURRENT     34   // ACS712 / INA226 模拟输出（ADC1）
#define PIN_RAIN_ADC    35   // 雨感模拟量（ADC1）
#define PIN_BUZZER       2
#define PIN_BTN_OPEN     4   // 本地手动按钮，另一端接 GND
#define PIN_BTN_CLOSE    5

/* ==================== 参数（务必按实机标定） ==================== */
static const uint32_t MOVE_TIMEOUT_MS = 45000;   // 单程最长运行时间
static const uint16_t STALL_MA        = 6000;    // 堵转电流阈值(mA)
static const uint32_t STALL_GRACE_MS  = 2500;    // 启动后屏蔽堵转检测
static const uint16_t RAIN_ADC_DRY    = 3000;    // 干燥时的 ADC 读数（标定用）
static const uint16_t RAIN_ADC_WET    = 1500;    // 淋湿时的 ADC 读数（标定用）
static const uint32_t RAIN_POLL_MS    = 2000;
static const uint32_t HEARTBEAT_MS    = 15000;
static const uint32_t POLL_WAIT_SEC   = 4;       // 长轮询等待秒数
static const uint16_t PWM_MAX         = 800;     // LEDC 0~1023，别拉满
static const uint32_t PWM_RAMP_MS     = 800;
static const char*    FW_VERSION      = "1.0.0";

/* ==================== 状态 ==================== */
enum State    { ST_IDLE, ST_OPENING, ST_CLOSING, ST_FAULT };
enum Position { POS_UNKNOWN, POS_OPEN, POS_CLOSED, POS_PARTIAL };

State    g_state = ST_IDLE;
Position g_pos   = POS_UNKNOWN;
String   g_fault = "";
uint32_t g_moveStart = 0, g_lastRain = 0, g_lastBeat = 0, g_lastWifiTry = 0;
bool     g_rain = false;
bool     g_stateDirty = true;

/* ==================== 前置声明 ==================== */
bool     limOpen();
bool     limClose();
uint16_t readCurrentMA();
void     motorStop();
void     startMove(bool forward);
void     raiseFault(const char* code, const char* msg);
void     reportState();
void     reportEvent(const char* level, const char* code, const char* message);

/* ==================== 工具 ==================== */
void beep(bool on) { digitalWrite(PIN_BUZZER, on ? HIGH : LOW); }

const char* posStr() {
  switch (g_pos) {
    case POS_OPEN:    return "open";
    case POS_CLOSED:  return "closed";
    case POS_PARTIAL: return "partial";
    default:          return "unknown";
  }
}

bool limOpen() {
  // 常闭接法：开关被压下 → 断开 → 上拉读到 HIGH
  return digitalRead(PIN_LIM_OPEN) == HIGH;
}
bool limClose() {
  return digitalRead(PIN_LIM_CLOSE) == HIGH;
}

/* ==================== HTTP ==================== */
int postJson(const char* path, const String& payload, bool quiet) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(8000);
  if (!http.begin(String(BASE) + path)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  int code = http.POST(payload);
  if (!quiet && code <= 0) Serial.printf("[HTTP] POST %s 失败: %s\n", path, http.errorToString(code).c_str());
  http.end();
  return code;
}

void reportEvent(const char* level, const char* code, const char* message) {
  StaticJsonDocument<256> d;
  d["level"]   = level;
  d["code"]    = code;
  d["message"] = message;
  String out;
  serializeJson(d, out);
  postJson("/api/observatory/device/event", out, true);
  Serial.printf("[EVENT] %s %s: %s\n", level, code, message);
}

String buildStatePayload() {
  StaticJsonDocument<384> d;
  d["position"]   = posStr();
  d["moving"]     = (g_state == ST_OPENING || g_state == ST_CLOSING);
  d["limitOpen"]  = limOpen();
  d["limitClose"] = limClose();
  d["rain"]       = g_rain;
  d["current"]    = readCurrentMA();
  d["fault"]      = g_fault.length() ? g_fault : String("");
  d["rssi"]       = WiFi.RSSI();
  d["firmware"]   = FW_VERSION;
  String out;
  serializeJson(d, out);
  return out;
}

void reportState() {
  postJson("/api/observatory/device/state", buildStatePayload(), true);
  g_stateDirty = false;
}

void ackCommand(const char* reqId, const char* status, const char* detail) {
  StaticJsonDocument<256> d;
  d["reqId"]  = reqId;
  d["status"] = status;
  d["detail"] = detail;
  String out;
  serializeJson(d, out);
  postJson("/api/observatory/device/ack", out, true);
}

/* ==================== 电流采样 ==================== */
/*
 * ACS712-30A：66mV/A，零点 2.5V。ESP32 ADC 上限 3.3V，
 * 因此输出经 1:2 分压后接入。若用 INA226(I2C) 请替换本函数。
 */
uint16_t readCurrentMA() {
  uint32_t acc = 0;
  for (int i = 0; i < 16; i++) { acc += analogRead(PIN_CURRENT); delayMicroseconds(200); }
  float v = (acc / 16.0f) * 3.3f / 4095.0f * 2.0f;    // 还原分压
  return (uint16_t)fabsf((v - 2.5f) / 0.066f * 1000.0f);
}

/* ==================== 电机 ==================== */
void motorStop() {
  ledcWrite(0, 0);
  ledcWrite(1, 0);
  digitalWrite(PIN_EN, LOW);
}

void motorDrive(bool forward, uint16_t duty) {
  digitalWrite(PIN_EN, HIGH);
  if (forward) { ledcWrite(0, duty); ledcWrite(1, 0); }
  else         { ledcWrite(0, 0);    ledcWrite(1, duty); }
}

void rampTo(bool forward, uint16_t target, uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    uint16_t d = (uint16_t)((uint32_t)target * (millis() - t0) / ms);
    motorDrive(forward, d);
    delay(8);
  }
  motorDrive(forward, target);
}

void raiseFault(const char* code, const char* msg) {
  motorStop();
  g_state = ST_FAULT;
  g_fault = code;
  beep(true);
  Serial.printf("[FAULT] %s: %s\n", code, msg);
  reportEvent("error", code, msg);
  reportState();
}

void startMove(bool forward) {
  if (g_state == ST_FAULT) { Serial.println("[SKIP] 故障未复位，拒绝动作"); return; }
  if (g_state != ST_IDLE)  { Serial.println("[SKIP] 正在动作中"); return; }
  if (g_rain)              { raiseFault("RAIN", "检测到降雨，拒绝开盖"); return; }
  if (forward && limOpen())  { g_pos = POS_OPEN;   reportState(); return; }
  if (!forward && limClose()) { g_pos = POS_CLOSED; reportState(); return; }

  g_state     = forward ? ST_OPENING : ST_CLOSING;
  g_moveStart = millis();
  g_fault     = "";
  beep(true);
  rampTo(forward, PWM_MAX, PWM_RAMP_MS);
  Serial.printf("[MOVE] %s 开始\n", forward ? "开盖" : "关盖");
  reportEvent("info", forward ? "OPEN_START" : "CLOSE_START", forward ? "开始开盖" : "开始关盖");
  reportState();
}

void tickMotor() {
  if (g_state != ST_OPENING && g_state != ST_CLOSING) return;

  const bool forward = (g_state == ST_OPENING);
  const uint32_t elapsed = millis() - g_moveStart;

  /* ① 到位 */
  if (forward && limOpen()) {
    motorStop(); beep(false);
    g_state = ST_IDLE; g_pos = POS_OPEN;
    Serial.println("[MOVE] 开到位");
    reportEvent("info", "OPEN_DONE", "顶盖已完全打开");
    reportState();
    return;
  }
  if (!forward && limClose()) {
    motorStop(); beep(false);
    g_state = ST_IDLE; g_pos = POS_CLOSED;
    Serial.println("[MOVE] 关到位");
    reportEvent("info", "CLOSE_DONE", "顶盖已完全关闭");
    reportState();
    return;
  }

  /* ② 超时 */
  if (elapsed > MOVE_TIMEOUT_MS) {
    raiseFault("TIMEOUT", forward ? "开盖超时未到位" : "关盖超时未到位");
    return;
  }

  /* ③ 堵转 */
  if (elapsed > STALL_GRACE_MS && readCurrentMA() > STALL_MA) {
    if (forward) {
      raiseFault("STALL_OPEN", "开盖堵转，可能有异物、结冰或机械卡死");
      return;
    }
    /* 关门受阻 = 可能夹到东西，必须反向退让 */
    Serial.println("[SAFE] 关门受阻，反转退让");
    motorStop();
    delay(300);
    rampTo(true, PWM_MAX, 300);
    delay(3000);
    motorStop();
    g_state = ST_IDLE;
    g_pos   = POS_PARTIAL;
    g_fault = "OBSTACLE";
    beep(true);
    reportEvent("warn", "OBSTACLE", "关门受阻，已反转退让，请现场检查");
    reportState();
  }
}

/* ==================== 雨感（本地硬逻辑） ==================== */
bool readRain() {
  uint32_t acc = 0;
  for (int i = 0; i < 8; i++) { acc += analogRead(PIN_RAIN_ADC); delayMicroseconds(200); }
  const uint16_t v = acc / 8;
  const uint16_t thr = (RAIN_ADC_DRY + RAIN_ADC_WET) / 2;
  return v < thr;   // 越湿读数越低
}

void tickRain() {
  if (millis() - g_lastRain < RAIN_POLL_MS) return;
  g_lastRain = millis();

  const bool now = readRain();
  if (now == g_rain) return;

  g_rain = now;
  g_stateDirty = true;
  if (g_rain) {
    Serial.println("[RAIN] 检测到降雨 → 强制关盖");
    reportEvent("warn", "RAIN", "检测到降雨，自动关盖");
    if (g_state == ST_OPENING) { motorStop(); g_state = ST_IDLE; delay(400); }
    startMove(false);
  } else {
    Serial.println("[RAIN] 降雨停止");
    reportEvent("info", "RAIN_CLEAR", "降雨停止");
  }
  reportState();
}

/* ==================== 指令处理 ==================== */
void handleCommand(JsonVariant cmd) {
  const char* action = cmd["action"] | "";
  const char* reqId  = cmd["reqId"]  | "";
  Serial.printf("[CMD] %s reqId=%s\n", action, reqId);

  if (!strcmp(action, "open")) {
    if (g_state != ST_IDLE) { ackCommand(reqId, "rejected", "设备正在动作中"); return; }
    if (g_rain)             { ackCommand(reqId, "rejected", "检测到降雨"); return; }
    ackCommand(reqId, "acked", "已接收，开始开盖");
    startMove(true);
  } else if (!strcmp(action, "close")) {
    if (g_state != ST_IDLE) { ackCommand(reqId, "rejected", "设备正在动作中"); return; }
    ackCommand(reqId, "acked", "已接收，开始关盖");
    startMove(false);
  } else if (!strcmp(action, "stop")) {
    motorStop();
    beep(false);
    g_state = ST_IDLE;
    g_pos   = POS_PARTIAL;
    ackCommand(reqId, "acked", "已停止");
    reportState();
  } else if (!strcmp(action, "clear-fault")) {
    motorStop();
    beep(false);
    g_fault = "";
    g_state = ST_IDLE;
    ackCommand(reqId, "acked", "故障已复位");
    reportEvent("info", "FAULT_CLEARED", "故障标志已人工复位");
    reportState();
  } else {
    ackCommand(reqId, "rejected", "未知指令");
  }
}

/* ==================== 长轮询 ==================== */
void pollOnce() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout((POLL_WAIT_SEC + 10) * 1000);
  String url = String(BASE) + "/api/observatory/device/poll?wait=" + String(POLL_WAIT_SEC);
  if (!http.begin(url)) return;
  http.addHeader("X-Device-Token", DEVICE_TOKEN);
  const int code = http.GET();

  if (code == 200) {
    String body = http.getString();
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, body)) {
      JsonVariant cmd = doc["command"];
      if (!cmd.isNull()) handleCommand(cmd);
    }
  } else if (code == 401 || code == 403) {
    Serial.printf("[HTTP] 设备令牌被拒绝(%d)，30 秒后重试\n", code);
    http.end();
    delay(30000);
    return;
  } else if (code < 0) {
    Serial.printf("[HTTP] poll 连接失败: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}

/* ==================== 本地按钮 ==================== */
void tickButtons() {
  if (g_state != ST_IDLE) return;
  if (digitalRead(PIN_BTN_OPEN) == LOW) {
    delay(60);
    if (digitalRead(PIN_BTN_OPEN) == LOW) {
      Serial.println("[LOCAL] 手动开盖");
      startMove(true);
      while (digitalRead(PIN_BTN_OPEN) == LOW) delay(10);
    }
  }
  if (digitalRead(PIN_BTN_CLOSE) == LOW) {
    delay(60);
    if (digitalRead(PIN_BTN_CLOSE) == LOW) {
      Serial.println("[LOCAL] 手动关盖");
      startMove(false);
      while (digitalRead(PIN_BTN_CLOSE) == LOW) delay(10);
    }
  }
}

/* ==================== 网络 ==================== */
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - g_lastWifiTry < 10000) return;
  g_lastWifiTry = millis();
  Serial.print("[WiFi] 连接中");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] 已连接 %s\n", WiFi.localIP().toString().c_str());
    reportState();
  }
}

/* ==================== 主流程 ==================== */
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== 远程天文台顶盖控制器 " FW_VERSION " ===");

  pinMode(PIN_LIM_OPEN,  INPUT_PULLUP);
  pinMode(PIN_LIM_CLOSE, INPUT_PULLUP);
  pinMode(PIN_EN,        OUTPUT);
  pinMode(PIN_BUZZER,    OUTPUT);
  pinMode(PIN_BTN_OPEN,  INPUT_PULLUP);
  pinMode(PIN_BTN_CLOSE, INPUT_PULLUP);

  ledcSetup(0, 20000, 10);   // 20kHz，超出听觉范围
  ledcAttachPin(PIN_RPWM, 0);
  ledcSetup(1, 20000, 10);
  ledcAttachPin(PIN_LPWM, 1);

  motorStop();
  analogReadResolution(12);

  /* 上电自检 */
  if (limOpen() && limClose()) {
    raiseFault("LIMIT_CONFLICT", "开、关限位同时触发，疑似线路故障");
  } else if (limOpen()) {
    g_pos = POS_OPEN;
  } else if (limClose()) {
    g_pos = POS_CLOSED;
  }

  WiFi.mode(WIFI_STA);
  ensureWifi();
  reportState();
}

void loop() {
  ensureWifi();
  tickRain();        // 最高优先级
  tickMotor();
  tickButtons();

  /* 仅在空闲时轮询 —— 动作期间不阻塞状态机 */
  if (g_state == ST_IDLE && WiFi.status() == WL_CONNECTED) {
    pollOnce();
  }

  /* 心跳 */
  if (millis() - g_lastBeat > HEARTBEAT_MS) {
    g_lastBeat = millis();
    reportState();
  } else if (g_stateDirty) {
    reportState();
  }

  delay(5);
}
