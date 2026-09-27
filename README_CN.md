# 内存清理应用

**简体中文** | [English](README.md)

> **本文档是唯一事实来源（source of truth）**：改动先改这一份，再同步到英文对照版 [README.md](README.md)；
> 两份内容不一致时以本文件为准。
> 易变的发布状态（提交号、版本号）一律以 `git log` 为准，刻意不写进 README；逐版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

读电脑全部内存、按应用归组显示占用与用途、一键清理（带多重安全防护）。

---

## 简介

**内存清理助手**（Memory Cleaner）是一个面向 Windows 的本地内存与磁盘清理工具。

它读取整机内存数据，把零散进程按「应用」归组，展示每个应用占用了多少内存、有什么用途，并按安全等级分红/黄/绿三色标注；用户勾选后可一键结束进程释放内存，也可只修剪工作集（不关程序）。另带磁盘清理模块，能按应用归类磁盘占用、定位可清理的缓存与垃圾文件；缓存还可以「搬走 + 目录链接」到其他盘，而不是删掉后等程序重建。

技术上**零依赖**——后端只用 Node.js 内置模块（`http`）+ PowerShell 采集脚本，前端是单文件 HTML 界面，不需要安装任何 npm 包。为保证安全，内置**九道闸门**：HTTP 访问控制（一次性令牌 + 环回 Host + 同源 Origin）、默认 dry-run、保护进程拦截、必须二次确认、PID 复用防护、批量上限、审计日志、磁盘忙碌拒绝，以及「禁止未公开内核 API」硬红线——只结束进程或调用 `EmptyWorkingSet` / `SetProcessWorkingSetSize`，绝不清空 Standby / Modified 页列表。释放量只在进程确实退出（或修剪确实成功）后才上报，且按各成功进程的工作集统计。数据全部在你本机处理，服务只监听 `127.0.0.1`。

> **一句话版**：零依赖的 Windows 内存/磁盘清理工具：按应用归组、安全结束进程或修剪工作集，缓存可搬走并建目录链接。
---

## 功能

### 原有

- **内存体检**：按应用归组显示占用、用途、红/黄/绿风险，口径对齐任务管理器 Working Set。
- **结束进程释放内存**：先优雅关闭再强制结束；保护进程拦截、PID 复用防护、必须二次确认。
- **磁盘垃圾清理**：只删词典白名单里的缓存/临时文件，不删安装目录、游戏、文档。
- **按应用看磁盘占用**：C/D 盘路径归到应用，勾选后只清对应白名单缓存。
- **提升权限**：标题栏弹出 UAC，以管理员身份重启本地服务。

### 本次新增

- **修剪工作集（不关程序）**：调用公开 API `EmptyWorkingSet` / `SetProcessWorkingSetSize`，进程继续运行。界面「一键清理」面板有独立按钮；`POST /api/cleanup/trim`。
- **禁止未公开内核 API**：不调用 Mem Reduct 那类 `NtSetSystemInformation` 清空 Standby / Modified 页列表，降低蓝屏风险。
- **磁盘忙碌拒绝清理**：下载或拷贝大文件时（吞吐 ≥ 20MB/s 或磁盘队列 ≥ 3）返回 HTTP 409，不自动强清。
- **缓存搬走 + 目录链接**：把缓存复制到其他盘，原位置建 `mklink /J`（默认，无需管理员；可选 `/D` 符号链接）。程序仍写原路径，数据落在目标盘。失败自动回滚，原数据不丢。
- **链接检查器**：判断路径是普通目录、junction、symlink 还是断链，并显示目标。`GET /api/disk/migrate/inspect`，命令行 `node disk-cli.js inspect <路径>`。
- **内存条按本机条数显示**：现场读 `Win32_PhysicalMemory`；PowerShell 5.1 单条收成对象时也会收成数组，笔记本 1 条、台式机多条都能显示。

### 长期档新增（2026-09-26）

- **长任务进度与取消**：全盘扫描、磁盘清理计划与执行改为**后台异步任务**，界面显示进度百分比与当前步骤，并可随时「取消」——取消会连带结束底层 PowerShell 子进程，不会留下孤儿进程。同一任务已在飞时再点一次会明确提示「正在执行」（409 `TASK_BUSY`），不再出现「按钮点了没反应、也不知道跑了多久」。进度与取消接口见下方「接口一览」。

### 本次安全加固与一致性修复（2026-09-23）

按评审清单完成 13 项改动，其中 P0 三项补齐了「文档承诺」与「代码事实」的差距：

- **HTTP 访问控制**：服务启动生成一次性令牌并内嵌首页；写接口与昂贵的扫描接口都校验令牌，非环回 `Host`、跨源 `Origin` 一律拒绝，写请求体必须是 `application/json`。
- **批量上限闸门真实生效**：原先前端恒传 `force` 使这道闸门形同虚设；现已把「放行批量」与「强制结束」拆成两个独立参数。
- **磁盘禁止路径覆盖全部本地盘符**：原先只对 C/D 盘生效，现按本机盘符动态生成。
- 另有 10 项跨机器 / 一致性 / 体验修复（垃圾扫描盘符动态化、PID 复用防护补齐回退、释放量改可归因口径、词典不再写死本机数值等）。

完整实施记录见 **`改动清单_实施总账.md`**（含逐项改动、实测数据，以及 4 处对原评审建议的推翻说明）。

## 快速上手

### 方式一：一键启动（推荐，功能完整）
双击 **`启动.bat`**。它会自动：
1. 采集一次实时内存数据
2. 生成界面
3. 启动本地服务并打开浏览器

界面地址：http://127.0.0.1:7788/ —— 在这个页面里**清理功能可用**。

### 方式二：直接看界面（只读）
双击 **`内存清理助手.html`**。内置数据快照，无需启动任何东西，但清理按钮不可用——本地文件既访问不到接口，也拿不到服务下发的一次性访问令牌（写接口会返回 403 `UNAUTHORIZED`，界面会提示改用服务地址打开）。

### 方式三：命令行
```bash
node build.js       # 重新采集并生成界面
node cli.js         # 内存排行（前 30）
node cli.js safe    # 只看可安全清理的
node cli.js 抖音    # 搜索应用
node disk-cli.js         # C/D 分区 + 可清理垃圾（约 3 秒）
node disk-cli.js plan    # dry-run 清理计划（不删文件）
node disk-cli.js apps    # 按应用归类占用（约 30~60 秒）
node disk-cli.js C       # 只扫 C 盘一级目录（垃圾清单与 Web 端一致，含回收站）
node disk-cli.js D       # 只扫 D 盘一级目录
node disk-cli.js inspect <路径>          # 检查是否为 junction/symlink/断链
node disk-cli.js migrate <源> <目标>     # 缓存迁移 dry-run（默认 mklink /J）
```

## 清理功能怎么用

1. 打开 http://127.0.0.1:7788/
2. **在应用列表前面勾选**要处理的应用（🔴 保护项无法勾选）
3. 顶部工具栏会显示「已选 N 个应用，预计释放 X」；点「结束已选应用」→ 弹窗二次确认 → 执行
4. 也可以继续用底部「🧹 一键清理」面板：点「生成清理计划」后勾选再执行。同一面板有「修剪工作集（不关程序）」——只收缩工作集，不结束进程。
5. 磁盘页下方「📦 缓存搬走」：选预置缓存目录或手填源/目标 → 预检 → 确认。默认在原位置建目录联接（`mklink /J`，无需管理员）；程序仍写原路径，数据落在目标盘。

磁盘页「按应用看占用」同样带勾选：只能勾有白名单缓存的应用，删除的是缓存/临时文件，**不会删安装目录、游戏或文档**。缓存若希望永久挪出 C 盘，优先用「搬走」而不是删除。

清理后显示**前后对比**：清理前 → 清理后、实际释放多少、失败原因是什么。

## 九道安全闸门（都写在代码里，不靠自觉）

| 闸门 | 行为 |
|---|---|
| 0. HTTP 访问控制 | 服务启动生成一次性 64 位令牌并内嵌到首页；**写接口（`POST`）与一切非豁免的读接口**都必须携带 `X-CC-Token`（只有 `/api/health`、`/api/disk/volumes` 等毫秒级无副作用的接口免令牌），且 `Host` 必须是环回地址、跨源 `Origin` 一律拒绝、有请求体的写请求必须是 `application/json` |
| 1. 默认 dry-run | 不传 `dryRun:false` 就只出计划，绝不动进程 |
| 2. 保护进程拦截 | 选中系统关键进程直接拒绝，返回 HTTP 403 + 中文原因；强制结束会连带整棵子树，**子树里只要出现受保护进程就整体拒绝**（详见下方「树杀范围」） |
| 3. 必须确认 | 真实执行必须传 `confirmed:true`，否则 HTTP 400 |
| 4. PID 复用防护 | 执行前比对 PID + 启动时间，不一致则拒绝（防误杀刚启动的新进程） |
| 5. 批量上限 | 一次超过 20 个进程，必须显式传 `acknowledgeBatchLimit:true`；`force` 只表示强制结束，不能用来放行批量 |
| 6. 审计日志 | 每次操作写入 `logs/cleanup-YYYYMMDD.log`，含成功/失败/原因 |
| 7. 磁盘忙碌拒绝 | 磁盘吞吐 ≥ 20MB/s 或队列 ≥ 3 时返回 HTTP 409，避免下载/拷贝期间清理 |
| 8. 禁止未公开内核 API | 不调用 `NtSetSystemInformation` 等，不清 Standby/Modified 列表 |

**访问控制的边界（如实说明）**：令牌靠首页下发，外部网页受同源策略限制读不到首页，因此拿不到令牌——这是**抬高门槛**，不是绝对隔离。本机上的程序仍可读取本地文件或首页拿到令牌。要做到真正的强隔离，需要改用命名管道等进程间通道，而不是 HTTP。

**释放量真实性**：只有在进程确实退出后才上报释放量。如果没有任何进程被关闭，释放量报 0 并说明「系统内存差值为自然波动」——不拿波动冒充效果。释放量按**各成功进程的工作集**统计（而非整机内存前后差值），避免把其它进程的自然波动算成本次战果。

**树杀范围（fail-closed）**：强制结束走的是 `taskkill /PID <pid> /T /F`，`/T` 会连带整棵子树，而被连带的子进程不会逐个查自身风险等级。为避免「点了一个安全的应用、顺手把树里的系统进程也结束了」，服务在动手前先枚举该目标的全部后代，逐个比对受保护影像名；**子树里只要出现一个受保护进程，就整体拒绝这一个目标**（`tree_contains_protected`）——不结束它的任何进程，也不做「跳过危险的那个、结束其它」的部分结束。同理，进程表读不出来、子树无法判定时一律按「无法核实」拒绝（`tree_check_failed`），与 PID 身份无法核实时的处理保持一致。受保护影像名有两处来源：`data/protectedProcesses.json` 的全量名单，以及本次快照里被判为 protected 的应用的进程名（有些分级只写在词典里，只看名单文件会漏）。该判定发生在前端「优雅关闭」之前，因此「拒绝」严格等于「这个目标一个进程都没动」。树杀闸门只在真正会用到 `/T` 的强制结束分支启用；纯优雅关闭不带 `/T`，不触发本闸门。

## 接口一览

所有接口都需要在请求头带 `X-CC-Token`（令牌从首页 HTML 的 `window.__CC_TOKEN__` 读取），**例外是几个毫秒级、无副作用的接口**：`/api/health`、`/api/cleanup/io`、`/api/disk/volumes`、`/api/disk/migrate/records`、`/api/privilege/status`。以 `server/server.js` 的 `CHEAP_READ_PATHS` 为唯一准据；不在其中的一律需要令牌，读接口也不例外。

为什么连读接口也要令牌：`/api/disk/snapshot` 与 `/api/disk/apps` 会做 30~60 秒的全盘扫描，若免令牌，任何网页用一个 `<img src="http://127.0.0.1:7788/api/disk/snapshot">` 就能反复触发（img 请求不带 `Origin`，来源校验挡不住，但它**一定带不上自定义请求头**）。`Host` / `Origin` 校验则对所有 `/api/*` 生效。

**长任务一律异步执行**：全盘扫描、磁盘清理计划与执行这些要跑 robocopy / PowerShell 的活儿（单次 30~60 秒，删除可能更久），统一登记进 `lib/tasks.js` 的任务表后在后台跑——扫描期间事件循环不再被占住，其它请求照常响应（实测：在飞的盘扫描期间 `GET /api/health` 约 **2ms** 返回）。前端据此显示进度百分比与文案，并可「取消」；取消会把 `AbortSignal` 透传到底层 `execFile`，**连带结束正在跑的 PowerShell 子进程**。

由此得到的传输契约（实现在 `server/routes/memory.js` 的 `TASK_ERROR_STATUS`，各接口不得自行解释）：

| 情况 | 响应 |
|---|---|
| 同一个长任务已在飞（如扫描中再点扫描） | **409** `TASK_BUSY` |
| 任务超时（各任务构造时给定 `timeoutMs`） | **504** `TASK_TIMEOUT` |
| 请求在任务执行期间被取消 | **409** `TASK_CANCELLED` |
| 取消一个已结束 / 从未运行的任务 | **409** `TASK_NOT_RUNNING` |
| 查询未知的任务 id | **404** `TASK_NOT_FOUND` |

响应形状刻意保持不变：成功仍是 200 + 原来的 JSON，前端与既有回归用例不需要区分「同步 / 异步」两种返回。

| 接口 | 说明 |
|---|---|
| `GET /` | 界面（与服务同源，清理可用） |
| `GET /api/health` | 健康检查（含 `isAdmin`、`batchLimit`） |
| `GET /api/memory/snapshot` | 完整快照（系统 + 应用 + 分级 + 守恒） |
| `GET /api/memory/apps?risk=safe&q=抖音&limit=20` | 应用排行 |
| `GET /api/memory/processes?q=chrome` | 进程明细 |
| `GET /api/cleanup/plan` | 清理计划（dry-run） |
| `POST /api/cleanup/execute` | 执行清理（需 `confirmed:true`；进程数 > 20 时还需 `acknowledgeBatchLimit:true`） |
| `GET /api/cleanup/io` | 磁盘忙碌采样（吞吐/队列） |
| `GET /api/cleanup/trim/plan` | 工作集修剪计划（dry-run） |
| `POST /api/cleanup/trim` | 修剪工作集（公开 API，需 `confirmed:true`） |
| `GET /api/disk/volumes` | C/D 分区容量（毫秒级） |
| `GET /api/disk/snapshot` | C/D 盘占用快照（一级目录 + 已知垃圾路径，约 30~60 秒） |
| `GET /api/disk/junk` | 可清理垃圾分类清单（约 3 秒） |
| `GET /api/disk/apps` | 按应用归类的磁盘占用 |
| `GET /api/disk/cleanup/plan` | 磁盘清理计划（dry-run） |
| `POST /api/disk/cleanup/execute` | 执行磁盘清理（需 confirmed=true，只删白名单路径） |
| `GET /api/disk/migrate/presets` | 评估常见缓存目录是否可搬走（需要页面访问令牌） |
| `GET /api/disk/migrate/inspect?path=` | 链接检查器（普通目录 / junction / symlink / 断链） |
| `GET /api/disk/migrate/records` | 已迁移记录 |
| `POST /api/disk/migrate/precheck` | 迁移预检 |
| `POST /api/disk/migrate/execute` | 缓存搬走 + 建链接（默认 junction，需 confirmed=true） |
| `GET /api/privilege/status` | 当前是否管理员、能否提权 |
| `POST /api/privilege/elevate` | 弹出 UAC，以管理员身份重启服务（`dryRun:true` 只出计划） |
| `GET /api/jobs` | 长任务进度：在飞任务（含 `percent` / `message` / `state`）+ 最近完成，另带 `running` 计数 |
| `GET /api/jobs/:id` | 单个任务详情；未知 id 返回 404 `TASK_NOT_FOUND` |
| `POST /api/jobs/:id/cancel` | 取消在飞长任务（202 + 任务快照）；已结束返回 409 `TASK_NOT_RUNNING` |

## 目录结构
```
启动.bat                      一键启动（采集 + 生成 + 起服务 + 开浏览器）
build.js                      采集数据并生成界面
cli.js                        命令行排行
内存清理助手.html            单文件界面（内嵌数据，双击可看）
lib/
  paths.js                   路径唯一来源（ROOT/DATA/HTML_FILE/collector/data 等锚点）
  psRunner.js                PowerShell 调用唯一实现（同步/异步四函数 + 参数转义 + 输出清洗）
  tasks.js                   长任务注册表（进度 / 取消 / 超时 / 单飞），见「接口一览」的传输契约
  dictCache.js               词典 JSON 的 mtime 缓存
  auditLog.js                审计日志写入
  ports.js                   端口探测与 EADDRINUSE 处理
server/
  server.js                   HTTP 服务（零依赖，同时提供界面和接口）
  routes/memory.js            RESTful 路由 + 参数校验 + 错误处理
  services/
    memoryService.js          汇总（采集+归组+分级）
    appGrouper.js             归组算法（强制归组/父子跟随/svchost 折叠）
    riskClassifier.js         三色风险分级器
    cleanupService.js         清理执行层（安全闸门 + 磁盘忙碌拒绝）
    workingSetService.js      工作集修剪（EmptyWorkingSet / SetProcessWorkingSetSize）
    diskIoGuard.js            磁盘忙碌闸门
    cacheMigrateService.js    缓存搬走 + 目录链接（默认 junction）
    junkLocator.js            垃圾目录定位（按词典全量）
    diskCleanupService.js     磁盘垃圾清理（白名单闸门 + 禁止路径校验）
  collectors/
    collect.ps1               内存采集脚本
    cleanup.ps1               进程清理脚本（含 PID 复用防护）
    trimWorkingSet.ps1        工作集修剪脚本（仅公开 API）
    diskScan.ps1              磁盘占用扫描（robocopy 量大小）
    processList.js            合并双数据源
    systemMemory.js           整机内存/内存条结构化
    diskSpace.js              磁盘枚举 + 占用快照（服务端）／命令行共用
data/
  appDict.zh.json             中文用途词典（70+ 条）
  junkDict.zh.json            垃圾路径词典（**唯一来源**：快照与清理都取自这里）
  protectedProcesses.json     禁止结束名单（18 个系统关键进程）
  snapshot.json               最近一次采集快照
logs/                         审计日志
```

## 关键设计（为什么这么做）

1. **主口径用 `Get-Process.WorkingSet64`**：实测同一时刻 CIM 的 `WorkingSetSize` 合计比真实已用偏大 1GB 以上，只有 WorkingSet64 对齐任务管理器。
2. **归组守恒是硬约束**：归组后应用内存合计必须严格等于归组前进程合计，否则就是有进程被丢了。
3. **用途绝不编造**：词典条目基于已在 Windows 上验证存在的常见路径；查不到显示「未收录」。词典**不预置任何机器相关的数值**——大小一律由实时扫描给出，`note` 只写量级参考与操作提醒。
4. **清理先优雅后强制**：先发关闭消息（等同点 ×，让程序自己保存），失败才强制结束。
5. **实测注意事项**：Windows 服务进程（如 `MSPCManagerService`）在普通权限下杀不掉，会返回「拒绝访问」——这是权限机制，需要以管理员身份运行。
6. **清内存只用公开 API**：结束进程或修剪工作集；绝不强制清空系统待机/修改页列表。
7. **缓存优先搬走而不是删除**：删除后程序会重建，占回 C 盘；搬走 + junction 后空间才是永久的。
8. **同一事实只留一处**：垃圾路径的唯一来源是 `data/junkDict.zh.json`，磁盘占用快照与磁盘清理都从它取；驱动器枚举只在 `diskSpace.listLocalDrives()` 实现一次（带进程内缓存）。快照只量算其中**一小部分条目**（`SNAPSHOT_JUNK_ENTRY_IDS`，每条要跑一次 robocopy），明细清单仍走词典全量——这是刻意的性能取舍，不是漏算。
9. **长任务不占事件循环**：走 PowerShell 的活儿一律异步执行并登记进任务表，扫描/删除期间服务仍能响应其它请求；同一任务只允许一个在飞，重复触发得到 409 而不是排队堆积。

## 提升权限

界面标题栏有「🛡️ 提升权限」按钮（通过 `启动.bat` 打开服务后才会出现）。

1. 点击按钮 → 弹出 Windows 用户账户控制（UAC）
2. 点「是」→ 服务以管理员身份重启，原页面自动刷新
3. 点「否」→ 什么都不改，仍是普通权限

提权后可以：结束原先「拒绝访问」的系统服务进程、读到更多进程的可执行路径。真正授权的是 UAC，应用本身提不了权。

## 已知边界
- 普通权限下约 230~240 / 400+ 个进程读不到可执行文件路径。界面上靠进程名+词典兜底，点「提升权限」后覆盖率显著提升。
- 清理 Windows 服务进程需要管理员权限，普通权限会失败并如实报告原因。
- 界面内嵌的是生成那一刻的快照，要看最新数据请重跑 `启动.bat`（提权重启也会重新采集）。
- 磁盘扫描只认 robocopy 的 Bytes/字节行。中文 Windows 的「已结束: 2026年…」不能再被当成目录大小（空的崩溃转储曾因此一直显示 2026 B）。
- 缓存搬走默认 `mklink /J`（目录联接），无需管理员、仅限本地卷；符号链接 `/D` 需要管理员或开发者模式。请先关闭占用该目录的程序，否则改名备份会失败并回滚。
- 工作集修剪不会结束进程，系统「已用内存」不一定等量下降。
- 本工具**不会**强制清空待机缓存；界面上的待机数值只是只读展示。

## 跨机器通用性（去硬编码）

本应用不假设用户名、不写死盘符，可在任意 Windows 电脑上完整运行：

- **动态盘符枚举**：磁盘模块通过 `Win32_LogicalDisk (DriveType=3)` 枚举本机所有本地固定磁盘（单 C 盘、C+D、C+D+E 均可），系统盘用 `%SystemDrive%` 求取，非系统盘自动识别为数据盘。
- **用户路径展开**：映射表与词典里的 `%LOCALAPPDATA%` / `%APPDATA%` / `%USERPROFILE%` / `%TEMP%` 在运行时展开为当前登录用户的真实路径，不再写死具体用户名。
- **回收站按盘符注入**：回收站条目（`id` 以 `recycle` 开头）在扫描时按本机所有本地盘符动态生成 `$Recycle.Bin` 路径。
- **剩余空间对比覆盖全部固定盘**：清理前后的剩余空间按本机全部本地固定盘聚合，`systemDeltaBytes` 因此也包含 E:/F: 等盘的变化（原先只读 C: 与 D: 两个盘符）。
- **无 D 盘降级**：只有系统盘时，数据盘列表为空，扫描循环安全跳过，应用仍能正常出系统盘的磁盘占用与垃圾清单。
- **内存条按本机条数显示**：物理内存来自 `Win32_PhysicalMemory`，容量/厂商/插槽/频率/代数都是这台电脑现场读的，不写死。PowerShell 5.1 在只有 1 条内存时会把数组收成对象，采集脚本和 Node 侧都强制收成数组，笔记本单条、台式机多条都能显示。

## 测试

仓库自带一套**脱敏、基于夹具**的单元测试子集（`server/services/__tests__/`）：只依赖 `%TEMP%` 沙箱与系统 PowerShell，不含本机绝对路径、用户名与私有目录，可在任意 Windows 机器上复跑，并接入了 GitHub Actions（Windows runner）。

```bash
npm test          # 等价于 node --test "server/services/__tests__/*.test.js"
```

Node 24 必须带 `*.test.js` 通配符，只传目录会失败。

端到端运行器（`tests/run-tests.js` + `tests/regenerate-baseline.js` + `tests/fixture.js`）也已随仓库分发：三者只依赖 `%TEMP%` 沙箱与系统 PowerShell，路径全部以 `__dirname` 为锚点（与工作目录解耦），含本机源码哈希的 `tests/baseline.json` 与运行产物仍被 `.gitignore` 排除。首次复跑需先生成本地基线：

```bash
node tests\regenerate-baseline.js   # 生成本机基线（含本机源码哈希，不进仓库）
node tests\run-tests.js             # 全量端到端（只打 %TEMP% 沙箱，自建 7799 端口）
```

定向验证脚本与探针（`_*.js`、`_*_results.json`）统一收纳在 `tools\` 下，仍只在本机运行、不随仓库分发（`.gitignore` 的 `_*` 模式无前导斜杠，在任意层级都生效）。以下是测试结论；完整明细见与本文档同目录的 `最终测试报告.md`（历史过程记录，数字不回填）。

### 已完成

| 范围 | 结果 |
|---|---|
| 原有单元测试（归组守恒、风险分级、安全闸门、磁盘清理、提权、扫尾时序等） | **96/96 通过**（14 套件） |
| 新增：禁用内核 API 扫描、磁盘忙碌闸门、工作集修剪闸门 | 通过 |
| 新增：缓存搬走沙箱真迁（`%TEMP%` 内 `mklink /J` + 探针 + 回滚相关拒绝项） | 9/9 通过 |
| 新增：内存条 0 / 1（单条会收成对象）/ N 条 | 通过 |
| 新增：批量上限独立闸门、磁盘禁止路径全盘符、垃圾扫描盘符动态化、PID 复用回退、释放量进程级口径 | 12/12 通过 |
| 新增：词典不写死本机值、CLI 与服务端垃圾清单同源、死代码清除 | 4/4 通过 |
| 新增：预置缓存目录筛选 | H1~H6 检查；真实接口实测 20 条中 15 条可迁移、5 条禁用并说明原因；约 2 秒 |
| **最新单元测试** | **203/203 通过**（25 套件，2026-09-26；`npm test`，Node 24.18） |
| **最新定向 HTTP 测试** | **71/71 通过**（2026-09-26；`node tools\_verify_http_gate.js`，含长任务 J1~J11 段） |
| **最新端到端测试** | **174/174 通过**（T0~T13，2026-09-26；367.9 秒，从仓库根执行 `node tests\run-tests.js`） |
| **删除性能实测** | 拟合 **固定 373ms + 0.4ms/文件**（1~2000 文件）；删除期间**事件循环最大延迟 14ms**；探针 `tools\_probe_delete_perf.js` |
| **真实环境验证** | 受控真实缓存迁移+回滚 **29/29**（Edge 缓存 1302 文件 / 367MB，逐文件 SHA256 复原一致）· 真实用户目录删除+完整复原 **23/23** · 界面点击验收 **18/18** |

其中安全复审 M-01 ~ M-08（链接删除防护、迁移串行锁与原子写、PID 校验 fail-closed、
前端统一转义、评估互斥与取消、过期备份清理接入、分页上限、状态损坏显式化）已全部修复并闭环，
自检用例见 `server/services/__tests__/securityRegression.test.js`（6 例）。
真实环境验证另发现并修复 2 个界面缺陷（撤销记录选择空值陷阱、清空后提示不同步）。

单元测试数字来自 `npm test`（可在本仓库复跑）；端到端数字来自 `tests/test-results.json`，定向 HTTP 数字来自 `tools\_verify_http_gate.js` 的输出——两者都是本机运行产物，不随仓库分发。
安全复审结论与证据见同目录的 `项目安全与质量复审报告_20260924_修正版.md`——该报告含本机现场细节，只保留在维护者本机，不随仓库分发。

### 尚待人工完成

| 项 | 状态 |
|---|---|
| ≥24 小时循环稳定性测试 | **未完成**（立项时的红线项）；前置条件（异步任务模型）已落地，需持续运行并检查服务存活、内存曲线、`GET /api/jobs` 的 `running` 计数与日志 |
| 真实断链 symlink 的检查器分支 | 链接检查器已能区分普通目录 / junction / symlink / 断链，但断链分支未在真机造链验证 |
| 读屏实测（Narrator / NVDA） | 可访问性只做了静态实现与断言，未用真实屏幕阅读器走一遍 |

本轮改动与发布状态一律以 `git log` 为准，本文档刻意不写具体提交号。

## 安全说明

- 运行时快照 `data/snapshot.json` 与生成界面 `内存清理助手.html` 含本机真实进程清单与用户名，已由 `.gitignore` 排除，**不会上传到仓库**。
- 审计日志（`logs/`、`*.log`）与带时间戳的工具备份（`*.2026-*-*Z`）同样排除。
- 单元测试子集（`server/services/__tests__/`）已**脱敏后随仓库分发**：只依赖 `%TEMP%` 沙箱与系统 PowerShell，不含本机绝对路径、用户名与私有目录，可在任意 Windows 机器上 `npm test` 复跑。反过来，端到端运行器（`tests/`）、定向脚本（`tools\` 下的 `_*.js`）与 `baseline.json` 含本机路径与进程清单，仍由 `.gitignore` 排除。
- 本项目零依赖、无项目密钥；服务仅监听 `127.0.0.1`，不对外暴露。访问控制见上文「九道安全闸门」第 0 道。

## 常见问题

- **双击 `内存清理助手.html` 后清理按钮为什么不可用？**
  本地文件（`file://`）既访问不到接口，也拿不到服务下发的一次性访问令牌，写接口会返回 403 `UNAUTHORIZED`。
  请通过 `启动.bat` 启动服务，再从 http://127.0.0.1:7788/ 打开。

- **为什么有些进程读不到路径、或杀不掉？**
  普通权限下约 230~240 / 400+ 个进程读不到可执行文件路径，界面靠进程名 + 词典兜底；
  Windows 服务进程（如 `MSPCManagerService`）在普通权限下会返回「拒绝访问」。
  点标题栏「🛡️ 提升权限」弹 UAC 后重启服务，覆盖率显著提升。

- **点了「修剪工作集」后「已用内存」没降？**
  修剪不会结束进程，系统「已用内存」不一定等量下降——这是预期行为。

- **会不会清掉系统待机缓存、导致蓝屏？**
  不会。本工具只结束进程，或调用公开 API `EmptyWorkingSet` / `SetProcessWorkingSetSize` 修剪工作集；
  **绝不**调用 `NtSetSystemInformation` 清空 Standby / Modified 页列表。界面上的待机数值只是只读展示。

- **缓存应该「删除」还是「搬走」？**
  优先「搬走」。删除后程序会重建、占回 C 盘；搬走 + `mklink /J` 目录联接后空间才是永久腾出来的。

- **换一台电脑能直接用吗？**
  能。不写死用户名与盘符：盘符通过 `Win32_LogicalDisk (DriveType=3)` 枚举，
  `%LOCALAPPDATA%` / `%APPDATA%` / `%USERPROFILE%` / `%TEMP%` 在运行时展开为当前登录用户的真实路径。
  只有 C 盘时会自动降级。

## 贡献指南

本项目目前没有正式的对外贡献流程；如果你想自行修改，以下几点能少踩坑：

1. 先看 `最终测试报告.md`、`改动清单_实施总账.md` 与 `遗留.md`，了解既有的安全约束、历史坑
   与「已决定不做 / 已知限制」的登记（例如 `force` 不能用来放行批量、释放量不能用整机内存差值统计）。
2. 不要提交运行时产物 —— `data/snapshot.json`、`内存清理助手.html`、`logs/`、`*.log`
   已被 `.gitignore` 排除，请勿 `git add -f`。
3. 改动后跑一遍测试：`npm test`（等价于 `node --test "server/services/__tests__/*.test.js"`，
   Node 24 必须带 `*.test.js` 通配符，只传目录会失败）；提交前可跑 `npm run verify`
   （四个入口文件的 `node --check` + 单元测试）。CI 在 Windows runner 上跑的就是 `npm test`。
4. 界面改动请同步改 `_template.html`，再跑 `node build.js` 重新生成单文件界面 ——
   直接改 `内存清理助手.html` 会在下次 build 时被覆盖。
5. 换行符由根目录 `.gitattributes` 统一：文本一律以 LF 入库，`.bat` / `.cmd` / `.vbs` 保留 CRLF。
   请勿把整文件改回 CRLF 或做无关的整文件重排 —— 那会让提交内容在不同机器之间不一致。

## 许可证

MIT，详见 [LICENSE](LICENSE)。本软件按「原样」提供，不附带任何形式的担保：本工具会结束进程、删除文件，请自行承担使用风险。
