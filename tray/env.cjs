'use strict';
/**
 * 环境变量读取：统一前缀与兼容策略。
 *
 * 跟 server/env.ts 是同一套规则，托盘是 CommonJS，引不了 TS 模块，
 * 所以这里另写一份。两边必须一致——同一个变量，托盘和服务端读出
 * 不同的值，症状是「托盘连的是 A，服务端跑在 B」，最难查的那种。
 *
 * 环境变量的前缀已从 MDHUB_ 统一成 WORKHUB_（跟产品名对齐）。
 * 旧名仍然认：新名优先，旧名兜底。理由见 server/env.ts——
 * `SECRET` 改名会让已加密的文档永久无法解密，`PORT` 改名会让托盘
 * 与服务端指向不同的端口，这类故障不能靠「使用者记得改」来避免。
 */

/** 前缀：新名在前。旧名是过渡期的兜底，不是推荐的写法。 */
const PREFIXES = ['WORKHUB_', 'MDHUB_'];

/**
 * 读一个环境变量，按后缀取。
 *
 * `envValue(env, 'PORT')` 依次看 `WORKHUB_PORT`、`MDHUB_PORT`，
 * 取第一个有值的；都没有就返回空串。
 *
 * @param {Record<string, string | undefined>} env 环境变量集合
 * @param {string} suffix 变量名后缀（不含前缀）
 * @returns {string}
 */
function envValue(env, suffix) {
  for (const prefix of PREFIXES) {
    const value = (env[prefix + suffix] ?? '').trim();
    if (value) return value;
  }
  return '';
}

module.exports = { envValue };
