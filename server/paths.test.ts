/**
 * 路径的单一真源：单测锁住优先级和边界。
 *
 * 这套优先级以前在四个文件里各写了一遍，其中一处还漏了 WORKHUB_DB。
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

test('旧变量名仍然生效：改名前写下的 .env 不该就此失效', () => {
  // 变量名从 MDHUB_ 换成 WORKHUB_ 是为了跟产品名对齐，不是要作废既有部署。
  // 认不出旧名的后果是「升级完找不到自己的库」——用户以为数据没了。
  assert.equal(resolveDbPath({ MDHUB_DB_V2: '/a/v2.db' }), '/a/v2.db');
  assert.equal(resolveDbPath({ MDHUB_DB: '/a/old.db' }), '/a/old.db');
  assert.equal(resolveVaultDir({ MDHUB_VAULT_DIR: '/v' }), '/v');
});

test('新旧变量名同时存在时以新名为准', () => {
  // 两个都配时选新的：照着新文档改的人，和忘了改的人，都得到正确结果
  assert.equal(resolveDbPath({ WORKHUB_DB_V2: '/new.db', MDHUB_DB_V2: '/old.db' }), '/new.db');
  assert.equal(resolveDbPath({ WORKHUB_DB_V2: '/new.db', MDHUB_DB: '/old.db' }), '/new.db');
});
