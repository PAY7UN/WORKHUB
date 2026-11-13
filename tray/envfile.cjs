'use strict';
/**
 * .env 的生命周期：生成、备份、恢复、修 BOM。
 *
 * 单独拆出来是为了能测。这一段管的是使用者的密钥和配置，
 * 出错的代价不是「服务起不来」，而是「库里的文档永久解不开」——
 * 这种事不能靠人肉回归兜底。
 *
 * 三条规矩：
 *
 * 1. **不静默换密钥。** 密钥没了、库还在的时候，绝不自动生成一把新的：
 *    新密钥解不开旧文档，而且不报错（解出来是乱码），
 *    使用者只会以为「文档坏了」。宁可不起服务，把话说明白。
 * 2. **留备份。** .env 会被误删、被杀毒软件隔离、被同步工具排除——
 *    有备份就能找回来，不用重新生成一把把库锁死。
 * 3. **修 BOM。** Node 的 --env-file 不认 UTF-8 BOM，会静默丢掉
 *    文件里的第一个变量（多半就是密钥），服务端于是判定「没配密钥」
 *    直接拒绝启动——报错指向的却是「你没配」，最难查的那一类。
 */
const fs = require('node:fs');
const path = require('node:path');

/** UTF-8 BOM */
const BOM = '\uFEFF';

/** .env 的备份路径 */
function backupPathOf(envFile) {
  return `${envFile}.bak`;
}

/**
 * 保证 .env 存在且能用。
 *
 * @param {object} options
 * @param {string} options.envFile .env 的路径
 * @param {string} options.dbPath 数据库的路径（用来判断「库还在不在」）
 * @param {number} options.port 写进 .env 的端口
 * @param {() => { secret: string }} options.makeCredentials 需要新建时调用它造密钥
 * @param {(message: string) => void} [options.log] 日志出口
 * @returns {{ error: string | null, created: boolean }}
 */
function ensureEnvFile({ envFile, dbPath, port, makeCredentials, log = () => {} }) {
  const backupFile = backupPathOf(envFile);

  if (fs.existsSync(envFile)) {
    repairBom(envFile, log);
    backupEnvFile(envFile, backupFile, log);
    return { error: null, created: false };
  }

  // .env 没了但备份还在：拿回来，别重新生成密钥。
  if (fs.existsSync(backupFile)) {
    try {
      fs.copyFileSync(backupFile, envFile);
      log(`已从备份恢复 ${envFile}`);
      return { error: null, created: false };
    } catch (err) {
      log(`从备份恢复 .env 失败：${err.message}`);
    }
  }

  // 库还在、密钥没了：不能重新生成。
  if (dbPath && fs.existsSync(dbPath)) {
    return {
      created: false,
      error:
        `${envFile} 不在了，但数据库还在（${dbPath}）。` +
        '重新生成密钥会让库里的文档全部无法解密，所以没有自动重建配置。' +
        '请把备份的 .env（.env.bak）放回该路径；确认数据可以舍弃的话，删掉数据库文件再来一次。',
    };
  }

  // 只写密钥与端口，不写密码：初始密码是公开的默认值 admin，
  // 把它写成明文既没有信息量（它本来就公开）又让 .env 看着像存了凭据。
  // 网页端在密码还是初始值时会一直提醒，改掉即消失。
  const { secret } = makeCredentials();
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      '# WorkHub 本地版配置（首次启动自动生成）',
      '# 主密钥：用于 JWT 签名与 API Key 加密，切勿泄露或分享',
      `WORKHUB_SECRET=${secret}`,
      '# 监听端口（托盘按它拼出「打开网页」的地址）',
      `WORKHUB_PORT=${port}`,
      '',
    ].join('\n'),
    'utf8',
  );
  backupEnvFile(envFile, backupFile, log);
  return { error: null, created: true };
}

/**
 * 去掉 .env 开头的 BOM。
 *
 * 先备份再改：改的是使用者的配置，改坏了没有退路。
 */
function repairBom(envFile, log = () => {}) {
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    if (!raw.startsWith(BOM)) return false;
    fs.writeFileSync(envFile, raw.slice(BOM.length), 'utf8');
    log('已去掉 .env 开头的 BOM（带着 BOM 时 Node 会丢掉 .env 里的第一个变量）');
    return true;
  } catch (err) {
    log(`去掉 .env 的 BOM 失败：${err.message}`);
    return false;
  }
}

/**
 * 给 .env 留一份备份。
 *
 * 备份只在内容变了时才更新——每次启动都写一遍没意义，
 * 还会把使用者刚改好的配置覆盖成旧的。
 */
function backupEnvFile(envFile, backupFile, log = () => {}) {
  try {
    const current = fs.readFileSync(envFile);
    try {
      if (fs.readFileSync(backupFile).equals(current)) return false;
    } catch {
      // 没有备份，写一份
    }
    fs.writeFileSync(backupFile, current);
    return true;
  } catch (err) {
    log(`备份 .env 失败：${err.message}`);
    return false;
  }
}

module.exports = { ensureEnvFile, backupPathOf, repairBom, backupEnvFile, BOM };
