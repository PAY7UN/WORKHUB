'use strict';
/**
 * 工作目录与它派生出来的位置。
 *
 * 单独拆一个模块出来，是为了能测。托盘主进程要 electron 才能跑，
 * 而「换了工作目录，.env 和日志是不是跟着换」恰恰是最容易出错、
 * 又最不容易在真机上发现的地方——配错了不会报错，
 * 只是数据库在新目录、密钥还在旧目录，两边分家。
 */
const path = require('node:path');

/**
 * 由工作目录派生出所有跟着它走的位置。
 *
 * @param {string} dataDir 工作目录（.env / 数据库 / vault / 日志都放这儿）
 * @returns {{ dataDir: string, envFile: string, logsDir: string }}
 */
function dataPaths(dataDir) {
  return {
    dataDir,
    envFile: path.join(dataDir, '.env'),
    logsDir: path.join(dataDir, 'logs'),
  };
}

/** 数据库与 vault 在工作目录下的位置（与服务端 server/paths.ts 的默认布局一致） */
function dataFiles(dataDir) {
  return {
    dbPath: path.join(dataDir, 'data', 'workhub-v2.db'),
    vaultDir: path.join(dataDir, 'data', 'vault'),
  };
}

/** 服务端认的数据库相关变量名（新旧名都算） */
const DB_ENV_NAMES = ['WORKHUB_DB_V2', 'MDHUB_DB_V2', 'WORKHUB_DB', 'MDHUB_DB'];
/** 服务端认的 vault 相关变量名 */
const VAULT_ENV_NAMES = ['WORKHUB_VAULT_DIR', 'MDHUB_VAULT_DIR'];

/**
 * 子进程要拿到的、跟工作目录有关的环境变量。
 *
 * 服务端默认按**代码目录**定位数据库与 vault（见 server/paths.ts）。
 * 托盘的工作目录一旦跟代码目录不是同一个（打包态、便携部署、
 * 开发态指定 appDir），就必须把这两个路径掰过去——否则库会落回代码目录：
 *
 * - 打包态：代码在安装目录（只读），普通用户写不进去，服务一起来就报错；
 * - 开发态指定 appDir：.env 与日志搬走了，库还留在仓库里——
 *   半生效，跟上一轮修的 .env/logs 是同一类毛病：看起来正常，
 *   实际是两份配置拼起来的部署，换台机器就露馅。
 *
 * 打包态一律由托盘说了算（托盘管的是一整套自洽的部署）；
 * 开发态里开发者显式设过的变量优先，不抢。
 *
 * @param {{ codeDir: string, dataDir: string, packaged: boolean }} paths 运行路径
 * @param {Record<string, string | undefined>} env 进程环境变量
 * @returns {Record<string, string>}
 */
function dataEnvOverrides(paths, env = {}) {
  const out = {};
  if (paths.packaged) out.NODE_ENV = 'production';
  const { dbPath, vaultDir } = dataFiles(paths.dataDir);
  const hasDb = DB_ENV_NAMES.some((name) => (env[name] ?? '').trim() !== '');
  const hasVault = VAULT_ENV_NAMES.some((name) => (env[name] ?? '').trim() !== '');
  if (paths.packaged || !hasDb) out.WORKHUB_DB_V2 = dbPath;
  if (paths.packaged || !hasVault) out.WORKHUB_VAULT_DIR = vaultDir;
  return out;
}

/**
 * 打包态的运行期日志目录要告诉服务端。
 *
 * 服务端的升级日志、升级结果摘要落在「运行期日志目录」里（server/paths.ts 的
 * resolveLogDir）。默认是代码目录下的 logs/，但打包态那是在安装目录里，
 * 普通用户写不进去——升级日志写不出来，升级结果也存不下来。
 * 托盘知道哪个目录可写（工作目录下的 logs），所以由它告诉服务端。
 */
function logDirEnv(paths) {
  return { WORKHUB_LOG_DIR: paths.logsDir };
}

module.exports = { dataPaths, dataFiles, dataEnvOverrides, logDirEnv };
