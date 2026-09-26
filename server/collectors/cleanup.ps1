# cleanup.ps1 -- close processes safely, with PID-reuse protection
# Input : targets JSON file  [{pid, name, startTime, startTimeMs}]
# Output: result  JSON file  [{pid, name, ok, method, error, wsBefore, verified}]
# Keep pure ASCII (PowerShell 5.1 reads .ps1 as ANSI).
#
# PS 5.1 pitfall: `$raw | ConvertFrom-Json` silently drops / truncates arrays
# whose objects contain ISO-8601 timestamps with a timezone offset.
# Always use ConvertFrom-Json -InputObject, and prefer numeric startTimeMs.

param(
  [Parameter(Mandatory=$true)][string]$TargetsFile,
  [Parameter(Mandatory=$true)][string]$ResultFile,
  [int]$GraceMs = 4000,
  [switch]$Force,
  # Semicolon-separated image names (no .exe) that must never be ended as part
  # of a descendant tree. Supplied by cleanupService from protectedProcesses.json
  # plus every app graded protected in the current snapshot.
  [string]$ProtectedNames = ''
)

$ErrorActionPreference = 'SilentlyContinue'

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
    verified = $false
    exited   = $false
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
  if (-not $expectedMs -and $t.startTime) {
    if ($t.startTime -is [DateTime]) {
      $expectedMs = Get-UnixMs $t.startTime
    } else {
      try { $expectedMs = Get-UnixMs ([DateTime]::Parse([string]$t.startTime)) } catch { $expectedMs = $null }
    }
  }
  if (-not $expectedMs -or -not $actualMs) {
    # Fail closed when PID identity cannot be verified.
    return @{ reused = $true; verified = $false; verificationFailed = $true }
  }
  $diff = [math]::Abs($actualMs - $expectedMs)
  if ($diff -gt 2000) {
    return @{ reused = $true; verified = $true }
  }
  return @{ reused = $false; verified = $true }
}

function Invoke-Taskkill($targetPid) {
  try {
    & "$env:SystemRoot\System32\taskkill.exe" /PID ([string]$targetPid) /T /F | Out-Null
    if ($null -eq $LASTEXITCODE) { return 0 }
    return [int]$LASTEXITCODE
  } catch {
    return -1
  }
}

# Build "parent pid -> direct children" once per run, so the tree guard below
# does not spawn one query per target.
# Returns $null when the process table cannot be read at all: the caller must
# then treat the tree as unverifiable and refuse (fail closed).
function Get-ChildIndex {
  $procs = @()
  try {
    $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  } catch {
    return $null
  }
  if ($procs.Count -eq 0) { return $null }
  $index = @{}
  foreach ($pr in $procs) {
    if ($null -eq $pr) { continue }
    $key = [int]$pr.ParentProcessId
    if (-not $index.ContainsKey($key)) { $index[$key] = New-Object System.Collections.ArrayList }
    $nm = ([string]$pr.Name) -replace '\.exe$', ''
    [void]$index[$key].Add([pscustomobject]@{ pid = [int]$pr.ProcessId; name = $nm })
  }
  return $index
}

# Descendants of $RootPid that must not be ended: kernel/system PIDs and any
# image name in $ProtectedSet. Returns @{ failed = bool; hits = string[] }.
# failed = $true means the descendant set could not be computed.
function Get-TreeHits($childIndex, [int]$RootPid, $ProtectedSet) {
  if ($null -eq $childIndex) { return @{ failed = $true; hits = @() } }
  $hits = New-Object System.Collections.ArrayList
  $seen = @{}
  $seen[$RootPid] = $true
  $queue = New-Object System.Collections.ArrayList
  if ($childIndex.ContainsKey($RootPid)) {
    foreach ($c in $childIndex[$RootPid]) { [void]$queue.Add($c) }
  }
  while ($queue.Count -gt 0) {
    $cur = $queue[0]
    $queue.RemoveAt(0)
    if ($seen.ContainsKey($cur.pid)) { continue }
    $seen[$cur.pid] = $true
    if ([int]$cur.pid -le 4) { [void]$hits.Add('pid:' + [string]$cur.pid); continue }
    if ($ProtectedSet.Contains(([string]$cur.name).ToLowerInvariant())) {
      [void]$hits.Add([string]$cur.name)
      continue
    }
    if ($childIndex.ContainsKey($cur.pid)) {
      foreach ($g in $childIndex[$cur.pid]) { [void]$queue.Add($g) }
    }
  }
  return @{ failed = $false; hits = @($hits.ToArray()) }
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

# Kill watchdogs first so they cannot respawn the app mid-run.
$targets = @($targets | Sort-Object @{
  Expression = {
    $n = [string]$_.name
    if ($n -match 'guard') { 0 } else { 1 }
  }
})

# Sweep baseline: a respawn can only have started at/after this run began.
# Any same-named process that was already alive before this moment is a real
# user process and must never be killed by the directory sweep below.
$sweepStartMs = Get-UnixMs (Get-Date)

# Tree-kill guard state. Only built when force-killing, because the tree is
# only ended by `taskkill /T` in that branch.
$protectedSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($pn in ([string]$ProtectedNames).Split(';')) {
  $norm = ([string]$pn).Trim().ToLowerInvariant()
  if ($norm) { [void]$protectedSet.Add($norm) }
}
$childIndex = $null
$treeGuardActive = $false
if ($Force) {
  $treeGuardActive = $true
  $childIndex = Get-ChildIndex
}

foreach ($t in $targets) {
  $entry = New-Entry $t.pid $t.name
  $targetPid = [int]$t.pid
  # $PID is the current PowerShell process; PIDs 0-4 are kernel/system.
  if ($targetPid -le 4 -or $targetPid -eq $PID) {
    $entry.error = 'refused_system_pid'
    [void]$results.Add($entry)
    continue
  }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    $entry.error = 'process_not_found'
    $entry.ok = $true
    $entry.method = 'already_gone'
    $entry.exited = $true
    [void]$results.Add($entry)
    continue
  }

  $entry.wsBefore = [int64]$proc.WorkingSet64

  $reuse = Test-PidReused $t $proc
  if ($reuse.verificationFailed) {
    $entry.error = 'start_time_unverified'
    $entry.verified = $false
    [void]$results.Add($entry)
    continue
  }
  if ($reuse.reused) {
    $entry.error = 'pid_reused_refused'
    $entry.verified = $true
    [void]$results.Add($entry)
    continue
  }
  $entry.verified = [bool]$reuse.verified

  # Tree-kill guard: `taskkill /T` ends the whole descendant tree without
  # consulting each child's own risk grade. If any descendant is a protected
  # system process -- or the descendant set cannot be established -- refuse this
  # target entirely and touch nothing, the same fail-closed stance used above
  # for unverifiable PID identity. Checked before the graceful close so that
  # "refused" really means no process of this target was ended.
  if ($treeGuardActive) {
    $tree = Get-TreeHits $childIndex $targetPid $protectedSet
    if ($tree.failed) {
      $entry.error = 'tree_check_failed'
      [void]$results.Add($entry)
      continue
    }
    if (@($tree.hits).Count -gt 0) {
      $entry.error = 'tree_contains_protected'
      $entry.treeProtected = @($tree.hits)
      [void]$results.Add($entry)
      continue
    }
  }

  $gracefulSent = $false
  try {
    $gracefulSent = $proc.CloseMainWindow()
  } catch {
    $gracefulSent = $false
  }

  if ($gracefulSent) {
    try { [void]$proc.WaitForExit($GraceMs) } catch { }
  }

  $stillRunning = $false
  try { $stillRunning = -not $proc.HasExited } catch { $stillRunning = $true }

  if (-not $stillRunning) {
    $entry.ok = $true
    $entry.method = 'graceful'
    $entry.exited = $true
    [void]$results.Add($entry)
    continue
  }

  if ($Force) {
    $code = Invoke-Taskkill $targetPid
    Start-Sleep -Milliseconds 250
    $chk = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    if ($null -eq $chk) {
      $entry.ok = $true
      $entry.method = 'force'
      $entry.exited = $true
    } else {
      try {
        Stop-Process -Id $targetPid -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 200
      } catch { }
      $chk2 = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
      if ($null -eq $chk2) {
        $entry.ok = $true
        $entry.method = 'force'
        $entry.exited = $true
      } else {
        $entry.error = 'force_failed_still_running'
      }
    }
    if (-not $entry.ok -and $code -ne 0 -and $code -ne -1) {
      $entry.error = 'force_failed_still_running'
    }
  } else {
    $entry.error = 'still_running_graceful_only'
  }

  [void]$results.Add($entry)
}

# Sweep respawns only under the same install directories as the original targets.
# Never sweep by image name alone (that would kill every node.exe on the machine).
if ($Force -and $targets.Count -gt 0) {
  Start-Sleep -Milliseconds 400
  $refused = @{}
  foreach ($r in $results) {
    if ($r.error -eq 'pid_reused_refused') { $refused[[int]$r.pid] = $true }
  }
  $prefixes = New-Object System.Collections.ArrayList
  foreach ($t in $targets) {
    if ($t.path) {
      try {
        $dir = [System.IO.Path]::GetDirectoryName([string]$t.path)
        if ($dir) { [void]$prefixes.Add($dir.ToLowerInvariant()) }
      } catch { }
    }
  }
  if ($prefixes.Count -gt 0) {
    $names = @($targets | ForEach-Object { [string]$_.name } | Select-Object -Unique)
    foreach ($n in $names) {
      if ([string]::IsNullOrEmpty($n)) { continue }
      $alive = @(Get-Process -Name $n -ErrorAction SilentlyContinue)
      foreach ($ap in $alive) {
        if ([int]$ap.Id -le 4 -or [int]$ap.Id -eq $PID) { continue }
        if ($refused.ContainsKey([int]$ap.Id)) { continue }
        $ppath = $null
        try { $ppath = [string]$ap.Path } catch { $ppath = $null }
        if ([string]::IsNullOrEmpty($ppath)) { continue }
        $pl = $ppath.ToLowerInvariant()
        $sameTree = $false
        foreach ($pre in $prefixes) {
          # Match only at a directory boundary. A bare StartsWith() would let
          # 'c:\app' match 'c:\app-other\run.exe' and kill an unrelated program.
          $withSep = $pre
          if (-not $withSep.EndsWith('\')) { $withSep = $withSep + '\' }
          if ($pl.StartsWith($withSep) -or $pl -eq $pre) { $sameTree = $true; break }
        }
        if (-not $sameTree) { continue }
        # BUG-1 fix: only sweep a process that started at/after this run began.
        # A same-named process that was already alive before the sweep is a real
        # user process, not a respawn of the ones we just closed -- leave it alone.
        $apStartMs = Get-UnixMs $ap.StartTime
        if ($null -eq $apStartMs -or $apStartMs -lt $sweepStartMs) { continue }
        $already = $false
        foreach ($r in $results) {
          if ([int]$r.pid -eq [int]$ap.Id -and $r.ok) { $already = $true; break }
        }
        if ($already) { continue }
        $entry = New-Entry $ap.Id $n
        try { $entry.wsBefore = [int64]$ap.WorkingSet64 } catch { }
        [void](Invoke-Taskkill $ap.Id)
        Start-Sleep -Milliseconds 200
        $chk = Get-Process -Id $ap.Id -ErrorAction SilentlyContinue
        if ($null -eq $chk) {
          $entry.ok = $true
          $entry.method = 'force_sweep'
          $entry.exited = $true
        } else {
          $entry.error = 'force_failed_still_running'
        }
        [void]$results.Add($entry)
      }
    }
  }
}

Write-Results $ResultFile $results
