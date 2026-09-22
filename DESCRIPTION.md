# 内存清理助手 · 项目简介 / Project Description

---

## 中文简介

**内存清理助手**（Memory Cleaner）是一个面向 Windows 的本地内存与磁盘清理工具。

它读取整机内存数据，把零散进程按「应用」归组，展示每个应用占用了多少内存、有什么用途，并按安全等级分红/黄/绿三色标注；用户勾选后可一键结束进程释放内存。另带磁盘清理模块，能按应用归类磁盘占用、定位可清理的缓存与垃圾文件。

技术上**零依赖**——后端只用 Node.js 内置模块（`http`）+ PowerShell 采集脚本，前端是单文件 HTML 界面，不需要安装任何 npm 包。为保证安全，内置**九道闸门**（HTTP 访问控制：一次性令牌 + 环回 Host + 同源 Origin、默认 dry-run、保护进程拦截、必须二次确认、PID 复用防护、批量上限、审计日志、磁盘忙碌拒绝、禁止未公开内核 API），且只在进程确实退出后才上报释放量。数据全部在你本机处理，服务只监听 `127.0.0.1`。

---

## English Description

**Memory Cleaner** is a local memory and disk cleaning tool for Windows.

It reads your machine's memory data, groups scattered processes by "application," and shows how much memory each app uses and what it's for — labeled with a three-color safety rating (red / yellow / green). You can select apps and terminate them with one click to free memory. It also includes a disk-cleaning module that breaks down disk usage by application and locates cleanable caches and junk files.

It is **zero-dependency** — the backend uses only Node.js built-in modules (`http`) plus PowerShell collection scripts, and the frontend is a single HTML file. No npm packages required. For safety, actions are guarded by **nine gates** (HTTP access control with a one-time token, loopback-only Host and same-origin checks; default dry-run; protected-process blocking; mandatory confirmation; PID-reuse protection; batch limit; audit logging; disk-busy rejection; and a ban on undocumented kernel APIs), and freed-memory figures are reported only after a process actually exits. All data stays on your machine, and the server listens only on `127.0.0.1`.

---

## 一句话版 / One-liner

> **中文**：一个零依赖的 Windows 内存/磁盘清理工具，按应用归组展示占用与用途，带九道安全闸门守护清理。
>
> **English**: A zero-dependency Windows memory & disk cleaner that groups usage by application and guards every cleanup with eight safety gates.
