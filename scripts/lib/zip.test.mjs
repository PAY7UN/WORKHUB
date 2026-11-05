'use strict';
/**
 * 打包结构的单元测试。
 *
 * 盯的是「解压出来长什么样」：
 * 两个包（服务端、托盘）的顶层都只应该有一个目录——
 * 解压出来是一个文件夹，而不是一堆文件摊在根部。
 *
 * 这条一旦破了，后果很具体：使用者解压看到的是一堆不认识的文件，
 * 升级时新旧两版还会混在同一个目录里。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zipDirectory } from './zip.mjs';

/** 列 zip 里的条目（不装依赖：Windows 用 PowerShell 自带的，其它系统用 unzip） */
function listEntries(zipPath) {
  if (process.platform === 'win32') {
    const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }
`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });
    return out.split(/\r?\n/).filter(Boolean);
  }
  const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean);
}

/** 造一个假的包目录：workhub/{package.json, server/index.js} */
function makePackage(base) {
  const pkg = join(base, 'workhub');
  mkdirSync(join(pkg, 'server'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), '{"version":"0.1.0"}', 'utf8');
  writeFileSync(join(pkg, 'server', 'index.js'), '// entry', 'utf8');
  return pkg;
}

test('打包：顶层只有一个目录，解压出来是一个文件夹', async () => {
  const base = mkdtempSync(join(tmpdir(), 'workhub-zip-'));
  try {
    const pkg = makePackage(base);
    const zipPath = join(base, 'out.zip');
    await zipDirectory(pkg, zipPath, { baseName: 'workhub' });

    const raw = listEntries(zipPath);
    // 条目名必须用正斜杠。写成反斜杠的话，Linux 上的 unzip 会把整串
    // 当成文件名（workhub\server\index.js），解出来的东西全是废的，
    // 而这种包在 Windows 上看着完全正常。
    const backslashed = raw.filter((name) => name.includes('\\'));
    assert.deepEqual(backslashed, [], `条目名里有反斜杠：${backslashed.slice(0, 3).join('、')}`);

    const entries = raw.map((name) => name.replace(/\\/g, '/'));
    const strays = entries.filter((name) => !name.startsWith('workhub/'));
    assert.deepEqual(strays, [], `顶层散着文件：${strays.join('、')}`);
    assert.ok(entries.includes('workhub/package.json'));
    assert.ok(entries.includes('workhub/server/index.js'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('打包：顶层目录名跟目录对不上就报错（早点失败，别打完包才发现）', async () => {
  const base = mkdtempSync(join(tmpdir(), 'workhub-zip-bad-'));
  try {
    const pkg = makePackage(base);
    const zipPath = join(base, 'out.zip');
    await assert.rejects(
      () => zipDirectory(pkg, zipPath, { baseName: '别的东西' }),
      /顶层目录名对不上/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
