/**
 * 环境变量读取：单测锁住「新名优先、旧名兜底」这条规则。
 *
 * 这条规则是这次改名的全部安全网。变量名从 MDHUB_ 换成 WORKHUB_ 是
 * 对的方向（产品名早就是 WorkHub 了），但这些变量不是随手配的开关，
 * 而是运行时契约：
 *
 * - SECRET：改名会让已加密的文档永久无法解密（主密钥由它派生）。
 * - DB_V2 / VAULT_DIR：改名会让既有部署找不到库、找不到正文。
 * - PORT：改名会让托盘与服务端指向不同的端口。
 *
 * 所以旧名必须继续能用，而且新名优先——两个都配时以新名为准，
 * 这样「照着新文档改」和「忘了改」两种情况都得到正确结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envValue, envValueFrom, envFlag, envConfigured } from './env.ts';

test('新名生效', () => {
  assert.equal(envValueFrom({ WORKHUB_SECRET: 'x' }, 'SECRET'), 'x');
});

test('旧名仍然生效', () => {
  assert.equal(envValueFrom({ MDHUB_SECRET: 'x' }, 'SECRET'), 'x');
});

test('两个都配时以新名为准', () => {
  assert.equal(envValueFrom({ WORKHUB_SECRET: 'new', MDHUB_SECRET: 'old' }, 'SECRET'), 'new');
});

test('空串按「没配」处理，空串挡不住旧名', () => {
  // 空串一路传下去会盖住默认值，是很常见的手滑
  assert.equal(envValueFrom({ WORKHUB_SECRET: '', MDHUB_SECRET: 'old' }, 'SECRET'), 'old');
  assert.equal(envValueFrom({ WORKHUB_SECRET: '   ' }, 'SECRET'), '');
});

test('首尾空白按「没配」处理', () => {
  assert.equal(envValueFrom({ WORKHUB_PORT: '  8080  ' }, 'PORT'), '8080');
  assert.equal(envValueFrom({ WORKHUB_PORT: '   ' }, 'PORT'), '');
});

test('没配时返回空串，不是 undefined', () => {
  // 返回 undefined 的话，调用方写 `value ?? fallback` 与 `value || fallback`
  // 行为不一致；返回空串则两者等价，少一类坑
  assert.equal(envValueFrom({}, 'SECRET'), '');
});

test('只认带前缀的完整名字，不认「看起来像」的', () => {
  // SECRET_PATH 这种一旦被认了，人会以为改了生效了，其实一直在用默认值
  assert.equal(envValueFrom({ SECRET: 'x', WORKHUB_SECRET_PATH: 'y' }, 'SECRET'), '');
});

test('envFlag：值为 1 才算开', () => {
  const saved = process.env.WORKHUB_SEED_DEMO;
  const savedOld = process.env.MDHUB_SEED_DEMO;
  try {
    delete process.env.WORKHUB_SEED_DEMO;
    delete process.env.MDHUB_SEED_DEMO;
    assert.equal(envFlag('SEED_DEMO'), false);

    process.env.WORKHUB_SEED_DEMO = '1';
    assert.equal(envFlag('SEED_DEMO'), true);

    // '0' 与 'true' 都不是 1 —— 这个开关只认 1，写错就会静默不生效
    process.env.WORKHUB_SEED_DEMO = '0';
    assert.equal(envFlag('SEED_DEMO'), false);
    process.env.WORKHUB_SEED_DEMO = 'true';
    assert.equal(envFlag('SEED_DEMO'), false);

    // 旧名同样认
    delete process.env.WORKHUB_SEED_DEMO;
    process.env.MDHUB_SEED_DEMO = '1';
    assert.equal(envFlag('SEED_DEMO'), true);
  } finally {
    if (saved === undefined) delete process.env.WORKHUB_SEED_DEMO;
    else process.env.WORKHUB_SEED_DEMO = saved;
    if (savedOld === undefined) delete process.env.MDHUB_SEED_DEMO;
    else process.env.MDHUB_SEED_DEMO = savedOld;
  }
});

test('envConfigured：只关心配没配，不关心值', () => {
  const saved = process.env.WORKHUB_SECRET;
  try {
    delete process.env.WORKHUB_SECRET;
    assert.equal(envConfigured('SECRET'), false);
    process.env.WORKHUB_SECRET = '   ';
    assert.equal(envConfigured('SECRET'), false);
    process.env.WORKHUB_SECRET = 'x';
    assert.equal(envConfigured('SECRET'), true);
  } finally {
    if (saved === undefined) delete process.env.WORKHUB_SECRET;
    else process.env.WORKHUB_SECRET = saved;
  }
});

test('envValue：读的是进程环境本身', () => {
  const saved = process.env.WORKHUB_SECRET;
  try {
    process.env.WORKHUB_SECRET = 'from-process';
    assert.equal(envValue('SECRET'), 'from-process');
  } finally {
    if (saved === undefined) delete process.env.WORKHUB_SECRET;
    else process.env.WORKHUB_SECRET = saved;
  }
});
