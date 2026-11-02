/**
 * 文档加密原语（信封加密，信封密码学 envelope encryption）。
 *
 * 为什么是信封而不是「直接用主密钥加密正文」：
 * 主密钥同时承担 JWT 签名、API Key 加密等职责。拿它直接加密正文，
 * 一旦主密钥轮换，所有历史文档的密文就一起报废；而且主密钥的用途会被
 * 摊得稀碎，任何一处泄露波及全部。
 *
 * 信封的做法是两段式：
 *   DEK（数据密钥，随机 32 字节）  ← 真正加密正文
 *   └─ 被「服务端主密钥」包裹        ← 换密钥时用它取回 DEK
 *
 * 于是三种能力同时成立：
 *   1. 正文在库里是密文，拖库拿到库文件也看不到内容；
 *   2. 管理员凭主密钥取回 DEK，随时能解开正文（见 /api/docs/:id/reveal）；
 *   3. 任何检索/问答链路都不持有 DEK → 密文对模型永远是密文。
 *
 * 【访问密码已下线】这里曾经还有一段「访问密码派生的密钥（KEK）」：
 * 访客输密码 → 派生 KEK → 解开被 KEK 包裹的 DEK。密码连同它的哈希、
 * 连同被主密钥封存的密码明文，都要在服务端落一份。
 *
 * 现在加密文档一律走申请制（申请 → 审批 → 授权 → 免密打开），
 * 服务端不再持有、也不再派生任何与访客口令相关的材料：
 * 只有主密钥能解开 DEK。少存一份密码材料，就没有「密码库被拖库」这条风险。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
/** GCM 建议 12 字节随机 IV */
const IV_BYTES = 12;
/** AES-256 的密钥长度 */
const KEY_BYTES = 32;

/** 密文/包裹物的统一格式：v1:<iv>:<tag>:<data>，各段 base64 */
const FORMAT_VERSION = 'v1';

export interface EncryptedDocMaterial {
  /** 正文密文 */
  cipher: string;
  /** 被主密钥包裹的 DEK；只有主密钥能解开它 */
  masterWrappedDek: string;
}

/** 用给定密钥加密，输出 v1:iv:tag:data */
function seal(key: Buffer, plain: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

/**
 * 用给定密钥解密。
 *
 * 失败一律返回 null——包括「密钥不对」与「密文被改过」两种情况：
 * GCM 的认证标签会把它们都变成解密失败，调用方无法也不需要区分。
 */
function open(key: Buffer, payload: string): Buffer | null {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const data = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * 加密正文并生成全部密钥材料。
 *
 * @param plain    文档明文
 * @param masterKey 服务端主密钥，只用于包裹 DEK
 */
export function encryptDocContent(plain: string, masterKey: Buffer): EncryptedDocMaterial {
  const dek = randomBytes(KEY_BYTES);
  return {
    cipher: seal(dek, Buffer.from(plain, 'utf8')),
    masterWrappedDek: seal(masterKey, dek),
  };
}

/** 用主密钥解开 DEK：管理员查看正文、或取消加密时使用 */
export function unwrapDekWithMaster(masterWrappedDek: string, masterKey: Buffer): Buffer | null {
  return open(masterKey, masterWrappedDek);
}

/** 用 DEK 解开正文；返回 null 表示密文损坏或 DEK 不对 */
export function decryptDocContent(cipher: string, dek: Buffer): string | null {
  const plain = open(dek, cipher);
  return plain === null ? null : plain.toString('utf8');
}

/**
 * 用既有 DEK 重新加密正文。
 *
 * 编辑加密文档时用：数据密钥不变，只换正文密文。
 */
export function encryptDocContentWithDek(plain: string, dek: Buffer): string {
  return seal(dek, Buffer.from(plain, 'utf8'));
}

/**
 * 加密二进制内容（原件的字节）并生成全部密钥材料。
 *
 * 原件同样要能加密：一个 zip 被标成「加密」却仍然以明文躺在磁盘上，
 * 那只是给用户一个「它加密了」的错觉。所以这里走的是与正文同一套信封，
 * 只是被加密的载荷从 UTF-8 文本换成任意字节。
 */
export function encryptBytes(data: Buffer, masterKey: Buffer): EncryptedDocMaterial {
  const dek = randomBytes(KEY_BYTES);
  return {
    cipher: seal(dek, data),
    masterWrappedDek: seal(masterKey, dek),
  };
}

/** 用 DEK 解开二进制内容；返回 null 表示密文损坏或 DEK 不对 */
export function decryptBytes(cipher: string, dek: Buffer): Buffer | null {
  return open(dek, cipher);
}
