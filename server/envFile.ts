/**
 * .env 的兜底读取与修复。
 *
 * 为什么需要它：Node 自带的 `--env-file` 解析器**不认 UTF-8 BOM**。
 * 而 Windows 上用记事本、PowerShell 5.1（`Set-Content -Encoding UTF8`）
 * 保存出来的 .env 恰恰都带 BOM。实测带 BOM 时，文件里的**第一个变量会被静默丢掉**：
 *
 *   \uFEFFWORKHUB_SECRET=xxx   →  读不到 WORKHUB_SECRET（后面的变量都正常）
 *   WORKHUB_PORT=8787          →  读得到
 *
 * 后果按部署形态分两种，但都很隐蔽：
 * - 打包态（托盘拉起，NODE_ENV=production）：WORKHUB_SECRET 被丢掉，
 *   服务端判定「生产环境未配置密钥」直接拒绝启动。密钥明明就在文件里，
 *   报错指向的却是「你没配密钥」——按提示去改配置也改不明白。
 * - 端口写在第一行时：服务端退回默认端口 8787，托盘按 .env 里的另一个端口去找，
 *   两边指向不同的端口，表现是「菜单说停了，服务明明在跑」。
 *
 * 所以这里做两件事：
 * 1. 按 Node 的规则把 .env 重新解析一遍（去掉 BOM），把 process.env 里缺的变量补上；
 * 2. 顺手把文件里的 BOM 去掉并回写（写不了就算了，只是不能再害下一次启动）。
 *
 * 补齐只针对「压根没设过」的变量：进程环境里已有的值优先级更高，
 * 这跟 Node 的行为一致（--env-file 不覆盖已存在的环境变量）。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_ROOT } from './paths.ts';

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
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * 解析 .env 文本。
 *
 * 返回的键原样保留（WORKHUB_SECRET / MDHUB_SECRET 都认），
 * 前缀的取舍交给 server/env.ts —— 那一层才决定「新名优先、旧名兜底」。
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stripBom(text).split(/\r?\n/)) {
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
 * 找 .env。
 *
 * 优先级：
 * 1. **命令行里 --env-file 指的那个**——那就是 Node 实际加载的文件，
 *    兜底要跟它对着干才对得上。Node 会把 --env-file 留在 process.execArgv 里
 *    （它从 process.argv 里拿掉了，但 execArgv 还留着）。
 * 2. 工作目录下的 .env：托盘把 cwd 设成工作目录（.env 与数据并排），
 *    服务宿主把 cwd 设成代码目录，开发态在仓库根——三种部署形态都对得上。
 * 3. 代码目录下的 .env：兜底。
 */
export function findEnvFile(cwd: string = process.cwd()): string | null {
  const seen = new Set<string>();
  const fromArgs = envFileFromExecArgv();
  if (fromArgs && existsSync(fromArgs)) return fromArgs;
  for (const dir of [cwd, APP_ROOT]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const file = join(dir, '.env');
    if (existsSync(file)) return file;
  }
  return null;
}

/** 从命令行参数里找 --env-file / --env-file-if-exists 指的文件 */
export function envFileFromExecArgv(execArgv: string[] = process.execArgv): string | null {
  for (const arg of execArgv) {
    const match = /^--env-file(?:-if-exists)?=(.*)$/.exec(arg);
    if (!match || !match[1]) continue;
    return resolve(match[1]);
  }
  return null;
}

export interface EnvFileRepair {
  /** .env 的路径（没找到就是 null） */
  file: string | null;
  /** 补进 process.env 的变量名 */
  applied: string[];
  /** 文件里的 BOM 是否被去掉了 */
  bomFixed: boolean;
  /** 去掉 BOM 前的备份路径（没备份就是 null） */
  backup: string | null;
}

/**
 * 兜底：把 .env 里的变量补进 process.env，并顺手修掉 BOM。
 *
 * 什么时候调：越早越好——端口、数据库路径、密钥都在模块加载期读，
 * 晚了就晚了（config.ts 在模块加载期就要用密钥）。
 */
export function applyEnvFileFallback(file: string | null = findEnvFile()): EnvFileRepair {
  const result: EnvFileRepair = { file, applied: [], bomFixed: false, backup: null };
  if (!file) return result;

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return result;
  }

  for (const [key, value] of Object.entries(parseEnvFile(raw))) {
    // 已经设过的（哪怕是空串）不覆盖：进程环境的优先级高于 .env，
    // 这与 Node 的 --env-file 一致。
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    result.applied.push(key);
  }

  if (raw.startsWith(BOM)) {
    const backup = `${file}.bak`;
    try {
      // 先备份再改：改的是使用者的配置，改坏了没有退路
      if (!existsSync(backup)) copyFileSync(file, backup);
      writeFileSync(file, stripBom(raw), 'utf8');
      result.bomFixed = true;
      result.backup = backup;
    } catch {
      // 写不了也不影响启动：变量已经补进进程内存了，
      // 下次启动还会再补一次。
    }
  }

  return result;
}
