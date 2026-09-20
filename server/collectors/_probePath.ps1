# ASCII only. Probe QueryFullProcessImageName vs Win32_Process.ExecutablePath
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ProcPath {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool QueryFullProcessImageName(IntPtr h, int f, StringBuilder n, ref int s);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "OPEN_FAIL:" + Marshal.GetLastWin32Error();
    try {
      int size = 1024;
      var sb = new StringBuilder(size);
      if (QueryFullProcessImageName(h, 0, sb, ref size)) return sb.ToString();
      return "QFAIL:" + Marshal.GetLastWin32Error();
    } finally { CloseHandle(h); }
  }
}
"@

$ids = 4052,7576,12268,4164,34260,428,472,19472,10796,2096,14460,1916,1968,21268,12616,1416,4,2132,1348,0
foreach($id in $ids){
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  $n = if($p){ $p.ProcessName } else { '?' }
  $path = $null
  try { $path = $p.Path } catch { $path = $null }
  $q = [ProcPath]::Get($id)
  Write-Output ("$id|$n|GetProcessPath=$path|QFPIN=$q")
}
