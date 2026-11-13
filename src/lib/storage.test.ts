/**
 * 本地存储键的读写。
 *
 * 旧键（mdhub.*）的回退读取已经下线，这里测的是现役行为：
 * 读得到、没有就是 null、写只写自己、删干净。
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

test('键直接读得到', () => {
  const store = fakeStore({ 'workhub.token': 'abc' });
  assert.equal(readStore(store, 'workhub.token'), 'abc');
});

test('没有就是 null，不是空串', () => {
  assert.equal(readStore(fakeStore(), 'workhub.token'), null);
});

test('旧键不再回退读取', () => {
  // 旧键里揣的是本地偏好，不是业务数据：
  // 丢了顶多重新登一次，但留着回退就等于让两套键长期并存
  const store = fakeStore({ 'mdhub.token': 'abc' });
  assert.equal(readStore(store, 'workhub.token'), null);
  assert.equal(store.getItem('mdhub.token'), 'abc', '不该顺手删别人的键');
});

test('写就是写', () => {
  const store = fakeStore();
  writeStore(store, 'workhub.docs', '[]');
  assert.equal(store.getItem('workhub.docs'), '[]');
});

test('删就是删', () => {
  const store = fakeStore({ 'workhub.token': 'new' });
  removeStore(store, 'workhub.token');
  assert.equal(store.getItem('workhub.token'), null);
});

test('不带前缀的键照常工作', () => {
  const store = fakeStore({ plain: 'v' });
  assert.equal(readStore(store, 'plain'), 'v');
});
