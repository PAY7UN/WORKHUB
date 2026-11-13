<#
.SYNOPSIS
  .env 的读取规则（PowerShell 侧唯一实现）。

.DESCRIPTION
  部署脚本要从 .env 里读端口：读到的端口会写进服务配置，宿主拿它调停机接口。
  读错端口的后果不是「服务起不来」——服务照常起在它自己的端口上，
  只是停机接口打不通，只能强杀；而且症状出现在停机那一刻，
  没人会联想到是部署时读错了端口。

  规则必须与服务端一致（服务端那两边的真源在 server/envFile.ts 与 tray/env.cjs）：
  - 值可以带引号（'...' 或 "..."），带引号时 # 是值的一部分；
  - 不带引号时，行尾 # 之后是注释（# 前面有没有空格都算注释）；
  - 同一个键写多次，后写的赢；
  - 前缀只有 WORKHUB_ 一个，旧名 MDHUB_ 不再兜底；
  - 文件带 UTF-8 BOM 不影响解析——BOM 后面的第一个键照样读得到。
    （Node 自带的 --env-file 恰恰认不出 BOM，会静默丢掉第一个变量，
     所以 PowerShell 这边必须自己处理，不然同一个 .env 服务端读到 A、
     部署脚本读到 B。）

  为什么要单独一个文件：deploy.ps1 与 install-service.ps1 都要读端口，
  两份实现迟早分叉。分叉之后症状是「同一个 .env，两个脚本读出两个端口」，
  而且全程没有报错——这种错只有靠「只有一份实现」来防。

  规则改动请同时改这三处：
    scripts/lib/env.ps1（本文件，PowerShell）
    server/envFile.ts（服务端）
    tray/env.cjs（托盘）
#>

# 前缀：只有新名。旧名不再兜底——两套名长期并存，改了新的却因为旧的还在而没生效，
# 比直接不生效更难查。
$script:WorkHubEnvPrefixes = @('WORKHUB_')

<#
.SYNOPSIS
  读 .env 文件的原始文本，顺手去掉 UTF-8 BOM。

.DESCRIPTION
  读不到就返回空串——文件不存在不是错误，调用方自己决定怎么兜底。
#>
function Read-EnvFileText {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    try {
        # ReadAllText 会按 BOM 探测编码；万一没探测到，这里再手动去一次头
        $text = [System.IO.File]::ReadAllText($Path)
    } catch {
        return ''
    }
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    return $text
}

<#
.SYNOPSIS
  按 Node --env-file 的规则把 .env 文本解析成键值表。

.DESCRIPTION
  返回 hashtable：键原样保留，前缀的取舍交给 Get-EnvValue。
#>
function ConvertFrom-EnvFileText {
    [CmdletBinding()]
    param([string]$Text)

    $table = @{}
    if (-not $Text) { return $table }
    if ($Text[0] -eq [char]0xFEFF) { $Text = $Text.Substring(1) }

    # 与 server/envFile.ts 里的 LINE_RE 一字不差：
    # 值要么被引号包着（引号里的 # 是值的一部分），要么一路到 # 或行尾。
    $lineRe = [regex]'^\s*([\w.-]+)\s*=\s*((?:''[^'']*''|"[^"]*"|[^#\r\n]*))\s*(?:#.*)?$'
    $quotedRe = [regex]'^([''"])([\s\S]*)\1$'

    foreach ($line in ($Text -split '\r?\n')) {
        $m = $lineRe.Match($line)
        if (-not $m.Success) { continue }
        $value = $m.Groups[2].Value.Trim()
        $quoted = $quotedRe.Match($value)
        if ($quoted.Success) { $value = $quoted.Groups[2].Value }
        # 同一个键写多次，后写的赢
        $table[$m.Groups[1].Value] = $value
    }
    return $table
}

<#
.SYNOPSIS
  读 .env 文件并解析成键值表。
#>
function Get-EnvFileTable {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    return ConvertFrom-EnvFileText (Read-EnvFileText -Path $Path)
}

<#
.SYNOPSIS
  按后缀取变量：只认新名，空串不算数。

.DESCRIPTION
  与 server/env.ts 的 envValueFrom 同规则：
  只看 WORKHUB_SECRET；配成空串等于没配
  （空串一路传下去会盖住默认值，是很常见的手滑）。
#>
function Get-EnvValue {
    [CmdletBinding()]
    param(
        [hashtable]$Table,
        [Parameter(Mandatory = $true)][string]$Suffix
    )

    if (-not $Table) { return '' }
    foreach ($prefix in $script:WorkHubEnvPrefixes) {
        $key = $prefix + $Suffix
        if (-not $Table.ContainsKey($key)) { continue }
        $value = ([string]$Table[$key]).Trim()
        if ($value) { return $value }
    }
    return ''
}

<#
.SYNOPSIS
  从目录下的 .env 里读服务端口。

.DESCRIPTION
  读不到、没有端口、端口不合法，一律返回 0（交给调用方用默认值）。
  端口范围按 TCP 有效区间卡：越界的端口写进服务配置，只会让停机接口打不通。
#>
function Get-PortFromEnv {
    [CmdletBinding()]
    param([string]$Dir)

    if (-not $Dir) { return 0 }
    $table = Get-EnvFileTable -Path (Join-Path $Dir '.env')
    $raw = Get-EnvValue -Table $table -Suffix 'PORT'
    if ($raw -notmatch '^\d+$') { return 0 }
    $port = [int]$raw
    if ($port -le 0 -or $port -ge 65536) { return 0 }
    return $port
}
