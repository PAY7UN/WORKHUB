/**
 * 本地自动生成的密钥：生成一次，落盘保存，之后每次启动都用同一把。
 *
 * 为什么以前不用落盘、而是写死一把：那一把是公开常量，谁拿到发布包都能
 * 自签管理员令牌、直接解密库里的模型密钥。
 * 现在改成真随机，但**必须存下来**——MASTER_KEY = sha256(WORKHUB_SECRET)，
 * 库里所有 API Key 与加密文档的数据密钥都由它包裹，密钥一变旧密文永久解不开，
 * 表现是「模型配置莫名其妙全空了」，比密码错更难查。
 *
 * 为什么存在它所保护的库旁边：库搬走了，密钥跟着搬。
 * 放在固定的代码目录里，升级换目录时反而会跟库走散——
 * 那时旧密文解不开，而现场只剩一个「密钥不对」的报错。
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnvFile } from './envFile.ts';
import { resolveDbPath } from './paths.ts';

/** 密钥最小长度：低于此值视为弱密钥（与配置校验的口径一致） */
export const MIN_SECRET_LENGTH = 32;

/** 密钥文件名：与数据库同目录，一个数据目录里只有这一把钥匙 */
export const LOCAL_SECRET_FILENAME = '.workhub-local-secret';

export type LocalSecretResult =
  /** 取到了：created 为 true 表示是这次新生成的 */
  | { ok: true; secret: string; created: boolean; path: string }
  /** 取不到：reason 说清为什么，交给调用方决定是中止还是换条路 */
  | { ok: false; path: string; reason: string };

/** 密钥文件的位置：数据库所在目录 */
export function localSecretPath(dbPath: string = resolveDbPath()): string {
  return join(dirname(dbPath), LOCAL_SECRET_FILENAME);
}

/** 从密钥文件里取出密钥；取不出（文件空、格式不对、太短）就是 null */
function readSecretFile(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const value = (parseEnvFile(raw)['WORKHUB_SECRET'] ?? '').trim();
  return value.length >= MIN_SECRET_LENGTH ? value : null;
}

/** 写入密钥文件：带两行注释，让人一眼看出这是什么、删了会怎样 */
function writeSecretFile(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      '# WorkHub 本地自动生成的密钥（仅限本机开发）',
      '# 它是 JWT 签名与 API Key 加密主密钥的种子。删掉它，库里的密文将永久无法解密。',
      `WORKHUB_SECRET=${secret}`,
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上权限由 ACL 管，chmod 失败不影响可用
  }
}

/**
 * 取本地密钥：有就复用，没有就生成一把并落盘。
 *
 * 有一处刻意「不自动修复」：密钥文件在、但内容读不出来，而数据库也已经在，
 * 此时**绝不**悄悄换一把新的——旧密文会永久失效，使用者只会以为「文档坏了」。
 * 这种情况下把话说明白（返回 ok:false），让人来决定配密钥还是确认数据可弃。
 *
 * @param dbPath 数据库路径：密钥落在它旁边
 */
export function loadOrCreateLocalSecret(dbPath: string = resolveDbPath()): LocalSecretResult {
  const path = localSecretPath(dbPath);

  if (existsSync(path)) {
    const existing = readSecretFile(path);
    if (existing) return { ok: true, secret: existing, created: false, path };
    if (existsSync(dbPath)) {
      return {
        ok: false,
        path,
        reason: '密钥文件存在，但里面没有可识别的 WORKHUB_SECRET',
      };
    }
    // 库还没建（没有东西需要这把密钥保护）：重新生成一把是安全的
  }

  const secret = randomBytes(32).toString('hex');
  try {
    writeSecretFile(path, secret);
  } catch (err) {
    return {
      ok: false,
      path,
      reason: `密钥文件写不下去：${(err as Error).message}`,
    };
  }
  return { ok: true, secret, created: true, path };
}
