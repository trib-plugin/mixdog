#requires -Version 5.1
<#
.SYNOPSIS
  ConPTY matrix for inject-input.ps1.
  Case A: default Start-Process pwsh (likely ConPTY-fronted under Windows Terminal).
  Case B: forced classic conhost via `conhost.exe pwsh.exe ...`.
#>
[CmdletBinding()]
param(
    [int]$WaitMs = 800,
    [int]$ResultTimeoutMs = 4000
)

$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $PSCommandPath
$helper = Join-Path $here 'inject-input.ps1'

function Invoke-Helper {
    param([int]$Pid_, [string]$Text)
    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()
    $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$helper,'-TargetPid',$Pid_,'-Text',$Text)
    $p = Start-Process pwsh -ArgumentList $a -NoNewWindow -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait
    $stdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { '' }
    $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { '' }
    Remove-Item $stdoutPath,$stderrPath -ErrorAction SilentlyContinue
    return [pscustomobject]@{ ExitCode=$p.ExitCode; Stdout=$stdout; Stderr=$stderr }
}

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

$expected = 'hello-from-inject'
$cases = @()

# ---- Case A: default Start-Process pwsh ----
$resA = Join-Path $env:TEMP 'inject_result_a.txt'
if (Test-Path $resA) { Remove-Item $resA -Force }
$cmdA = "Read-Host 'in' | Set-Content -Encoding utf8 '$resA'; exit"
$procA = Start-Process pwsh -ArgumentList '-NoExit','-Command',$cmdA -PassThru
Start-Sleep -Milliseconds $WaitMs

# Find descendant pwsh if Start-Process spawned a wrapper. Usually $procA is pwsh itself.
$targetPidA = $procA.Id
$attA = Invoke-Helper -Pid_ $targetPidA -Text "hello-from-inject`r"
$contentA = Wait-ForResult -path $resA -timeoutMs $ResultTimeoutMs
$passA = ($null -ne $contentA) -and (($contentA.TrimEnd("`r","`n"," ","`t")) -eq $expected)

if (-not $procA.HasExited) { try { Stop-Process -Id $procA.Id -Force -ErrorAction SilentlyContinue } catch {} }

$cases += [pscustomobject]@{
    Case='A: default Start-Process pwsh'
    TargetPid=$targetPidA
    HelperExit=$attA.ExitCode
    HelperStderr=($attA.Stderr | Out-String).Trim()
    FileExists=(Test-Path $resA)
    Content=if($null -ne $contentA){$contentA.Trim()}else{'<no file>'}
    Pass=$passA
}

# ---- Case B: forced classic conhost ----
$resB = Join-Path $env:TEMP 'inject_result_b.txt'
if (Test-Path $resB) { Remove-Item $resB -Force }
$cmdB = "Read-Host 'in' | Set-Content -Encoding utf8 '$resB'; exit"

# conhost.exe pwsh.exe -NoExit -Command "<cmd>"
# We need to capture the spawned pwsh PID. Strategy: snapshot pwsh PIDs before/after.
$before = @(Get-Process pwsh -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
# Spawn via cmd /c start so we don't wait; conhost owns its own console.
$startArgs = "/c start `"injB`" conhost.exe pwsh.exe -NoExit -Command `"$cmdB`""
$procBwrap = Start-Process cmd -ArgumentList $startArgs -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds ($WaitMs + 400)
$after = @(Get-Process pwsh -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$newPwsh = $after | Where-Object { $before -notcontains $_ }
$targetPidB = if ($newPwsh) { $newPwsh | Select-Object -First 1 } else { 0 }

if ($targetPidB -gt 0) {
    $attB = Invoke-Helper -Pid_ $targetPidB -Text "hello-from-inject`r"
    $contentB = Wait-ForResult -path $resB -timeoutMs $ResultTimeoutMs
    $passB = ($null -ne $contentB) -and (($contentB.TrimEnd("`r","`n"," ","`t")) -eq $expected)
    try {
        $procB = Get-Process -Id $targetPidB -ErrorAction SilentlyContinue
        if ($procB -and -not $procB.HasExited) { Stop-Process -Id $targetPidB -Force -ErrorAction SilentlyContinue }
    } catch {}
    $cases += [pscustomobject]@{
        Case='B: conhost.exe pwsh.exe (classic)'
        TargetPid=$targetPidB
        HelperExit=$attB.ExitCode
        HelperStderr=($attB.Stderr | Out-String).Trim()
        FileExists=(Test-Path $resB)
        Content=if($null -ne $contentB){$contentB.Trim()}else{'<no file>'}
        Pass=$passB
    }
} else {
    $cases += [pscustomobject]@{
        Case='B: conhost.exe pwsh.exe (classic)'
        TargetPid=0
        HelperExit=$null
        HelperStderr='could not locate spawned pwsh PID'
        FileExists=$false
        Content='<not run>'
        Pass=$false
    }
}

"=========================================="
"  ConPTY matrix"
"=========================================="
$cases | Format-List
