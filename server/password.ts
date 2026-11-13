/**
 * 登录密码的哈希与校验（基于 node:crypto scrypt，无第三方依赖）。
 *
 * 为什么不用明文：数据库文件一旦泄露（备份、误传、误提交到版本库）
 * 密码即刻暴露。明文存储也让「改密码」这个功能天然危险——
 * 新密码同样会明文落库，等于把问题固化。
 *
 * 库里只有密码哈希这一份副本，没有明文列，也没有「存量明文」的兼容分支：
 * 一份凭据只留一份副本，任何一处泄露都足以登录。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AdminPasswordState } from '../shared/types.ts';

/**
 * 规则与校验函数来自 shared，让服务端与前端表单共用同一份定义，
 * 避免出现「前端放行、后端拒绝」的错位。此处只负责哈希与比对。
 */
export {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
} from '../shared/passwordPolicy.ts';

/**
 * scrypt 参数。N=16384、r=8、p=1 是 RFC 7914 的建议下限，
 * 单次派生约 16MB 内存、几十毫秒——对登录这种低频操作足够，
 * 又不至于让攻击者离线爆破时每猜一次都付出可忽略的成本。
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

/** 存储格式：scrypt$<salt_hex>$<hash_hex>。带算法名是为了将来换算法时能识别旧值 */
const ALGO = 'scrypt';

/** 随机盐长度：16 字节，128 位熵 */
const SALT_BYTES = 16;

/** 生成带盐的哈希，可直接存库 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `${ALGO}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * 校验密码。
 *
 * @param stored 库里的密码哈希，形如 scrypt$<salt>$<hash>
 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== ALGO) return false;
  const [, saltHex, hashHex] = parts;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT.keylen) return false;
  const derived = scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * 取哈希的一个短指纹，供 JWT 携带以实现「改密码后旧令牌立即失效」。
 *
 * 只取前 16 个十六进制字符（64 位）：它只需要能区分「改密前 / 改密后」，
 * 不需要承载安全性——真正的安全性来自密码本身与令牌签名。
 */
export function passwordFingerprint(storedHash: string): string {
  return storedHash ? storedHash.slice(ALGO.length + 1, ALGO.length + 1 + 16) : '';
}

/**
 * 判定管理员密码属于哪一种状态（纯函数，不碰数据库）。
 *
 * 'admin' 是所有部署的起点（config.ts 的 DEFAULT_ADMIN_PASSWORD）；
 * configuredInitial 是部署方在 .env 里写下的那个值。
 * 两者都算「初始值」——都意味着这个密码不是使用者自己挑的。
 *
 * 单独拆成纯函数是为了能独立测试：提醒用户改密码这件事，
 * 判错的代价是「该提醒时没提醒」（密码就这么一直开着）。
 */
export function classifyAdminPassword(
  storedHash: string,
  configuredInitial: string,
): AdminPasswordState {
  const matches = (candidate: string) => verifyPassword(candidate, storedHash);
  if (matches('admin')) return 'initial-default';
  if (configuredInitial !== 'admin' && matches(configuredInitial)) return 'initial-configured';
  return 'custom';
}
