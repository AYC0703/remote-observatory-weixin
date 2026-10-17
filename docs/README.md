# 项目文档索引

「远程天文台使用申请审批及统计系统」项目文档（微信小程序版）。

## 文档清单

| 文档 | 内容简介 | 主要读者 |
| --- | --- | --- |
| [MINIPROGRAM_DESIGN.md](./MINIPROGRAM_DESIGN.md) | 微信小程序改造设计：总体架构、页面映射、鉴权、图表与导出方案、校验与测试 | 开发者 |
| [PRD.md](./PRD.md) | 产品需求文档：背景、目标、角色权限、功能需求、业务流程、非功能需求、验收标准 | 需求方 / 产品 / 开发者 |
| [TECH_DESIGN.md](./TECH_DESIGN.md) | 技术架构、模块划分、关键流程、核心算法、安全设计 | 开发者 |
| [HARDWARE_DESIGN.md](./HARDWARE_DESIGN.md) | 观测站顶盖远程控制：架构、权限联锁、通信协议、指令生命周期、自动策略、配置项、硬件安全要求 | 开发者 / 硬件负责人 |
| [DATABASE_DESIGN.md](./DATABASE_DESIGN.md) | 数据模型、ER 关系、表结构字段明细、枚举与时间约定 | 开发者 |
| [API.md](./API.md) | REST API 接口清单：路径、权限、参数、响应、错误码与调用示例 | 前端 / 联调方 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 环境要求、安装启动、环境变量、生产部署、备份恢复、故障排查 | 运维 / 部署人员 |
| [TESTING.md](./TESTING.md) | 测试环境、功能 / 安全 / 兼容性测试用例与执行结果、验收清单 | 测试 / 验收方 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更记录 | 全体成员 |
| [ORIGINAL_README.md](./ORIGINAL_README.md) | 原网页版根 README（历史参考） | 全体成员 |

### S50 校园智能天文台（立项材料）

| 文档 | 内容简介 | 主要读者 |
| --- | --- | --- |
| [S50立项书.md](./S50立项书.md) | 立项书正文的 Markdown 转写（18 页 PDF，**忠实原文，含其中的错误数字**） | 全体成员 / 评审方 |
| [S50审阅问题清单.md](./S50审阅问题清单.md) | 转写中发现的金额矛盾、逻辑冲突、安全缺项、工程计算与图纸问题清单 | 指导教师 / 项目负责人 |
| [S50附件索引.md](./S50附件索引.md) | 附件清单、图纸对照、三个 xlsx 与经费预算明细表的转写 | 全体成员 |
| [S50楼顶勘察清单.xlsx](./S50楼顶勘察清单.xlsx) | **现场勘察工具**：66 项楼顶勘察清单 + 23 项关键尺寸实测 + 工具与拍照清单，对应审阅清单组 9 | 项目负责人 / 现场勘察人员 |
| [`attachments/`](./attachments/) | 前期资料（已脱敏）：`S50前期资料01_技术问题清单.xlsx`（原 `Q&A.xlsx`）、`S50前期资料02_成本清单.xlsx`（原 `costs.xlsx`）、`S50前期资料03_远程控制专项选型报价.xlsx`（原 `远程方面专项costs.xlsx`）。**立项书 PDF 原件因含真实姓名未收录**，内容见转写稿 | 全体成员 |
| [`assets/`](./assets/) | 图纸与表格：`S50图纸01`~`S50图纸03`、`S50经费预算明细表.png` | 全体成员 |

## 阅读路径建议

- **第一次接触项目** → 先读 [MINIPROGRAM_DESIGN.md](./MINIPROGRAM_DESIGN.md) 了解改造，再读 [PRD.md](./PRD.md) 了解业务，最后读 [TECH_DESIGN.md](./TECH_DESIGN.md) 了解实现
- **小程序开发 / 接口联调** → [MINIPROGRAM_DESIGN.md](./MINIPROGRAM_DESIGN.md) + [API.md](./API.md) + [DATABASE_DESIGN.md](./DATABASE_DESIGN.md)
- **接硬件 / 装顶盖控制器** → [HARDWARE_DESIGN.md](./HARDWARE_DESIGN.md) + [firmware/cover-controller/README.md](../firmware/cover-controller/README.md)
- **S50 立项评审 / 硬件施工前复核** → [S50审阅问题清单.md](./S50审阅问题清单.md) → 先看 **组 9 选址变更连带问题**（地面→楼顶）与 **组 3 安全缺项**，再看 **组 1 金额矛盾**
- **上教学楼楼顶做现场勘察** → 带上 [S50楼顶勘察清单.xlsx](./S50楼顶勘察清单.xlsx)（打印或平板），它把审阅清单组 9 拆成了 66 个可逐项打勾的勘察项
- **部署上线** → [DEPLOYMENT.md](./DEPLOYMENT.md)
- **回归测试 / 验收** → [TESTING.md](./TESTING.md)

## 相关文档

- 项目根目录 [README.md](../README.md)：快速上手（后端启动、小程序导入、演示账号、项目结构）
- [firmware/cover-controller/README.md](../firmware/cover-controller/README.md)：ESP32 接线表、标定步骤、烧录方法与 curl 联调示例
