' elevate.vbs -- ASCII only. Unicode paths come in via WScript.Arguments.
' Usage: wscript.exe elevate.vbs <nodeExe> <launcher.js> <replacePid>
' Shell.Application.ShellExecute with verb "runas" is the reliable way
' to show the Windows UAC consent dialog from a background process.
Option Explicit

If WScript.Arguments.Count < 3 Then
  WScript.Quit 1
End If

Dim nodeExe, launcher, replacePid, workDir, slashPos, args
nodeExe = WScript.Arguments(0)
launcher = WScript.Arguments(1)
replacePid = WScript.Arguments(2)

slashPos = InStrRev(launcher, "\")
If slashPos < 1 Then
  WScript.Quit 2
End If
workDir = Left(launcher, slashPos - 1)

' Quote the launcher path so spaces/Chinese in the path stay one argument.
args = Chr(34) & launcher & Chr(34) & " --replace " & replacePid

Dim sh
Set sh = CreateObject("Shell.Application")
' Last argument 1 = SW_SHOWNORMAL, so the elevated console is visible.
sh.ShellExecute nodeExe, args, workDir, "runas", 1
