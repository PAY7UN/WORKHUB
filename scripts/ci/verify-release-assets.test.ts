// 发布后回头核对：Release 上该有的资产都在，体积也对得上。
//
// 这道闸门是被 v0.3.0 逼出来的：那次打包崩了却显示成功，
// 托盘包传到 GitHub 上时已经是残包，流水线全程是绿的。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(ROOT, 'scripts', 'ci', 'verify-release-assets.mjs');
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/** 这一版该有的五个文件 */
const EXPECTED = [
  `workhub-server-${VERSION}.zip`,
  `workhub-server-${VERSION}.zip.sha256`,
  `workhub-tray-${VERSION}.zip`,
  `workhub-tray-${VERSION}.zip.sha256`,
  `WorkHub-Setup-${VERSION}.exe`,
];

type RunResult = { status: number; stdout: string; stderr: string };

/**
 * 跑一遍核对脚本。
 *
 * 用异步 spawn 而不是 spawnSync：假 API 跑在本进程里，
 * 同步等待会把事件循环堵住，假 API 没人应答，子进程就一直等下去。
 */
function runScript(api: string, dir: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SCRIPT, `v${VERSION}`], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'PAY7UN/WORKHUB',
        GITHUB_TOKEN: 'test-token',
        WORKHUB_RELEASE_DIR: dir,
        WORKHUB_RELEASE_API: api,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ status: code ?? -1, stdout, stderr });
    });
  });
}

/** 起一台假 API，等端口起来再返回 */
async function startFakeApi(assets: { name: string; size: number }[]) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: `v${VERSION}`, assets }));
  });
  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, api: `http://127.0.0.1:${port}` };
}

/** 摆一个假的「发布目录」，返回每个文件的实际大小 */
function makeFakeReleaseDir() {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-release-verify-'));
  const sizes: Record<string, number> = {};
  for (const name of EXPECTED) {
    const content = `内容-${name}`;
    writeFileSync(join(dir, name), content, 'utf8');
    sizes[name] = Buffer.byteLength(content);
  }
  return { dir, sizes };
}

test('资产齐全、体积也对得上：算通过', async () => {
  const { dir, sizes } = makeFakeReleaseDir();
  const assets = EXPECTED.map((name) => ({ name, size: sizes[name] }));
  const { server, api } = await startFakeApi(assets);
  try {
    const result = await runScript(api, dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /资产齐全/);
  } finally {
    server.close();
  }
});

test('少了资产：算失败', async () => {
  const { dir, sizes } = makeFakeReleaseDir();
  // 模拟「上传那一步没传上去」：托盘的校验值没挂上
  const assets = EXPECTED
    .filter((name) => name !== `workhub-tray-${VERSION}.zip.sha256`)
    .map((name) => ({ name, size: sizes[name] }));
  const { server, api } = await startFakeApi(assets);
  try {
    const result = await runScript(api, dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /少了/);
  } finally {
    server.close();
  }
});

test('体积跟本地打出来的不一样：算失败', async () => {
  const { dir, sizes } = makeFakeReleaseDir();
  // 传上去的托盘包比本地小——就是「上传途中坏掉」的样子
  const assets = EXPECTED.map((name) => ({
    name,
    size: name === `workhub-tray-${VERSION}.zip` ? 123 : sizes[name],
  }));
  const { server, api } = await startFakeApi(assets);
  try {
    const result = await runScript(api, dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /跟本地打出来的不一样/);
  } finally {
    server.close();
  }
});
