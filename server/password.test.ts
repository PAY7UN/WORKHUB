/**
 * 密码哈希与共享密码规则。
 *
 * 前半部分针对 shared/passwordPolicy（前后端共用的那一份），后半部分针对
 * scrypt 哈希与比对。哈希用例故意控制在个位数：每次 scrypt 派生都要占约 16MB
 * 内存和几十毫秒，跑太多反而会让套件变慢。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateNewPassword,
} from '../shared/passwordPolicy.ts';
import {
  classifyAdminPassword,
  hashPassword,
  passwordFingerprint,
  verifyPassword,
} from './password.ts';

test('长度不足时拒绝并说明下限', () => {
  assert.match(validateNewPassword('short') ?? '', /至少/);
  assert.equal(validateNewPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1)) !== null, true);
});

test('恰好达到下限时通过', () => {
  assert.equal(validateNewPassword('x'.repeat(MIN_PASSWORD_LENGTH)), null);
});

test('超长密码被拒绝', () => {
  assert.match(validateNewPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1)) ?? '', /过长/);
});

test('恰好达到上限时通过', () => {
  assert.equal(validateNewPassword('x'.repeat(MAX_PASSWORD_LENGTH)), null);
});

test('拒绝与当前密码相同的新密码', () => {
  assert.match(validateNewPassword('samepass1', 'samepass1') ?? '', /不能与当前密码相同/);
});

test('未传 current 时不做相同性判断', () => {
  assert.equal(validateNewPassword('samepass1', undefined), null);
});

test('哈希可验证正确密码，拒绝错误密码', () => {
  const hash = hashPassword('correct-horse');
  assert.equal(verifyPassword('correct-horse', hash), true);
  assert.equal(verifyPassword('wrong-horse', hash), false);
});

test('相同密码两次哈希不同（盐随机）', () => {
  assert.notEqual(hashPassword('samepass1'), hashPassword('samepass1'));
});

test('损坏的哈希格式一律判否，不抛异常', () => {
  const bad = ['', 'scrypt', 'scrypt$', 'scrypt$aa', 'bcrypt$a$b', 'scrypt$aa$bb$cc'];
  for (const value of bad) {
    assert.equal(verifyPassword('anything', value), false, `bad=${value}`);
  }
});

test('没有哈希一律判否，不存在明文兜底', () => {
  // 库里只有哈希这一份副本。空哈希就是「这个账号没有可用密码」，
  // 而不是「拿明文去比一比」——后者等于把明文密码又变回了可用的凭据。
  assert.equal(verifyPassword('anything', ''), false);
});

test('指纹区分改密前后，且不泄露哈希主体', () => {
  const before = hashPassword('pass-aaaaa');
  const after = hashPassword('pass-bbbbb');
  assert.notEqual(passwordFingerprint(before), passwordFingerprint(after));
  assert.equal(passwordFingerprint(before).length, 16);
  assert.equal(passwordFingerprint(''), '');
});

test('密码还是默认的 admin 时判为初始值', () => {
  assert.equal(classifyAdminPassword(hashPassword('admin'), 'admin'), 'initial-default');
});

test('密码还是部署时配置的那个值时判为初始值', () => {
  assert.equal(classifyAdminPassword(hashPassword('deploy-pwd'), 'deploy-pwd'), 'initial-configured');
});

test('配置值本身就是 admin 时按默认算，不重复报一次', () => {
  assert.equal(classifyAdminPassword(hashPassword('admin'), 'admin'), 'initial-default');
});

test('密码被改过之后判为 custom（不再提醒）', () => {
  assert.equal(classifyAdminPassword(hashPassword('brand-new-pwd'), 'admin'), 'custom');
  assert.equal(classifyAdminPassword(hashPassword('brand-new-pwd'), 'deploy-pwd'), 'custom');
});

test('没有密码记录时判为 custom，不误报', () => {
  assert.equal(classifyAdminPassword('', 'admin'), 'custom');
});
