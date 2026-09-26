# 变更记录

本文件按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式书写，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> 两点约定：
> 1. **发布状态以 `git log` 为准**，本文件只记录**已落地**的变更，不预告计划。
> 2. 当前版本号为 `0.1.0`：功能与安全闸门已可用，但立项时最关注的 **≥24 小时挂机稳定性**
>    尚未验证（见文末「未验证」），因此不足以称 `1.0.0`。

## 0.1.0 - 2026-09-26

首个可交付版本。按「立即档 → 短期档 → 长期档」三轮推进，
**立即-1 ~ 立即-10、短期-1 ~ 短期-17、长期-1 ~ 长期-4① 全部落地**；长期-4② 未做（见「未验证」）。

### 长期档（架构变更）

- **长任务异步化**：全盘扫描、磁盘清理计划与执行等原本同步阻塞的 `execFileSync` 调用点改为
  `execFile`，统一登记进 `lib/tasks.js` 任务注册表，具备进度、取消、超时与单飞能力。
  扫描期间事件循环不再被占住（实测在飞的盘扫描期间 `GET /api/health` 约 2ms 返回）。
- **任务接口**：`GET /api/jobs`、`GET /api/jobs/:id`、`POST /api/jobs/:id/cancel`；
  传输契约集中在 `server/routes/memory.js` 的 `TASK_ERROR_STATUS`——
  同一长任务并发重复请求 **409 `TASK_BUSY`**、超时 **504 `TASK_TIMEOUT`**、
  执行中被取消 **409 `TASK_CANCELLED`**、取消未运行的任务 **409 `TASK_NOT_RUNNING`**、
  未知任务 id **404 `TASK_NOT_FOUND`**。取消会把 `AbortSignal` 透传到底层 `execFile`，
  **连带结束正在跑的 PowerShell 子进程**，不留孤儿进程。
- **前端**：长任务显示进度百分比与当前步骤，并带「取消」按钮。
- **验证能力入仓库**：`server/services/__tests__/` 下 25 个测试套件脱敏后随仓库分发
  （只依赖 `%TEMP%` 沙箱与系统 PowerShell，不含本机路径/用户名），配 `npm test`
  入口与 Windows CI；并补了真实 stdio 管道编码对照测试。
  端到端运行器（`tests/run-tests.js`、`tests/regenerate-baseline.js`、`tests/fixture.js`）
  同样随仓库分发——`.gitignore` 只定向放行这三个脚本，本机基线 `baseline.json`
  与运行产物（`*-state.json`、`test-results.json`、`*.log`）仍留在本地；
  脚本内所有输入/产物路径改为以 `__dirname` 为锚点，**从任意工作目录执行结果一致**。
- **统一数据与配置布局**：新增 `lib/paths.js`（唯一路径来源）、垃圾路径唯一来源
  （`diskSpace` 只列词典 id，消除与 `junkDict` 的双源漂移）、驱动器枚举进程内缓存。
- **删除性能基准**：有真机实测记录（长期-4①）。

### 短期档（结构性清理）

- **批量上限改为服务端下发**：`GET /api/health` 返回 `batchLimit`，前端不再写死；
  `cleanupService.BATCH_LIMIT` 为唯一来源。
- **错误码 → 用户文案映射**：`errorMapping.test.js` 手工维护 `USER_FACING_CODES`（74 个码）
  与 `EXEMPT` 豁免清单，新增错误码若既无文案也未豁免则测试失败；另加一条**反向扫描**，
  从 `server/**/*.js` 抓出全部 `code: 'X'` / `err.code = 'X'` 字面量与该清单做差集，
  服务端新增错误码而清单没跟上时会直接测试失败（不再靠人肉核对）。
- **可访问性**：补 `aria-live` 区域、键盘可展开行（Enter/Space）、`focus-visible` 焦点环、
  风险标签的非纯颜色提示，并有 `a11y.test.js` 静态断言守着这些属性不被删掉。
- **文档单一事实来源**：`README_CN.md` 为唯一源，`README.md` 为英译镜像。
  删除重叠的 `DESCRIPTION.md`（内容已并入 README「简介」）；README 顶部不再承载
  版本号与提交号，改为指向 `git log` 与本文件；根目录的定向验证脚本与探针
  （`_*.js`、`_*_results.json`）统一收纳进 `tools\`。
- 以及：`appGrouper` 两趟解析 + 环路保护、重型读接口 single-flight、消除重复采集、
  按实际盘符聚合的 `driveFreeBytes`（`systemDeltaBytes` 语义由「C+D」变为「全部固定盘」，
  已同步 UI 文案与 README）、PowerShell 参数化 + 路径规范化、异步路由统一 rejection 捕获、
  启动器端口占用提示、`purgeExpiredBackups()` 定时化、字典热路径缓存、
  抽取 `lib/auditLog.js` 与 `lib/psRunner.js`、审计日志轮转与保留、统一分页语义。
- **树杀范围改为 fail-closed**：强制结束前先枚举目标全部后代，**子树里只要出现一个受保护进程
  就整体拒绝该目标**（`tree_contains_protected`）；进程表读不出来或子树无法判定时按
  「无法核实」拒绝（`tree_check_failed`）。该判定发生在前端「优雅关闭」之前。

### 立即档（低风险高收益）

- **HTTP 访问控制**：服务启动生成一次性 64 位令牌并内嵌首页；
  写接口与一切非豁免的读接口都必须带 `X-CC-Token`，`Host` 必须是环回地址、
  跨源 `Origin` 一律拒绝、有请求体的写请求必须是 `application/json`。
- **批量上限闸门真实生效**：原先前端恒传 `force` 使该闸门形同虚设，
  现把「放行批量」（`acknowledgeBatchLimit`）与「强制结束」（`force`）拆成两个独立参数。
- **磁盘禁止路径覆盖全部本地盘符**：由原先只对 C/D 盘生效改为按本机盘符动态生成。
- **补安全响应头**：`X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy`。
- 以及：删除无效采集并停止命令行落盘、收紧迁移 `inspect` 鉴权、缓存管理员状态、
  `Host` 缺失改为拒绝、树杀路径前缀匹配补分隔符、前端风险取值兜底、
  仓库卫生整理、新增 `package.json` 基础字段与 `LICENSE`。

### 修复

- 修复令牌注入导致界面全面 403（P0）。
- 修复迁移复制同步阻塞事件循环，并修回滚清理与失败留痕。
- 修复 UAC 点「否」后按钮卡死 90 秒（改 6 秒取消判定 + 三分支恢复按钮）。
- 迁移预检加占用抽样探测；磁盘闸门改连续双采样（任一轮忙即拒绝）。
- 修复**迁移测试污染真实迁移记录**：迁移用例跑的是真迁移，记录原先会追加进
  `data/cache-migrations.json`——即界面「可撤销的迁移记录」读的那份，于是每跑一次测试
  就多几条指向 `%TEMP%`、早已被删除的沙箱记录。现给状态文件加了仅供测试使用的
  `CC_MIGRATE_STATE_FILE` 出口，测试改指临时文件并在结束时清理（默认行为不变，详见 `遗留.md` 遗留-37）。
- 修复**测试基线把运行期产物当成生产源码**：`tests/baseline.json` 原先会继承上一份基线的全部条目，
  于是 `data/snapshot.json`（应用每次扫描都重写的状态文件）被钉成「源码」——只要正常用过一次应用
  而源码一行未动，端到端 T0.4 就报「生产源码内容变化」。现基线只由「git 追踪的源码 + 本地测试套件」
  构成，重建脚本另加一条防回退断言：清单里只要出现被 `.gitignore` 忽略的文件就拒绝写盘并列出文件名
  （详见 `遗留.md` 遗留-38）。

### 安全边界（如实说明）

- 访问控制是**抬高门槛，不是绝对隔离**：令牌由首页下发，外部网页受同源策略限制读不到它；
  但**本机程序仍可读取本地文件或首页拿到令牌**。真正的强隔离需改用命名管道等进程间通道。
- 释放量按**各成功进程的工作集下降量**统计，属刻意保守口径，不计入进程退出后系统连带回收的部分。
- 未调用 `NtSetSystemInformation` 等未公开内核 API，不清空 Standby / Modified 页列表。
- 磁盘忙碌闸门读的是 WMI「格式化」性能计数器，**空载时也会偶发毛刺**（实测 6 次采样里有 1 次读到
  84.2MB/s）。判定刻意保持 fail-closed，因此偶有可能拒绝一次本可执行的清理——代价是「再点一次」，
  放行错误则是「高 I/O 下修剪放大抖动」，两个方向不对称（详见 `遗留.md` 遗留-36）。

### 未验证

- **≥24 小时挂机稳定性未做**。这是立项时最关注的红线（Mem Reduct 蓝屏经历），
  目前只有真机 6 轮磁盘闸门采样（5 次正确拒绝、空闲 2/2 放行）与短时高频验证，
  **不能代替长时间稳定性**。执行时须记录内存/句柄增长曲线与 `GET /api/jobs` 的 `running` 计数。
- 真实断链 symlink 的检查器分支、可访问性读屏实测（NVDA / Narrator）均只有静态断言或沙箱证据。
