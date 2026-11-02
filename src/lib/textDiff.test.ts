import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRange } from './textDiff.ts';

test('相同文本没有差异', () => {
  const r = diffRange('hello', 'hello');
  // 无差异表现为「替换区间为空且不插任何东西」
  assert.equal(r.from, r.to);
  assert.equal(r.insert, '');
});

test('末尾新增只替换新增的部分', () => {
  const r = diffRange('hello', 'hello world');
  assert.equal(r.from, 5);
  assert.equal(r.to, 5);
  assert.equal(r.insert, ' world');
});

test('中间插入只替换插入的位置', () => {
  const r = diffRange('ab', 'aXb');
  assert.equal(r.from, 1);
  assert.equal(r.to, 1);
  assert.equal(r.insert, 'X');
});

test('删除一段只替换被删掉的部分', () => {
  const r = diffRange('aXXXb', 'ab');
  assert.equal(r.from, 1);
  assert.equal(r.to, 4);
  assert.equal(r.insert, '');
});

test('整篇替换覆盖全文', () => {
  const r = diffRange('old', 'new');
  assert.equal(r.from, 0);
  assert.equal(r.to, 3);
  assert.equal(r.insert, 'new');
});

test('用差异区间回写能得到新文本', () => {
  const cases: Array<[string, string]> = [
    ['hello', 'hello world'],
    ['ab', 'aXb'],
    ['aXXXb', 'ab'],
    ['old', 'new'],
    ['', 'new'],
    ['old', ''],
    ['相同的结尾', '完全不同的开头'],
  ];
  for (const [oldText, newText] of cases) {
    const r = diffRange(oldText, newText);
    const rebuilt = oldText.slice(0, r.from) + r.insert + oldText.slice(r.to);
    assert.equal(rebuilt, newText);
  }
});
