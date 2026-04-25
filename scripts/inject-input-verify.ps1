#requires -Version 5.1
<#
.SYNOPSIS
  End-to-end verification of inject-input.ps1.

.DESCRIPTION
  Spawns a target pwsh in its own console waiting on Read-Host, then uses
  inject-input.ps1 to type "hello-from-inject<CR>" into it. Verifies the
  written file matches.
#>
[CmdletBinding()]
param(
    [int]$WaitMs = 600,
    [int]$ResultTimeoutMs = 3000,
    [switch]$UseVk
)

$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $PSCommandPath
$helper = Join-Path $here 'inject-input.ps1'

$report = [ordered]@{}
$sw = [System.Diagnostics.Stopwatch]::StartNew()

# --- Environment fingerprint ---
$report.OSVersion        = ([System.Environment]::OSVersion).ToString()
$report.OSBuild          = [System.Environment]::OSVersion.Version.Build
try {
    $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    $report.WinDisplay   = "$($cv.ProductName) $($cv.DisplayVersion) (Build $($cv.CurrentBuild).$($cv.UBR))"
} catch {
    $report.WinDisplay   = "unavailable: $($_.Exception.Message)"
}
try {
    $wt = Get-AppxPackage -Name 'Microsoft.WindowsTerminal' -ErrorAction Stop
    if ($wt) { $report.WindowsTerminal = "$($wt.Name) $($wt.Version)" } else { $report.WindowsTerminal = 'not installed' }
} catch {
    $report.WindowsTerminal = "unknown: $($_.Exception.Message)"
}
$report.PSEdition  = $PSVersionTable.PSEdition
$report.PSVersion  = $PSVersionTable.PSVersion.ToString()
$report.PSHost     = $Host.Name

# --- Result file ---
$resultPath = Join-Path $env:TEMP 'inject_result.txt'
if (Test-Path $resultPath) { Remove-Item $resultPath -Force }
$report.ResultPath = $resultPath

# --- Spawn target ---
$targetCmd = "Read-Host 'in' | Set-Content -Encoding utf8 '$resultPath'; exit"
$proc = Start-Process pwsh -ArgumentList '-NoExit','-Command',$targetCmd -PassThru
$report.TargetPid = $proc.Id
Start-Sleep -Milliseconds $WaitMs

function Invoke-Helper {
    param([int]$Pid_, [string]$Text, [switch]$UseVk)
    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$helper,'-TargetPid',$Pid_,'-Text',$Text)
    if ($UseVk) { $args += '-UseVk' }
    $p = Start-Process pwsh -ArgumentList $args -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait
    $stdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { '' }
    $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { '' }
    Remove-Item $stdoutPath,$stderrPath -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

$attempt1 = Invoke-Helper -Pid_ $proc.Id -Text "hello-from-inject`r" -UseVk:$UseVk
$report.Attempt1_ExitCode = $attempt1.ExitCode
$report.Attempt1_Stderr   = ((($attempt1.Stderr | Out-String) -replace "`r?`n",' | ').Trim())
$report.Attempt1_UseVk    = [bool]$UseVk

# --- Wait for result file ---
function Wait-ForResult([string]$path,[int]$timeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path $path) {
            $c = Get-Content $path -Raw -ErrorAction SilentlyContinue
            if ($c) { return $c }
        }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

$content = Wait-ForResult -path $resultPath -timeoutMs $ResultTimeoutMs
$report.Attempt1_FileExists = Test-Path $resultPath
$report.Attempt1_Content    = if ($null -ne $content) { $content } else { '<no file>' }

$expected = 'hello-from-inject'
$pass1 = ($null -ne $content) -and (($content.TrimEnd("`r","`n"," ","`t")) -eq $expected)
$report.Attempt1_Pass = $pass1

# --- Diagnostic retry if first attempt failed ---
$attempt2 = $null
if (-not $pass1) {
    # Kill any leftover, respawn
    if (-not $proc.HasExited) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if (Test-Path $resultPath) { Remove-Item $resultPath -Force -ErrorAction SilentlyContinue }
    $proc2 = Start-Process pwsh -ArgumentList '-NoExit','-Command',$targetCmd -PassThru
    $report.Attempt2_TargetPid = $proc2.Id
    Start-Sleep -Milliseconds $WaitMs

    # Flip the UseVk switch for the diagnostic attempt
    $diagUseVk = -not [bool]$UseVk
    $attempt2 = Invoke-Helper -Pid_ $proc2.Id -Text "hello-from-inject`r" -UseVk:$diagUseVk
    $report.Attempt2_UseVk    = $diagUseVk
    $report.Attempt2_ExitCode = $attempt2.ExitCode
    $report.Attempt2_Stderr   = ((($attempt2.Stderr | Out-String) -replace "`r?`n",' | ').Trim())
    $content2 = Wait-ForResult -path $resultPath -timeoutMs $ResultTimeoutMs
    $report.Attempt2_FileExists = Test-Path $resultPath
    $report.Attempt2_Content    = if ($null -ne $content2) { $content2 } else { '<no file>' }
    $pass2 = ($null -ne $content2) -and (($content2.TrimEnd("`r","`n"," ","`t")) -eq $expected)
    $report.Attempt2_Pass = $pass2

    if (-not $proc2.HasExited) {
        try { Stop-Process -Id $proc2.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
} else {
    $pass2 = $false
}

# --- Cleanup ---
if (-not $proc.HasExited) {
    try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
}

$sw.Stop()
$report.ElapsedMs = $sw.ElapsedMilliseconds

# --- Verdict ---
if ($pass1 -or $pass2) {
    $report.Verdict = 'WORKS'
} elseif (($attempt1.ExitCode -eq 0) -or ($attempt2 -and $attempt2.ExitCode -eq 0)) {
    $report.Verdict = 'PARTIAL'
    $report.LikelyCause = 'Helper reported success but Read-Host did not receive input — likely ConPTY interception (Windows Terminal hosts pwsh via ConPTY; AttachConsole hits the conhost shim, but input does not propagate to the pseudoconsole-driven child).'
} else {
    $report.Verdict = 'FAILS'
    $report.LikelyCause = 'AttachConsole or WriteConsoleInputW returned an error — see stderr. Common causes: target has no console (subsystem != console), target is hosted in ConPTY without a real conhost owner, or ACL blocks attach across session.'
}

# --- Render report ---
"=========================================="
"  AttachConsole + WriteConsoleInputW PoC"
"=========================================="
foreach ($k in $report.Keys) {
    $v = $report[$k]
    "{0,-26} : {1}" -f $k, $v
}
