/**
 * 本地自动生成密钥的回归测试。
 *
 * 盯的是一个真会发生的故障：密钥如果每次启动都换一把，
 * 库里所有 API Key 与加密文档的密文就再也解不开了——
 * 表现是「模型配置莫名其妙全空了」，而日志里什么错都没有。
 *
 * 所以这里守两条：
 * 1. 生成一次就要留住，重启后必须是同一把；
 * 2. 留不住的时候要明说，绝不能悄悄换一把新的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateLocalSecret, localSecretPath } from './localSecret.ts';

/** 造一个临时数据目录，返回 { dir, dbPath } */
function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-secret-'));
  return { dir, dbPath: join(dir, 'workhub-v2.db') };
}

test('首次生成一把密钥并落在数据库旁边', () => {
  const { dir, dbPath } = tempDataDir();
  try {
    const result = loadOrCreateLocalSecret(dbPath);
    assert.equal(result.ok, true, '应当拿到一把密钥');
    if (!result.ok) return;
    assert.equal(result.created, true, '第一次调用应当是新建的');
    assert.ok(result.secret.length >= 32, '密钥长度得够');
    assert.equal(result.path, localSecretPath(dbPath));
    assert.equal(result.path, join(dir, '.workhub-local-secret'), '密钥文件在数据库旁边');
    assert.ok(existsSync(result.path), '密钥文件应当已经落盘');

    // 再取一次：必须是同一把，否则库里的密文就废了
    const again = loadOrCreateLocalSecret(dbPath);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.created, false, '第二次不该重新生成');
    assert.equal(again.secret, result.secret, '重启后必须是同一把密钥');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥文件在、但内容坏了，而库里已经有数据：不换钥匙，明说', () => {
  const { dir, dbPath } = tempDataDir();
  try {
    writeFileSync(localSecretPath(dbPath), '这里不是一把密钥\n', 'utf8');
    writeFileSync(dbPath, '假装这是一个已经用过的库\n', 'utf8');

    const result = loadOrCreateLocalSecret(dbPath);
    assert.equal(result.ok, false, '这种情况不能悄悄换一把新密钥');
    if (result.ok) return;
    assert.match(result.reason, /密钥文件/);
    assert.equal(result.path, localSecretPath(dbPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥文件坏了但库里还没有东西：可以重新生成', () => {
  const { dir, dbPath } = tempDataDir();
  try {
    writeFileSync(localSecretPath(dbPath), '这里不是一把密钥\n', 'utf8');

    const result = loadOrCreateLocalSecret(dbPath);
    assert.equal(result.ok, true, '还没有东西需要这把钥匙保护，可以重新生成');
    if (!result.ok) return;
    assert.equal(result.created, true);
    assert.ok(result.secret.length >= 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('密钥文件里写的是 KEY=VALUE 形式，能直接抄进 .env', () => {
  const { dir, dbPath } = tempDataDir();
  try {
    const result = loadOrCreateLocalSecret(dbPath);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const text = readFileSync(result.path, 'utf8');
    assert.match(text, /WORKHUB_SECRET=/, '得是能抄进 .env 的写法');
    assert.ok(text.includes(result.secret), '文件里得就是这把密钥');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
