'use strict';
/**
 * 环境变量与 .env 文件的读取：统一前缀。
 *
 * 跟 server/env.ts 是同一套规则，托盘是 CommonJS，引不了 TS 模块，
 * 所以这里另写一份。两边必须一致——同一个变量，托盘和服务端读出
 * 不同的值，症状是「托盘连的是 A，服务端跑在 B」，最难查的那种。
 *
 * 环境变量的前缀统一成 WORKHUB_（跟产品名对齐），旧名不再认。
 *
 * .env 文件的解析规则同样要对齐 Node 的 `--env-file`（服务端就是靠它读配置的）：
 * 规则见 server/envFile.ts，两边必须一起改。
 */

/** 前缀 */
const PREFIX = 'WORKHUB_';

/**
 * 读一个环境变量，按后缀取。
 *
 * `envValue(env, 'PORT')` 读的就是 `WORKHUB_PORT`，没配则返回空串。
 *
 * @param {Record<string, string | undefined>} env 环境变量集合
 * @param {string} suffix 变量名后缀（不含前缀）
 * @returns {string}
 */
function envValue(env, suffix) {
  return (env[PREFIX + suffix] ?? '').trim();
}

/** UTF-8 BOM */
const BOM = '\uFEFF';

/**
 * 一行 `KEY=value`。
 *
 * 规则与 Node 的 --env-file 对齐（实测过）：
 * - 值可以用单引号或双引号包起来，包起来时 # 是值的一部分；
 * - 没包起来时，行尾 # 之后是注释（# 前面有没有空格都算注释）；
 * - 同一个键写多次，后写的赢。
 */
const LINE_RE = /^\s*([\w.-]+)\s*=\s*((?:'[^']*'|"[^"]*"|[^#\r\n]*))\s*(?:#.*)?$/;

/** 去掉 UTF-8 BOM */
function stripBom(text) {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * 解析 .env 文本。
 *
 * 键原样保留，前缀的取舍交给 envValue —— 那一层只认 WORKHUB_。
 *
 * @param {string} text .env 文件内容
 * @returns {Record<string, string>}
 */
function parseEnvFile(text) {
  const out = {};
  for (const line of stripBom(String(text ?? '')).split(/\r?\n/)) {
    const match = LINE_RE.exec(line);
    if (!match) continue;
    let value = (match[2] ?? '').trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    out[match[1]] = value;
  }
  return out;
}

/**
 * 合并进程环境与 .env 文件，算出服务端实际会用的端口。
 *
 * 合并规则必须跟 Node 的 `--env-file` 一模一样，否则托盘和服务端会指向不同的端口：
 * 1. 先看进程环境（.env 不覆盖已经设过的变量）；
 * 2. 再用 .env 里**没被进程环境覆盖过**的键补齐；
 * 3. 取端口 `WORKHUB_PORT`，没有则用兜底值。
 *
 * 为什么不能简单地「进程环境优先于 .env 文件」：
 * 那是按**变量名**覆盖的，不是按后缀。.env 里写 `WORKHUB_PORT=9000`、
 * 系统环境里留着别的键时，托盘若按后缀一刀切就会取错值——
 * 两边指向不同的端口，表现是「菜单说停了，服务明明在跑」。
 *
 * @param {Record<string, string | undefined>} env 进程环境变量
 * @param {string} envFileText .env 文件内容（读不到就传空串）
 * @param {number} fallback 都没有时的兜底端口
 * @returns {number}
 */
function resolvePort(env, envFileText, fallback) {
  const merged = { ...env };
  for (const [key, value] of Object.entries(parseEnvFile(envFileText))) {
    if (merged[key] !== undefined) continue;
    merged[key] = value;
  }
  const raw = envValue(merged, 'PORT');
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return fallback;
}

module.exports = { envValue, stripBom, parseEnvFile, resolvePort };
