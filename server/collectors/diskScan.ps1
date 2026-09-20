# diskScan.ps1 -- disk space scanner
# Uses robocopy /L (list-only, no copy) for directory sizing.
# PURE ASCII: PowerShell 5.1 reads .ps1 as ANSI, no non-ASCII literals.
# Output: UTF-8 JSON (no BOM) to stdout.

param(
  [Parameter(Mandatory=$true)][string]$Drive,
  [string]$TopDirs = "",
  [string]$JunkList = ""
)

$ErrorActionPreference = 'SilentlyContinue'
$script:errors = New-Object System.Collections.ArrayList

function Get-DirSize([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return [int64]0 }
  if (-not (Test-Path -LiteralPath $path)) { return [int64]0 }

  $nullDest = Join-Path $env:TEMP ('rcnull_' + [guid]::NewGuid().ToString('N'))
  $output = $null
  try {
    $output = & robocopy.exe $path $nullDest /L /E /BYTES /NFL /NDL /NJH /NP /R:0 /W:0 /XJ 2>&1
  } catch {
    [void]$script:errors.Add("robocopy $path : $($_.Exception.Message)")
    return [int64]0
  }

  # Parse the Bytes / 字节 summary row only.
  # Do NOT take the max integer in the whole output: on Chinese Windows
  # the trailing "Ended" line looks like "2026年9月19日 1:53:12" and used
  # to be misread as 2026 bytes for empty directories (CrashDumps, Minidump).
  $bytesLabel = ([char]0x5B57).ToString() + ([char]0x8282).ToString() # "字节", keep this file ASCII
  $candidates = New-Object System.Collections.ArrayList
  foreach ($line in $output) {
    $s = [string]$line
    if ($s -match '\d+:\d+:\d+') { continue } # Times / Ended
    $matches2 = [regex]::Matches($s, '\d+')
    if ($matches2.Count -lt 4) { continue }
    $first = [int64]0
    if (-not [int64]::TryParse($matches2[0].Value, [ref]$first)) { continue }
    $isBytesRow = ($s -match 'Bytes') -or ($s.Contains($bytesLabel))
    if ($isBytesRow) { return $first }
    [void]$candidates.Add($first)
  }
  # Fallback: Dirs / Files / Bytes in that order -> 3rd is Bytes
  if ($candidates.Count -ge 3) { return [int64]$candidates[2] }
  return [int64]0
}

# ---- 1. drive info ----
$driveInfo = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$Drive'" -ErrorAction SilentlyContinue

# ---- 2. top-level dirs ----
# Use a regular PowerShell array of PSCustomObject. ArrayList + ConvertTo-Json
# in PS 5.1 serializes as [""] (known bug).
$topList = @()
$names = @()
if ($TopDirs -and $TopDirs.Trim().Length -gt 0) {
  $names = @($TopDirs.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
} else {
  $all = Get-ChildItem -LiteralPath ($Drive + '\') -Directory -Force -ErrorAction SilentlyContinue
  $names = @($all | ForEach-Object { $_.Name })
}

foreach ($n in $names) {
  $p = Join-Path $Drive $n
  $bytes = Get-DirSize $p
  $topList += [pscustomobject]@{ name = $n; path = $p; bytes = $bytes }
}

# ---- 3. junk paths ----
$junkArr = @()
if ($JunkList -and $JunkList.Trim().Length -gt 0) {
  foreach ($jp in @($JunkList.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    $expanded = [Environment]::ExpandEnvironmentVariables($jp)
    $exists = Test-Path -LiteralPath $expanded
    $bytes = if ($exists) { Get-DirSize $expanded } else { [int64]0 }
    $junkArr += [pscustomobject]@{ path = $jp; expanded = $expanded; bytes = $bytes; exists = [bool]$exists }
  }
}

$total = [int64]0
$free = [int64]0
if ($driveInfo) {
  $total = [int64]$driveInfo.Size
  $free = [int64]$driveInfo.FreeSpace
}

$result = [ordered]@{
  schemaVersion = 1
  collectedAt   = (Get-Date).ToUniversalTime().ToString('o')
  drive         = $Drive
  volumeName    = if ($driveInfo) { [string]$driveInfo.VolumeName } else { '' }
  totalBytes    = $total
  freeBytes     = $free
  usedBytes     = $total - $free
  fileSystem    = if ($driveInfo) { [string]$driveInfo.FileSystem } else { '' }
  topDirs       = @($topList)
  junkPaths     = @($junkArr)
  errors        = @($script:errors.ToArray())
}

$json = $result | ConvertTo-Json -Compress -Depth 6
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.Write($json)
