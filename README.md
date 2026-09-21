# 内存清理应用

读电脑全部内存、按应用归组显示占用与用途、一键清理（带多重安全防护）。

---

## 中文简介

**内存清理助手**（Memory Cleaner）是一个面向 Windows 的本地内存与磁盘清理工具。

它读取整机内存数据，把零散进程按「应用」归组，展示每个应用占用了多少内存、有什么用途，并按安全等级分红/黄/绿三色标注；用户勾选后可一键结束进程释放内存，也可只修剪工作集（不关程序）。另带磁盘清理模块，能按应用归类磁盘占用、定位可清理的缓存与垃圾文件；缓存还可以「搬走 + 目录链接」到其他盘，而不是删掉后等程序重建。

技术上**零依赖**——后端只用 Node.js 内置模块（`http`）+ PowerShell 采集脚本，前端是单文件 HTML 界面，不需要安装任何 npm 包。为保证安全，清理动作内置**六道闸门**（默认 dry-run、保护进程拦截、必须二次确认、PID 复用防护、批量上限、审计日志），外加磁盘忙碌拒绝、以及「禁止未公开内核 API」硬红线：只结束进程或调用 `EmptyWorkingSet` / `SetProcessWorkingSetSize`，绝不清空 Standby / Modified 页列表。释放量只在进程确实退出（或修剪确实成功）后才上报。数据全部在你本机处理，服务只监听 `127.0.0.1`。

## English Description

**Memory Cleaner** is a local memory and disk cleaning tool for Windows.

It reads your machine's memory data, groups scattered processes by "application," and shows how much memory each app uses and what it's for — labeled with a three-color safety rating (red / yellow / green). You can terminate apps or only trim their working sets (public APIs, no undocumented kernel calls). It also includes a disk-cleaning module, plus **cache relocate**: copy a cache folder to another drive and put a directory junction (`mklink /J`) back at the original path.

It is **zero-dependency** — the backend uses only Node.js built-in modules (`http`) plus PowerShell collection scripts, and the frontend is a single HTML file. No npm packages required. Cleanup is guarded by dry-run, protected-process blocking, confirmation, PID-reuse checks, a batch limit, audit logs, a busy-disk gate, and a hard ban on flushing Standby/Modified page lists. All data stays on your machine, and the server listens only on `127.0.0.1`.

> **一句话版 / One-liner**：零依赖的 Windows 内存/磁盘清理工具：按应用归组、安全结束进程或修剪工作集，缓存可搬走并建目录链接。
> A zero-dependency Windows memory & disk cleaner: group usage by app, trim working sets safely, or relocate caches with directory junctions.

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

## 快速上手

### 方式一：一键启动（推荐，功能完整）
双击 **`启动.bat`**。它会自动：
1. 采集一次实时内存数据
2. 生成界面
3. 启动本地服务并打开浏览器

界面地址：http://127.0.0.1:7788/ —— 在这个页面里**清理功能可用**。

### 方式二：直接看界面（只读）
双击 **`内存清理助手.html`**。内置数据快照，无需启动任何东西，但清理按钮不可用（本地文件无法访问接口）。

### 方式三：命令行
```bash
node build.js       # 重新采集并生成界面
node cli.js         # 内存排行（前 30）
node cli.js safe    # 只看可安全清理的
node cli.js 抖音    # 搜索应用
node disk-cli.js         # C/D 分区 + 可清理垃圾（约 3 秒）
node disk-cli.js plan    # dry-run 清理计划（不删文件）
node disk-cli.js apps    # 按应用归类占用（约 30~60 秒）
node disk-cli.js C       # 只扫 C 盘一级目录
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

## 六道安全闸门（都写在代码里，不靠自觉）

| 闸门 | 行为 |
|---|---|
| 1. 默认 dry-run | 不传 `dryRun:false` 就只出计划，绝不动进程 |
| 2. 保护进程拦截 | 选中系统关键进程直接拒绝，返回 HTTP 403 + 中文原因 |
| 3. 必须确认 | 真实执行必须传 `confirmed:true`，否则 HTTP 400 |
| 4. PID 复用防护 | 执行前比对 PID + 启动时间，不一致则拒绝（防误杀刚启动的新进程） |
| 5. 批量上限 | 一次超过 20 个进程要求显式 force |
| 6. 审计日志 | 每次操作写入 `logs/cleanup-YYYYMMDD.log`，含成功/失败/原因 |
| 7. 磁盘忙碌拒绝 | 磁盘吞吐 ≥ 20MB/s 或队列 ≥ 3 时返回 HTTP 409，避免下载/拷贝期间清理 |
| 8. 禁止未公开内核 API | 不调用 `NtSetSystemInformation` 等，不清 Standby/Modified 列表 |

**释放量真实性**：只有在进程确实退出后才上报释放量。如果没有任何进程被关闭，释放量报 0 并说明「系统内存差值为自然波动」——不拿波动冒充效果。

## 接口一览

| 接口 | 说明 |
|---|---|
| `GET /` | 界面（与服务同源，清理可用） |
| `GET /api/health` | 健康检查（含 `isAdmin`） |
| `GET /api/memory/snapshot` | 完整快照（系统 + 应用 + 分级 + 守恒） |
| `GET /api/memory/apps?risk=safe&q=抖音&limit=20` | 应用排行 |
| `GET /api/memory/processes?q=chrome` | 进程明细 |
| `GET /api/cleanup/plan` | 清理计划（dry-run） |
| `POST /api/cleanup/execute` | 执行清理（需 `confirmed:true`） |
| `GET /api/cleanup/io` | 磁盘忙碌采样（吞吐/队列） |
| `GET /api/cleanup/trim/plan` | 工作集修剪计划（dry-run） |
| `POST /api/cleanup/trim` | 修剪工作集（公开 API，需 `confirmed:true`） |
| `GET /api/disk/volumes` | C/D 分区容量（毫秒级） |
| `GET /api/disk/snapshot` | C/D 盘占用快照（一级目录 + 已知垃圾路径，约 30~60 秒） |
| `GET /api/disk/junk` | 可清理垃圾分类清单（约 3 秒） |
| `GET /api/disk/apps` | 按应用归类的磁盘占用 |
| `GET /api/disk/cleanup/plan` | 磁盘清理计划（dry-run） |
| `POST /api/disk/cleanup/execute` | 执行磁盘清理（需 confirmed=true，只删白名单路径） |
| `GET /api/disk/migrate/presets` | 可搬走的常见缓存目录 |
| `GET /api/disk/migrate/inspect?path=` | 链接检查器（普通目录 / junction / symlink / 断链） |
| `GET /api/disk/migrate/records` | 已迁移记录 |
| `POST /api/disk/migrate/precheck` | 迁移预检 |
| `POST /api/disk/migrate/execute` | 缓存搬走 + 建链接（默认 junction，需 confirmed=true） |
| `GET /api/privilege/status` | 当前是否管理员、能否提权 |
| `POST /api/privilege/elevate` | 弹出 UAC，以管理员身份重启服务（`dryRun:true` 只出计划） |

## 目录结构
```
启动.bat                      一键启动（采集 + 生成 + 起服务 + 开浏览器）
build.js                      采集数据并生成界面
cli.js                        命令行排行
内存清理助手.html            单文件界面（内嵌数据，双击可看）
server/
  server.js                   HTTP 服务（零依赖，同时提供界面和接口）
  routes/memory.js            RESTful 路由 + 参数校验 + 错误处理
  services/
    memoryService.js          汇总（采集+归组+分级）
    appGrouper.js             归组算法（强制归组/父子跟随/svchost 折叠）
    riskClassifier.js         三色风险分级器
    cleanupService.js         清理执行层（六道闸门 + 磁盘忙碌拒绝）
    workingSetService.js      工作集修剪（EmptyWorkingSet / SetProcessWorkingSetSize）
    diskIoGuard.js            磁盘忙碌闸门
    cacheMigrateService.js    缓存搬走 + 目录链接（默认 junction）
    __tests__/                单元测试
  collectors/
    collect.ps1               内存采集脚本
    cleanup.ps1               进程清理脚本（含 PID 复用防护）
    trimWorkingSet.ps1        工作集修剪脚本（仅公开 API）
    processList.js            合并双数据源
    systemMemory.js           整机内存/内存条结构化
data/
  appDict.zh.json             中文用途词典（70+ 条）
  protectedProcesses.json     禁止结束名单（18 个系统关键进程）
  snapshot.json               最近一次采集快照
logs/                         审计日志
```

## 关键设计（为什么这么做）

1. **主口径用 `Get-Process.WorkingSet64`**：实测同一时刻 CIM 的 `WorkingSetSize` 合计比真实已用偏大 1GB 以上，只有 WorkingSet64 对齐任务管理器。
2. **归组守恒是硬约束**：归组后应用内存合计必须严格等于归组前进程合计，否则就是有进程被丢了。
3. **用途绝不编造**：词典每条来自本机实测路径或 `Win32_Service` 服务表反查；查不到显示「未收录」。
4. **清理先优雅后强制**：先发关闭消息（等同点 ×，让程序自己保存），失败才强制结束。
5. **实测注意事项**：Windows 服务进程（如 `MSPCManagerService`）在普通权限下杀不掉，会返回「拒绝访问」——这是权限机制，需要以管理员身份运行。
6. **清内存只用公开 API**：结束进程或修剪工作集；绝不强制清空系统待机/修改页列表。
7. **缓存优先搬走而不是删除**：删除后程序会重建，占回 C 盘；搬走 + junction 后空间才是永久的。

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
- **无 D 盘降级**：只有系统盘时，数据盘列表为空，扫描循环安全跳过，应用仍能正常出系统盘的磁盘占用与垃圾清单。
- **内存条按本机条数显示**：物理内存来自 `Win32_PhysicalMemory`，容量/厂商/插槽/频率/代数都是这台电脑现场读的，不写死。PowerShell 5.1 在只有 1 条内存时会把数组收成对象，采集脚本和 Node 侧都强制收成数组，笔记本单条、台式机多条都能显示。

## 测试

```bash
node --test server/services/__tests__/*.test.js
```

Node 24 必须带 `*.test.js`，只传目录会失败。明细见仓库根目录 `最终测试报告.md`。

### 已完成

| 范围 | 结果 |
|---|---|
| 原有单元测试（归组守恒、风险分级、六道闸门、磁盘清理、提权、扫尾时序等） | 45/45 通过 |
| 新增：禁用内核 API 扫描、磁盘忙碌闸门、工作集修剪闸门 | 通过 |
| 新增：缓存搬走沙箱真迁（`%TEMP%` 内 `mklink /J` + 探针 + 回滚相关拒绝项） | 9/9 通过 |
| 新增：内存条 0 / 1（PowerShell 单条收成对象）/ N 条 | 通过 |
| 上述新功能单测复跑 | **26/26 通过**（2026-09-21，Windows 11 10.0.26200.9457） |

旧版全功能实测（采集/结束进程/HTTP/界面/CLI）见历史记录，当时 47 项通过。

### 未完成（需在真机手工做）

| 项 | 说明 |
|---|---|
| 界面点一遍新按钮 | 「修剪工作集」「缓存搬走」预检/确认未做 UI 点击测试 |
| 真实缓存目录搬走 | 未对浏览器/游戏等生产路径执行，只在 `%TEMP%` 沙箱验证 |
| 重启后目录链接仍有效 | junction 按 NTFS 语义应仍在，未实际重启验证 |
| 大文件下载期间反复清理 | 未做蓝屏压力；高 I/O 时代码会拒绝清理，不能代替实测 |
| ≥24 小时循环 | 未挂机 |

## 安全说明

- 运行时快照 `data/snapshot.json` 与生成界面 `内存清理助手.html` 含本机真实进程清单与用户名，已由 `.gitignore` 排除，**不会上传到仓库**。
- 审计日志（`logs/`、`*.log`）与带时间戳的工具备份（`*.2026-*-*Z`）同样排除。
- 本项目零依赖、无任何密钥/令牌；服务仅监听 `127.0.0.1`，不对外暴露。
