# WorkHub

[![CI](https://github.com/PAY7UN/WORKHUB/actions/workflows/ci.yml/badge.svg)](https://github.com/PAY7UN/WORKHUB/actions/workflows/ci.yml)

文档与原件一体化归档平台。笔记用 Markdown 写，压缩包 / 图片 / PDF 按原样存；
文档与 Agent 配置均存储在服务端，访客浏览器不再持有模型凭据，加密文档的正文始终留在服务端。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite + Tailwind CSS v4 + shadcn/ui |
| 后端 | Node.js（原生 TS，零编译）+ Express |
| 存储 | SQLite（better-sqlite3），单文件免运维 |
| 模型 | OpenAI 兼容接口（默认 MiniMax），由服务端持有凭据 |

## 目录结构

```
mdhub/
├─ shared/          前后端共享层（类型、种子数据、RAG 检索算法、密码策略、日志脱敏）
├─ server/          Node 服务端（原生 TS，零编译）
│  ├─ index.ts      Express 入口：鉴权、文档过滤、Agent SSE
│  ├─ db.ts         SQLite 数据访问，API Key AES-256-GCM 加密
│  ├─ auth.ts       HS256 JWT 签发与校验（含密码指纹）
│  ├─ password.ts   密码哈希与指纹
│  ├─ docCrypto.ts  文档信封加密：正文密文、DEK 被主密钥包裹
│  ├─ docAccess.ts  Agent 检索范围的纯函数（便于回归测试）
│  ├─ dingtalk.ts   钉钉接入：加签、工作通知、钉钉待办
│  ├─ reminderScheduler.ts 提醒调度：30 秒一轮巡检到期的提醒
│  ├─ guests.ts     访客会话：httpOnly cookie 承载的访客身份
│  ├─ manage.ts     运维接口：状态 / 最近日志 / 重启 / 停机（认机器令牌，不认用户会话）
│  ├─ manageTokens.ts 机器令牌：发放、校验、列出、撤销、清理（库里只存哈希）
│  ├─ manageToken.ts 机器令牌的命令行入口（npm run manage:token，支持 --json）
│  ├─ logger.ts     统一日志出口：分级、脱敏、路径脱敏，兼带最近 500 行的内存缓冲
│  └─ *.test.ts     node --test 用例（password / loginThrottle / logger / docCrypto / docAccess / accessGrant / dingtalk / manage）
├─ scripts/         工具：docs.mjs（文档查看/导出）、verify.mjs（端到端自检）、
│                   pack-tray.mjs（组装服务 payload + 调 electron-builder 出安装包）、
│                   install-service.ps1 / uninstall-service.ps1（装卸 Windows 服务）、
│                   service/WorkHubService.cs（服务宿主源码，用系统 csc.exe 现场编译）
├─ electron-builder.yml 托盘工具的打包配置（应用目录、payload、NSIS 安装项）
├─ tray/            Windows 托盘工具（Electron 主进程）
│  ├─ main.cjs      托盘图标与菜单；local 模式拉起并守护服务进程，remote 模式走 HTTP
│  ├─ manage.cjs    remote 模式的 HTTP 客户端：状态 / 日志 / 重启
│  ├─ run-server.cjs 服务进程的包装：父进程（托盘）没了就自己退出，不留孤儿占端口
│  ├─ icon.cjs      用代码画托盘图标 PNG 与 exe 图标 ICO（不往仓库里塞二进制资源）
│  └─ package.json  Electron 应用入口声明
├─ data/            SQLite 索引 + 仓库目录里的正文（运行期生成，git 忽略）
│  ├─ mdhub-v2.db   现役索引库
│  └─ vault/        正文文件：<仓库 slug>/docs/…、<仓库 slug>/assets/…
├─ content/         导出的文档正文（git 默认忽略，用 npm run docs:export 生成）
└─ src/             React 前端
  ├─ lib/api.ts    API 客户端：令牌、SSE 解析
  ├─ lib/logger.ts 前端日志出口（生产构建只保留 error）
  ├─ context/      全局状态，数据源为服务端
  └─ components/   app/ 业务组件（app/admin/ 管理后台各分区）、ui/ shadcn 基础组件
```

> 数据库落在**项目根的 `data/`**，而不是 `server/data/`——`server/db.ts` 以自身目录为基准做
> `resolve(HERE, '../data/mdhub-v2.db')`，`../` 即项目根。用 `MDHUB_DB_V2` 可改到别处。
>
> 正文不在库里，在 `data/vault/` 的仓库目录里；库里只留索引（路径、哈希、大小）。
> 老库 `data/mdhub.db` 是 v1 时代的遗留，作为回退底牌保留，不参与运行。

## 启动

```bash
npm install

# 终端 1：服务端（默认 http://localhost:8787）
npm run server

# 终端 2：前端（默认 http://localhost:8080，/api 自动代理到服务端）
npm run dev
```

也可以一条命令同时启动（`concurrently` 已在 devDependencies 中）：

```bash
npm run dev:all
```

首次启动会在 `data/mdhub-v2.db` 自动建库。示例文档**仅在显式设置 `MDHUB_SEED_DEMO=1` 时**灌入，
正式部署默认是空库（详见 `.env.example`）。

### 生产模式：一个进程就是完整应用

```bash
npm run build     # 产出 dist/
npm run server    # 同一个端口既提供 API 也提供前端页面
```

服务端会直接托管 `dist/`（`server/index.ts` 末尾的静态中间件），
所以生产环境不必再另摆一个 Caddy/nginx 托静态站点——少一个组件就少一处配置、一处证书、
一处「页面能开但接口 404」的排查点。构建产物不在时只提供 API，并在日志里提示。

## 部署成 Windows 服务（服务器用）

桌面端用托盘就行；服务器上要的是「开机自启、崩了能自己爬起来、没人管也在跑」，
这一节就是干这个的。

```powershell
# 管理员身份的 PowerShell
npm run service:install
```

装完是个真正的 Windows 服务（`services.msc` 里能看到）：

```powershell
sc.exe query WorkHub       # 看状态
sc.exe stop WorkHub        # 停（走优雅停机）
sc.exe start WorkHub       # 起
```

### 它到底装了什么

没有引入 nssm / winsw 这类第三方二进制。脚本用**系统自带的 .NET Framework 编译器**
（`csc.exe`，Win10/11 与 Server 2012+ 都带）现场编一个几十 KB 的小 exe 当服务宿主，
它负责：

| 活儿 | 怎么做 |
| --- | --- |
| 拉起 node | 子进程，工作目录就是代码目录，`.env` 从那儿读 |
| 收日志 | node 的 stdout/stderr 转到 `logs/service.log`（带时间戳和级别） |
| 崩溃自愈 | node 崩了自己拉起来，退避 5/10/15… 秒；连续 5 次拉不起来才放弃 |
| 干净停止 | 收到停止指令先调服务端的停机接口，让它把事务收完；超时才强杀 |
| 不留孤儿 | 子进程关进 Windows Job Object：宿主被强杀，node 跟着死，不占着端口 |

「崩溃自愈」放在宿主里而不是交给服务管理器，是因为外部的重启策略各有各的脾气——
任务计划程序就不会重启「被终止」的任务。放在宿主里，两种安装方式的行为才是一套的。

### 没有管理员权限时

```powershell
npm run service:install -- -Task
```

改用任务计划程序：不需要管理员权限，开机登录后自动起来，崩了也会被拉起。
但它有两个边界：用户没登录时不跑，任务计划程序自己被禁用时也不跑。
真要无人值守，还是用服务模式。

### 常用参数

```powershell
# 指定代码目录（默认仓库根）、端口、node 路径
npm run service:install -- -AppDir D:\WorkHub -Port 8787 -Node "C:\Program Files\nodejs\node.exe"

# 只看要做什么，不真改系统
npm run service:install -- -DryRun

# 端口被占用时强行装（服务多半起不来）
npm run service:install -- -Force
```

### 卸载

```powershell
npm run service:uninstall
```

停服务、注销注册、清掉残留进程、删安装目录；**数据库、正文、日志一律不动**。
装服务时发的那把机器令牌也会一并撤销——它能重启服务，留着等于把钥匙留在门上。

### 两个要留心的

- **服务以 LocalSystem 运行，读不到用户环境变量。** 配置请写进代码目录下的 `.env`，
  别指望设过的用户级环境变量能传进去。
- **托盘托管和服务托管别同时开。** 两个都想拉起同一个端口，谁后起来谁撞
  `EADDRINUSE`（服务端会重试 10 秒，然后放弃）。

## 托盘工具（Windows）

一个托盘图标 + 一个菜单，不做完整界面。一套代码两种模式：

| 模式 | 用途 | 行为 |
| --- | --- | --- |
| `local` | 使用者本地版 | 托盘自己拉起并守护本机的 WorkHub 服务进程（菜单可启停） |
| `remote` | 运维管理面板 | 托盘只通过 HTTP 跟远端服务器说话 |

```bash
npm run tray      # 开发态启动（Electron 自带运行时）
```

- **使用者机器上不需要另外装 Node**：托盘用 `ELECTRON_RUN_AS_NODE=1` 让自带的运行时当纯 Node 用。
- **托盘被强杀不会留下孤儿服务**：服务进程盯着父进程 PID，父进程没了就自己退出、释放端口
  （Windows 不像 Unix 会自动收拾孤儿进程）。
- 配置放在 `tray/tray.config.json`（按机器而异，不进版本库；样例见 `tray/tray.config.example.json`）：
  `mode` / `target` / `appDir` / `entry` / `token`。

### remote 模式：拿托盘当运维面板

`mode: "remote"` 时托盘不碰本机服务，只跟一台远端服务器说话。菜单里是三个动作：

| 菜单项 | 做什么 |
| --- | --- |
| 查看服务器状态 | 版本、运行时长、内存、数据库大小、内容条数、托管方式 |
| 查看最近日志 | 服务端最近 200 行（默认，可指定行数） |
| 重启服务器 | 先弹窗确认，再发重启请求 |

凭据是**机器令牌**（`x-workhub-token` 请求头），和用户登录口令是两套东西，互不通用：

```bash
# 在服务器上发一把令牌（明文只出现这一次）
npm run manage:token -- issue "运维笔记本"

# 列出已发放的令牌
npm run manage:token -- list

# 撤销
npm run manage:token -- revoke <令牌 id>

# 清掉某个标签下从未被用过的令牌（装服务反复留下的残骸）
npm run manage:token -- cleanup "windows service"
```

加 `--json` 只输出 JSON，脚本解析用（`issue --json` 会带出 id 和明文）。

把令牌填进托盘配置，或用环境变量 `WORKHUB_MANAGE_TOKEN`：

```json
{
  "mode": "remote",
  "target": "http://192.168.1.10:8787",
  "token": "mht_xxxxxxxx"
}
```

托盘在 remote 模式下每 15 秒拉一次状态，显示在菜单标题上；连不上时菜单标题直接写「离线」，
并往 `logs/tray.log` 记一条（只在状态翻转时记，不刷屏）。

对应的服务端接口（认机器令牌，不认用户会话）：

| 接口 | 说明 |
| --- | --- |
| `GET /api/manage/status` | 状态快照 |
| `GET /api/manage/logs?tail=N` | 最近 N 行日志（默认 200） |
| `POST /api/manage/restart` | 重启服务 |

重启会先判断服务是谁拉起来的（systemd / pm2 / docker / 托盘托管 / 裸跑），
再选对应的重启方式；**被托盘托管时拒绝远端重启**——那种情况归本地托盘管，
从外面再拉一个进程会跟托盘抢端口。

### 打包成 exe

```bash
npm run pack:tray
```

产物：`release/WorkHub-Setup-<版本>.exe`（一键安装包，约 118MB——大头是 Electron 本身）。

安装包里装的是两样东西，**目录分工是打包版的关键**：

| 位置 | 内容 | 权限 |
| --- | --- | --- |
| 安装目录 `resources/payload` | 服务端代码 + 前端产物 + 服务端运行时依赖 | 只读 |
| `%LOCALAPPDATA%\WorkHub` | `.env`、数据库、vault、日志 | 可写 |

之所以要分开：服务端是**按代码目录**定位数据库和 vault 的（`server/storage/v2/db.ts`），
打包后代码在安装目录里，数据库要是跟着落在那儿，普通用户根本写不进去——
服务一起来就报错。所以打包态用 `MDHUB_DB_V2` / `MDHUB_VAULT_DIR` 把它们掰到用户目录。

首次运行的行为：

1. 托盘在用户目录生成 `.env`：随机密钥 + 随机管理员密码 + 一个没被占用的端口；
2. 弹窗把**初始密码当面告诉使用者**（只显示这一次）；
3. 拉起服务进程（从安装目录的 payload 里跑），页面地址 `http://127.0.0.1:<端口>`。

打包相关的几个坑（都在 `scripts/pack-tray.mjs` 里绕掉了）：

- **payload 里的 `node_modules` 要单独一条 `extraResources`**：electron-builder 的文件过滤器
  硬编码排除「复制源根部的 node_modules」，把源目录设成 `node_modules` 本身才拷得进去。
- **托盘应用要明确排除 `node_modules`**：否则 electron-builder 会按仓库根的 `package.json`
  把前端依赖（react、codemirror…）连同原生模块拖进安装包，白多四十兆。
- **打包的中间产物放临时目录**：electron-builder 解压 electron 发行包的最后一步是目录改名，
  在 IDE 打开的仓库里做目录改名会被安全删除钩子拦掉（EPERM），打包会挂在最后一步。
- **better-sqlite3 只留 `prebuilds/win32-x64.node`**：它自带 10MB 的 sqlite3 C 源码和 6 个
  别的平台的预编译二进制，运行时都用不上。

## 局域网访问

前端 dev server 已监听 `0.0.0.0:8080`，同一局域网内的设备直接用本机 IP 访问即可：

```
http://<本机内网 IP>:8080
```

查本机内网 IP：

```bash
ipconfig            # Windows：看「IPv4 地址」
hostname -I         # Linux / macOS
```

服务端启动日志也会直接打印可用的局域网地址（`http://<内网IP>:8787` 这个端口只被本机代理访问，不需要对外暴露）。

### 首次配置：放行 Windows 防火墙

Windows 防火墙默认策略是 `BlockInbound`，且 Node.js 通常没有入站放行规则，
所以**本机用内网 IP 能打开、别的设备打不开**——这一步必须手动放行一次。

以**管理员身份**打开 PowerShell，执行：

```powershell
New-NetFirewallRule -DisplayName "WorkHub Dev 8080" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private,Domain
```

只放行 8080：浏览器始终与前端 dev server 通信，`/api` 由它在**本机**转发到服务端，
后端端口不需要对外暴露。

删除这条规则：

```powershell
Remove-NetFirewallRule -DisplayName "WorkHub Dev 8080"
```

验证端口确实在监听全部网卡（`LocalAddress` 应为 `0.0.0.0` 或 `::`，
只有 `127.0.0.1` 就说明没绑全网卡）：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 8080
```

### 仍然打不开时

按这个顺序排查：

1. **设备不在同一网段**。先在访问端确认 `ipconfig`，IP 需与本机同段（如都是 `192.168.1.x`）。
2. **路由器开启了 AP / 客户端隔离**。这是最常见的第二个原因：手机连同一个 Wi-Fi 却互相打不开。
   在路由器管理页（无线设置 / WLAN / 访客网络）里找「AP 隔离」「客户端隔离」「访客网络隔离」并关闭。
3. **访客网络（Guest Wi-Fi）天然隔离**。访客网络只放行到网关，设备之间不互通，
   需要把设备切到主 Wi-Fi。
4. 本机能开、别人不能开 → 基本可以确定是防火墙；别人连别的网络能开、同网段不能开 → 是隔离问题。

### 从公网访问

路由器的端口转发需要把外部端口指向本机内网 IP 的 **8080**：

- 转发生效的前提是本机拿到**固定内网 IP**（在路由器 DHCP 里按 MAC 地址绑定），
  否则重启后内网 IP 变化，转发会指向错误地址。
- 前端 dev server 没有 HTTPS，公网访问时登录密码是明文传输的。
  长期对外暴露请用 `npm run build && npm run preview`，并在前面套一层 HTTPS 反向代理。

访问者各自登录，权限按账号角色（管理员 / 访客）生效——访客能看到全部文档，但加密文档的正文必须凭已批准的访问授权才能查看。

## 管理员密码

| 场景 | 做法 |
| --- | --- |
| 想自己指定初始密码 | 在 `.env` 写 `MDHUB_ADMIN_PASSWORD=...`，**首次建库时**写入 |
| 登录后想换密码 | 侧边栏头像旁的钥匙图标，需输入当前密码 |
| 已经进不去 / 忘了密码 | 见下方「忘记密码」 |

本地开发若未配置 `MDHUB_ADMIN_PASSWORD`，服务端会在**首次建库时**生成一个随机密码并打印到启动日志，**只显示这一次**，请立刻记录。之后想换成自己好记的，登录后用侧边栏的钥匙图标修改即可。

> 早期版本文档里的默认密码 `admin123` 已不再适用：它只在显式设置 `MDHUB_ALLOW_INSECURE_DEV=1` 时才会启用。

### 忘记密码

改密入口要求先登录，而初始密码只在启动日志里出现过一次——一旦错过就无路可走。因此提供了离线重置命令，它直接改库、不需要任何登录态：

```bash
npm run admin:password -- 我的新密码

# 或让脚本生成一个强随机密码（同样只打印一次）
npm run admin:password -- --generate
```

要点：

- 命令可在服务端运行期间执行（SQLite 处于 WAL 模式，支持并发写）
- 不依赖 `MDHUB_SECRET` 是否配置，也不会建表或灌种子数据
- 改密后**所有已登录设备的下一次请求都会因令牌指纹过期而被要求重新登录**
- 密码规则与设置页一致：至少 8 位

## 环境变量

复制 `.env.example` 为 `.env` 后按需修改（服务端启动时自动加载）：

> **关于 `MDHUB_` 前缀**：产品名已改为 WorkHub，但环境变量、数据库文件名（`mdhub-v2.db`）、
> Cookie（`mdhub_sid`）与前端存储键（`mdhub.*`）一律**保持原样**——
> 这些是运行时契约而非品牌：改掉它们会让既有部署读不到 `.env`、找不到库、
> 登录态与本地设置全部作废。改品牌不动契约。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MDHUB_SECRET` | 无（缺失则拒绝启动） | JWT 签名、Agent Key 加密主密钥，以及**文档加密主密钥的种子**（`MASTER_KEY = sha256(MDHUB_SECRET)`），**生产必须配置**；本地需写入 `.env` 或设置 `MDHUB_ALLOW_INSECURE_DEV=1`。改动它会让已加密文档的密文永久无法解密 |
| `MDHUB_ADMIN_PASSWORD` | 本地随机生成 | 管理员**初始**密码，仅首次建库时写入；已有库请用 `npm run admin:password` 或侧边栏修改，改动此变量对已有库无效 |
| `MDHUB_PORT` | `8787` | 服务端端口 |
| `MDHUB_WEB_PORT` | `8080` | 前端 dev server 端口（监听 `0.0.0.0`，供局域网访问） |
| `MDHUB_DB_V2` | `data/mdhub-v2.db` | 数据库路径（索引库）。`MDHUB_DB` 是 v1 时代的旧变量，仅作兼容兜底 |
| `MDHUB_VAULT_DIR` | `data/vault` | 仓库目录：正文文件实际存放的位置 |
| `MDHUB_LOG_LEVEL` | `info` | 服务端日志级别：`silent` / `error` / `warn` / `info` / `debug` |
| `MDHUB_SEED_DEMO` | 关闭 | 置 `1` 时首次建库灌入示例文档（`shared/seed.ts`）；正式部署保持关闭 |
| `MDHUB_ALLOW_INSECURE_DEV` | 关闭 | 置 `1` 时允许使用公开的开发默认值（密钥 `mdhub-dev-secret-change-me`、密码 `admin123`）；`NODE_ENV=production` 下无效 |
| `NODE_ENV` | 未设置 | 置 `production` 启用生产模式：强制要求显式配置密钥与管理员密码 |
| `WORKHUB_MANAGE_TOKEN` | 无 | 机器令牌：托盘 remote 模式用；优先于配置文件里的 `token`。**只发给可信机器**，它等价于运维权限 |

## 日志

服务端日志统一走 `server/logger.ts`，格式固定为 `[workhub][级别] 内容`：

| 级别 | 何时打印 | 去向 |
| --- | --- | --- |
| `fatal` | 进程即将终止前的最后一条消息（未捕获异常），**不受级别开关影响** | stderr |
| `error` | 启动校验失败、落库失败等异常 | stderr |
| `warn` | 降级但不中断的情况（如用量统计失败） | stderr |
| `info` | 启动横幅、建表迁移、种子数据等常规信息 | stdout |
| `debug` | 排查用的细节 | stdout |
| `notice` | 必须让用户看到的关键信息（一次性管理员密码），**不受级别开关影响** | stdout |

用 `MDHUB_LOG_LEVEL` 调整：`silent` 全关、`error` 只留错误、`warn` / `info` 逐级放开、`debug` 最啰嗦。
`npm run server > out.log` 时常规输出（`info` / `debug` / `notice`）进 `out.log`，错误（`error` / `warn` / `fatal`）
仍在控制台——`>` 只重定向 stdout，想把两者收进同一个文件要补 `2>&1`。

所有未处理的异常都从同一个出口出去：Express 的全局错误处理中间件把它交给 `logger`，
客户端只收到一句「服务器内部错误」，**不会拿到堆栈**（堆栈里有本机路径与依赖版本）。

两条安全约定：

- **写入前脱敏**。所有日志入参都会过一遍密钥/令牌/密码的匹配（`Bearer` 头、JSON 里的 `apiKey`、
  `password=`、URL 里的 `user:pass@` 之类），命中的值一律替换成 `***`；数据库路径只给相对形式，
  不带本机用户名目录。上游返回的错误体同样先脱敏再发给浏览器。
  唯一的例外是 `notice`：它承担一次性密码的逐字交付，脱敏规则可能把密码本身改写
  （随机串里恰好出现 `sk-` 就成了 `sk-***`），那就等于给了用户一把开不了门的钥匙。
- **一次性密码只在启动时打印**。未配置 `MDHUB_ADMIN_PASSWORD` 时生成的那串随机密码会出现在
  启动日志里（只此一次），它不受日志级别影响。**转贴启动日志前请先把那几行删掉。**

前端日志在 `src/lib/logger.ts`：开发期全开，生产构建只保留 `error`——
访客控制台里的内部状态变化对用户没有可操作性，只会淹没真正的报错。

## 权限模型

| 能力 | 管理员 | 访客 |
| --- | --- | --- |
| 查看/下载普通文档 | 全部 | 全部 |
| 创建/编辑/删除/移动/上传 | 允许 | 服务端 403 拒绝 |
| 加密 / 取消加密 | 允许 | 拒绝 |
| 查看加密文档正文 | 允许（服务端凭主密钥直接解密，免密） | 凭已批准的访问授权（需含 `view`） |
| 下载加密文档 | 允许 | 凭已批准的访问授权（需**显式**含 `download`） |
| 申请访问加密文档 | 不需要 | 允许（进入管理员待审批列表） |
| 审批申请 / 收回授权 / 调整授权能力 | 允许 | 拒绝（403） |
| 配置 Agent（含 API Key） | 允许 | 拒绝（403） |
| 使用 Agent 问答 | 允许 | 由管理员开关 `allowGuest` 控制 |

关键点：**「对访客隐藏」已下线**——访客与管理员拿到同一份文档清单，保密不再靠"藏起来"，
而是靠**加密**：加密文档的正文只存密文，访客必须凭已批准的访问授权才能读到，且其内容
不进入任何 Agent 的检索上下文（管理员身份也不例外）。

> 老库里原先标记为「对访客隐藏」的文档，在升级时会被**自动转成加密文档**——
> 可见性开关没了，但内容对访客依然不可读。访客提交访问申请、管理员批准后即可查看。

## 文档加密（申请制）

加密是把正文挡在**访客**之外的门槛——访客必须走申请制拿到授权，Agent 一律无权读取。

在文档右键菜单点「加密文档」之后：

- 正文以 **AES-256-GCM 密文**写入 `docs.enc_cipher`，`content` 列置空，接口返回的同样只有密文
- 每篇文档一把随机数据密钥（DEK），信封加密：DEK 被**服务端主密钥**包裹一份（`docs.enc_master_dek`）
- **服务端不签发、也不存储任何访客口令**——没有密码哈希，没有封存的密码密文，没有密码派生密钥
- 加密文档**不进入 Agent 的检索范围**，管理员身份也不例外；`/agent/polish` 对加密文档直接返回 403

**原件同样能加密，而且是真的加密**：`kind='file'` 的节点加密时，
盘上的**字节**被换成密文（不是只把索引标成加密）。
把一个 zip 标成「已加密」却让它继续以明文躺在磁盘上，
只是给用户一个「它加密了」的错觉——真出事时拖走 vault 的人照样拿得到内容。
原件的解密也在服务端完成：`/raw` 与 `/download` 在授权通过后回传明文字节。

**访客只有一条路**：提交访问申请 → 管理员批准 → 凭授权免密打开（详见下一节）。
没有「拿到密码」这个选项，也就没有「密码被拖库」这条风险。

**管理员免密查看**：服务端本就持有被主密钥包裹的那份 DEK，
所以管理员打开加密文档时由服务端直接解密并返回明文。
解密全程在服务端完成，浏览器拿到的仍是明文而非密文；该动作会记入服务端日志。

**加密文档分区**（管理后台 → 加密文档，仅管理员）：看清哪些文档以密文保存、加密了多久、
当前有几个人被放行，并可从这里跳转去改授权或取消加密。

解锁后的明文只留在浏览器内存里，不写回全局状态、不落 localStorage；退出该文档即需重新申请。

> ⚠️ 主密钥 `MASTER_KEY = sha256(MDHUB_SECRET)`：**改动 `MDHUB_SECRET` 会让既有密文永久无法解密**。

> 升级说明：本次改动会 `DROP` 掉 `docs` 表里的 `enc_wrapped_dek` / `enc_salt` /
> `enc_pwd_used_at` / `enc_pw_cipher` 四列（访问密码机制的遗留物）。
> 正文密文 `enc_cipher` 与主密钥包裹的 DEK `enc_master_dek` 都留着，
> **既有加密文档照常可读**——管理员免密查看、授权后访客打开都不受影响。

## 管理后台

管理员的活儿原本挤在侧边栏一排没有文字的小图标里：授权、加密文档、改密。
图标一多就得对着看才能认出哪个是哪件事，而且每个功能各开各的弹窗，
点开一个盖住另一个。

现在只有一个入口——侧边栏的「管理」按钮（有待审批时带角标），
进去以后是**按功能拆分的分区**：

| 分区 | 干什么 | 主要位置 |
| --- | --- | --- |
| 概览 | 现在有多少事等着处理：待审批数、有效授权数、Agent 是否配好 | 管理后台 → 概览 |
| 访问授权 | 审批访客申请、选有效期、收回已给出的权限 | 管理后台 → 访问授权；文档菜单「访问授权」直接定位到该篇 |
| 加密文档 | 哪些文档以密文保存、加密多久、谁被放行、取消加密 | 管理后台 → 加密文档；文档菜单「加密文档 / 取消加密」 |
| AI Agent | 接口地址、模型、API Key、访客开关、检索参数 | 管理后台 → AI Agent；AI 助手面板右上角齿轮 |
| 钉钉同步 | 接入自己的钉钉、到点提醒、提醒记录 | 管理后台 → 钉钉同步 |
| 账号安全 | 修改管理员密码（需当前密码） | 管理后台 → 账号安全 |

几个约定：

- **同一件事只在一个地方出现**。文档菜单里点「访问授权」不是另开一个弹窗，
  而是打开管理后台的访问授权分区，并**限定在这一篇文档**上（右上角有「查看全部文档」可退回）。
  AI 助手的齿轮同理，落到管理后台的 AI Agent 分区。
- **分区导航在左侧**，窄屏改成横向滚动条。每个分区名下面有一行说明，
  不用猜图标是干什么的。
- **概览里的数字可点击**，点一下直接跳到该处理的分区。
- 组件位置：`src/components/app/admin/`（`AdminConsole` 容器 + 各分区），
  打开状态与当前分区放在全局 `AppContext`——入口散在侧边栏、文档菜单、AI 助手三处，
  它们要的是同一扇门。

## 访问授权（「获取权限」式申请）

加密文档的访问只有这一条路：**申请 → 审批 → 授权**。

| | 访问授权 |
| --- | --- |
| 怎么拿到 | 你自己申请，管理员批准 |
| 粒度 | 一个人一篇文档 |
| 口子多大 | **两级**：查看（`view`）与下载（`download`）分开给 |
| 能否收回 | 能，点「收回」即刻生效 |
| 有效期 | 可设 1 / 7 / 30 天或长期 |
| 留痕 | 谁申请、何时批、批给谁、看过什么、拿走什么，都在库里 |

**「能看」不等于「能拿走」。**
授权默认只有 `view`：能打开、能读，但下载会被服务端挡下（403）。
要放行下载，管理员得显式勾上 `download`——
默认就开放下载，等于让管理员在没想过这件事的情况下把文件交了出去。
访客那边会同步收敛：授权里没有 `download` 时，下载按钮是置灰的，
并说清「本次授权仅允许查看」。这份收敛是活的——访客开着文档时每隔十几秒
探一次权限状态（切回窗口时也探一次），管理员刚放开的下载能力不必等对方
关掉重开才生效；反过来管理员收窄了能力，对方界面也会自己把按钮按回去。

批准时给错能力是常事，所以授权列表里可以直接改：
点「下载原件」那一格即刻生效（`PATCH /api/docs/:id/access-grants/:gid`）。
这比「收回再重批」好——后者会把中间那段的口子状态从流水里抹掉，
「那段时间到底能不能下载」就再也查不出来。

> 以前加密文档还有第二条路——「访问密码」：管理员把密码发过来，访客输一次长期使用。
> 那条路已经下线：密码意味着服务端要存一份口令材料（无论是哈希、封存密文，
> 还是包裹数据密钥的密码派生密钥），库一旦被拖走就是一次凭据泄露。
> 现在服务端只认会话与授权，不认任何共享口令。

**访客侧**：打开加密文档时会先拿自己的会话（`mdhub_sid` httpOnly cookie）去问一次
「有没有已批准的授权」——有就直接打开，没有才显示申请界面。
填个名字、说明来意即可提交；管理员批准后刷新页面就能看到正文。
申请被拒会显示「未获批准」，可重新申请。

**管理员侧**：左侧栏的「授权」图标（或文档菜单里的「访问授权」）打开面板：

- **待审批**：谁想看哪篇文档、为什么、什么时候提的；批准时可顺手选有效期（长期 / 1 / 7 / 30 天）与能力
- **已授权**：当前还有效的授权；能力一格直接改，点「收回」即刻让对方下一次打开就撞墙；
  已收回的收在折叠区里备查
- **访问审计**：谁在什么时候看过、下载过、申请过、批过、收过、改过能力，全在这儿

未处理的申请数会在入口图标上显示角标，不用点开就知道有人等着。

四张表支撑这套机制：`guest_sessions`（访客身份）、`access_requests`（申请与审批结果）、
`access_grants`（授权：能力、有效期、可撤销）、`access_audit`（访问流水）。
文档被取消加密时，这篇文档上的申请与授权会一并清掉——
留着只会让管理端显示一堆已经不成立的授权。

**审计流水**（`access_audit` 表，`GET /api/access-audit`）记的是动作本身：
`提交申请` / `批准授权` / `拒绝申请` / `打开正文` / `下载原件` / `撤销授权` / `调整授权`。
权限授出去之后会被追问的从来不是「批了没有」，
而是「谁在什么时候看过、拿走过什么」——这件事只有流水答得上来。
它放在管理后台的最后一个分区：这是事后追查用的账，不是日常操作界面。

**定位深链**：链接里带上申请单号（`?access=<申请单号>`），审批人点开落回本站时，
管理后台会直接跳到「访问授权」分区并高亮那一条申请，省得自己在一堆申请里翻。

## 文档分析 Agent

1. 管理员在右下角「AI 助手」面板点击齿轮，填写接口地址（预设含 MiniMax）、模型名、API Key
2. API Key 经 AES-256-GCM 加密后存入 SQLite，不下发到任何浏览器
3. 访客问答时，服务端按访客可见文档做检索 → 拼接上下文 → 调用模型 → SSE 流式返回，并标注引用来源
4. 管理员可随时关闭「允许访客使用 Agent」，关闭后服务端直接拒绝访客提问

**检索到哪个仓库**（这条最容易踩坑，所以规则写死）：

| 情况 | 检索范围 |
| --- | --- |
| 面板里选了某个仓库 | 只检索那个仓库 |
| 问题里点名了某个仓库（「B 仓库里怎么…」） | 只检索那个仓库 |
| 都没说 | 只检索**默认仓库**（库里最早建的那个） |
| 管理员在设置里划定了范围 | 取交集，范围只能收窄不能放宽 |

面板底部能看到「当前检索范围」，问完还会回传服务端实际用到的仓库名，
两处对不上就说明落点变了。仓库名互相包含时只认更长的那个
（同时存在「项目」与「项目甲」，问的显然是后者）。

## 钉钉同步（到点提醒）

管理后台 → 钉钉同步：把 WorkHub 接到你自己的钉钉上，到点自动提醒。

**三条通道**，按省事程度排：

| 通道 | 需要什么 | 推到哪里 | 适合 |
| --- | --- | --- | --- |
| 群机器人 | 一个 Webhook 地址（加签则再加一个 SEC 密钥） | 钉钉群 | 个人自用首选，不用申请应用 |
| 工作通知 | AppKey / AppSecret + 接收人 userid | 单聊 | 要推给指定成员、不受群机器人频率限制 |
| 钉钉待办 | AppKey / AppSecret + unionId + WorkHub 地址 | 钉钉「待办」列表 | 想在钉钉里留下可点回的条目 |

配置在**管理后台 → 钉钉同步**里填，保存后点「发送测试消息」当场验证——
不必先保存才能测，填错了当场就能看出来。密钥（加签密钥、AppSecret）经 AES-256-GCM
加密落库，浏览器只拿到「已配置 / 未配置」，与 Agent 的 API Key 同一口径。

**提醒怎么用**：在同一分区「新建提醒」，填标题、时间、可选的关联文档与重复规则
（仅一次 / 每天 / 每周 / 每月）。到点由**服务端**推送，不依赖浏览器开着。

几处刻意的设计：

- **提醒记录留痕**。每条提醒的状态、推送次数、最近一次失败原因都存在 `reminders` 表里，
  可以手动「立即推送」补发，或标记完成 / 取消。
- **重复提醒按原定时刻顺延**。9:30 触发的每天仍是 9:30，不会因为巡检晚了几十秒就漂到 9:31。
- **停机期间错过的重复提醒不补发**。服务停了三天，恢复后只响一次，不连响三遍。
- **推送失败不丢提醒**。失败原因记下来，5 分钟后自动重试，不会刷屏式重试。

表与代码位置：`dingtalk_config`（接入配置）、`reminders`（提醒记录）两张表；
`server/dingtalk.ts`（三条通道与加签）、`server/reminderScheduler.ts`（30 秒一轮的巡检）。

## 上传文件：笔记与原件

站里只有两种东西，**分清楚比什么都重要**：

| 上传的东西 | 变成什么 | 打开时看到 |
| --- | --- | --- |
| `.md` / `.markdown` | 一篇**笔记**（`kind='note'`） | Markdown 编辑器 + 分屏预览 |
| 其它格式（docx、pdf、图片、源码、**压缩包**……） | 一个**原件**（`kind='file'`），字节原样落盘 | 原件本身 |

**文件不需要配一份同名备注。**
以前上传一个 zip 会凭空多出一篇同名的 Markdown 备注——那份备注没人写，
只是系统硬凑出来的，于是「上传了但打不开、打开了是空的」成了常态。
现在文件就是文件：点开一个 zip，看到的是这个 zip 本身，
不配备注，也没有一个同名同格式的空编辑器在等着。

原件按格式分档预览：

| 格式 | 预览方式 |
| --- | --- |
| 图片（png / jpg / gif / webp / svg……） | 直接内联显示 |
| PDF | 内嵌阅读器 |
| 文本（txt / md / json / yaml / 源码……） | 取原始字节按 UTF-8 解出来原样显示 |
| 其它（zip / docx / exe……） | 一张说清「这是什么、多大、怎么拿走」的卡片 |

内联预览走 `GET /api/docs/:id/raw`（`inline` + 私有缓存），
下载走 `GET /api/docs/:id/download`：**原样回传原始字节与原始 MIME，
文件名保留原名**。笔记的下载则导出为 `.md` 文本——加密笔记导出的是**明文**，
不是密文，也不是一个看着成功、打开却是空的 .md。

加密文档这两条路都要过权限：查看要有 `view`，下载要**显式**有 `download`。
「能看」不等于「能拿走」，详见下面的访问授权一节。

前端取字节时一律带上令牌再渲染（图片、PDF 走对象 URL），不写成
`<img src="/api/docs/:id/raw">`——浏览器发那种请求不会带 `Authorization` 头，
服务端只认得 cookie 里的访客身份，管理员打开自己加密的图片只会看到一张裂图。

**压缩包不会被解开**：上传 `a.zip` 就是把这个包原样存进来。
解包会擅自改变资料的组织方式，归档的边界该由用户自己定——
要拆开的话，在本地拆好再逐个上传。

上传、删除之后仓库的文件数会立刻跟着变，不用手动刷新页面。

## 文档存在哪：仓库目录里的文件

v2 起文档正文是**真的文件**：放在 `data/vault/<仓库 slug>/docs/` 下的 `.md`，
数据库（`data/mdhub-v2.db`）只留索引——路径、哈希、大小。
这决定了两件事：

- 把项目传到 GitHub，**只会带走代码**，带不走任何文档内容（`data/` 被 `.gitignore` 忽略）
- 想让文档进 GitHub，要先从仓库目录导出一份带 front matter 的 md 树

```bash
npm run docs:list      # 列出库里的文档：路径、正文大小
npm run docs:export    # 导出成 content/ 下的 md 文件树（含 manifest.json 记录 id 对应关系）
```

导出规则：目录结构照搬仓库目录（`content/<仓库 slug>/<文档路径>`），文件名前是 YAML
front matter（`id` / `name` / `tags` / 时间戳），正文原样保留。
加密文档导不出明文（库里只有密文），会被列在「已跳过」里——不会给你一个看着成功、
内容其实空着的文件。`content/` 默认在 `.gitignore` 里——
**提交它等于公开这些文档**，确认要上传再删掉那行。

## 自检

```bash
npm run lint     # ESLint
npm test         # 单元测试（node --test）
npm run verify   # 端到端自检
```

这三步已经接进 CI（`.github/workflows/ci.yml`）：每次推送与 PR 自动跑
类型检查 → lint → 单测 → 端到端自检。CI 里的示例库是现场生成的
（只导入 `server/db.ts` 即建库、灌示例文档、写出仓库目录），
不碰仓库里的任何真实数据——`data/` 本来就不该被提交。

`npm run verify` 会在**临时目录复制一份数据库和一份仓库目录**、用独立端口拉起一个服务端实例，
跑完 69 项检查后自动退出：服务启动、访客与管理员清单一致、错误密码 401、登录与鉴权、
Agent 配置脱敏、改密后旧令牌立即失效，文档加密全流程
（密文入库、访客拿不到正文、加密接口不再签发密码、密码相关接口均已下线、管理员免密查看），
访问授权全流程（访客取会话、无授权 403、提交申请、重复申请 409、访客读不到申请列表、
访客不能自行批准、审批前 reason=pending、批准即免密打开、授权名单可列、收回后立刻打不开），
原件与下载（上传 zip 只得到一个文件节点、不配同名 `.md` 备注、按原字节下载、
保留原文件名与原始 MIME、内联预览字节一致），
能力分级（无授权下载 403、只给「查看」时能看不能下载、在线 `PATCH` 加上 `download` 后才拿得到、
访问审计留下 `adjust` 与 `download` 记录、访客读不到审计），
以及仓库与上传（压缩包按原件存为附件、不拆成多篇文档、仓库文件数随增删同步、解包接口已下线）。

它不碰正在运行的实例，也不修改生产库与生产仓库目录——库和目录都只在副本上操作，
改密码那一步同样只在副本上执行。

> 前置条件：先跑过一次 `npm run server` 建好 `data/mdhub-v2.db` 与 `data/vault/`
> （示例文档需 `MDHUB_SEED_DEMO=1`），脚本会复制这两份做隔离验证；
> 没有库时它会直接告诉你缺什么，而不是抛一堆无关错误。

## 常用接口

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 公开（密码登录；连续失败会触发递增退避，超限返回 429） |
| `POST` | `/api/auth/change-password` | 管理员（需校验当前密码，改密后旧令牌全部失效） |
| `GET` | `/api/docs` | 所有人（访客与管理员拿到同一份清单） |
| `POST` `PATCH` `DELETE` | `/api/docs/:id` | 管理员 |
| `POST` | `/api/docs/upload` | 管理员（上传原件：请求体是文件字节，文件名与 MIME 走 query；只得到一个文件节点，不配同名备注） |
| `GET` | `/api/docs/:id/download` | 所有人（原件按原字节 + 原 MIME + 原文件名回传；笔记导出为 `.md`；加密文档需授权且须含 `download` 能力） |
| `GET` | `/api/docs/:id/raw` | 所有人（内联预览原件，`inline` + 私有缓存；加密文档需授权且须含 `view` 能力） |
| `POST` | `/api/docs/:id/encrypt` | 管理员（首次加密，不签发任何密码） |
| `POST` | `/api/docs/:id/decrypt` | 管理员（取消加密，明文写回） |
| `GET` `POST` | `/api/auth/guest` | 所有人（访客会话：取回 / 修改昵称，凭证在 httpOnly cookie 里） |
| `POST` | `/api/docs/:id/access-request` | 所有人（申请访问加密文档，重复申请 409） |
| `POST` | `/api/docs/:id/access-open` | 所有人（凭已批准授权免密打开；无授权 403 并附 reason） |
| `GET` | `/api/docs/:id/access-status` | 所有人（访客此刻的权限状态与能力，不含正文；界面据此收敛下载按钮） |
| `GET` | `/api/access-requests` | 管理员（待审批 / 已批 / 已拒；可按 docId 过滤） |
| `POST` | `/api/access-requests/:rid/approve` | 管理员（批准即授权，expiresInDays 为 0 表示长期；capabilities 默认只有 `view`） |
| `POST` | `/api/access-requests/:rid/reject` | 管理员（拒绝申请） |
| `POST` | `/api/access-requests/bulk-approve` | 管理员（一次批多条，共用有效期与能力） |
| `GET` | `/api/access-grants` | 管理员（全部授权总览） |
| `GET` | `/api/docs/:id/access-grants` | 管理员（某篇文档的授权名单，含每条的能力） |
| `PATCH` | `/api/docs/:id/access-grants/:gid` | 管理员（在线调整授权能力与有效期，并留一条 `adjust` 审计） |
| `DELETE` | `/api/docs/:id/access-grants/:gid` | 管理员（收回授权，即刻生效） |
| `GET` | `/api/access-audit` | 管理员（访问审计流水；可按 docId 过滤） |
| `GET` `PUT` | `/api/agent/config` | 管理员（Key 不回显） |
| `GET` | `/api/agent/status` | 所有人 |
| `POST` | `/api/agent/ask` | 按 `allowGuest` 判定 |
| `GET` `PUT` | `/api/dingtalk/config` | 管理员（密钥不回显） |
| `POST` | `/api/dingtalk/test` | 管理员（按草稿配置发一条测试消息） |
| `GET` `POST` | `/api/reminders` | 管理员（提醒清单 / 新建提醒） |
| `PATCH` `DELETE` | `/api/reminders/:id` | 管理员（改时间、标记完成、取消、删除） |
| `POST` | `/api/reminders/:id/fire` | 管理员（立即推送，与自动触发同一套逻辑） |

### 运维接口（机器令牌）

这一组不认用户会话，只认 `x-workhub-token` 请求头里的机器令牌——给没有浏览器的场景用
（托盘 remote 模式、监控脚本）。令牌在服务器上用 `npm run manage:token -- issue "<用途>"` 发放。

| 接口 | 说明 |
| --- | --- |
| `GET` | `/api/manage/status` | 状态快照：版本、运行时长、内存、数据库、各类条数、托管方式 |
| `GET` | `/api/manage/logs?tail=N` | 最近 N 行日志（默认 200，内存里最多留 500 行） |
| `POST` | `/api/manage/restart` | 重启服务（按托管方式选择 systemd / pm2 / docker / 自拉起） |
| `POST` | `/api/manage/shutdown` | 停掉当前进程（不拉新的）。被托盘托管时拒绝——托盘会把它拉回来 |

## License

[MIT](LICENSE) © PAY7UN
