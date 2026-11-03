<#
.SYNOPSIS
  卸载 WorkHub 服务（Windows 服务或任务计划，两种都能卸）。

.DESCRIPTION
  依次做四件事：停止、注销、清理残留进程、删安装目录。
  数据（数据库、正文、日志）一律不动——卸载服务不等于删数据。

.PARAMETER Name
  服务名/任务名，与安装时一致。

.PARAMETER AppDir
  服务端代码目录。用来认出残留的 node 进程（命令行里带这个路径的）。

.PARAMETER KeepFiles
  保留安装目录里的文件（默认也保留日志，只删 exe 与配置）。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/uninstall-service.ps1
#>
[CmdletBinding()]
param(
    [string]$Name = 'WorkHub',
    [string]$AppDir = '',
    [switch]$KeepFiles
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }

if (-not $AppDir) { $AppDir = $RepoRoot }
if (Test-Path $AppDir) { $AppDir = (Resolve-Path $AppDir).Path }

Write-Step "卸载 WorkHub 服务（$Name）"

# 先把「本次安装发的那把令牌」记下来——待会儿要删安装目录，
# 配置删了就没法知道是哪一把了
$issuedTokenId = ''
foreach ($dir in @((Join-Path $env:ProgramData 'WorkHub\service'), (Join-Path $env:LOCALAPPDATA 'WorkHub\service'))) {
    $conf = Join-Path $dir 'service.conf'
    if (-not (Test-Path $conf)) { continue }
    foreach ($line in Get-Content $conf -ErrorAction SilentlyContinue) {
        if ($line -match '^\s*tokenId\s*=\s*(\S+)') { $issuedTokenId = $Matches[1] }
    }
}
if ($issuedTokenId) { Write-Info "本次安装的令牌：$issuedTokenId" }

# ---- 1. 停止 ----
Write-Step '停止服务'
$service = Get-Service -Name $Name -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') {
        try {
            Stop-Service -Name $Name -Force -ErrorAction Stop
            Write-Info '服务已停止'
        } catch {
            Write-Warn "停止服务失败：$($_.Exception.Message)"
        }
        # 停不下来的话等它一会儿——被占住的服务删了会留下「标记为删除」的僵尸
        for ($i = 0; $i -lt 15; $i++) {
            $state = (Get-Service -Name $Name -ErrorAction SilentlyContinue).Status
            if (-not $state -or $state -eq 'Stopped') { break }
            Start-Sleep -Seconds 1
        }
    } else {
        Write-Info '服务本来就是停的'
    }
} else {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        Write-Info '已停止计划任务'
    } else {
        Write-Info '没有找到服务或计划任务，继续清理'
    }
}

# ---- 2. 注销 ----
Write-Step '注销注册'
if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    & sc.exe delete $Name | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Info '服务已注销' } else { Write-Warn "sc.exe delete 返回 $LASTEXITCODE" }
}
if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Info '计划任务已注销'
}

# ---- 3. 清理残留进程 ----
Write-Step '清理残留进程'
$killed = 0
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -eq 'node.exe' -or $_.Name -eq 'WorkHubService.exe') -and
    $_.CommandLine -and $_.CommandLine -like "*$AppDir*"
}
foreach ($proc in $processes) {
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        $killed += 1
        Write-Info "已结束进程 $($proc.ProcessId)（$($proc.Name)）"
    } catch {
        Write-Warn "结束进程 $($proc.ProcessId) 失败：$($_.Exception.Message)"
    }
}
if ($killed -eq 0) { Write-Info '没有残留进程' }

# ---- 4. 清理文件 ----
Write-Step '清理安装文件'
$installDirs = @(
    (Join-Path $env:ProgramData 'WorkHub\service'),
    (Join-Path $env:LOCALAPPDATA 'WorkHub\service')
)
foreach ($dir in $installDirs) {
    if (-not (Test-Path $dir)) { continue }
    if ($KeepFiles) {
        Write-Info "保留：$dir"
        continue
    }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $dir) {
        Write-Warn "没能删干净：$dir"
    } else {
        Write-Info "已删除：$dir"
    }
}

Write-Step '卸载完成'
Write-Info '数据（数据库、正文、日志）没有动，需要的话自己删。'

# ---- 撤销本次安装发的令牌 ----
# 精确撤这一把：它能重启服务，留着就是留了把钥匙在门上。
# 撤不掉的（服务早就卸了、配置没了）再按标签兜底清理。
Push-Location $RepoRoot
try {
    if ($issuedTokenId) {
        & node --env-file-if-exists=.env server/manageToken.ts revoke $issuedTokenId 2>&1 | ForEach-Object { Write-Info "  $_" }
    }
    # 兜底：清掉历次安装留下的、从未被使用过的令牌
    & node --env-file-if-exists=.env server/manageToken.ts cleanup 'windows service' 2>&1 | ForEach-Object { Write-Info "  $_" }
    Write-Info '剩余令牌：'
    & node --env-file-if-exists=.env server/manageToken.ts list 2>&1 | ForEach-Object { Write-Info "  $_" }
} finally {
    Pop-Location
}
