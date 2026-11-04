/**
 * 本地存储键的兼容读写。
 *
 * 键名从 mdhub.* 换成 workhub.*，但旧键里还揣着用户的登录令牌与本地设置。
 * 直接换掉等于「升级后被登出、本地设置全丢」——这类故障没有提示，
 * 只是功能突然不见了，所以读旧键这条退路必须有测试兜着。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStore, removeStore, writeStore } from './storage.ts';

/** 够用的假 Storage：只实现存取删三件事 */
function fakeStore(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

test('新键直接读得到', () => {
  const store = fakeStore({ 'workhub.token': 'abc' });
  assert.equal(readStore(store, 'workhub.token'), 'abc');
});

test('新键没有时回退旧键', () => {
  const store = fakeStore({ 'mdhub.token': 'abc' });
  assert.equal(readStore(store, 'workhub.token'), 'abc');
});

test('读到旧键时顺手搬到新键', () => {
  // 搬一次之后，浏览器里就只剩新名字了
  const store = fakeStore({ 'mdhub.token': 'abc' });
  readStore(store, 'workhub.token');
  assert.equal(store.getItem('workhub.token'), 'abc');
  assert.equal(store.getItem('mdhub.token'), null);
});

test('两个都有时以新键为准', () => {
  const store = fakeStore({ 'workhub.token': 'new', 'mdhub.token': 'old' });
  assert.equal(readStore(store, 'workhub.token'), 'new');
  assert.equal(store.getItem('mdhub.token'), 'old', '旧键还在，不该顺手删掉');
});

test('都没有时是 null，不是空串', () => {
  assert.equal(readStore(fakeStore(), 'workhub.token'), null);
});

test('写只写新键', () => {
  const store = fakeStore();
  writeStore(store, 'workhub.docs', '[]');
  assert.equal(store.getItem('workhub.docs'), '[]');
  assert.equal(store.getItem('mdhub.docs'), null);
});

test('删会把新旧两个键都删掉', () => {
  // 只删新键的话，旧键会变成幽灵数据：用户以为登出了，浏览器里还留着凭证
  const store = fakeStore({ 'workhub.token': 'new', 'mdhub.token': 'old' });
  removeStore(store, 'workhub.token');
  assert.equal(store.getItem('workhub.token'), null);
  assert.equal(store.getItem('mdhub.token'), null);
});

test('不是 workhub 前缀的键没有旧名', () => {
  const store = fakeStore({ 'plain': 'v' });
  assert.equal(readStore(store, 'plain'), 'v');
  assert.equal(readStore(store, 'plain'), 'v');
});
