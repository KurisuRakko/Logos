<#
.SYNOPSIS
  Installs the Surface diagnostics collector for the current user. Safe to run repeatedly.

.DESCRIPTION
  Copies surface-diag.ps1 and apps.json to %LOCALAPPDATA%\surface-diag\bin and registers two
  scheduled tasks for the current user (no administrator rights required):
    SurfaceDiag-Watch  At logon (2 minute delay) and every 15 minutes: surface-diag.ps1 -Reason watch
    SurfaceDiag-Crash  On Application log Event ID 1000 (Application Error): -Reason crash
  Both tasks start through "conhost.exe --headless" so that no console window is shown.
  Keep this file ASCII only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipConnectivityTest
)

$ErrorActionPreference = 'Stop'

$BaseDir = Join-Path $env:LOCALAPPDATA 'surface-diag'
$BinDir = Join-Path $BaseDir 'bin'
$Script = Join-Path $BinDir 'surface-diag.ps1'
$Conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

foreach ($d in @($BaseDir, $BinDir, (Join-Path $BaseDir 'state'), (Join-Path $BaseDir 'outbox'))) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
foreach ($f in @('surface-diag.ps1', 'apps.json')) {
    $src = Join-Path $PSScriptRoot $f
    if (-not (Test-Path -LiteralPath $src)) { throw "Missing source file: $src" }
    Copy-Item -LiteralPath $src -Destination (Join-Path $BinDir $f) -Force
}
Write-Host "Files copied to $BinDir"

function New-HeadlessAction([string]$Reason) {
    $arg = "--headless `"$PowerShellExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`" -Reason $Reason"
    return New-ScheduledTaskAction -Execute $Conhost -Argument $arg -WorkingDirectory $BinDir
}

$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

# Task A: logon + every 15 minutes.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$logon.Delay = 'PT2M'
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)
$watchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName 'SurfaceDiag-Watch' -TaskPath '\' -Action (New-HeadlessAction 'watch') `
    -Trigger @($logon, $periodic) -Principal $principal -Settings $watchSettings `
    -Description 'Surface diagnostics collector: periodic check, uploads only when new problems are found.' -Force | Out-Null
Write-Host 'Registered task SurfaceDiag-Watch (at logon and every 15 minutes)'

# Task B: Application Error (Event ID 1000). The collector filters by monitored executable.
$subscription = @'
<QueryList><Query Id="0" Path="Application"><Select Path="Application">*[System[Provider[@Name='Application Error'] and EventID=1000]]</Select></Query></QueryList>
'@
$eventClass = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace 'Root/Microsoft/Windows/TaskScheduler'
$eventTrigger = New-CimInstance -CimClass $eventClass -ClientOnly
$eventTrigger.Enabled = $true
$eventTrigger.Subscription = $subscription.Trim()
$eventTrigger.Delay = 'PT15S'
$crashSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances Queue -Hidden
Register-ScheduledTask -TaskName 'SurfaceDiag-Crash' -TaskPath '\' -Action (New-HeadlessAction 'crash') `
    -Trigger $eventTrigger -Principal $principal -Settings $crashSettings `
    -Description 'Surface diagnostics collector: runs when an Application Error (Event ID 1000) is logged.' -Force | Out-Null
Write-Host 'Registered task SurfaceDiag-Crash (Application log, Event ID 1000)'

$cfg = [IO.File]::ReadAllText((Join-Path $BinDir 'apps.json'), (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
$key = [Environment]::ExpandEnvironmentVariables($cfg.server.identityFile)
if (-not (Test-Path -LiteralPath $key)) {
    Write-Warning "SSH key not found: $key. Packages will remain in $BaseDir\outbox until it exists."
} elseif (-not $SkipConnectivityTest) {
    $ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
    if (-not (Test-Path -LiteralPath $ssh)) { $ssh = 'ssh.exe' }
    $ErrorActionPreference = 'Continue'
    $out = & $ssh -i $key -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new `
        "$($cfg.server.user)@$($cfg.server.host)" "mkdir -p ~/$($cfg.server.remoteDir) && echo ok" 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { Write-Host "Connectivity test passed: $($cfg.server.user)@$($cfg.server.host)" }
    else { Write-Warning "Connectivity test failed (exit $LASTEXITCODE): $($out.Trim())" }
}

Write-Host ''
Write-Host "Manual upload:       powershell -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Reason manual -Force"
Write-Host "Post-install check:  powershell -NoProfile -ExecutionPolicy Bypass -File `"$Script`" -Reason post-install -WaitForApp 20"
Write-Host "Collector log:       $BaseDir\collector.log"
