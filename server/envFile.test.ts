/**
 * .env 兜底读取的回归测试。
 *
 * 盯的是一个真会发生的故障：Windows 上用记事本、PowerShell 5.1
 * 保存出来的 .env 带 UTF-8 BOM，而 Node 的 --env-file **不认 BOM**，
 * 会静默丢掉文件里的第一个变量——通常是 WORKHUB_SECRET。
 *
 * 后果：打包态下服务端判定「生产环境未配置密钥」，直接拒绝启动。
 * 而密钥明明就在文件里，按报错去改配置也改不明白——最难查的那一类。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile, stripBom, applyEnvFileFallback } from './envFile.ts';

test('解析规则与 Node 的 --env-file 对齐', () => {
  const parsed = parseEnvFile(
    [
      '# 注释',
      'WORKHUB_SECRET=abc123',
      'WORKHUB_PORT="9000" # 行尾注释',
      "WORKHUB_ADMIN_PASSWORD='p#ss'",
      'WORKHUB_EMPTY=',
      'WORKHUB_PORT=9001',
    ].join('\n'),
  );
  assert.equal(parsed.WORKHUB_SECRET, 'abc123');
  assert.equal(parsed.WORKHUB_PORT, '9001', '同一个键写多次，后写的赢');
  assert.equal(parsed.WORKHUB_ADMIN_PASSWORD, 'p#ss', '引号里的 # 是值的一部分');
  assert.equal(parsed.WORKHUB_EMPTY, '');
});

test('BOM 挡在前面时，第一个变量照样读得出来', () => {
  const parsed = parseEnvFile('\uFEFFWORKHUB_SECRET=abc123\nWORKHUB_PORT=9000\n');
  assert.equal(parsed.WORKHUB_SECRET, 'abc123');
  assert.equal(parsed.WORKHUB_PORT, '9000');
});

test('stripBom 只动开头的 BOM', () => {
  assert.equal(stripBom('\uFEFFa=1'), 'a=1');
  assert.equal(stripBom('a=1'), 'a=1');
});

test('兜底能补上被 BOM 吞掉的变量，并顺手修掉 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, '\uFEFFWORKHUB_SECRET=secret-from-file\nWORKHUB_PORT=9100\n', 'utf8');

  const saved = { ...process.env };
  try {
    delete process.env.WORKHUB_SECRET;
    delete process.env.WORKHUB_PORT;
    const repair = applyEnvFileFallback(file);
    assert.equal(process.env.WORKHUB_SECRET, 'secret-from-file');
    assert.equal(process.env.WORKHUB_PORT, '9100');
    assert.ok(repair.bomFixed, 'BOM 应当被修掉');
    assert.ok(existsSync(repair.backup!), '修之前应当留一份备份');
    assert.ok(!readFileSync(file, 'utf8').startsWith('\uFEFF'), '文件里不该再有 BOM');
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('进程环境里已经有的值不被 .env 覆盖', () => {
  // 跟 Node 一样：--env-file 不覆盖已经设过的变量。
  // 不然使用者临时改一个环境变量想验证点什么，会被配置文件悄悄改回去。
  const dir = mkdtempSync(join(tmpdir(), 'workhub-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'WORKHUB_SECRET=from-file\n', 'utf8');

  const saved = { ...process.env };
  try {
    process.env.WORKHUB_SECRET = 'from-process';
    applyEnvFileFallback(file);
    assert.equal(process.env.WORKHUB_SECRET, 'from-process');
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('文件不在时安静地什么都不做', () => {
  const saved = { ...process.env };
  try {
    const repair = applyEnvFileFallback(join(tmpdir(), 'workhub-not-exist', '.env'));
    assert.equal(repair.applied.length, 0);
    assert.equal(repair.bomFixed, false);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
