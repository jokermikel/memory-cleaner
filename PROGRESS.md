# 内存清理应用 · 第 1 批进度（步骤 1 + 2）

目标：交付「内存采集引擎 + 应用归组与中文用途词典」+ 命令行版内存排行，立刻可用。

## 分步清单

- [x] 实测采集性能与字段质量（521ms / 391 进程）
- [x] 实测内存口径差异，确定主口径为 Get-Process.WorkingSet64
- [x] 确定技术栈：零依赖（Node 内置 http + node:test），避免 npm 装包风险
- [x] 调研 GitHub 现成项目：Mem Reduct / WinMemoryCleaner / LiteMonitor 均无「按应用归组+用途」能力，第 1 批自研，第 4 步清理借鉴 WinMemoryCleaner 的 API 方案
- [x] 步骤 1：采集引擎
  - [x] `server/collectors/collect.ps1` 采集脚本（纯 ASCII，规避 PS 5.1 中文编码坑）
  - [x] `server/collectors/systemMemory.js` 整机内存 + 内存条明细
  - [x] `server/collectors/processList.js` 进程明细采集（合并双数据源）
  - [x] `server/services/memoryService.js` 汇总统一 JSON
  - [x] `server/routes/memory.js` RESTful 接口（参数校验+错误处理）
  - [x] 权限降级：239/441 进程读不到路径时不报错、不中断
- [x] 步骤 2：应用归组 + 用途词典
  - [x] `data/appDict.zh.json` 中文用途词典（70+ 条，经 Win32_Service 反查核实）
  - [x] `server/services/appGrouper.js` 归组算法（强制归组/父子跟随/svchost 折叠）
  - [x] 归组后合计 = 归组前合计（守恒校验，实测 17.51GB = 17.51GB）
- [x] 单元测试（node:test）：6/6 通过
- [x] `cli.js` 命令行版排行（第 1 批即可用）
- [x] `server/server.js` HTTP 服务 + `README.md`
- [x] 交付验收：cli 与 REST 接口均实测通过

## 第 2 批（步骤 3 + 步骤 5 只读界面）完成情况

- [x] 步骤 3：风险分级
  - [x] `data/protectedProcesses.json` 禁止结束名单（18 个系统关键进程，附理由+来源）
  - [x] `server/services/riskClassifier.js` 三色分级器
  - [x] `server/services/__tests__/risk.test.js` 单元测试（11/11 通过）
  - [x] 真实数据验证：16 保护 / 19 可清理 / 138 谨慎，全部合理
- [x] 步骤 5：只读界面
  - [x] `内存清理助手.html` 单文件界面（内置真实数据，双击即开）
  - [x] 环形图 + 指标卡 + 内存条卡片 + 应用列表（搜索/筛选/展开）
  - [x] 默认 Top 30 +「显示全部」，页面高度 18040px → 3692px
  - [x] check_page 无报错，截图视觉检查通过

## 验收结果（2026-09-17）

| 验收项 | 结果 |
|---|---|
| 单元测试 | 6/6 通过 |
| 端到端采集 | 441 进程，0 错误 |
| 归组守恒 | ✓ 17.51GB = 17.51GB |
| REST 接口 | health/apps/snapshot/404 全部实测通过 |
| cli 排行 | 正常输出 Top 应用（夸克 1.8GB / 服务宿主 1.8GB / 豆包 1.7GB / 迅雷 1.2GB） |
| 词典覆盖 | 本机 Top 消耗者全部收录（含用户新开的夸克/豆包/迅雷/QQ频道） |

## 第 3 批（步骤 4 + 步骤 6）完成情况

- [x] 步骤 4：清理执行层
  - [x] `server/collectors/cleanup.ps1` 清理脚本（优雅关闭 → 强制结束 + PID 复用防护）
  - [x] `server/services/cleanupService.js` 六道安全闸门
  - [x] `server/services/__tests__/cleanup.test.js` 单元测试
  - [x] 路由接入：`GET /api/cleanup/plan`、`POST /api/cleanup/execute`
  - [x] 实测：防误杀生效（错误启动时间被拒，进程安然无恙）
  - [x] 实测：真实清理成功（449.5MB 进程关闭，系统内存实测下降 358.6MB）
  - [x] 实测：三道闸门全部拦截（403 保护进程 / 400 未确认 / dry-run 不动进程）
  - [x] **修正真实性问题**：进程未退出时不报释放量（原误报 68.2MB 波动，已改为必须真有进程退出才上报）
- [x] 步骤 6：打包交付
  - [x] `build.js` 一键采集 + 生成界面
  - [x] `启动.bat` 一键启动（采集 → 生成 → 起服务 → 开浏览器）
  - [x] 服务端 `GET /` 直接返回界面（同源，清理按钮可用）
  - [x] 界面加清理面板（勾选 → 计划 → 二次确认 → 前后对比）
- [x] 回归测试：17/17 全部通过
- [x] `README.md` 完整更新

## 全部完成情况

| 步骤 | 状态 |
|---|---|
| 1 内存采集引擎 | ✅ |
| 2 应用归组 + 用途词典 | ✅ |
| 3 风险分级 + 保护名单 | ✅ |
| 4 清理执行层 | ✅ |
| 5 界面层 | ✅ |
| 6 打包交付 | ✅ |
| 7 整体验收 | 部分（见下） |

## 第 7 步验收状态

| 验收项 | 状态 |
|---|---|
| 内存总量准确性 | ✅ 对齐任务管理器口径 |
| 进程覆盖完整性 | ✅ 400+ 进程 100% 归组 |
| 归组金额守恒 | ✅ 单元测试断言 |
| 用途说明覆盖率 | ✅ 本机 Top 消耗者全覆盖 |
| 风险分级正确性 | ✅ 16 保护进程零误判 |
| 清理安全性 | ✅ 保护进程 100% 被拦截 |
| 释放量真实性 | ✅ 有进程退出才上报 |
| 单元测试 | ✅ 17/17 |
| 界面清晰度 | ✅ check_page 无报错 |
| 管理员权限路径 | ✅ 界面「提升权限」按钮 → UAC → 管理员重启 |

---

## 磁盘清理模块（新增）

计划文档：`磁盘清理模块_实施计划.md`

- [x] GitHub 调研：MangoDisk 等均不能直接嵌入，自研
- [x] 第 1 步：磁盘扫描引擎
  - [x] 实测逐文件递归 260s 不可用；robocopy /L 扫 Users 18s（639,662 文件 / 240GB）
  - [x] `server/collectors/diskScan.ps1` 扫描脚本
  - [x] `server/collectors/diskSpace.js` Node 封装
  - [x] `server/services/diskService.js` 汇总
  - [x] `server/services/__tests__/disk.test.js` 3/3 通过
  - [x] `disk-cli.js` 命令行排行
  - [x] `GET /api/disk/snapshot` 接口
  - [x] 实测 C 盘：400GB / 已用 320GB / Users 224.24GB
  - [x] 实测 D 盘：551.6GB / 已用 418.5GB / youxi 178GB + steam 116GB，覆盖率 99.8%
  - [x] 垃圾路径：用户 Temp 912.8MB、更新缓存 285.9MB
- [x] 第 2 步：垃圾定位器（分类词典）
  - [x] `data/junkDict.zh.json` 21 条，全部本机路径实测
  - [x] `server/services/junkLocator.js` 扫描 + 父子路径去重
  - [x] `server/services/__tests__/junk.test.js` 3/3 通过
  - [x] `GET /api/disk/junk` + `disk-cli.js` 输出分类清单
  - [x] 实测可安全清理 **19.16 GB**（NVIDIA DXCache 15.39 GB 为最大头）
  - [x] 谨慎项 6.89 GB（微信/腾讯视频/HuggingFace，默认不勾选）
- [x] 第 3 步：空间占用分析（按应用归类）
  - [x] `data/diskAppMap.json` 路径→应用映射（本机实测，含 Play Games 80GB 拆分）
  - [x] `server/services/diskAnalyzer.js` 最长前缀 + 父子去重
  - [x] `server/services/__tests__/diskAnalyzer.test.js` 3/3 通过
  - [x] `GET /api/disk/apps` + `disk-cli.js` 输出应用排行
  - [x] 实测 Top：youxi 178GB / Steam 116GB / Google Play 游戏 80GB / 解限机 47GB
- [x] 第 4 步：清理执行层
  - [x] `server/services/diskCleanupService.js` 白名单 + dry-run + 禁止根目录 + 审计日志
  - [x] `server/services/__tests__/diskCleanup.test.js` 5/5 通过
  - [x] `GET /api/disk/cleanup/plan` `POST /api/disk/cleanup/execute`
  - [x] 实测计划：14 项 safe，预计 19.16 GB（NVIDIA 15.39 GB 最大）
- [x] 第 5 步：界面集成
  - [x] 内存 / C·D 磁盘 双标签页
  - [x] `GET /api/disk/volumes` 毫秒级分区概览
  - [x] 扫描垃圾 / 按应用占用 / 勾选删除（二次确认）
  - [x] check_page 无报错

