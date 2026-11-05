<#
.SYNOPSIS
  Surface diagnostics collector. Collects logs, crash records and environment
  information for the applications listed in apps.json and uploads the package
  to rakkoserver (~/diag/surface/<app>/<timestamp>-<reason>.zip).

.DESCRIPTION
  Modes (-Reason):
    watch         Periodic check. Packages and uploads only when something new is
                  found: crash events, new panic.log content, the application not
                  running although it is expected to, or new ERROR/WARN log lines.
    crash         Started by the Application Error (Event ID 1000) task. Same as
                  watch, labelled "crash" when a matching crash event is found.
    manual        Use with -Force to package and upload immediately.
    post-install  Use with -WaitForApp <seconds>. Waits for the application to
                  start; packages and uploads when it does not start or exits
                  shortly after starting. Exit code: 0 ok, 2 not started,
                  3 started and exited, 1 collector error.

  The collector only reads application files. Secrets are redacted from the
  configuration and the logs; translation history is never collected.
  Windows PowerShell 5.1 compatible. Keep this file ASCII only.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File surface-diag.ps1 -Reason manual -Force
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File surface-diag.ps1 -Reason post-install -WaitForApp 20
#>
[CmdletBinding()]
param(
    [ValidateSet('watch', 'crash', 'manual', 'post-install')]
    [string]$Reason = 'watch',
    [switch]$Force,
    [int]$WaitForApp = 0,
    [string]$App = '',
    [string]$ConfigPath = '',
    [switch]$NoUpload
)

$ErrorActionPreference = 'Continue'
$CollectorVersion = '1.0.0'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$BaseDir = Join-Path $env:LOCALAPPDATA 'surface-diag'
$StateDir = Join-Path $BaseDir 'state'
$OutboxDir = Join-Path $BaseDir 'outbox'
$WorkDir = Join-Path $BaseDir 'work'
$CollectorLog = Join-Path $BaseDir 'collector.log'

# ---------------------------------------------------------------- helpers

function Write-Utf8File([string]$Path, [string]$Text) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Write-JsonFile([string]$Path, $Object) {
    Write-Utf8File $Path ($Object | ConvertTo-Json -Depth 20)
}

function Write-CollectorLog([string]$Message) {
    try {
        if (-not (Test-Path -LiteralPath $BaseDir)) { New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null }
        $line = '{0} [{1}] {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Reason, $Message
        [IO.File]::AppendAllText($CollectorLog, $line + "`r`n", $Utf8NoBom)
        $fi = Get-Item -LiteralPath $CollectorLog
        if ($fi.Length -gt 1MB) {
            $keep = Get-Content -LiteralPath $CollectorLog -Tail 2000 -Encoding UTF8
            [IO.File]::WriteAllText($CollectorLog, (($keep -join "`r`n") + "`r`n"), $Utf8NoBom)
        }
    } catch { }
}

function Expand-PathVars([string]$Path) {
    if (-not $Path) { return $Path }
    return [Environment]::ExpandEnvironmentVariables($Path)
}

function ConvertTo-IsoTime($Date) {
    if ($null -eq $Date) { return $null }
    return ([datetime]$Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
}

# Open with FileShare.ReadWrite|Delete so the application keeps full access.
function Open-SharedRead([string]$Path) {
    return New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
}

function Read-SharedBytes([string]$Path, [long]$Offset, [long]$MaxBytes) {
    $fs = $null
    try {
        $fs = Open-SharedRead $Path
        $len = $fs.Length
        if ($Offset -lt 0) { $Offset = 0 }
        if ($Offset -gt $len) { $Offset = $len }
        $count = $len - $Offset
        if ($MaxBytes -gt 0 -and $count -gt $MaxBytes) {
            $Offset = $len - $MaxBytes
            $count = $MaxBytes
        }
        $buf = New-Object byte[] ([int]$count)
        [void]$fs.Seek($Offset, [IO.SeekOrigin]::Begin)
        $read = 0
        while ($read -lt $count) {
            $n = $fs.Read($buf, $read, [int]($count - $read))
            if ($n -le 0) { break }
            $read += $n
        }
        return @{ Bytes = $buf; Length = $len; Start = $Offset }
    } finally {
        if ($fs) { $fs.Dispose() }
    }
}

function Read-SharedText([string]$Path, [long]$Offset, [long]$MaxBytes) {
    $r = Read-SharedBytes $Path $Offset $MaxBytes
    return @{ Text = $Utf8NoBom.GetString($r.Bytes); Length = $r.Length; Start = $r.Start }
}

function Split-Lines([string]$Text) {
    if (-not $Text) { return @() }
    return @($Text -split "`r?`n" | Where-Object { $_ -ne '' })
}

# ---------------------------------------------------------------- redaction

$SensitiveNamePattern = '(?i)(key|token|secret|passw|pwd|auth|cookie|credential|session|username|email|account|cert|license)'
$HistoryNamePattern = '(?i)history'

function Protect-Text([string]$Text) {
    if (-not $Text) { return $Text }
    $t = $Text
    $t = [regex]::Replace($t, '(?i)(bearer\s+)[A-Za-z0-9._~+/=\-]+', '$1[REDACTED]')
    $t = [regex]::Replace($t, '(?i)((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd|authorization|cookie|app[_-]?key|appid|app[_-]?secret)\\?["'']?\s*[:=]\s*\\?["'']?)[^\s"''\\,;&}]+', '$1[REDACTED]')
    $t = [regex]::Replace($t, '(?i)([?&](?:key|token|apikey|api_key|access_token|appkey|appid|sign|signature|salt|auth)=)[^&\s"'']+', '$1[REDACTED]')
    $t = [regex]::Replace($t, '(?i)(://)[^/@\s:]+:[^/@\s]+@', '$1[REDACTED]@')
    $t = [regex]::Replace($t, '\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_\-]{12,}', '[REDACTED]')
    return $t
}

function Test-SecretLikeValue([string]$Value) {
    if (-not $Value) { return $false }
    if ($Value -match '^(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_\-]{8,}') { return $true }
    # long opaque tokens without spaces, path separators or dots
    if ($Value -match '^[A-Za-z0-9_\-+/=]{32,}$' -and $Value -notmatch '[\\/]{2}') { return $true }
    return $false
}

function Protect-JsonNode($Node, [string]$KeepPattern, [System.Collections.ArrayList]$Dropped, [string]$Path) {
    if ($null -eq $Node) { return $null }
    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        $out = [ordered]@{}
        foreach ($p in $Node.PSObject.Properties) {
            $name = $p.Name
            $childPath = if ($Path) { "$Path.$name" } else { $name }
            if ($name -match $HistoryNamePattern) { [void]$Dropped.Add($childPath); continue }
            $keep = $KeepPattern -and ($name -match $KeepPattern)
            if (-not $keep -and $name -match $SensitiveNamePattern) {
                $v = $p.Value
                if ($null -eq $v -or ($v -is [string] -and $v -eq '')) { $out[$name] = $v }
                else { $out[$name] = '[REDACTED]' }
                continue
            }
            $out[$name] = Protect-JsonNode $p.Value $KeepPattern $Dropped $childPath
        }
        return $out
    }
    if ($Node -is [string]) {
        if (Test-SecretLikeValue $Node) { return '[REDACTED]' }
        return (Protect-Text $Node)
    }
    if ($Node -is [System.Collections.IEnumerable]) {
        $list = New-Object System.Collections.ArrayList
        $i = 0
        foreach ($item in $Node) {
            [void]$list.Add((Protect-JsonNode $item $KeepPattern $Dropped "$Path[$i]"))
            $i++
        }
        return , $list.ToArray()
    }
    return $Node
}

# ---------------------------------------------------------------- state

function Get-AppState([string]$Name) {
    $p = Join-Path $StateDir ($Name + '.json')
    if (Test-Path -LiteralPath $p) {
        try {
            $o = [IO.File]::ReadAllText($p, $Utf8NoBom) | ConvertFrom-Json
            $h = @{}
            foreach ($prop in $o.PSObject.Properties) { $h[$prop.Name] = $prop.Value }
            $logs = @{}
            if ($o.logs) { foreach ($prop in $o.logs.PSObject.Properties) { $logs[$prop.Name] = $prop.Value } }
            $h['logs'] = $logs
            return $h
        } catch { Write-CollectorLog "state read failed for ${Name}: $($_.Exception.Message)" }
    }
    return @{ logs = @{} }
}

function Save-AppState([string]$Name, [hashtable]$State) {
    Write-JsonFile (Join-Path $StateDir ($Name + '.json')) $State
}

# ---------------------------------------------------------------- app info

function Get-AppProcesses($AppCfg) {
    $result = @()
    foreach ($pn in @($AppCfg.processNames)) {
        foreach ($p in @(Get-Process -Name $pn -ErrorAction SilentlyContinue)) {
            $start = $null; $path = $null
            try { $start = $p.StartTime } catch { }
            try { $path = $p.Path } catch { }
            $result += [ordered]@{
                name      = $p.ProcessName
                pid       = $p.Id
                sessionId = $p.SessionId
                startTime = ConvertTo-IsoTime $start
                path      = $path
                responding = $p.Responding
                workingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
            }
        }
    }
    return , $result
}

function Get-AppInstallInfo($AppCfg, $Processes) {
    $exe = $null
    foreach ($p in $Processes) { if ($p.path) { $exe = $p.path; break } }
    $uninstall = @()
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    if ($AppCfg.uninstallDisplayName) {
        foreach ($r in $roots) {
            foreach ($e in @(Get-ItemProperty -Path $r -ErrorAction SilentlyContinue)) {
                if ($e.DisplayName -and $e.DisplayName -like ($AppCfg.uninstallDisplayName + '*')) {
                    $uninstall += [ordered]@{
                        displayName     = $e.DisplayName
                        displayVersion  = $e.DisplayVersion
                        publisher       = $e.Publisher
                        installLocation = $e.InstallLocation
                        installDate     = $e.InstallDate
                        registryKey     = $e.PSPath -replace '^Microsoft\.PowerShell\.Core\\Registry::', ''
                    }
                    if (-not $exe -and $e.InstallLocation) {
                        # some installers register the location wrapped in quotes
                        $loc = ([string]$e.InstallLocation).Trim().Trim('"')
                        foreach ($n in @($AppCfg.exeNames)) {
                            if (-not $loc -or -not (Test-Path -LiteralPath $loc)) { break }
                            $c = Join-Path $loc $n
                            if (Test-Path -LiteralPath $c) { $exe = $c; break }
                        }
                    }
                }
            }
        }
    }
    if (-not $exe) {
        foreach ($c in @($AppCfg.exeCandidates)) {
            $x = Expand-PathVars $c
            if ($x -and (Test-Path -LiteralPath $x)) { $exe = $x; break }
        }
    }
    $exeInfo = $null
    if ($exe -and (Test-Path -LiteralPath $exe)) {
        $fi = Get-Item -LiteralPath $exe
        $exeInfo = [ordered]@{
            path           = $fi.FullName
            fileVersion    = $fi.VersionInfo.FileVersion
            productVersion = $fi.VersionInfo.ProductVersion
            sizeBytes      = $fi.Length
            lastWriteTime  = ConvertTo-IsoTime $fi.LastWriteTime
        }
    }
    return [ordered]@{ exe = $exeInfo; uninstallEntries = $uninstall }
}

# ---------------------------------------------------------------- logs

# Scans watched logs for new content since the stored offsets. Updates $State.
function Find-NewLogFindings($AppCfg, [hashtable]$State) {
    $res = [ordered]@{ newErrorLines = 0; newWarnLines = 0; newPanic = $false; lastErrorLine = $null; lastPanicLine = $null }
    $logDir = Expand-PathVars $AppCfg.logDir
    if (-not $logDir -or -not (Test-Path -LiteralPath $logDir)) { return $res }
    $errPattern = if ($AppCfg.errorPattern) { $AppCfg.errorPattern } else { '\[(ERROR|WARN)\]' }
    foreach ($l in @($AppCfg.logs)) {
        if (-not ($l.watch -or $l.panic)) { continue }
        $path = Join-Path $logDir $l.file
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $prev = $State.logs[$l.file]
        $offset = 0L
        $firstSeen = $null -eq $prev
        if (-not $firstSeen) { $offset = [long]$prev.offset }
        $len = (Get-Item -LiteralPath $path).Length
        if ($len -lt $offset) { $offset = 0L }  # rotated or truncated
        if ($len -gt $offset) {
            # First sighting: only look at the last 256 KB to avoid reporting old history.
            $max = if ($firstSeen) { 256KB } else { 8MB }
            $r = Read-SharedText $path $offset $max
            $lines = Split-Lines $r.Text
            if ($l.panic) {
                if ($lines.Count -gt 0) {
                    $res.newPanic = $true
                    $pl = @($lines | Where-Object { $_ -match 'panic at' })
                    if ($pl.Count -gt 0) { $res.lastPanicLine = Protect-Text $pl[-1] }
                    else { $res.lastPanicLine = Protect-Text $lines[0] }
                }
            } else {
                foreach ($line in $lines) {
                    if ($line -match $errPattern) {
                        if ($Matches[1] -eq 'ERROR') { $res.newErrorLines++; $res.lastErrorLine = Protect-Text $line }
                        else { $res.newWarnLines++; if (-not $res.lastErrorLine -or $res.lastErrorLine -notmatch '\[ERROR\]') { $res.lastErrorLine = Protect-Text $line } }
                    }
                }
            }
            $offset = $r.Length
        }
        $State.logs[$l.file] = @{ offset = $offset; seenAt = ConvertTo-IsoTime (Get-Date) }
    }
    return $res
}

function Copy-AppLogs($AppCfg, [string]$DestDir) {
    $logDir = Expand-PathVars $AppCfg.logDir
    $copied = @()
    if (-not $logDir -or -not (Test-Path -LiteralPath $logDir)) { return , $copied }
    $byName = @{}
    foreach ($l in @($AppCfg.logs)) { $byName[$l.file.ToLower()] = $l }
    $otherTail = if ($AppCfg.otherLogTailLines) { [int]$AppCfg.otherLogTailLines } else { 200 }
    foreach ($f in @(Get-ChildItem -LiteralPath $logDir -Filter '*.log' -File -ErrorAction SilentlyContinue)) {
        try {
            $cfg = $byName[$f.Name.ToLower()]
            $text = ''
            if ($cfg -and $cfg.full) {
                $text = (Read-SharedText $f.FullName 0 4MB).Text
            } else {
                $tail = if ($cfg -and $cfg.tailLines) { [int]$cfg.tailLines } else { $otherTail }
                $lines = Split-Lines (Read-SharedText $f.FullName 0 8MB).Text
                if ($cfg -and $cfg.dropPattern) { $lines = @($lines | Where-Object { $_ -notmatch $cfg.dropPattern }) }
                if ($lines.Count -gt $tail) { $lines = $lines[($lines.Count - $tail)..($lines.Count - 1)] }
                $text = ($lines -join "`r`n") + "`r`n"
            }
            Write-Utf8File (Join-Path $DestDir $f.Name) (Protect-Text $text)
            $copied += [ordered]@{ file = $f.Name; sizeBytes = $f.Length; lastWriteTime = ConvertTo-IsoTime $f.LastWriteTime }
        } catch {
            Write-CollectorLog "log copy failed $($f.Name): $($_.Exception.Message)"
        }
    }
    return , $copied
}

function Copy-RedactedConfig($AppCfg, [string]$DestPath) {
    $src = Expand-PathVars $AppCfg.configFile
    if (-not $src -or -not (Test-Path -LiteralPath $src)) { return 'absent' }
    try {
        $raw = (Read-SharedText $src 0 4MB).Text
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
        $obj = $raw | ConvertFrom-Json
        $dropped = New-Object System.Collections.ArrayList
        $red = Protect-JsonNode $obj $AppCfg.configKeepPattern $dropped ''
        $wrapper = [ordered]@{
            note           = 'Redacted copy. Sensitive fields are replaced with [REDACTED]; history fields are removed.'
            droppedFields  = @($dropped)
            config         = $red
        }
        Write-JsonFile $DestPath $wrapper
        return 'redacted'
    } catch {
        # Never fall back to the raw file.
        Write-CollectorLog "config redaction failed: $($_.Exception.Message)"
        return 'parse-failed'
    }
}

# ---------------------------------------------------------------- events

function Get-EventsSafe([hashtable]$Filter) {
    try { return @(Get-WinEvent -FilterHashtable $Filter -ErrorAction Stop) } catch { return @() }
}

function Format-EventRecord($E) {
    $msg = ''
    try { $msg = $E.Message } catch { }
    if (-not $msg) { $msg = ($E.Properties | ForEach-Object { $_.Value }) -join ' | ' }
    return [ordered]@{
        time     = ConvertTo-IsoTime $E.TimeCreated
        log      = $E.LogName
        id       = $E.Id
        provider = $E.ProviderName
        recordId = $E.RecordId
        message  = Protect-Text $msg
    }
}

function Get-EventText($E) {
    $t = ''
    try { $t = $E.Message } catch { }
    $props = ''
    try { $props = ($E.Properties | ForEach-Object { [string]$_.Value }) -join ' ' } catch { }
    return "$t $props"
}

function Get-AppCrashEvents($AppCfg, [datetime]$Since, [bool]$AppRunning) {
    $names = @($AppCfg.exeNames | ForEach-Object { $_.ToLower() })
    $evs = Get-EventsSafe @{ LogName = 'Application'; Id = 1000, 1001, 1002, 1026; StartTime = $Since }
    $out = @()
    foreach ($e in $evs) {
        $text = (Get-EventText $e).ToLower()
        $isApp = $false
        foreach ($n in $names) { if ($text.Contains($n)) { $isApp = $true; break } }
        $isWebView = $AppCfg.usesWebView2 -and $text.Contains('msedgewebview2')
        if (-not ($isApp -or $isWebView)) { continue }
        $rec = Format-EventRecord $e
        $rec['matchedApp'] = $isApp
        $rec['matchedWebView2'] = [bool]$isWebView
        # 1001 is the WER bucket record of the same incident; it does not count as a separate crash.
        # WebView2 crashes count only while the application is running, since other programs also host WebView2.
        $rec['countsAsCrash'] = ($e.Id -ne 1001) -and ($isApp -or ($isWebView -and $AppRunning))
        $out += $rec
    }
    return , $out
}

function Get-DisplayKernelEvents([datetime]$Since) {
    $out = @()
    foreach ($e in (Get-EventsSafe @{ LogName = 'System'; Id = 4101; StartTime = $Since })) { $out += (Format-EventRecord $e) }
    foreach ($e in (Get-EventsSafe @{ LogName = 'System'; Id = 1001; StartTime = $Since })) {
        if ($e.ProviderName -match 'BugCheck|WER-SystemErrorReporting') { $out += (Format-EventRecord $e) }
    }
    foreach ($e in (Get-EventsSafe @{ LogName = 'Application'; Id = 1001; StartTime = $Since })) {
        if ((Get-EventText $e) -match 'LiveKernelEvent') { $out += (Format-EventRecord $e) }
    }
    foreach ($r in $out) { if ($r.message.Length -gt 600) { $r.message = $r.message.Substring(0, 600) + ' ...' } }
    return , $out
}

function Copy-WerReports($AppCfg, [datetime]$Since, [string]$DestDir) {
    $roots = @(
        (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportArchive'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportQueue'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue')
    )
    $names = @($AppCfg.exeNames | ForEach-Object { $_.ToLower() })
    if ($AppCfg.usesWebView2) { $names += 'msedgewebview2.exe' }
    $found = @()
    $kernel = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            if ($d.LastWriteTime -lt $Since) { continue }
            $lower = $d.Name.ToLower()
            if ($lower -match '^(kernel|livekernelevent)_') {
                $kernel += [ordered]@{ report = $d.Name; root = $root; time = ConvertTo-IsoTime $d.LastWriteTime }
                continue
            }
            $hit = $false
            foreach ($n in $names) { if ($lower.Contains('_' + $n + '_')) { $hit = $true; break } }
            if (-not $hit) { continue }
            $found += [ordered]@{ report = $d.Name; root = $root; time = ConvertTo-IsoTime $d.LastWriteTime; dir = $d }
        }
    }
    $found = @($found | Sort-Object { $_.time } -Descending | Select-Object -First 20)
    $listed = @()
    foreach ($f in $found) {
        $wer = Join-Path $f.dir.FullName 'Report.wer'
        $copied = $false
        if (Test-Path -LiteralPath $wer) {
            try {
                $bytes = (Read-SharedBytes $wer 0 1MB).Bytes
                # Report.wer is usually UTF-16 LE with BOM.
                $text = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
                    [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
                } else { $Utf8NoBom.GetString($bytes) }
                Write-Utf8File (Join-Path $DestDir ($f.report + '.wer.txt')) (Protect-Text $text)
                $copied = $true
            } catch { Write-CollectorLog "WER copy failed $($f.report): $($_.Exception.Message)" }
        }
        $listed += [ordered]@{ report = $f.report; root = $f.root; time = $f.time; copied = $copied }
    }
    return [ordered]@{ appReports = $listed; kernelReports = $kernel }
}

# ---------------------------------------------------------------- environment

function Get-RegValue([string]$Path, [string]$Name) {
    try { return (Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop).$Name } catch { return $null }
}

function Get-EnvironmentInfo {
    $os = $null; $cpu = $null; $gpus = @(); $mons = @()
    try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch { }
    try { $cpu = @(Get-CimInstance Win32_Processor -ErrorAction Stop)[0] } catch { }
    try {
        foreach ($g in @(Get-CimInstance Win32_VideoController -ErrorAction Stop)) {
            $gpus += [ordered]@{
                name = $g.Name; driverVersion = $g.DriverVersion
                driverDate = ConvertTo-IsoTime $g.DriverDate
                resolution = "$($g.CurrentHorizontalResolution)x$($g.CurrentVerticalResolution)"
                refreshRate = $g.CurrentRefreshRate; status = $g.Status
            }
        }
    } catch { }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
            $mons += [ordered]@{
                device = $s.DeviceName; primary = $s.Primary
                bounds = "$($s.Bounds.Width)x$($s.Bounds.Height)@$($s.Bounds.X),$($s.Bounds.Y)"
                workingArea = "$($s.WorkingArea.Width)x$($s.WorkingArea.Height)"
            }
        }
    } catch { }
    $perMonitor = @()
    try {
        foreach ($k in @(Get-ChildItem 'HKCU:\Control Panel\Desktop\PerMonitorSettings' -ErrorAction Stop)) {
            $perMonitor += [ordered]@{ monitor = $k.PSChildName; dpiValue = (Get-ItemProperty -LiteralPath $k.PSPath).DpiValue }
        }
    } catch { }
    $cv = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $wv2 = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $locked = $null
    try { $locked = [bool](Get-Process -Name LogonUI -ErrorAction SilentlyContinue) } catch { }
    return [ordered]@{
        computerName = $env:COMPUTERNAME
        user         = $env:USERNAME
        os = [ordered]@{
            caption        = if ($os) { $os.Caption } else { $null }
            version        = if ($os) { $os.Version } else { $null }
            build          = Get-RegValue $cv 'CurrentBuildNumber'
            ubr            = Get-RegValue $cv 'UBR'
            displayVersion = Get-RegValue $cv 'DisplayVersion'
            lastBoot       = if ($os) { ConvertTo-IsoTime $os.LastBootUpTime } else { $null }
        }
        cpu = [ordered]@{
            name                    = if ($cpu) { $cpu.Name } else { $null }
            processorArchitecture   = $env:PROCESSOR_ARCHITECTURE
            processorArchitectureW6432 = $env:PROCESSOR_ARCHITEW6432
            is64BitProcess          = [Environment]::Is64BitProcess
        }
        memory = [ordered]@{
            totalMB = if ($os) { [math]::Round($os.TotalVisibleMemorySize / 1KB) } else { $null }
            freeMB  = if ($os) { [math]::Round($os.FreePhysicalMemory / 1KB) } else { $null }
        }
        webView2 = [ordered]@{
            hklmWow6432 = Get-RegValue "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wv2" 'pv'
            hklm        = Get-RegValue "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wv2" 'pv'
            hkcu        = Get-RegValue "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wv2" 'pv'
        }
        display = [ordered]@{
            appliedDpi         = Get-RegValue 'HKCU:\Control Panel\Desktop\WindowMetrics' 'AppliedDPI'
            perMonitorSettings = $perMonitor
            screens            = $mons
            gpus               = $gpus
        }
        session = [ordered]@{
            lockedHeuristic = $locked
            note            = 'lockedHeuristic is true when LogonUI.exe is running. Idle time is not collected.'
        }
    }
}

# ---------------------------------------------------------------- packaging and upload

function New-DiagPackage($AppCfg, [string]$EffReason, [hashtable]$State, $Findings, $Processes, [datetime]$Now) {
    $stamp = $Now.ToString('yyyyMMdd-HHmmss')
    $pkgName = "$stamp-$EffReason"
    $stage = Join-Path $WorkDir ($AppCfg.name + '__' + $pkgName)
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage -Force | Out-Null

    $lookback = $Now.AddHours(-$script:MaxLookbackHours)
    $since = $lookback
    if ($State.lastPackage) {
        try { $lp = [datetime]$State.lastPackage; if ($lp -gt $since) { $since = $lp } } catch { }
    }
    if ($Reason -eq 'manual' -or $Reason -eq 'post-install') { $since = $lookback }

    $install = Get-AppInstallInfo $AppCfg $Processes
    Write-JsonFile (Join-Path $stage 'app.json') ([ordered]@{ name = $AppCfg.name; running = ($Processes.Count -gt 0); processes = $Processes; install = $install })

    $logs = Copy-AppLogs $AppCfg (Join-Path $stage 'logs')
    $configStatus = Copy-RedactedConfig $AppCfg (Join-Path $stage 'config.redacted.json')

    $crashes = Get-AppCrashEvents $AppCfg $since ($Processes.Count -gt 0)
    Write-JsonFile (Join-Path $stage 'events\app-crash-events.json') $crashes
    $dk = Get-DisplayKernelEvents $since
    $wer = Copy-WerReports $AppCfg $since (Join-Path $stage 'wer')
    Write-JsonFile (Join-Path $stage 'events\display-kernel-events.json') ([ordered]@{ events = $dk; werKernelReports = $wer.kernelReports })
    Write-JsonFile (Join-Path $stage 'wer\index.json') $wer.appReports

    Write-JsonFile (Join-Path $stage 'env.json') (Get-EnvironmentInfo)

    if (Test-Path -LiteralPath $CollectorLog) {
        $tail = Get-Content -LiteralPath $CollectorLog -Tail 200 -Encoding UTF8
        Write-Utf8File (Join-Path $stage 'collector.log') (($tail -join "`r`n") + "`r`n")
    }

    $lastError = $null
    $latestCrash = @($crashes | Where-Object { $_.countsAsCrash } | Sort-Object { $_.time } -Descending | Select-Object -First 1)
    if ($latestCrash.Count -gt 0) {
        $first = (Split-Lines $latestCrash[0].message) | Select-Object -First 1
        $lastError = "event $($latestCrash[0].id) $($latestCrash[0].time): $first"
    } elseif ($Findings.lastPanicLine) { $lastError = "panic: $($Findings.lastPanicLine)" }
    elseif ($Findings.lastErrorLine) { $lastError = "log: $($Findings.lastErrorLine)" }
    if ($lastError -and $lastError.Length -gt 400) { $lastError = $lastError.Substring(0, 400) + ' ...' }

    $summary = [ordered]@{
        app              = $AppCfg.name
        reason           = $EffReason
        requestedReason  = $Reason
        triggers         = @($Findings.triggers)
        collectedAt      = ConvertTo-IsoTime $Now
        eventsSince      = ConvertTo-IsoTime $since
        computerName     = $env:COMPUTERNAME
        collectorVersion = $CollectorVersion
        appStatus = [ordered]@{
            running        = ($Processes.Count -gt 0)
            expectRunning  = [bool]$AppCfg.expectRunning
            pids           = @($Processes | ForEach-Object { $_.pid })
            version        = if ($install.exe) { $install.exe.productVersion } else { $null }
            exeLastWrite   = if ($install.exe) { $install.exe.lastWriteTime } else { $null }
        }
        newCrashCount    = [int]$Findings.newCrashCount
        crashEventsInPackage = @($crashes | Where-Object { $_.countsAsCrash }).Count
        newPanic         = [bool]$Findings.newPanic
        newErrorLines    = [int]$Findings.newErrorLines
        newWarnLines     = [int]$Findings.newWarnLines
        displayKernelEvents = @($dk).Count
        werAppReports    = @($wer.appReports).Count
        config           = $configStatus
        logs             = $logs
        lastError        = $lastError
        postInstall      = $Findings.postInstall
    }
    Write-JsonFile (Join-Path $stage 'summary.json') $summary

    if (-not (Test-Path -LiteralPath $OutboxDir)) { New-Item -ItemType Directory -Path $OutboxDir -Force | Out-Null }
    $zip = Join-Path $OutboxDir ($AppCfg.name + '__' + $pkgName + '.zip')
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue

    $State.lastPackage = ConvertTo-IsoTime $Now
    Write-CollectorLog "packaged $zip"
    return $zip
}

function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $out = & $Exe @Arguments 2>&1 | Out-String
    return @{ Code = $LASTEXITCODE; Output = $out.Trim() }
}

function Send-Outbox($Cfg) {
    if ($NoUpload) { return }
    $files = @(Get-ChildItem -LiteralPath $OutboxDir -Filter '*.zip' -File -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($files.Count -eq 0) { return }
    $sshDir = Join-Path $env:WINDIR 'System32\OpenSSH'
    $ssh = Join-Path $sshDir 'ssh.exe'
    $scp = Join-Path $sshDir 'scp.exe'
    if (-not (Test-Path -LiteralPath $ssh)) { $ssh = 'ssh.exe'; $scp = 'scp.exe' }
    $key = Expand-PathVars $Cfg.server.identityFile
    $target = "$($Cfg.server.user)@$($Cfg.server.host)"
    $remoteBase = $Cfg.server.remoteDir.TrimEnd('/')
    $common = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10',
        '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new')
    $madeDirs = @{}
    foreach ($f in $files) {
        $parts = $f.Name -split '__', 2
        if ($parts.Count -ne 2) { continue }
        $appName = $parts[0] -replace '[^A-Za-z0-9._-]', '_'
        $remoteName = $parts[1] -replace '[^A-Za-z0-9._-]', '_'
        $remoteDir = "$remoteBase/$appName"
        if (-not $madeDirs.ContainsKey($remoteDir)) {
            $r = Invoke-Native $ssh ($common + @($target, "mkdir -p ~/$remoteDir"))
            if ($r.Code -ne 0) { Write-CollectorLog "upload deferred (ssh exit $($r.Code)): $($r.Output)"; return }
            $madeDirs[$remoteDir] = $true
        }
        # Upload under a .part name, then rename, so readers never see a partial package.
        $r = Invoke-Native $scp ($common + @('-q', $f.FullName, "${target}:$remoteDir/.$remoteName.part"))
        if ($r.Code -ne 0) { Write-CollectorLog "upload deferred (scp exit $($r.Code)): $($r.Output)"; return }
        $r = Invoke-Native $ssh ($common + @($target, "mv -f ~/$remoteDir/.$remoteName.part ~/$remoteDir/$remoteName"))
        if ($r.Code -ne 0) { Write-CollectorLog "rename failed (ssh exit $($r.Code)): $($r.Output)"; return }
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        Write-CollectorLog "uploaded $remoteDir/$remoteName"
    }
}

function Limit-Outbox([int]$Max) {
    $files = @(Get-ChildItem -LiteralPath $OutboxDir -Filter '*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($files.Count -le $Max) { return }
    foreach ($f in $files[$Max..($files.Count - 1)]) {
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        Write-CollectorLog "outbox limit reached, removed $($f.Name)"
    }
}

# ---------------------------------------------------------------- main

function Invoke-Main {
    foreach ($d in @($BaseDir, $StateDir, $OutboxDir, $WorkDir)) {
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    $cfgFile = if ($ConfigPath) { $ConfigPath } else { Join-Path $PSScriptRoot 'apps.json' }
    $cfg = [IO.File]::ReadAllText($cfgFile, $Utf8NoBom) | ConvertFrom-Json
    $script:MaxLookbackHours = if ($cfg.maxLookbackHours) { [int]$cfg.maxLookbackHours } else { 24 }
    $maxOutbox = if ($cfg.maxOutbox) { [int]$cfg.maxOutbox } else { 50 }

    $apps = @($cfg.apps)
    if ($App) { $apps = @($apps | Where-Object { $_.name -eq $App }) }
    if ($apps.Count -eq 0) { Write-CollectorLog "no matching app: '$App'"; return 1 }
    if ($Reason -eq 'post-install' -and -not $App) { $apps = @($apps[0]) }

    $exitCode = 0
    foreach ($a in $apps) {
        $now = Get-Date
        $state = Get-AppState $a.name
        $triggers = New-Object System.Collections.ArrayList
        $postInstall = $null

        if ($Reason -eq 'post-install') {
            $deadline = $now.AddSeconds([math]::Max($WaitForApp, 1))
            $procs = Get-AppProcesses $a
            while ($procs.Count -eq 0 -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 500
                $procs = Get-AppProcesses $a
            }
            if ($procs.Count -eq 0) {
                $postInstall = [ordered]@{ result = 'not-started'; waitedSeconds = $WaitForApp }
                $exitCode = 2
            } else {
                # Stability window: the app relaunches itself once on startup retry, so check by name, not PID.
                $stableUntil = (Get-Date).AddSeconds(10)
                $gone = $false
                while ((Get-Date) -lt $stableUntil) {
                    Start-Sleep -Milliseconds 500
                    if ((Get-AppProcesses $a).Count -eq 0) {
                        Start-Sleep -Seconds 3
                        if ((Get-AppProcesses $a).Count -eq 0) { $gone = $true; break }
                    }
                }
                if ($gone) { $postInstall = [ordered]@{ result = 'exited'; firstPids = @($procs | ForEach-Object { $_.pid }) }; $exitCode = 3 }
                else { $postInstall = [ordered]@{ result = 'running'; pids = @((Get-AppProcesses $a) | ForEach-Object { $_.pid }) } }
            }
            if ($exitCode -ne 0) { [void]$triggers.Add("post-install:$($postInstall.result)") }
            $now = Get-Date
        }

        $procs = Get-AppProcesses $a
        $running = $procs.Count -gt 0

        # Crash events since the last check (at most the lookback window).
        $since = $now.AddHours(-$script:MaxLookbackHours)
        if ($state.lastCheck) { try { $lc = [datetime]$state.lastCheck; if ($lc -gt $since) { $since = $lc } } catch { } }
        $lastRec = 0L
        if ($state.lastAppEventRecordId) { $lastRec = [long]$state.lastAppEventRecordId }
        $recent = Get-AppCrashEvents $a $since $running
        foreach ($ev in $recent) { if ([long]$ev.recordId -gt [long]$state.lastAppEventRecordId) { $state.lastAppEventRecordId = [long]$ev.recordId } }
        $newCrashes = @($recent | Where-Object { $_.countsAsCrash -and ([long]$_.recordId -gt $lastRec) })
        $logFind = Find-NewLogFindings $a $state

        if ($newCrashes.Count -gt 0) { [void]$triggers.Add("crash-events:$($newCrashes.Count)") }
        if ($logFind.newPanic) { [void]$triggers.Add('panic-log') }
        if ($logFind.newErrorLines -gt 0) { [void]$triggers.Add("log-error:$($logFind.newErrorLines)") }
        if ($logFind.newWarnLines -gt 0) { [void]$triggers.Add("log-warn:$($logFind.newWarnLines)") }
        if ($a.expectRunning -and $Reason -ne 'post-install') {
            if (-not $running -and -not $state.notRunningReported) {
                [void]$triggers.Add('not-running')
                $state.notRunningReported = $true
            } elseif ($running) {
                $state.notRunningReported = $false
            }
        }

        $effReason = $Reason
        if ($Reason -eq 'crash' -and $newCrashes.Count -eq 0) { $effReason = 'watch' }
        if ($Reason -eq 'watch' -and $newCrashes.Count -gt 0) { $effReason = 'crash' }

        $shouldPackage = $Force -or ($triggers.Count -gt 0)
        $findings = @{
            triggers = $triggers; newCrashCount = $newCrashes.Count; newPanic = $logFind.newPanic
            newErrorLines = $logFind.newErrorLines; newWarnLines = $logFind.newWarnLines
            lastPanicLine = $logFind.lastPanicLine; lastErrorLine = $logFind.lastErrorLine; postInstall = $postInstall
        }
        if ($shouldPackage) {
            if ($triggers.Count -eq 0) { [void]$triggers.Add('forced') }
            try { [void](New-DiagPackage $a $effReason $state $findings $procs $now) }
            catch { Write-CollectorLog "packaging failed for $($a.name): $($_.Exception.Message)"; if ($exitCode -eq 0) { $exitCode = 1 } }
        } else {
            Write-CollectorLog "$($a.name): no new findings"
        }
        $state.lastCheck = ConvertTo-IsoTime $now
        $state.lastRunning = $running
        Save-AppState $a.name $state
    }

    Limit-Outbox $maxOutbox
    try { Send-Outbox $cfg } catch { Write-CollectorLog "upload error: $($_.Exception.Message)" }
    return $exitCode
}

# Serialize runs of the periodic task, the crash task and manual calls.
$mutex = New-Object System.Threading.Mutex($false, 'Local\SurfaceDiagCollector')
$acquired = $false
$code = 1
try {
    try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(120)) } catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { Write-CollectorLog 'another run is still active; skipped'; exit 0 }
    $code = Invoke-Main | Select-Object -Last 1
} catch {
    Write-CollectorLog "fatal: $($_.Exception.Message)"
    $code = 1
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $code
