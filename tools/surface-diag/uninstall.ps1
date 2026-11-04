<#
.SYNOPSIS
  Removes the Surface diagnostics collector scheduled tasks and program files.

.DESCRIPTION
  Unregisters SurfaceDiag-Watch and SurfaceDiag-Crash and deletes %LOCALAPPDATA%\surface-diag\bin.
  State, the outbox (packages not yet uploaded) and collector.log are kept unless -Purge is given.
  Keep this file ASCII only.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
#>
[CmdletBinding()]
param(
    [switch]$Purge
)

$ErrorActionPreference = 'Continue'
$BaseDir = Join-Path $env:LOCALAPPDATA 'surface-diag'

foreach ($name in @('SurfaceDiag-Watch', 'SurfaceDiag-Crash')) {
    $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task) {
        Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false
        Write-Host "Removed task $name"
    } else {
        Write-Host "Task $name is not registered"
    }
}

$bin = Join-Path $BaseDir 'bin'
if (Test-Path -LiteralPath $bin) {
    Remove-Item -LiteralPath $bin -Recurse -Force
    Write-Host "Removed $bin"
}
if ($Purge -and (Test-Path -LiteralPath $BaseDir)) {
    Remove-Item -LiteralPath $BaseDir -Recurse -Force
    Write-Host "Removed $BaseDir (state, outbox and collector log)"
} elseif (Test-Path -LiteralPath $BaseDir) {
    Write-Host "Kept $BaseDir (state, outbox, collector log). Use -Purge to remove it."
}
