import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSessionTrace,
  listSessions,
  selectDueSessions,
  traceToPrompt,
} from './codebuddy.ts';

function makeStore(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'wh-collector-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedSession(root: string, id: string, files: Array<Record<string, unknown>>, updatedAt?: number) {
  mkdirSync(join(root, 'file-changes', id), { recursive: true });
  files.forEach((f, i) => {
    const path = join(root, 'file-changes', id, `${i}.json`);
    writeFileSync(path, JSON.stringify(f), 'utf8');
    // 同一毫秒里写出的文件 mtime 相同，排序会不稳定；按序号铺开时间
    const t = new Date(Date.now() - 100_000 + i * 1000);
    utimesSync(path, t, t);
  });
  mkdirSync(join(root, 'edit-sessions'), { recursive: true });
  writeFileSync(
    join(root, 'edit-sessions', `${id}.json`),
    JSON.stringify({ conversationId: id, createdAt: 1, updatedAt: updatedAt ?? 2 }),
    'utf8',
  );
}

test('listSessions：会话取自 file-changes 目录，updatedAt 优先用 edit-sessions', () => {
  const { root, cleanup } = makeStore();
  try {
    seedSession(root, 'aaaa', [{ filePath: 'a.ts', diff: 'x' }], 12345);
    const sessions = listSessions({ root });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].conversationId, 'aaaa');
    assert.equal(sessions[0].updatedAt, 12345);
  } finally {
    cleanup();
  }
});

test('listSessions：没有存储目录时不抛错、返回空', () => {
  assert.deepEqual(listSessions({ root: join(tmpdir(), 'wh-not-exist') }), []);
});

test('selectDueSessions：空闲且游标没追上才收，老的排前面', () => {
  const now = 1_000_000;
  const sessions = [
    { conversationId: 'busy', updatedAt: now - 1000 }, // 太新，不收
    { conversationId: 'processed', updatedAt: now - 500_000 }, // 游标已追上
    { conversationId: 'old', updatedAt: now - 900_000 },
    { conversationId: 'newer', updatedAt: now - 700_000 },
    { conversationId: 'no-time', updatedAt: 0 }, // 读不到时间的不收
  ];
  const due = selectDueSessions(sessions, {
    now,
    idleMs: 600_000,
    cursorOf: (id) => (id === 'processed' ? sessions[1].updatedAt : undefined),
  });
  assert.deepEqual(
    due.map((s) => s.conversationId),
    ['old', 'newer'],
  );
});

test('buildSessionTrace：跳过凭据文件并脱敏，超长截断', () => {
  const { root, cleanup } = makeStore();
  try {
    seedSession(root, 'bbbb', [
      { filePath: 'd:/proj/.env', changeType: 'modify', addedLines: 1, removedLines: 1, diff: 'MDHUB_SECRET=abcdef' },
      {
        filePath: 'd:/proj/src/api.ts',
        changeType: 'modify',
        addedLines: 2,
        removedLines: 0,
        diff: 'const apiKey = "sk-abcdef123456";\nconst ok = true;',
      },
      { filePath: 'd:/proj/big.ts', changeType: 'modify', addedLines: 500, removedLines: 0, diff: 'x'.repeat(5000) },
    ]);
    const trace = buildSessionTrace({ root }, 'bbbb', { maxDiffChars: 1000, maxTotalChars: 2000 });
    assert.equal(trace.conversationId, 'bbbb');
    // .env 被跳过
    assert.equal(trace.files.length, 2);
    assert.equal(trace.files[0].filePath, 'd:/proj/src/api.ts');
    // 密钥形态被抹掉（字段名规则先命中，值整个换成 ***）
    assert.ok(!trace.files[0].diff.includes('sk-abcdef123456'));
    assert.ok(trace.files[0].diff.includes('"***"'));
    // 整份原料被总上限截断
    assert.ok(trace.files[1].diff.length <= 2000);
  } finally {
    cleanup();
  }
});

test('traceToPrompt：文件路径与 diff 都进原料', () => {
  const trace = {
    conversationId: 'ccccdddd',
    createdAt: 1,
    updatedAt: 2,
    files: [{ filePath: 'd:/p/a.ts', changeType: 'modify', addedLines: 3, removedLines: 1, diff: '+hello', recordedAt: 1 }],
  };
  const text = traceToPrompt(trace);
  assert.ok(text.includes('d:/p/a.ts'));
  assert.ok(text.includes('+hello'));
  assert.ok(text.includes('+3/-1'));
});
