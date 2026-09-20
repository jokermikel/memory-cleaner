@echo off
REM ASCII-only wrapper. Do NOT put Chinese in this file:
REM cmd.exe reads .bat as ANSI/GBK; UTF-8 Chinese will crash the script.
cd /d "%~dp0"
call "%~dp0start.cmd"
