<#
.SYNOPSIS
  把发布包铺到机器上并注册成服务——首装和「用包升级」走的是同一条路。

.DESCRIPTION
  发布包（workhub-server-<版本>.zip）里带着编译好的服务端、运行时依赖，
  以及（可选的）自带 Node 运行时。这个脚本负责：

    1. 取包（本地 zip 或 URL）
    2. 校验 sha256（旁边有 .sha256 就校验）
    3. 解压
    4. 把内容铺到目标目录（data/、logs/、.env 保留不动）
    5. 升级时清掉新版里已经没有的旧文件
    6. 调 install-service.ps1 注册/重启服务并做健康检查

  目标机因此不需要装 Node、不需要 npm install、不需要联网装依赖：
  解压 + 一条命令就是完整的部署。

.PARAMETER Package
  发布包路径或 URL。不填则用 -AppDir 里已有的内容重新注册（只重装服务）。

.PARAMETER AppDir
  部署目录（代码放这儿）。默认 %ProgramData%\WorkHub\app。
  升级时就地覆盖这个目录。

.PARAMETER Task
  用任务计划程序代替 Windows 服务（不需要管理员权限）。

.PARAMETER Port
  服务端口。不填就读 .env 里的 WORKHUB_PORT，再不行用 8787。

.PARAMETER Force
  端口被占用时也继续。

.PARAMETER NoStart
  只铺文件，不注册/启动服务。

.PARAMETER DryRun
  只打印将要执行的动作。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -Package .\release\workhub-server-1.0.0.zip
#>
[CmdletBinding()]
param(
    [string]$Package = '',
    [string]$AppDir = '',
    [string]$Name = 'WorkHub',
    [string]$DisplayName = 'WorkHub 文档服务',
    [int]$Port = 0,
    [switch]$Task,
    [switch]$Force,
    [switch]$NoStart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "    $Text" }
function Write-Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "    $Text" -ForegroundColor Red }

# 这些是数据不是代码：铺包时绝不覆盖
$KeepDirs = @('data', 'logs')
$KeepFiles = @('.env')

function Get-DefaultAppDir {
    if ($Task) { return (Join-Path $env:LOCALAPPDATA 'WorkHub\app') }
    return (Join-Path $env:ProgramData 'WorkHub\app')
}

# 取包：URL 就下载，本地路径就直接用
function Get-PackageFile {
    param([string]$Source)
    if (-not $Source) { return '' }
    if ($Source -match '^https?://') {
        $tmp = Join-Path $env:TEMP ("workhub-package-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tmp -Force | Out-Null
        $script:downloadDir = $tmp
        $file = Join-Path $tmp ([IO.Path]::GetFileName(([Uri]$Source).AbsolutePath))
        Write-Info "下载：$Source"
        Invoke-WebRequest -Uri $Source -OutFile $file -UseBasicParsing
        # 校验文件一起拿：Release 上的资产名就是 <包名>.sha256。
        # 不校验就等于把下载损坏的包直接铺到机器上——而包铺坏了服务是起不来的。
        try {
            Invoke-WebRequest -Uri ($Source + '.sha256') -OutFile "$file.sha256" -UseBasicParsing
        } catch {
            Write-Warn '没找到 .sha256，只能不校验这个包'
        }
        return $file
    }
    if (-not (Test-Path $Source)) { throw "找不到发布包：$Source" }
    return (Resolve-Path $Source).Path
}

# 校验 sha256：旁边有同名 .sha256 就必须对上
function Test-PackageHash {
    param([string]$ZipPath)
    $hashFile = "$ZipPath.sha256"
    if (-not (Test-Path $hashFile)) {
        Write-Warn '旁边没有 .sha256，跳过校验'
        return $true
    }
    $expected = ((Get-Content $hashFile -ErrorAction SilentlyContinue | Select-Object -First 1) -split '\s+')[0]
    if (-not $expected) { return $true }
    $actual = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        throw "校验不过：包的 sha256 与 .sha256 文件对不上（文件可能下坏了）"
    }
    Write-Info "校验通过：sha256 $actual"
    return $true
}

# 从 .env 里读端口
# 新名 WORKHUB_PORT，旧名 MDHUB_PORT 也认：改名前写下的 .env 不该就此失效
function Get-PortFromEnv {
    param([string]$Dir)
    $envFile = Join-Path $Dir '.env'
    if (-not (Test-Path $envFile)) { return 0 }
    foreach ($line in Get-Content $envFile -ErrorAction SilentlyContinue) {
        if ($line -match '^\s*(?:WORKHUB|MDHUB)_PORT\s*=\s*(\d+)\s*$') { return [int]$Matches[1] }
    }
    return 0
}

# 端口是否已被占着
function Test-PortInUse {
    param([int]$ServicePort)
    if ($ServicePort -le 0) { return $false }
    try {
        $conns = Get-NetTCPConnection -LocalPort $ServicePort -State Listen -ErrorAction Stop
        return (($conns | Measure-Object).Count -gt 0)
    } catch {
        $hit = & netstat -ano 2>$null | Select-String ":$ServicePort\s+.*LISTENING"
        return ($null -ne $hit)
    }
}

# 停掉正在跑的服务
#
# 铺文件之前必须停，两个原因：
#   1. 自带的 runtime\node.exe 正被服务占着，Windows 不允许覆盖正在运行的
#      程序文件——不停就必然 EPERM，铺到一半失败。
#   2. 旧实例还占着端口，后面 install-service.ps1 的端口检查会直接判「端口
#      被占用」而拒绝安装。
function Stop-RunningService {
    param([string]$ServiceName, [bool]$AsTask, [int]$ServicePort)
    $installed = $false
    if ($AsTask) {
        $null = & schtasks.exe /Query /TN "$ServiceName" 2>$null
        $installed = ($LASTEXITCODE -eq 0)
    } else {
        $installed = ($null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue))
    }
    if (-not $installed) {
        Write-Info '还没有装过服务，直接铺文件。'
        return $true
    }
    Write-Info "停掉正在运行的服务：$ServiceName"
    if ($AsTask) {
        & schtasks.exe /End /TN "$ServiceName" 2>$null | Out-Null
    } else {
        & sc.exe stop "$ServiceName" 2>$null | Out-Null
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortInUse -ServicePort $ServicePort)) {
            Write-Info '服务已停。'
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Warn "端口 $ServicePort 还被占着，旧服务可能没停干净；铺文件可能失败。"
    return $false
}

# 解压后包根在哪一层：有的包会多包一层目录
function Resolve-PackageRoot {
    param([string]$Dir)
    $current = $Dir
    for ($i = 0; $i -lt 3; $i++) {
        if ((Test-Path (Join-Path $current 'server')) -and (Test-Path (Join-Path $current 'package.json'))) {
            return $current
        }
        $children = @(Get-ChildItem -Path $current -Directory -ErrorAction SilentlyContinue)
        if ($children.Count -ne 1) { break }
        $current = $children[0].FullName
    }
    return $null
}

Write-Step '部署 WorkHub 服务端'

if (-not $AppDir) { $AppDir = Get-DefaultAppDir }
$AppDir = [IO.Path]::GetFullPath($AppDir)

# ---- 取包、解压 ----
$packageRoot = $null
$hasPackage = $false
if ($Package) {
    $hasPackage = $true
    $zip = Get-PackageFile -Source $Package
    Test-PackageHash -ZipPath $zip | Out-Null

    $extract = Join-Path $env:TEMP ("workhub-extract-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extract -Force | Out-Null
    Write-Info '解压发布包……'
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $packageRoot = Resolve-PackageRoot -Dir $extract
    if (-not $packageRoot) {
        throw "包里没找到服务端代码（应该有 server\ 与 package.json）：$zip"
    }
}

if (-not $hasPackage) {
    # 不给包：就地重装服务（改完配置或换了 Node 之后用）
    if (-not (Test-Path $AppDir)) { throw "目录不存在：$AppDir（要部署新版本请给 -Package）" }
    Write-Info "就地重装服务：$AppDir"
}

# ---- 铺文件 ----
if ($packageRoot) {
    if (-not (Test-Path $AppDir)) {
        if ($DryRun) {
            Write-Info "[DryRun] 将会创建目录：$AppDir"
        } else {
            New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
        }
    }
    if (Test-Path $AppDir) { $AppDir = (Resolve-Path $AppDir).Path }

    # 新包里带没带自带运行时：决定了旧运行时该不该留（见下面清理旧文件那段）
    $packageHasRuntime = Test-Path (Join-Path $packageRoot 'runtime')

    # 先停旧服务：跑着的 exe 换不掉，占着的端口也会挡住后面的安装
    if (-not $DryRun) {
        Write-Step '停掉正在运行的服务'
        $servicePort = $Port
        if ($servicePort -le 0) { $servicePort = Get-PortFromEnv -Dir $AppDir }
        if ($servicePort -le 0) { $servicePort = 8787 }
        Stop-RunningService -ServiceName $Name -AsTask $Task -ServicePort $servicePort | Out-Null
    }

    $manifestPath = Join-Path $packageRoot '.workhub-files.txt'
    $newFiles = @()
    if (Test-Path $manifestPath) {
        $newFiles = @(Get-Content $manifestPath | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
    }

    # 升级：删掉新版里已经没有的旧文件（改名加版本号的老文件就是这么攒下来的）
    $oldManifest = Join-Path $AppDir '.workhub-files.txt'
    if ((Test-Path $oldManifest) -and $newFiles.Count -gt 0) {
        $keep = New-Object 'System.Collections.Generic.HashSet[string]'
        foreach ($f in $newFiles) { [void]$keep.Add($f.Replace('\', '/')) }
        $removed = 0
        foreach ($line in (Get-Content $oldManifest)) {
            $rel = $line.Trim()
            if (-not $rel) { continue }
            $rel = $rel.Replace('\', '/')
            if ($keep.Contains($rel)) { continue }
            $top = ($rel -split '/')[0]
            if ($KeepDirs -contains $top) { continue }
            if ($KeepFiles -contains $top) { continue }
            # 自带运行时是「这台机器上的东西」，不是代码：新包没带运行时，
            # 不等于目标机上那份就该删——那台机器上只有这一份 Node，
            # 删了服务就再也起不来了。
            if ($top -eq 'runtime' -and -not $packageHasRuntime) { continue }
            $target = Join-Path $AppDir ($rel -replace '/', '\')
            if (Test-Path $target) {
                if ($DryRun) { Write-Info "[DryRun] 删旧文件：$rel" }
                else { Remove-Item -Path $target -Recurse -Force -ErrorAction SilentlyContinue }
                $removed++
            }
        }
        if ($removed -gt 0) { Write-Info "已清理 $removed 个新版里不再有的旧文件" }
    }

    Write-Info "把发布包铺到：$AppDir"
    if ($DryRun) {
        Write-Info '[DryRun] 不会真的复制文件'
    } else {
        # 先把新内容整个搬进暂存目录，再一份一份换过去。
        #
        # 为什么不用 Copy-Item 直接往目标目录里铺：目标已存在时，PowerShell 会把
        # 源目录「塞进」目标目录——server 变成 server\server，node_modules 变成
        # node_modules\node_modules。首装看不出来（目标目录本来就是空的），
        # 升级时才炸：新代码落在没人执行的地方，目录看着是新的，服务跑的还是
        # 旧代码，而且没有任何报错。
        #
        # 先暂存再换还有第二个好处：拷贝失败时目标目录还是原样，
        # 不会出现「铺了一半」的半成品目录。
        $stage = Join-Path $AppDir '.deploy-new'
        if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        foreach ($item in (Get-ChildItem -Path $packageRoot -Force)) {
            Copy-Item -Path $item.FullName -Destination (Join-Path $stage $item.Name) -Recurse -Force
        }

        # 换过去：旧的删掉（依赖目录也是整块换——残留的旧版本依赖比缺依赖更难查），
        # 新的移过来。data\、logs\、.env 是数据不是代码，原样留着。
        foreach ($item in (Get-ChildItem -Path $stage -Force)) {
            $name = $item.Name
            if ($KeepDirs -contains $name) { continue }
            if ($KeepFiles -contains $name) { continue }
            $dest = Join-Path $AppDir $name
            if (Test-Path $dest) {
                Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue
            }
            Move-Item -Path $item.FullName -Destination $dest -Force
        }
        Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        Write-Info '文件已就位'
    }
}

if (-not (Test-Path $AppDir)) {
    if ($DryRun) { Write-Info "[DryRun] 目录还不存在：$AppDir" }
    else { throw "目录不存在：$AppDir" }
}
if (Test-Path $AppDir) { $AppDir = (Resolve-Path $AppDir).Path }

# ---- 注册服务 ----
if ($NoStart) {
    Write-Step '只铺文件，跳过服务注册'
    Write-Info "目标目录：$AppDir"
    if ($extract -and (Test-Path $extract)) { Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue }
    if ($downloadDir -and (Test-Path $downloadDir)) { Remove-Item $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 0
}

if ($DryRun -and -not (Test-Path $AppDir)) {
    Write-Step '[DryRun] 跳过服务注册（目录还不存在）'
    if ($extract -and (Test-Path $extract)) { Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue }
    if ($downloadDir -and (Test-Path $downloadDir)) { Remove-Item $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
    exit 0
}

$installScript = Join-Path $AppDir 'scripts\install-service.ps1'
if (-not (Test-Path $installScript)) { $installScript = Join-Path $RepoRoot 'scripts\install-service.ps1' }
if (-not (Test-Path $installScript)) { throw "找不到 install-service.ps1" }

Write-Step '注册服务'
$installArgs = @('-ExecutionPolicy', 'Bypass', '-File', $installScript, '-AppDir', $AppDir, '-Name', $Name, '-DisplayName', $DisplayName)
if ($Task) { $installArgs += '-Task' }
if ($Force) { $installArgs += '-Force' }
if ($DryRun) { $installArgs += '-DryRun' }
if ($Port -gt 0) { $installArgs += @('-Port', "$Port") }

& powershell @installArgs
if ($LASTEXITCODE -ne 0) { throw "安装服务失败（退出码 $LASTEXITCODE）" }

Write-Step '部署完成'
Write-Info "部署目录：$AppDir"
Write-Info '目标机不需要安装 Node、不需要 npm install。'

# 解压出来的临时目录用完就删：一份带自带运行时的包解压出来有几十兆，
# 每次部署都留一份，临时目录很快就满了
if ($extract -and (Test-Path $extract)) { Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue }
if ($downloadDir -and (Test-Path $downloadDir)) { Remove-Item $downloadDir -Recurse -Force -ErrorAction SilentlyContinue }
