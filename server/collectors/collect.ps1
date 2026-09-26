# collect.ps1 -- memory snapshot collector for Windows
# Output: single-line JSON to stdout (UTF-8 without BOM)
# IMPORTANT: keep this file pure ASCII. PowerShell 5.1 reads .ps1 as ANSI,
# so non-ASCII literals here would be corrupted. Chinese text lives in the
# Node-side dictionary (data/appDict.zh.json) instead.

$ErrorActionPreference = 'SilentlyContinue'
$script:errors = New-Object System.Collections.ArrayList

function SafeGet {
  param([scriptblock]$Block, [string]$Label)
  try {
    $r = & $Block
    if ($null -eq $r) { [void]$script:errors.Add("$Label`:null") }
    return $r
  } catch {
    [void]$script:errors.Add("$Label`: " + $_.Exception.Message)
    return $null
  }
}

# ---------- 1. OS level memory ----------
$os = SafeGet { Get-CimInstance -ClassName Win32_OperatingSystem } 'os'
$cs = SafeGet { Get-CimInstance -ClassName Win32_ComputerSystem } 'cs'

# ---------- 2. physical memory modules ----------
$modules = SafeGet {
  @(Get-CimInstance -ClassName Win32_PhysicalMemory |
    Select-Object BankLabel, DeviceLocator, Capacity, Speed, ConfiguredClockSpeed,
                  Manufacturer, PartNumber, SerialNumber, MemoryType, SMBIOSMemoryType)
} 'modules'

# ---------- 3. page file ----------
$pagefile = SafeGet {
  Get-CimInstance -ClassName Win32_PageFileUsage |
    Select-Object Name, AllocatedBaseSize, CurrentUsage, PeakUsage
} 'pagefile'

# ---------- 3b. OS memory performance counters ----------
# AvailableMBytes is the value Task Manager labels "Available" (free + standby).
# FreePhysicalMemory alone understates availability, which is why users see a
# mismatch. We collect both and label them distinctly in the UI.
$perfOs = SafeGet {
  Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory |
    Select-Object AvailableMBytes, AvailableKBytes, CacheBytes, CommittedBytes,
                  CommitLimit, PercentCommittedBytesInUse, FreeAndZeroPageListBytes,
                  ModifiedPageListBytes, StandbyCacheNormalPriorityBytes,
                  StandbyCacheReserveBytes, StandbyCacheCoreBytes,
                  PoolPagedBytes, PoolNonpagedBytes
} 'perfOs'

# ---------- 4. process table ----------
# Two sources merged by PID:
#   a) Get-Process  -> accurate WorkingSet64 / PrivateMemorySize64 (matches Task Manager)
#   b) Win32_Process -> ParentProcessId / ExecutablePath (CIM only)
$getProc = SafeGet {
  Get-Process | ForEach-Object {
    [pscustomobject]@{
      pid           = $_.Id
      name          = $_.ProcessName
      workingSet    = $_.WorkingSet64
      privateBytes  = $_.PrivateMemorySize64
      pagedMemory   = $_.PagedMemorySize64
      virtualBytes  = $_.VirtualMemorySize64
      startTime     = if ($_.StartTime) { $_.StartTime.ToString('o') } else { $null }
      cpuSeconds    = if ($_.CPU) { [math]::Round($_.CPU, 3) } else { 0 }
    }
  }
} 'getProcess'

$cimProc = SafeGet {
  Get-CimInstance -ClassName Win32_Process |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate
} 'cimProcess'

if (-not $getProc) { $getProc = @() }
if (-not $cimProc) { $cimProc = @() }
# PS 5.1 ConvertTo-Json collapses a 1-element array to a bare object.
# Wrap CIM collections so a laptop with one DIMM still serializes as [].
if ($null -eq $modules) { $modules = @() } else { $modules = @($modules) }
if ($null -eq $getProc) { $getProc = @() } else { $getProc = @($getProc) }
if ($null -eq $cimProc) { $cimProc = @() } else { $cimProc = @($cimProc) }
if ($null -eq $script:errors) { $script:errors = @() } else { $script:errors = @($script:errors) }

# ---------- 5. privilege state ----------
$isAdmin = $false
try {
  $wi = [Security.Principal.WindowsIdentity]::GetCurrent()
  $wp = New-Object Security.Principal.WindowsPrincipal($wi)
  $isAdmin = $wp.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {
  [void]$script:errors.Add('isAdmin: ' + $_.Exception.Message)
}

$result = [ordered]@{
  schemaVersion = 1
  collectedAt   = (Get-Date).ToUniversalTime().ToString('o')
  hostName      = $env:COMPUTERNAME
  isAdmin       = $isAdmin
  os            = $os
  cs            = $cs
  modules       = $modules
  pagefile      = $pagefile
  perfOs        = $perfOs
  processes     = $getProc
  cimProcesses  = $cimProc
  errors        = $script:errors
}

$json = $result | ConvertTo-Json -Compress -Depth 5
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.Write($json)
