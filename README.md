# Memory Cleaner

[简体中文](README_CN.md) | **English**

> **This file is a translation kept in sync with [README_CN.md](README_CN.md), which is the single source of truth.**
> Change the Chinese version first, then mirror it here; if the two ever disagree, README_CN.md wins.
> Release state (commit hashes, version numbers) lives in `git log`, deliberately not in the README; per-version changes are recorded in [CHANGELOG.md](CHANGELOG.md).

Read your machine's full memory usage, group it by application with purpose labels, and clean up in one click (guarded by multiple safety mechanisms).

---

## Overview

**Memory Cleaner** is a local memory and disk cleaning tool for Windows.

It reads the machine's memory data, groups scattered processes by *application*, and shows how much memory each app uses and what it is for — labeled with a three-color safety rating (red / yellow / green). After ticking the apps you want, you can terminate them to free memory, or only trim their working sets (without closing the programs). A disk-cleaning module is also included: it groups disk usage by application and locates removable caches and junk files. Caches can also be **relocated** to another drive with a directory junction, instead of being deleted only to be rebuilt by the app.

Technically it is **zero-dependency** — the backend uses only Node.js built-in modules (`http`) plus PowerShell collection scripts, and the frontend is a single HTML file. No npm packages required. For safety, **nine gates** are enforced in code: HTTP access control (one-time token + loopback `Host` + same-origin `Origin`), default dry-run, protected-process blocking, mandatory confirmation, PID-reuse protection, batch limit, audit logs, busy-disk rejection, and a hard ban on undocumented kernel APIs — it only terminates processes or calls `EmptyWorkingSet` / `SetProcessWorkingSetSize`, and never flushes the Standby / Modified page lists. Freed-memory figures are reported only after a process actually exits (or a trim actually succeeds), and are counted per successful process. All data stays on your machine; the server listens only on `127.0.0.1`.

> **One-liner**: A zero-dependency Windows memory & disk cleaner — group usage by app, terminate processes safely or trim working sets, and relocate caches with directory junctions.

---

## Features

### Core

- **Memory checkup**: usage grouped by app with purpose and red / yellow / green risk; the metric matches Task Manager's Working Set.
- **Terminate processes to free memory**: graceful close first, then forced kill; with protected-process blocking, PID-reuse protection, and mandatory confirmation.
- **Disk junk cleanup**: only deletes caches / temp files on the dictionary allowlist — never install directories, games, or documents.
- **Disk usage by app**: C / D drive paths grouped by application; ticking an app only clears its allowlisted caches.
- **Privilege elevation**: raises UAC from the title bar and restarts the local service as administrator.

### Added Later

- **Trim working sets (without closing apps)**: calls the public APIs `EmptyWorkingSet` / `SetProcessWorkingSetSize`; processes keep running. Dedicated button in the "One-click Cleanup" panel; `POST /api/cleanup/trim`.
- **No undocumented kernel APIs**: does not call `NtSetSystemInformation` (as Mem Reduct does) to flush the Standby / Modified page lists, reducing blue-screen risk.
- **Refuse cleanup while the disk is busy**: while downloading or copying large files (throughput ≥ 20MB/s or disk queue ≥ 3) it returns HTTP 409 instead of force-cleaning.
- **Cache relocate + directory junction**: copy a cache to another drive and put `mklink /J` back at the original path (default; no admin required; `/D` symlink optional). Programs keep writing to the original path while the data lands on the target drive. Failures roll back automatically — no data loss.
- **Link inspector**: tells whether a path is a normal directory, junction, symlink, or broken link, and shows its target. `GET /api/disk/migrate/inspect`, CLI: `node disk-cli.js inspect <path>`.
- **RAM modules shown per machine**: reads `Win32_PhysicalMemory` live. PowerShell 5.1 collapses a single result into an object, so the collector always wraps it into an array — works for laptops (1 module) and desktops (several).

### Long-term Batch (2026-09-26)

- **Progress and cancellation for long tasks**: full-drive scans, disk cleanup plans and cleanup execution now run as **background async tasks**. The UI shows a percentage and the current step, and you can cancel at any time — cancelling also terminates the underlying PowerShell child process, so no orphans are left behind. Triggering the same task again while it is in flight now says so explicitly (409 `TASK_BUSY`), instead of "clicked the button and nothing happened, with no idea how long it had been running". See the API overview below for the progress and cancel endpoints.

### Security Hardening & Consistency Fixes (2026-09-23)

13 changes from a review checklist were implemented; the three P0 items closed the gap between "documented promise" and "actual code":

- **HTTP access control**: the service generates a one-time token at startup and embeds it in the homepage. Both write endpoints and expensive scan endpoints verify the token; non-loopback `Host` and cross-origin `Origin` are rejected; write request bodies must be `application/json`.
- **Batch limit gate now actually works**: the frontend used to send `force` unconditionally, which made the gate a no-op. "Allow batch" and "force kill" are now two separate parameters.
- **Forbidden disk paths cover every local drive**: previously only C / D; now generated dynamically from the machine's drives.
- Plus 10 portability / consistency / UX fixes (dynamic drive letter for junk scanning, PID-reuse fallback, attributable freed-memory accounting, dictionaries no longer hardcoding this machine's numbers, etc.).

Full record lives in **`改动清单_实施总账.md`** (per-item changes, measured data, and the 4 review suggestions that were rejected).

## Quick Start

### Option 1: One-click launch (recommended, full functionality)

Double-click **`启动.bat`**. It will automatically:
1. Collect a live memory snapshot
2. Generate the UI
3. Start the local service and open your browser

UI address: http://127.0.0.1:7788/ — **cleanup works** on this page.

### Option 2: Open the UI directly (read-only)

Double-click **`内存清理助手.html`**. Data is embedded, so nothing needs to be started — but the cleanup buttons are unavailable: a local file can neither reach the API nor obtain the one-time access token issued by the service (write endpoints return 403 `UNAUTHORIZED`, and the UI tells you to open it through the service address instead).

### Option 3: Command line

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

## How to Clean Up

1. Open http://127.0.0.1:7788/
2. **Tick the apps** you want to handle in the app list (🔴 protected items cannot be ticked)
3. The top toolbar shows "Selected N apps, estimated free X"; click "End selected apps" → confirm in the dialog → execute
4. Or use the bottom "🧹 One-click Cleanup" panel: click "Generate cleanup plan", tick, then execute. The same panel has "Trim working sets (without closing apps)" — it only shrinks working sets and never ends processes.
5. On the disk page, "📦 Relocate cache": pick a preset cache directory or enter source / target → precheck → confirm. By default a directory junction (`mklink /J`, no admin needed) is created at the original path; programs keep writing there while the data lands on the target drive.

"Disk usage by app" on the disk page supports ticking too: you can only tick apps that have allowlisted caches, and only caches / temp files are deleted — **never** install directories, games, or documents. To move a cache off C: permanently, prefer "relocate" over "delete".

After cleanup a **before / after comparison** is shown: before → after, how much was actually freed, and why anything failed.

## Nine Safety Gates (Enforced in Code)

| Gate | Behavior |
|---|---|
| 0. HTTP access control | A one-time 64-char token is generated at startup and embedded in the homepage; **write endpoints (`POST`) and every non-exempt read endpoint** must carry `X-CC-Token` (only millisecond-level side-effect-free endpoints such as `/api/health` and `/api/disk/volumes` are exempt). `Host` must be loopback, cross-origin `Origin` is rejected, and write request bodies must be `application/json` |
| 1. Default dry-run | Without `dryRun:false` it only produces a plan and never touches a process |
| 2. Protected-process blocking | Selecting a critical system process is rejected with HTTP 403 and a Chinese reason; a force-kill also takes down the whole process tree, so **if any protected process appears anywhere in that tree the whole operation is rejected** (see "Tree-kill scope" below) |
| 3. Confirmation required | Real execution requires `confirmed:true`, otherwise HTTP 400 |
| 4. PID-reuse protection | PID + start time are compared before execution; a mismatch is rejected (prevents killing a newly started process that reused the PID) |
| 5. Batch limit | More than 20 processes in one run requires an explicit `acknowledgeBatchLimit:true`; `force` only means force-kill and cannot be used to allow a batch |
| 6. Audit log | Every operation is written to `logs/cleanup-YYYYMMDD.log` with success / failure / reason |
| 7. Busy-disk rejection | Disk throughput ≥ 20MB/s or queue ≥ 3 returns HTTP 409, avoiding cleanup during downloads / copies |
| 8. No undocumented kernel APIs | Does not call `NtSetSystemInformation` or similar; never flushes the Standby / Modified lists |

**Honest boundary of the access control**: the token is delivered inside the homepage. External web pages cannot read the homepage because of the same-origin policy, so they cannot get the token — this **raises the bar**, it is not absolute isolation. A program already running on your machine can still read the local files or the homepage to obtain the token. True isolation would require switching to named pipes or another inter-process channel instead of HTTP.

**Freed-memory honesty**: freed memory is reported only after a process actually exits. If nothing was closed, it reports 0 and explains that the system memory delta is just natural fluctuation — it never passes noise off as results. The figure is counted from **the working set of each successful process** (not from the whole-machine memory delta), so other processes' natural fluctuation is not counted as this run's gain.

**Tree-kill scope (fail-closed)**: force-kill uses `taskkill /PID <pid> /T /F`, and `/T` takes down the whole descendant tree — the descendants dragged along never have their own risk grade consulted. So that "I ticked one safe app and a critical system process went down with its tree" cannot happen, the service enumerates every descendant of the target before acting and checks each one against the protected image names. **If even a single protected process appears in that tree, the whole target is rejected** (`tree_contains_protected`): none of its processes are ended, and there is no partial "skip the dangerous one, kill the rest". Likewise, if the process table cannot be read and the tree cannot be established, it is rejected as unverifiable (`tree_check_failed`) — the same fail-closed stance used when PID identity cannot be verified. Protected image names come from two sources: the full list in `data/protectedProcesses.json`, plus the process names of every app graded `protected` in the current snapshot (some grades live only in the dictionary, so the list file alone would miss them). The check runs *before* the graceful close, so "rejected" strictly means not one process of that target was touched. The tree guard is only armed in the force-kill branch that actually uses `/T`; a plain graceful close carries no `/T` and does not trigger it.

## API Overview

All endpoints require the `X-CC-Token` request header (the token is read from `window.__CC_TOKEN__` in the homepage HTML). **Exceptions are a few millisecond-level, side-effect-free endpoints**: `/api/health`, `/api/cleanup/io`, `/api/disk/volumes`, `/api/disk/migrate/records`, `/api/privilege/status`. The authoritative list is `CHEAP_READ_PATHS` in `server/server.js`; anything not in it requires a token, including read endpoints.

Why even read endpoints need a token: `/api/disk/snapshot` and `/api/disk/apps` perform a 30~60 second full-drive scan. Without a token, any web page could trigger them repeatedly with a single `<img src="http://127.0.0.1:7788/api/disk/snapshot">` — an `img` request carries no `Origin`, so origin checks cannot stop it, but it **can never carry a custom request header**. The `Host` / `Origin` checks apply to all `/api/*`.

**Long tasks always run asynchronously**: anything that drives robocopy / PowerShell — full-drive scans, disk cleanup plans and executions (30~60 s each, deletions possibly longer) — is registered in the task table in `lib/tasks.js` and runs in the background. The event loop is no longer blocked while scanning, so other requests are answered normally (measured: `GET /api/health` returns in about **2 ms** while a drive scan is in flight). The UI shows progress and lets you cancel; cancelling propagates the `AbortSignal` down to `execFile` and **terminates the running PowerShell child process**.

That yields the following transport contract (implemented in `TASK_ERROR_STATUS` in `server/routes/memory.js`; call sites must not interpret the codes themselves):

| Situation | Response |
|---|---|
| The same long task is already in flight (e.g. pressing scan again) | **409** `TASK_BUSY` |
| Task timed out (each task is constructed with a `timeoutMs`) | **504** `TASK_TIMEOUT` |
| The request was cancelled while the task was running | **409** `TASK_CANCELLED` |
| Cancelling a finished / never-started task | **409** `TASK_NOT_RUNNING` |
| Querying an unknown task id | **404** `TASK_NOT_FOUND` |

The response shape is deliberately unchanged: success is still 200 + the original JSON, so neither the front end nor the existing regression tests have to distinguish synchronous from asynchronous returns.

| Endpoint | Description |
|---|---|
| `GET /` | UI (same origin as the service; cleanup works) |
| `GET /api/health` | Health check (includes `isAdmin`, `batchLimit`) |
| `GET /api/memory/snapshot` | Full snapshot (system + apps + rating + conservation) |
| `GET /api/memory/apps?risk=safe&q=抖音&limit=20` | App ranking |
| `GET /api/memory/processes?q=chrome` | Process details |
| `GET /api/cleanup/plan` | Cleanup plan (dry-run) |
| `POST /api/cleanup/execute` | Execute cleanup (requires `confirmed:true`; also `acknowledgeBatchLimit:true` when > 20 processes) |
| `GET /api/cleanup/io` | Disk busy sampling (throughput / queue) |
| `GET /api/cleanup/trim/plan` | Working-set trim plan (dry-run) |
| `POST /api/cleanup/trim` | Trim working sets (public API, requires `confirmed:true`) |
| `GET /api/disk/volumes` | C / D partition capacity (milliseconds) |
| `GET /api/disk/snapshot` | C / D usage snapshot (top-level dirs + known junk paths, ~30~60s) |
| `GET /api/disk/junk` | Cleanable junk, categorized (~3s) |
| `GET /api/disk/apps` | Disk usage grouped by application |
| `GET /api/disk/cleanup/plan` | Disk cleanup plan (dry-run) |
| `POST /api/disk/cleanup/execute` | Execute disk cleanup (requires confirmed=true, allowlisted paths only) |
| `GET /api/disk/migrate/presets` | Assess preset cache directories for relocation; requires the page token |
| `GET /api/disk/migrate/inspect?path=` | Link inspector (normal dir / junction / symlink / broken link) |
| `GET /api/disk/migrate/records` | Relocation records |
| `POST /api/disk/migrate/precheck` | Relocation precheck |
| `POST /api/disk/migrate/execute` | Relocate cache + create link (junction by default, requires confirmed=true) |
| `GET /api/privilege/status` | Whether you are admin and can elevate |
| `POST /api/privilege/elevate` | Raise UAC and restart the service as admin (`dryRun:true` only returns the plan) |
| `GET /api/jobs` | Long-task progress: in-flight tasks (`percent` / `message` / `state`) + recently finished, plus a `running` count |
| `GET /api/jobs/:id` | One task's progress snapshot; unknown id returns 404 `TASK_NOT_FOUND` |
| `POST /api/jobs/:id/cancel` | Cancel an in-flight long task (202 + task snapshot); finished tasks return 409 `TASK_NOT_RUNNING` |

## Project Structure

```
启动.bat                      One-click launch (collect + generate + serve + open browser)
build.js                      Collect data and generate the UI
cli.js                        Command-line ranking
内存清理助手.html            Single-file UI (data embedded, double-click to view)
lib/
  paths.js                    Single source of path anchors (ROOT / DATA / HTML_FILE / collector / data ...)
  psRunner.js                 The one implementation of PowerShell invocation (4 sync/async helpers + arg escaping + output cleaning)
  tasks.js                    Long-task registry (progress / cancel / timeout / single-flight); see the transport contract above
  dictCache.js                mtime-based JSON dictionary cache
  auditLog.js                 Audit-log writing
  ports.js                    Port probing and EADDRINUSE handling
server/
  server.js                   HTTP service (zero-dependency; serves both UI and API)
  routes/memory.js            RESTful routes + parameter validation + error handling
  services/
    memoryService.js          Aggregation (collect + group + rate)
    appGrouper.js             Grouping algorithm (forced grouping / parent-child / svchost folding)
    riskClassifier.js         Three-color risk classifier
    cleanupService.js         Cleanup execution layer (safety gates + busy-disk rejection)
    workingSetService.js      Working-set trimming (EmptyWorkingSet / SetProcessWorkingSetSize)
    diskIoGuard.js            Busy-disk gate
    cacheMigrateService.js    Cache relocation + directory link (junction by default)
    junkLocator.js            Junk-directory location (full dictionary)
    diskCleanupService.js     Disk junk cleanup (allowlist gate + forbidden-path checks)
  collectors/
    collect.ps1               Memory collection script
    cleanup.ps1               Process cleanup script (with PID-reuse protection)
    trimWorkingSet.ps1        Working-set trim script (public APIs only)
    diskScan.ps1              Disk-usage scan (sizes via robocopy)
    processList.js            Merges two data sources
    systemMemory.js           Machine memory / RAM module structuring
    diskSpace.js              Drive enumeration + usage snapshot (server and CLI share it)
data/
  appDict.zh.json             Chinese purpose dictionary (70+ entries)
  junkDict.zh.json            Junk-path dictionary (**single source**: both snapshot and cleanup read it)
  protectedProcesses.json     Never-terminate list (18 critical system processes)
  snapshot.json               Most recent collection snapshot
logs/                         Audit logs
```

## Key Design Decisions

1. **`Get-Process.WorkingSet64` is the primary metric**: measured at the same instant, CIM's `WorkingSetSize` total runs more than 1GB above real usage; only `WorkingSet64` matches Task Manager.
2. **Grouping conservation is a hard constraint**: total app memory after grouping must exactly equal total process memory before grouping — otherwise a process was dropped.
3. **Purposes are never invented**: dictionary entries are based on common paths verified to exist on Windows; anything unknown shows "not catalogued". The dictionary **presets no machine-specific numbers** — sizes always come from a live scan, and `note` only carries magnitude hints and handling reminders.
4. **Cleanup is graceful first, forced second**: a close message is sent first (equivalent to clicking ×, letting the program save), and only failure escalates to forced termination.
5. **A note from real testing**: Windows service processes (such as `MSPCManagerService`) cannot be killed under normal privileges and return "access denied" — that is the permission model, and it needs administrator rights.
6. **Only public APIs for freeing memory**: terminate processes or trim working sets; never force-flush the system standby / modified page lists.
7. **Prefer relocating caches over deleting them**: deleted caches get rebuilt and reclaim C:; relocate + junction frees the space permanently.
8. **One fact lives in exactly one place**: the single source of junk paths is `data/junkDict.zh.json`, and both the disk-usage snapshot and disk cleanup read from it; drive enumeration is implemented once in `diskSpace.listLocalDrives()` (with an in-process cache). The snapshot only sizes **a small subset of entries** (`SNAPSHOT_JUNK_ENTRY_IDS`, since each one costs a robocopy run), while the detailed list still comes from the full dictionary — a deliberate performance trade-off, not an omission.
9. **Long tasks never occupy the event loop**: any work that drives PowerShell runs asynchronously and is registered in the task table, so the service keeps answering other requests while scanning or deleting; only one instance of a given task may be in flight, so a repeated trigger gets 409 instead of piling up in a queue.

## Privilege Elevation

The title bar has a "🛡️ Elevate" button (it only appears once the service was started via `启动.bat`).

1. Click the button → Windows User Account Control (UAC) appears
2. Click "Yes" → the service restarts as administrator and the page refreshes automatically
3. Click "No" → nothing changes; you stay at normal privileges

After elevating you can: terminate service processes that previously returned "access denied", and read executable paths for more processes. The real authorization is UAC — the app cannot elevate itself.

## Known Limitations

- Under normal privileges, executable paths cannot be read for roughly 230~240 of 400+ processes. The UI falls back to process names + the dictionary; clicking "Elevate" raises coverage significantly.
- Cleaning up Windows service processes requires administrator rights; without them it fails and reports the reason honestly.
- The UI embeds a snapshot from the moment it was generated. To see fresh data, rerun `启动.bat` (elevating and restarting also re-collects).
- Disk scanning only recognizes robocopy's `Bytes` / `字节` summary row. On Chinese Windows the "已结束: 2026年…" line must not be taken as a directory size (an empty crash dump once showed 2026 B because of this).
- Cache relocation uses `mklink /J` (directory junction) by default: no admin needed, local volumes only; the `/D` symlink needs admin or Developer Mode. Close programs holding that directory first, or the rename-backup step fails and rolls back.
- Working-set trimming does not end processes, so system "memory in use" may not drop by the same amount.
- This tool does **not** force-flush the standby cache; the standby figure in the UI is read-only display.

## Portability (No Hardcoding)

The app assumes no username and hardcodes no drive letter — it runs fully on any Windows machine:

- **Dynamic drive enumeration**: the disk module enumerates all local fixed disks via `Win32_LogicalDisk (DriveType=3)` (single C, C+D, C+D+E all work). The system drive comes from `%SystemDrive%`, and non-system drives are treated as data drives.
- **User path expansion**: `%LOCALAPPDATA%` / `%APPDATA%` / `%USERPROFILE%` / `%TEMP%` in the mapping table and dictionaries expand to the current logged-in user's real paths at runtime — no username is hardcoded.
- **Recycle bin injected per drive**: recycle-bin entries (ids starting with `recycle`) generate `$Recycle.Bin` paths for every local drive at scan time.
- **Free-space comparison covers every fixed drive**: cleanup before/after free space is aggregated over all local fixed drives from the same enumeration, so the reported `systemDeltaBytes` includes E:/F: as well (previously only C: and D: were read).
- **Degrades with no D: drive**: with only a system drive, the data-drive list is empty and the scan loop skips safely; the app still reports system-drive usage and junk.
- **RAM modules shown per machine**: physical memory comes from `Win32_PhysicalMemory`; capacity / vendor / slot / speed / generation are read live from this machine, never hardcoded. PowerShell 5.1 collapses a single module into an object, so both the collector script and the Node side force it into an array — laptops with one module and desktops with several both display correctly.

## Testing

The repo ships a **desensitised, fixture-based** unit-test subset (`server/services/__tests__/`): it only depends on a `%TEMP%` sandbox and the system PowerShell, contains no machine-specific absolute paths, usernames or private directories, runs on any Windows machine, and is wired into GitHub Actions (Windows runner).

```bash
npm test          # same as: node --test "server/services/__tests__/*.test.js"
```

Node 24 requires the `*.test.js` glob; passing just the directory fails.

The end-to-end runner and fixtures (`tests\run-tests.js` + `tests\regenerate-baseline.js` + `tests\fixture.js`) **run on the maintainer's machine only and are not distributed** (the whole `tests\` directory is excluded by `.gitignore`). On the maintainer's machine the order is below; generate the local baseline first:

```bash
node tests\regenerate-baseline.js   # build the local baseline (machine-specific hashes)
node tests\run-tests.js             # full end-to-end (touches only the %TEMP% sandbox, spins up port 7799)
```

The targeted verification scripts and probes (`_*.js`, `_*_results.json`) likewise live under `tools\` and run on the maintainer's machine only, not distributed (the `_*` patterns in `.gitignore` have no leading slash, so they apply at any depth). Below are the test results; full details are in `最终测试报告.md`, kept alongside this README (a historical record — its numbers are not back-filled).

### Completed

| Scope | Result |
|---|---|
| Existing unit tests (grouping conservation, risk rating, safety gates, disk cleanup, elevation, sweep timing, etc.) | **96/96 passed** (14 suites) |
| Added: undocumented-kernel-API scan, busy-disk gate, working-set trim gate | Passed |
| Added: cache relocation in a sandbox (`mklink /J` inside `%TEMP%` + probe + rollback rejection cases) | 9/9 passed |
| Added: RAM modules 0 / 1 (collapsed to an object) / N | Passed |
| Added: standalone batch-limit gate, forbidden paths for all drives, dynamic junk-scan drive letter, PID-reuse fallback, per-process freed-memory accounting | 12/12 passed |
| Added: dictionary free of machine-specific values, CLI and server sharing one junk list, dead code removal | 4/4 passed |
| Added: preset cache-directory assessment | H1–H6 checks; live API run: 15 of 20 relocatable, 5 disabled with reasons; ~2 s |
| **Latest unit tests** | **203/203 passed** (25 suites, 2026-09-26; `npm test`, Node 24.18) |
| **Latest targeted HTTP tests** | **71/71 passed** (2026-09-26; `node tools\_verify_http_gate.js`, including the long-task section J1–J11) |
| **Latest end-to-end tests** | **174/174 passed** (T0–T13, 2026-09-26; 367.9 s, run on the maintainer's machine via `node tests\run-tests.js`; that runner is not distributed) |
| **Delete-performance benchmark** | Fit: **fixed 373 ms + 0.4 ms per file** (1–2000 files); **max event-loop lag 14 ms** during deletion; probe `tools\_probe_delete_perf.js` |
| **Real-environment verification** | Controlled real cache relocation + rollback **29/29** (Edge cache, 1302 files / 367 MB, byte-identical per-file SHA256 restore) · Real user-directory deletion + full restore **23/23** · UI click acceptance **18/18** |

The security-review items M-01 – M-08 (reparse-point protection on delete, migration serialization +
atomic state writes, fail-closed PID verification, unified front-end escaping, assessment mutual
exclusion + cancellation, expired-backup purge wiring, list pagination caps, explicit corrupted-state
handling) are all fixed and closed; the self-check cases live in
`server/services/__tests__/securityRegression.test.js` (6 cases). The real-environment pass also found
and fixed 2 UI defects (empty rollback-selection resolving to record #0; stale hint text after clearing).

Unit-test numbers come from `npm test` (reproducible from this repo); end-to-end numbers come from `tests/test-results.json` and targeted-HTTP numbers from the `tools\_verify_http_gate.js` output — both are machine-local run artefacts and are not distributed.
For the security-review evidence, see `项目安全与质量复审报告_20260924_修正版.md` alongside this README — it contains machine-local detail and stays on the maintainer's machine, not distributed.

### Still To Do (Manual, On Real Machines)

| Item | Note |
|---|---|
| ≥24 hour loop stability test | **Not done** (the red line from project kickoff); the prerequisite (async task model) has landed, so it needs a long uninterrupted run, then a check of service liveness, memory curve, the `running` count from `GET /api/jobs`, and the logs |
| Broken-symlink branch of the link inspector | The inspector already distinguishes normal dir / junction / symlink / broken link, but the broken-link branch has not been verified with a hand-made link |
| Screen-reader pass (Narrator / NVDA) | Accessibility has a static implementation and assertions only; no real screen reader has been walked through it |

Commit history and release state are tracked by git (`git log`), not by this document — commit hashes are deliberately not written here.

## Security Notes

- The runtime snapshot `data/snapshot.json` and the generated UI `内存清理助手.html` contain this machine's real process list and username. Both are excluded by `.gitignore` and are **never uploaded**.
- Audit logs (`logs/`, `*.log`) and timestamped tool backups (`*.2026-*-*Z`) are excluded as well.
- The unit-test subset (`server/services/__tests__/`) is **desensitised and distributed with the repo**: it only depends on a `%TEMP%` sandbox and the system PowerShell, contains no machine-specific absolute paths, usernames or private directories, and can be rerun on any Windows machine with `npm test`. Conversely, the end-to-end runner and fixtures (`tests/`), the targeted scripts under `tools\` (`_*.js`), the machine-local baseline (`baseline.json`) and the legacy register (`遗留.md`, which carries machine-specific paths and measurements) are **all not distributed** and are excluded by `.gitignore`.
- Zero dependencies, no project secrets; the service listens only on `127.0.0.1` and is not exposed externally. See gate 0 in "Nine Safety Gates" above for access control.

## FAQ

- **Why are the cleanup buttons unavailable after double-clicking `内存清理助手.html`?**
  A local file (`file://`) can neither reach the API nor obtain the one-time access token issued by the service — write endpoints return 403 `UNAUTHORIZED`. Start the service with `启动.bat` and open http://127.0.0.1:7788/ instead.

- **Why can't some processes' paths be read, or why can't they be killed?**
  Under normal privileges the executable path cannot be read for roughly 230~240 of 400+ processes; the UI falls back to process names plus the dictionary. Windows service processes (such as `MSPCManagerService`) return "access denied". Click "🛡️ Elevate" in the title bar, confirm UAC, and coverage improves significantly.

- **"Memory in use" did not drop after trimming working sets?**
  Trimming does not end processes, so system "memory in use" does not necessarily fall by the same amount — that is expected.

- **Will it flush the system standby cache and cause a blue screen?**
  No. It only terminates processes, or calls the public APIs `EmptyWorkingSet` / `SetProcessWorkingSetSize` to trim working sets. It **never** calls `NtSetSystemInformation` to flush the Standby / Modified lists. The standby figure in the UI is read-only display.

- **Should a cache be "deleted" or "relocated"?**
  Prefer "relocate". Deleted caches get rebuilt and reclaim C:; relocate + `mklink /J` frees the space permanently.

- **Can I run it on another machine as-is?**
  Yes. No username or drive letter is hardcoded: drives are enumerated via `Win32_LogicalDisk (DriveType=3)`, and `%LOCALAPPDATA%` / `%APPDATA%` / `%USERPROFILE%` / `%TEMP%` expand to the current user's real paths at runtime. It degrades automatically when only C: exists.

## Contributing

There is no formal external contribution process yet. If you want to modify it yourself, these notes will save you some trouble:

1. Read `最终测试报告.md` and `改动清单_实施总账.md` first to learn the existing safety constraints and historical pitfalls
   (for example: `force` must not be used to allow a batch, and freed memory must not be computed from the whole-machine memory delta).
2. Do not commit runtime artifacts — `data/snapshot.json`, `内存清理助手.html`, `logs/`, `*.log` are already excluded by `.gitignore`; please do not `git add -f` them.
3. Run the tests after changes: `npm test` (same as `node --test "server/services/__tests__/*.test.js"`;
   Node 24 requires the `*.test.js` glob, passing just the directory fails). Before committing you can run
   `npm run verify` (`node --check` on the four entry points + the unit tests). CI runs exactly `npm test` on a Windows runner.
4. For UI changes, edit `_template.html` and then run `node build.js` to regenerate the single-file UI —
   editing `内存清理助手.html` directly will be overwritten by the next build.
5. Line endings are normalised by the root `.gitattributes`: text files are stored as LF, while
   `.bat` / `.cmd` / `.vbs` keep CRLF. Do not convert whole files back to CRLF or reflow them —
   that makes the committed content differ between machines.

## License

MIT — see [LICENSE](LICENSE). The software is provided "as is", without warranty of any kind: this tool
terminates processes and deletes files, and you use it at your own risk.
