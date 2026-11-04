/**
 * 路径的单一真源：单测锁住优先级和边界。
 *
 * 这套优先级以前在四个文件里各写了一遍，其中一处还漏了 MDHUB_DB。
 * 一旦改错，表现是「工具改的和服务端读的不是同一个库」——
 * 比如重置管理员密码改了服务端压根不读的库，命令说成功，用户还是登不进去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DB_PATH,
  DEFAULT_VAULT_DIR,
  resolveDbPath,
  resolveVaultDir,
} from './paths.ts';

test('数据库路径：MDHUB_DB_V2 优先于 MDHUB_DB', () => {
  const env = { MDHUB_DB_V2: '/a/v2.db', MDHUB_DB: '/a/old.db' };
  assert.equal(resolveDbPath(env), '/a/v2.db');
});

test('数据库路径：只配 MDHUB_DB 时用它', () => {
  assert.equal(resolveDbPath({ MDHUB_DB: '/a/old.db' }), '/a/old.db');
});

test('数据库路径：都没配时用默认路径', () => {
  assert.equal(resolveDbPath({}), DEFAULT_DB_PATH);
});

test('数据库路径：空串按「没配」处理', () => {
  // 空串一路传下去的话，最后 dirname('') 变成 '.'，开库失败，报错还很难看懂
  assert.equal(resolveDbPath({ MDHUB_DB_V2: '  ', MDHUB_DB: '/a/old.db' }), '/a/old.db');
  assert.equal(resolveDbPath({ MDHUB_DB_V2: '', MDHUB_DB: '' }), DEFAULT_DB_PATH);
});

test('数据库路径：只认这两个变量，别的一概不认', () => {
  // MDHUB_DB_PATH 这种「看起来像」的变量一旦被认了，
  // 会让人以为改了生效了，其实一直在改默认库
  assert.equal(resolveDbPath({ MDHUB_DB_PATH: '/x.db' }), DEFAULT_DB_PATH);
});

test('vault 目录：环境变量优先，否则用默认', () => {
  assert.equal(resolveVaultDir({ MDHUB_VAULT_DIR: '/v' }), '/v');
  assert.equal(resolveVaultDir({}), DEFAULT_VAULT_DIR);
});
