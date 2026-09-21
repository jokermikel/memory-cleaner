# trimWorkingSet.ps1 -- process-level working set trim via PUBLIC APIs only.
# Allowed: EmptyWorkingSet (psapi) / SetProcessWorkingSetSize (kernel32).
# FORBIDDEN: UndocumentedSystemMemoryApi, UndocumentedMemoryListClass, ForbiddenMemoryFlush*,
#            standby/modified list flush, any undocumented kernel call.
# Input : targets JSON [{pid, name, startTimeMs}]
# Output: result  JSON [{pid, name, ok, method, error, wsBefore, wsAfter, verified}]
# Keep pure ASCII (PowerShell 5.1 reads .ps1 as ANSI).

param(
  [Parameter(Mandatory=$true)][string]$TargetsFile,
  [Parameter(Mandatory=$true)][string]$ResultFile
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CcWsTrim {
  [DllImport("psapi.dll", SetLastError=true)]
  public static extern bool EmptyWorkingSet(IntPtr hProcess);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetProcessWorkingSetSize(IntPtr hProcess, IntPtr min, IntPtr max);
}
"@

function Write-Utf8($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Write-Results($path, $list) {
  if ($null -eq $list -or $list.Count -eq 0) {
    Write-Utf8 $path '[]'
    return
  }
  $json = @($list.ToArray()) | ConvertTo-Json -Compress -Depth 4
  if ($list.Count -eq 1 -and $json -notmatch '^\s*\[') {
    $json = '[' + $json + ']'
  }
  if ([string]::IsNullOrEmpty($json)) { $json = '[]' }
  Write-Utf8 $path $json
}

function New-Entry($processId, $procName) {
  return [ordered]@{
    pid      = [int]$processId
    name     = [string]$procName
    ok       = $false
    method   = $null
    error    = $null
    wsBefore = 0
    wsAfter  = 0
    verified = $false
  }
}

function Get-UnixMs($dt) {
  if ($null -eq $dt) { return $null }
  try {
    $utc = ([DateTime]$dt).ToUniversalTime()
    $epoch = [DateTime]::SpecifyKind([DateTime]'1970-01-01', 'Utc')
    return [int64]($utc - $epoch).TotalMilliseconds
  } catch {
    return $null
  }
}

function Test-PidReused($t, $proc) {
  $actualMs = Get-UnixMs $proc.StartTime
  $expectedMs = $null
  if ($t.PSObject.Properties.Name -contains 'startTimeMs' -and $t.startTimeMs) {
    try { $expectedMs = [int64]$t.startTimeMs } catch { $expectedMs = $null }
  }
  if (-not $expectedMs -or -not $actualMs) {
    return @{ reused = $false; verified = $false }
  }
  $diff = [math]::Abs($actualMs - $expectedMs)
  if ($diff -gt 2000) {
    return @{ reused = $true; verified = $true }
  }
  return @{ reused = $false; verified = $true }
}

$raw = [System.IO.File]::ReadAllText($TargetsFile, [System.Text.Encoding]::UTF8)
$targets = @()
$parseError = $null
try {
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'Stop'
  $trimmed = $raw.Trim()
  if ([string]::IsNullOrEmpty($trimmed) -or $trimmed -eq '[]') {
    $targets = @()
  } else {
    $parsed = ConvertFrom-Json -InputObject $raw
    if ($null -eq $parsed) { $targets = @() }
    else { $targets = @($parsed) }
  }
  $ErrorActionPreference = $oldEap
} catch {
  $parseError = $_.Exception.Message
  $targets = @()
}

$results = New-Object System.Collections.ArrayList

if ($parseError) {
  $entry = New-Entry 0 ''
  $safe = ($parseError -replace '[^\x20-\x7E]', ' ')
  $entry.error = 'json_parse_failed: ' + $safe
  [void]$results.Add($entry)
  Write-Results $ResultFile $results
  exit 0
}

foreach ($t in $targets) {
  $entry = New-Entry $t.pid $t.name
  $targetPid = [int]$t.pid
  if ($targetPid -le 4 -or $targetPid -eq $PID) {
    $entry.error = 'refused_system_pid'
    [void]$results.Add($entry)
    continue
  }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    $entry.error = 'process_not_found'
    [void]$results.Add($entry)
    continue
  }

  $entry.wsBefore = [int64]$proc.WorkingSet64
  $reuse = Test-PidReused $t $proc
  if ($reuse.reused) {
    $entry.error = 'pid_reused_refused'
    $entry.verified = $true
    [void]$results.Add($entry)
    continue
  }
  $entry.verified = [bool]$reuse.verified

  $handle = [IntPtr]::Zero
  try { $handle = $proc.Handle } catch { $handle = [IntPtr]::Zero }
  if ($handle -eq [IntPtr]::Zero) {
    $entry.error = 'open_process_denied'
    [void]$results.Add($entry)
    continue
  }

  $trimmed = $false
  try {
    $trimmed = [CcWsTrim]::EmptyWorkingSet($handle)
    if ($trimmed) { $entry.method = 'EmptyWorkingSet' }
  } catch {
    $trimmed = $false
  }

  if (-not $trimmed) {
    try {
      $neg = [IntPtr]::new(-1)
      $trimmed = [CcWsTrim]::SetProcessWorkingSetSize($handle, $neg, $neg)
      if ($trimmed) { $entry.method = 'SetProcessWorkingSetSize' }
    } catch {
      $trimmed = $false
    }
  }

  Start-Sleep -Milliseconds 80
  $after = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -ne $after) {
    try { $entry.wsAfter = [int64]$after.WorkingSet64 } catch { $entry.wsAfter = $entry.wsBefore }
  } else {
    $entry.wsAfter = 0
  }

  if ($trimmed) {
    $entry.ok = $true
  } else {
    $entry.error = 'trim_failed'
  }
  [void]$results.Add($entry)
}

Write-Results $ResultFile $results
