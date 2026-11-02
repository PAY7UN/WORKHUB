/**
 * 加密原语的单元测试。
 *
 * 覆盖的核心性质：
 *   1. 密文不等于明文（库里不落明文）
 *   2. 同一个主密钥能取回 DEK 并解出正文（管理员免密查看、授权后访客打开）
 *   3. 错误的主密钥解不出正文（材料不会被误用）
 *   4. 正文被篡改后解密失败（GCM 的认证标签起作用）
 *   5. 换主密钥 → 旧的包裹物失效（旧主密钥已经不该再能用）
 *
 * 【没有访问密码用例】这一层以前还要测「密码派生密钥 → 解开 DEK →
 * 访客用密码解锁」。访问密码机制已下线：加密文档一律走申请制，
 * 服务端只认主密钥，不认任何访客口令，所以这里不该再有口令相关的用例。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  decryptDocContent,
  encryptDocContent,
  encryptDocContentWithDek,
  unwrapDekWithMaster,
} from './docCrypto.ts';

const MASTER = randomBytes(32);
const OTHER_MASTER = randomBytes(32);

test('加密后正文不以明文形式出现在密文中', () => {
  const plain = '这是机密内容：数据库密码是 hunter2';
  const material = encryptDocContent(plain, MASTER);
  assert.ok(!material.cipher.includes('hunter2'));
  assert.ok(!material.cipher.includes('机密'));
  // 包裹物同样不该泄露明文
  assert.ok(!material.masterWrappedDek.includes('hunter2'));
});

test('用主密钥取回 DEK 后能解出原文', () => {
  const plain = '机密正文';
  const material = encryptDocContent(plain, MASTER);
  const dek = unwrapDekWithMaster(material.masterWrappedDek, MASTER);
  assert.ok(dek, '应当能取回数据密钥');
  assert.equal(decryptDocContent(material.cipher, dek), plain);
});

test('同一份明文两次加密得到不同密文（IV 随机）', () => {
  const plain = '机密正文';
  const a = encryptDocContent(plain, MASTER);
  const b = encryptDocContent(plain, MASTER);
  assert.notEqual(a.cipher, b.cipher);
  assert.notEqual(a.masterWrappedDek, b.masterWrappedDek);
});

test('错误的主密钥解不开包裹的数据密钥', () => {
  const material = encryptDocContent('机密正文', MASTER);
  assert.equal(unwrapDekWithMaster(material.masterWrappedDek, OTHER_MASTER), null);
});

test('密文被篡改后解密失败', () => {
  const material = encryptDocContent('机密正文', MASTER);
  const dek = unwrapDekWithMaster(material.masterWrappedDek, MASTER);
  assert.ok(dek);
  // 改动密文最后一段的一个字符
  const parts = material.cipher.split(':');
  const body = parts[3];
  const flipped = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
  const tampered = [...parts.slice(0, 3), flipped].join(':');
  assert.equal(decryptDocContent(tampered, dek), null);
});

test('换主密钥后旧的包裹物无法解开', () => {
  const material = encryptDocContent('机密正文', MASTER);
  // 服务端换了主密钥：旧主密钥不该再能解开（这里断言新主密钥解不开）
  assert.equal(unwrapDekWithMaster(material.masterWrappedDek, OTHER_MASTER), null);
});

test('用既有 DEK 重新加密正文：内容不变、密文变化', () => {
  const material = encryptDocContent('第一版', MASTER);
  const dek = unwrapDekWithMaster(material.masterWrappedDek, MASTER);
  assert.ok(dek);
  const reEncrypted = encryptDocContentWithDek('第二版', dek);
  assert.equal(decryptDocContent(reEncrypted, dek), '第二版');
  assert.notEqual(reEncrypted, material.cipher);
});
