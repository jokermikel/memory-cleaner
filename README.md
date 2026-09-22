# Memory Cleaner

[简体中文](README_CN.md) | **English**

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
| 2. Protected-process blocking | Selecting a critical system process is rejected with HTTP 403 and a Chinese reason |
| 3. Confirmation required | Real execution requires `confirmed:true`, otherwise HTTP 400 |
| 4. PID-reuse protection | PID + start time are compared before execution; a mismatch is rejected (prevents killing a newly started process that reused the PID) |
| 5. Batch limit | More than 20 processes in one run requires an explicit `acknowledgeBatchLimit:true`; `force` only means force-kill and cannot be used to allow a batch |
| 6. Audit log | Every operation is written to `logs/cleanup-YYYYMMDD.log` with success / failure / reason |
| 7. Busy-disk rejection | Disk throughput ≥ 20MB/s or queue ≥ 3 returns HTTP 409, avoiding cleanup during downloads / copies |
| 8. No undocumented kernel APIs | Does not call `NtSetSystemInformation` or similar; never flushes the Standby / Modified lists |

**Honest boundary of the access control**: the token is delivered inside the homepage. External web pages cannot read the homepage because of the same-origin policy, so they cannot get the token — this **raises the bar**, it is not absolute isolation. A program already running on your machine can still read the local files or the homepage to obtain the token. True isolation would require switching to named pipes or another inter-process channel instead of HTTP.

**Freed-memory honesty**: freed memory is reported only after a process actually exits. If nothing was closed, it reports 0 and explains that the system memory delta is just natural fluctuation — it never passes noise off as results. The figure is counted from **the working set of each successful process** (not from the whole-machine memory delta), so other processes' natural fluctuation is not counted as this run's gain.

## API Overview

All endpoints require the `X-CC-Token` request header (the token is read from `window.__CC_TOKEN__` in the homepage HTML). **Exceptions are a few millisecond-level, side-effect-free endpoints**: `/api/health`, `/api/cleanup/io`, `/api/disk/volumes`, `/api/disk/migrate/{presets,inspect,records}`, `/api/privilege/status`.

Why even read endpoints need a token: `/api/disk/snapshot` and `/api/disk/apps` perform a 30~60 second full-drive scan. Without a token, any web page could trigger them repeatedly with a single `<img src="http://127.0.0.1:7788/api/disk/snapshot">` — an `img` request carries no `Origin`, so origin checks cannot stop it, but it **can never carry a custom request header**. The `Host` / `Origin` checks apply to all `/api/*`.

| Endpoint | Description |
|---|---|
| `GET /` | UI (same origin as the service; cleanup works) |
| `GET /api/health` | Health check (includes `isAdmin`) |
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
| `GET /api/disk/migrate/presets` | Common cache directories that can be relocated |
| `GET /api/disk/migrate/inspect?path=` | Link inspector (normal dir / junction / symlink / broken link) |
| `GET /api/disk/migrate/records` | Relocation records |
| `POST /api/disk/migrate/precheck` | Relocation precheck |
| `POST /api/disk/migrate/execute` | Relocate cache + create link (junction by default, requires confirmed=true) |
| `GET /api/privilege/status` | Whether you are admin and can elevate |
| `POST /api/privilege/elevate` | Raise UAC and restart the service as admin (`dryRun:true` only returns the plan) |

## Project Structure

```
启动.bat                      One-click launch (collect + generate + serve + open browser)
build.js                      Collect data and generate the UI
cli.js                        Command-line ranking
内存清理助手.html            Single-file UI (data embedded, double-click to view)
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
  collectors/
    collect.ps1               Memory collection script
    cleanup.ps1               Process cleanup script (with PID-reuse protection)
    trimWorkingSet.ps1        Working-set trim script (public APIs only)
    processList.js            Merges two data sources
    systemMemory.js           Machine memory / RAM module structuring
data/
  appDict.zh.json             Chinese purpose dictionary (70+ entries)
  protectedProcesses.json     Never-terminate list (18 critical system processes)
  snapshot.json               Most recent collection snapshot
logs/                         Audit logs
```

## Key Design Decisions

1. **`Get-Process.WorkingSet64` is the primary metric**: measured at the same instant, CIM's `WorkingSetSize` total runs more than 1GB above real usage; only `WorkingSet64` matches Task Manager.
2. **Grouping conservation is a hard constraint**: total app memory after grouping must exactly equal total process memory before grouping — otherwise a process was dropped.
3. **Purposes are never invented**: dictionary entries are based on common paths verified to exist on Windows, or reverse lookups against the `Win32_Service` table; anything unknown shows "not catalogued". The dictionary **presets no machine-specific numbers** — sizes always come from a live scan, and `note` only carries magnitude hints and handling reminders.
4. **Cleanup is graceful first, forced second**: a close message is sent first (equivalent to clicking ×, letting the program save), and only failure escalates to forced termination.
5. **A note from real testing**: Windows service processes (such as `MSPCManagerService`) cannot be killed under normal privileges and return "access denied" — that is the permission model, and it needs administrator rights.
6. **Only public APIs for freeing memory**: terminate processes or trim working sets; never force-flush the system standby / modified page lists.
7. **Prefer relocating caches over deleting them**: deleted caches get rebuilt and reclaim C:; relocate + junction frees the space permanently.

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
- **Degrades with no D: drive**: with only a system drive, the data-drive list is empty and the scan loop skips safely; the app still reports system-drive usage and junk.
- **RAM modules shown per machine**: physical memory comes from `Win32_PhysicalMemory`; capacity / vendor / slot / speed / generation are read live from this machine, never hardcoded. PowerShell 5.1 collapses a single module into an object, so both the collector script and the Node side force it into an array — laptops with one module and desktops with several both display correctly.

## Testing

The test scaffolding (`server/services/__tests__/`) runs on the maintainer's machine only and is **not distributed with the repo** — it contains machine-specific paths and process names.
Below are the test results; full details are in **`最终测试报告.md`** at the repo root.

To rerun locally as the maintainer:

```bash
node --test server/services/__tests__/*.test.js
```

Node 24 requires the `*.test.js` glob; passing just the directory fails.

### Completed

| Scope | Result |
|---|---|
| Existing unit tests (grouping conservation, risk rating, safety gates, disk cleanup, elevation, sweep timing, etc.) | **96/96 passed** (14 suites) |
| Added: undocumented-kernel-API scan, busy-disk gate, working-set trim gate | Passed |
| Added: cache relocation in a sandbox (`mklink /J` inside `%TEMP%` + probe + rollback rejection cases) | 9/9 passed |
| Added: RAM modules 0 / 1 (PowerShell collapsing to an object) / N | Passed |
| Added: standalone batch-limit gate, forbidden paths for all drives, dynamic junk-scan drive letter, PID-reuse fallback, per-process freed-memory accounting | 12/12 passed |
| Added: dictionary free of machine-specific values, CLI and server sharing one junk list, dead code removal | 4/4 passed |
| Rerun of all the above | **96/96 passed** (2026-09-23, Windows 11 10.0.26200.9457) |

End-to-end **150 checks** (T0~T12, including HTTP access control and the P2 regressions) also run locally only and are not distributed.

The older full-function pass (collection / process termination / HTTP / UI / CLI) is in the historical record: 47 checks passed at the time.

### Not Covered (Manual, On Real Machines)

| Item | Note |
|---|---|
| Click through the new UI buttons | Precheck / confirm for "trim working sets" and "relocate cache", plus "show all" for disk apps — no real UI click testing |
| Relocating a real cache directory | Not run against production browser / game paths; only verified in a `%TEMP%` sandbox |
| Junction still valid after reboot | Should survive per NTFS semantics; not verified with an actual reboot |
| Repeated cleanup during large downloads | No blue-screen stress test; the code refuses cleanup under high I/O, which is not a substitute for real testing |
| ≥24 hour loop | Not run |

## Security Notes

- The runtime snapshot `data/snapshot.json` and the generated UI `内存清理助手.html` contain this machine's real process list and username. Both are excluded by `.gitignore` and are **never uploaded**.
- Audit logs (`logs/`, `*.log`) and timestamped tool backups (`*.2026-*-*Z`) are excluded as well.
- The unit-test scaffolding (`server/services/__tests__/`) contains machine-specific paths and process names; it is excluded by `.gitignore` and not distributed.
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
3. Run the local tests after changes: `node --test server/services/__tests__/*.test.js`
   (Node 24 requires the `*.test.js` glob; passing just the directory fails).
4. For UI changes, edit `_template.html` and then run `node build.js` to regenerate the single-file UI —
   editing `内存清理助手.html` directly will be overwritten by the next build.

## License

This project **does not yet ship a LICENSE file; no license has been specified**. Please check with the author before using, modifying, or distributing it.
(The author can add a `LICENSE` file to the repo root later if they choose to open-source it.)
