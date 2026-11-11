// 打包用的 zip 读写：自己写、自己读，得对得上，也得别人读得懂。
//
// 这里特意用系统自带的解压器（Windows 的 .NET、其它系统的 unzip）再数一遍条目：
// 自己写自己读只能说明「我们没写坏」，说明不了「使用者电脑上的解压工具能解开」。
// v0.3.0 的托盘包就是「看着像压缩包、实际解不开」——
// 而当时没有任何一环会打开它看一眼。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readZipEntries, readZipEntryContent, verifyZipArchive, zipDirectory } from './zip.mjs';

/** 摆一个小目录树当打包内容（顶层目录就叫 workhub，跟发布包一致） */
function makeTree() {
  const tmp = mkdtempSync(join(tmpdir(), 'workhub-zip-'));
  const root = join(tmp, 'workhub');
  mkdirSync(root);
  mkdirSync(join(root, 'server'));
  mkdirSync(join(root, 'empty-dir'));
  writeFileSync(join(root, 'server', 'index.js'), 'console.log("hi");\n');
  writeFileSync(join(root, '说明.txt'), '这是中文名的文件\n');
  writeFileSync(join(root, 'empty.txt'), '');
  return root;
}

test('zip 顶层目录名对不上就报错', async () => {
  const root = makeTree();
  await assert.rejects(
    () => zipDirectory(root, join(root, 'out.zip'), { baseName: 'wrong-name' }),
    /顶层目录名对不上/,
  );
});

test('目录打包成 zip：条目、正斜杠、内容都对', async () => {
  const root = makeTree();
  const zipPath = join(root, 'out.zip');
  await zipDirectory(root, zipPath, { baseName: 'workhub' });

  const entries = readZipEntries(zipPath);
  const names = entries.map((entry) => entry.name);

  // 顶层是一层 workhub/，不是文件摊在根部
  assert.ok(names.every((name) => name.startsWith('workhub/')), names.join('\n'));
  assert.ok(names.includes('workhub/server/index.js'), names.join('\n'));
  assert.ok(names.includes('workhub/说明.txt'), names.join('\n'));

  // 反斜杠会让 Linux 上的 unzip 解出一堆「workhub\server\index.js」这样的废文件
  assert.ok(names.every((name) => !name.includes('\\')), names.join('\n'));

  const index = entries.find((entry) => entry.name === 'workhub/server/index.js');
  assert.equal(readZipEntryContent(zipPath, index).toString('utf8'), 'console.log("hi");\n');

  const chinese = entries.find((entry) => entry.name === 'workhub/说明.txt');
  assert.equal(readZipEntryContent(zipPath, chinese).toString('utf8'), '这是中文名的文件\n');

  const empty = entries.find((entry) => entry.name === 'workhub/empty.txt');
  assert.equal(empty.size, 0);
  assert.equal(readZipEntryContent(zipPath, empty).length, 0);
});

test('打完的包当场验一遍：结构不对就报错', async () => {
  const root = makeTree();
  const zipPath = join(root, 'out.zip');
  await zipDirectory(root, zipPath, { baseName: 'workhub' });

  // 正常情况：验得过
  const entries = verifyZipArchive(zipPath, { prefix: 'workhub' });
  assert.ok(entries.length > 0);

  // 顶层散着文件（没有 workhub/ 这层）：要报错
  assert.throws(() => verifyZipArchive(zipPath, { prefix: '别的名字' }), /顶层散着文件/);

  // 被截断的包：读不出来就报错，不能当成「打包成功」
  const truncated = join(root, 'truncated.zip');
  const bytes = readFileSync(zipPath);
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  assert.throws(() => readZipEntries(truncated), /截断/);
});

test('系统自带的解压器也能读（交叉核对）', async () => {
  const root = makeTree();
  const zipPath = join(root, 'out.zip');
  await zipDirectory(root, zipPath, { baseName: 'workhub' });
  const ourCount = readZipEntries(zipPath).length;

  let systemCount = null;
  try {
    if (process.platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
try { $zip.Entries.Count } finally { $zip.Dispose() }
`;
      systemCount = Number.parseInt(
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
        }).trim(),
        10,
      );
    } else {
      systemCount = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean).length;
    }
  } catch {
    systemCount = null;
  }

  if (systemCount === null) {
    // 机器上没有解压器，跳过
    return;
  }
  assert.equal(systemCount, ourCount, '系统解压器读出来的条目数跟我们写的不一样');
});

test('打的包真的存在、不是空文件', async () => {
  const root = makeTree();
  const zipPath = join(root, 'out.zip');
  await zipDirectory(root, zipPath, { baseName: 'workhub' });
  assert.ok(existsSync(zipPath));
  assert.ok(readFileSync(zipPath).length > 0);
});
