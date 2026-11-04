/**
 * 全站默认值的单一真源。
 *
 * 为什么单独放一个文件：端口这种值散在多处时，改一次要动一串地方，
 * 漏掉哪一处都不会报错——服务照跑，只是监听的端口和文档里说的不一样，
 * 用户照着文档访问却连不上，排查起来极其费劲。
 *
 * 现在 TS / JS 侧的服务端与前端构建配置都从这里取。
 * 还有几处镜像改不了，各自留了注释指回这里——改端口时把它们一起改：
 *   - scripts/upgrade-apply.mjs      升级器只依赖 Node 内置模块。它必须独立于被替换的代码：
 *                                     万一新代码坏了，更新器也得还能跑，否则没人能救场
 *   - tray/main.cjs                 托盘应用目录里没有 shared/（shared/ 在 payload 里，路径不通）
 *   - scripts/install-service.ps1    PowerShell 不执行 TS
 *   - scripts/service/WorkHubService.cs  .NET Framework 4 没有 JSON 解析器
 */

/** 服务端 API 端口。对应环境变量 WORKHUB_PORT */
export const DEFAULT_API_PORT = 8787;

/** 前端开发服务器端口。对应环境变量 WORKHUB_WEB_PORT */
export const DEFAULT_WEB_PORT = 8080;
