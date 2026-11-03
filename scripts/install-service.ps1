<#
.SYNOPSIS
  把 WorkHub 服务端注册成开机自启的常驻服务。

.DESCRIPTION
  两种装法，按有没有管理员权限选：

  - 默认（Windows 服务）：注册成真正的服务，services.msc 里能看到，
    开机自启，崩了由服务管理器拉起来。需要管理员权限。
  - -Task（任务计划）：用任务计划程序代替，不需要管理员权限。
    开机登录后自动起来，崩了由任务计划程序拉起来。
    适合没有管理员权限的机器；服务器上还是建议用服务。

  两种模式跑的都是同一个 WorkHubService.exe 宿主，它负责拉起 node、
  转发日志、收到停止指令时让服务优雅退出。

.PARAMETER AppDir
  服务端代码所在目录（里面有 server/index.ts）。默认取仓库根。

.PARAMETER Node
  node.exe 的路径。不填就从 PATH 和常见安装位置里找。

.PARAMETER Port
  服务端口。不填就读 .env 里的 MDHUB_PORT，再不行用 8787。

.PARAMETER Token
  机器令牌。留空则自动发一把（停机时靠它走优雅关闭）。

.PARAMETER Task
  用任务计划程序代替 Windows 服务（不需要管理员权限）。

.PARAMETER DryRun
  只打印将要执行的动作，不真的改系统。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-service.ps1
  powershell -ExecutionPolicy Bypass -File scripts/install-service.ps1 -Task
#>
[CmdletBinding()]
param(
    [string]$Name = 'WorkHub',
    [string]$DisplayName = 'WorkHub 文档服务',
    [string]$AppDir = '',
    [string]$Node = '',
    [string]$Arguments = '--env-file-if-exists=.env server/index.ts',
    [string]$Log = '',
    [int]$Port = 0,
    [string]$Token = '',
    [switch]$Task,
    [switch]$DryRun,
    [switch]$NoStart,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "    $Text" -ForegroundColor Red }

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 找出 node.exe：先看参数，再看 PATH，最后看常见安装位置
function Find-Node {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { throw "指定的 node 不存在：$Explicit" }
        return (Resolve-Path $Explicit).Path
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw '找不到 node.exe，请用 -Node 指定路径'
}

# 找 C# 编译器：系统自带的 .NET Framework 编译器，Win10/11 与 Server 2012+ 都带
function Find-Csc {
    $candidates = @(
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'),
        (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v3.5\csc.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw '找不到 csc.exe（.NET Framework 编译器）。请确认系统装有 .NET Framework 4.x'
}

# 从 .env 里读端口
function Get-PortFromEnv {
    param([string]$Dir)
    $envFile = Join-Path $Dir '.env'
    if (-not (Test-Path $envFile)) { return 0 }
    foreach ($line in Get-Content $envFile -ErrorAction SilentlyContinue) {
        if ($line -match '^\s*MDHUB_PORT\s*=\s*(\d+)\s*$') { return [int]$Matches[1] }
    }
    return 0
}

function Test-Health {
    param([int]$ServicePort, [string]$Token = '', [datetime]$Since = [datetime]::MinValue, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$ServicePort/api/healthz" -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                if (-not $Token) { return $true }
                # 端口上有东西应答，不等于那是我们刚起的这个——
                # 可能杵着一个旧实例（上次装完没退干净），健康检查却报成功，
                # 结果新服务其实一直在撞 EADDRINUSE。
                # 用状态接口里的启动时间对一下，确认是新的。
                try {
                    $headers = @{ 'x-workhub-token' = $Token }
                    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$ServicePort/api/manage/status" -Headers $headers -TimeoutSec 3
                    $startedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$status.startedAt).LocalDateTime
                    if ($startedAt -ge $Since.AddSeconds(-3)) { return $true }
                    Write-Info "端口上有旧实例（启动于 $startedAt），继续等新实例接管……"
                } catch {
                    Write-Info '状态接口还没通，继续等……'
                }
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

# 端口是否已被别人占着
function Test-PortInUse {
    param([int]$ServicePort)
    try {
        $conns = Get-NetTCPConnection -LocalPort $ServicePort -State Listen -ErrorAction Stop
        return (($conns | Measure-Object).Count -gt 0)
    } catch {
        $hit = & netstat -ano 2>$null | Select-String ":$ServicePort\s+.*LISTENING"
        return ($null -ne $hit)
    }
}

# 发放一把机器令牌：停机时要靠它走优雅关闭
function Issue-ManageToken {
    param([string]$Dir)
    Push-Location $Dir
    try {
        # 用 --json 拿结果：日志行带时间戳和前缀，正则抠出来的值
        # 哪天日志格式一改就会悄悄抠错，错了还不报错
        $raw = & node --env-file-if-exists=.env server/manageToken.ts issue 'windows service' --json 2>$null | Out-String
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.ok -and $parsed.token) {
            return @{ Token = $parsed.token; Id = $parsed.id }
        }
        Write-Warn '没能拿到令牌，停止时会改为强杀进程。'
        return @{ Token = ''; Id = '' }
    } catch {
        Write-Warn "发放令牌失败：$($_.Exception.Message)"
        return @{ Token = ''; Id = '' }
    } finally {
        Pop-Location
    }
}

Write-Step "安装 WorkHub 服务（$DisplayName）"

# ---- 校验参数 ----
if (-not $AppDir) { $AppDir = $RepoRoot }
if (-not (Test-Path $AppDir)) { throw "目录不存在：$AppDir" }
$AppDir = (Resolve-Path $AppDir).Path
if (-not (Test-Path (Join-Path $AppDir 'server\index.ts'))) {
    throw "这个目录里没有 server/index.ts，不像服务端代码目录：$AppDir"
}

if ($Task) {
    Write-Info '安装方式：任务计划程序（开机登录后自动启动，崩了自动拉起）'
} else {
    if (-not (Test-Admin)) {
        Write-Fail '注册 Windows 服务需要管理员权限。'
        Write-Info '两条出路：'
        Write-Info '  1) 用「管理员身份」打开 PowerShell 再跑一次这个脚本；'
        Write-Info '  2) 加 -Task 参数，改用任务计划程序（不需要管理员）。'
        exit 1
    }
    Write-Info '安装方式：Windows 服务（开机自启，崩了由服务管理器拉起）'
}

$NodePath = Find-Node -Explicit $Node
Write-Info "node：$NodePath"

$installDir = if ($Task) {
    Join-Path $env:LOCALAPPDATA 'WorkHub\service'
} else {
    Join-Path $env:ProgramData 'WorkHub\service'
}
$hostExe = Join-Path $installDir 'WorkHubService.exe'
$confPath = Join-Path $installDir 'service.conf'

if (-not $Log) { $Log = Join-Path $AppDir 'logs\service.log' }
if (-not $Port) { $Port = Get-PortFromEnv -Dir $AppDir }
if (-not $Port) { $Port = 8787 }

# ---- 端口检查 ----
# 端口上杵着别的东西时，硬装上去只会多一个抢不到端口的进程，
# 而健康检查还会被那个旧实例骗过去，报「服务已就绪」。
if ((Test-PortInUse -ServicePort $Port) -and -not $Force -and -not $DryRun) {
    Write-Fail "端口 $Port 已经被占用。"
    Write-Info '先停掉占用的实例（比如之前手工跑的服务），或者换个端口。'
    Write-Info '确认要继续的话加 -Force（服务多半起不来）。'
    exit 1
}

# ---- 编译宿主 ----
Write-Step '编译服务宿主'
$csc = Find-Csc
Write-Info "编译器：$csc"
$source = Join-Path $RepoRoot 'scripts\service\WorkHubService.cs'
if (-not (Test-Path $source)) { throw "找不到宿主源码：$source" }

if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
if ($DryRun) {
    Write-Info "[DryRun] 将会编译：$source -> $hostExe"
} else {
    # codepage:65001 让编译器按 UTF-8 读源码，否则中文日志会变乱码
    & $csc /nologo /target:exe /optimize+ /codepage:65001 /reference:System.ServiceProcess.dll "/out:$hostExe" $source
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $hostExe)) {
        throw "编译失败（退出码 $LASTEXITCODE）"
    }
    Write-Info "已生成：$hostExe（$((Get-Item $hostExe).Length) 字节）"
}

# ---- 机器令牌 ----
$TokenId = ''
if (-not $Token) {
    Write-Step '准备机器令牌'
    if ($DryRun) {
        Write-Info '[DryRun] 将会发放一把令牌（仅用于停机时优雅关闭）'
        $Token = 'DRY-RUN-TOKEN'
    } else {
        $issued = Issue-ManageToken -Dir $AppDir
        $Token = $issued.Token
        $TokenId = $issued.Id
        if ($Token) { Write-Info '已发放一把令牌（仅用于停机时优雅关闭）' }
    }
}

# ---- 写配置 ----
Write-Step '写服务配置'
$conf = @(
    '# WorkHub 服务配置（由 install-service.ps1 生成）'
    "node=$NodePath"
    "dir=$AppDir"
    "args=$Arguments"
    "log=$Log"
    "port=$Port"
    "token=$Token"
    "tokenId=$TokenId"
    "name=$Name"
    "displayName=$DisplayName"
    'stopTimeoutSeconds=15'
) -join "`r`n"
if ($DryRun) {
    Write-Info "[DryRun] 将会写入 $confPath ："
    Write-Info (($conf -split "`r`n" | Where-Object { $_ -notmatch '^token=' }) -join "`n")
} else {
    [System.IO.File]::WriteAllText($confPath, $conf, (New-Object System.Text.UTF8Encoding($false)))
    Write-Info "已写入：$confPath"
}

# ---- 注册 ----
if ($Task) {
    Write-Step '注册任务计划'
    $action = New-ScheduledTaskAction -Execute $hostExe -Argument "--console `"$confPath`"" -WorkingDirectory $installDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

    if ($DryRun) {
        Write-Info "[DryRun] 将会注册计划任务：$Name"
    } else {
        if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        }
        Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $DisplayName -Force | Out-Null
        Write-Info "已注册计划任务：$Name"
    }
} else {
    Write-Step '注册 Windows 服务'
    $binPath = "`"$hostExe`""
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
        Write-Info '发现同名服务，先卸掉旧的'
        & sc.exe stop $Name | Out-Null
        & sc.exe delete $Name | Out-Null
        Start-Sleep -Seconds 2
    }
    if ($DryRun) {
        Write-Info '[DryRun] 将会执行：'
        Write-Info "  sc.exe create $Name binPath= $binPath start= auto DisplayName= `"$DisplayName`" obj= LocalSystem"
        Write-Info "  sc.exe description $Name `"$DisplayName`""
        Write-Info "  sc.exe failure $Name reset= 86400 actions= restart/5000/restart/15000/restart/60000"
        Write-Info "  sc.exe failureflag $Name 1"
    } else {
        & sc.exe create $Name "binPath= $binPath" "start= auto" "DisplayName= `"$DisplayName`"" "obj= LocalSystem" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe create 失败（退出码 $LASTEXITCODE），请用管理员身份运行" }
        & sc.exe description $Name "$DisplayName" | Out-Null
        # 崩了自动拉起：三次，分别等 5 秒、15 秒、60 秒
        & sc.exe failure $Name "reset= 86400" "actions= restart/5000/restart/15000/restart/60000" | Out-Null
        # 连退出码为 0 的意外退出也重启
        & sc.exe failureflag $Name 1 | Out-Null
        Write-Info "已注册服务：$Name（开机自启，崩了自动重启）"

        # 装完立刻核对一遍 sc 记下来的路径：binPath 拼错是最容易犯又最难查的错，
        # 到时候表现是「服务起不来」，而日志里什么都看不出来
        $configured = (& sc.exe qc $Name 2>$null | Select-String 'BINARY_PATH_NAME') -join ''
        if ($configured -and ($configured -notlike "*$hostExe*")) {
            Write-Warn "服务记录的路径和预期不一致：$configured"
        }

        # 配置里有机器令牌，目录别让普通用户读——那等于把令牌送出去
        & icacls $installDir '/inheritance:r' '/grant:r' 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
        Write-Info '已收紧安装目录权限（仅 SYSTEM 与管理员可读）'
    }
}

# ---- 启动 ----
if (-not $NoStart) {
    Write-Step '启动服务'
    if ($DryRun) {
        Write-Info '[DryRun] 将会启动并做健康检查'
    } else {
        $startedAt = Get-Date
        if ($Task) {
            Start-ScheduledTask -TaskName $Name
        } else {
            Start-Service -Name $Name
        }
        Write-Info '等待服务就绪……'
        if (Test-Health -ServicePort $Port -Token $Token -Since $startedAt -TimeoutSec 40) {
            Write-Info "服务已就绪：http://127.0.0.1:$Port"
        } else {
            Write-Warn "健康检查没通过（http://127.0.0.1:$Port/api/healthz），去看日志：$Log"
            exit 2
        }
    }
}

Write-Step '安装完成'
Write-Info "日志：$Log"
if (-not $Task) {
    Write-Info "服务名：$Name（sc.exe start $Name / stop / query 查看）"
    Write-Info '提醒：服务以 LocalSystem 运行，用户环境变量读不到——配置请写进 .env。'
} else {
    Write-Info "任务名：$Name（Start-ScheduledTask / Stop-ScheduledTask）"
    Write-Info '提醒：任务计划模式在用户登录后才启动；需要无人值守常驻就用服务模式（管理员 PowerShell）。'
}
Write-Info "卸载：powershell -ExecutionPolicy Bypass -File scripts/uninstall-service.ps1"
