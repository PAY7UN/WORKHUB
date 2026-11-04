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

module.exports = { dataPaths };
