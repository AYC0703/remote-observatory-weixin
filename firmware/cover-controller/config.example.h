/*
 * 复制本文件为 config.h 并填入真实值。
 * config.h 已加入 .gitignore，不会提交到仓库。
 *
 *   cp config.example.h config.h
 */

#pragma once

/* ---------- Wi-Fi ---------- */
#define WIFI_SSID   "OBS_AP"
#define WIFI_PASS   "change-me"

/* ---------- 后端地址 ----------
 * 只填协议 + 主机 + 端口，不要带结尾斜杠、不要带路径。
 *   http://192.168.1.10:3000     局域网直连
 *   https://obs.example.edu      公网（务必用 HTTPS，令牌是明文 Bearer）
 */
#define BASE        "http://192.168.1.10:3000"

/* ---------- 设备令牌 ----------
 * 在小程序「观测站控制 → 接入管理」生成，形如 cov_xxxxxxxx...
 * 每个设备一份，互不相同；重置后立即失效。
 */
#define DEVICE_TOKEN "cov_replace_with_your_token"
