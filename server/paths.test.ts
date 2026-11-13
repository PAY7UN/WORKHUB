/**
 * 路径的单一真源：单测锁住优先级和边界。
 *
 * 这套优先级以前在四个文件里各写了一遍，其中一处还漏了 WORKHUB_DB。
 * 一旦改错，表现是「工具改的和服务端读的不是同一个库」——
 * 比如重置管理员密码改了服务端压根不读的库，命令说成功，用户还是登不进去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  DB_FILENAME,
  DEFAULT_DB_PATH,
  DEFAULT_VAULT_DIR,
  resolveDbPath,
  resolveVaultDir,
} from './paths.ts';

test('数据库路径：WORKHUB_DB_V2 优先于 WORKHUB_DB', () => {
  const env = { WORKHUB_DB_V2: '/a/v2.db', WORKHUB_DB: '/a/old.db' };
  assert.equal(resolveDbPath(env), '/a/v2.db');
});

test('数据库路径：只配 WORKHUB_DB 时用它', () => {
  assert.equal(resolveDbPath({ WORKHUB_DB: '/a/old.db' }), '/a/old.db');
});

test('数据库路径：都没配时用默认路径', () => {
  assert.equal(resolveDbPath({}), DEFAULT_DB_PATH);
});

test('数据库路径：空串按「没配」处理', () => {
  // 空串一路传下去的话，最后 dirname('') 变成 '.'，开库失败，报错还很难看懂
  assert.equal(resolveDbPath({ WORKHUB_DB_V2: '  ', WORKHUB_DB: '/a/old.db' }), '/a/old.db');
  assert.equal(resolveDbPath({ WORKHUB_DB_V2: '', WORKHUB_DB: '' }), DEFAULT_DB_PATH);
});

test('数据库路径：只认这两个变量，别的一概不认', () => {
  // WORKHUB_DB_PATH 这种「看起来像」的变量一旦被认了，
  // 会让人以为改了生效了，其实一直在改默认库
  assert.equal(resolveDbPath({ WORKHUB_DB_PATH: '/x.db' }), DEFAULT_DB_PATH);
});

test('vault 目录：环境变量优先，否则用默认', () => {
  assert.equal(resolveVaultDir({ WORKHUB_VAULT_DIR: '/v' }), '/v');
  assert.equal(resolveVaultDir({}), DEFAULT_VAULT_DIR);
});

test('旧变量名不再生效', () => {
  // 旧名不认：配了它等于没配。
  // 认旧名的后果是「升级完找不到自己的库」，但更麻烦的是两套名长期并存：
  // 改了新名却因为旧名还在而没生效，这比直接报错更难查。
  assert.equal(resolveDbPath({ MDHUB_DB_V2: '/a/v2.db' }), DEFAULT_DB_PATH);
  assert.equal(resolveDbPath({ MDHUB_DB: '/a/old.db' }), DEFAULT_DB_PATH);
  assert.equal(resolveVaultDir({ MDHUB_VAULT_DIR: '/v' }), DEFAULT_VAULT_DIR);
});

test('新旧变量名同时存在时只认新名', () => {
  const env = { WORKHUB_DB_V2: '/new.db', MDHUB_DB_V2: '/old.db', MDHUB_DB: '/older.db' };
  assert.equal(resolveDbPath(env), '/new.db');
});

test('默认库名用 workhub 前缀', () => {
  assert.equal(DB_FILENAME, 'workhub-v2.db');
  assert.ok(DEFAULT_DB_PATH.endsWith(join('data', 'workhub-v2.db')));
});
