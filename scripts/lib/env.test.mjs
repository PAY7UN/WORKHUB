/**
 * PowerShell 侧与 Node 侧的 .env 解析必须给出同一个答案。
 *
 * 背景：部署脚本（deploy.ps1 / install-service.ps1）读 .env 里的端口，
 * 服务端（server/envFile.ts）读同一份 .env 里的同一个键。PowerShell 读不到
 * 源码，只能自己实现一份解析规则——于是有了两份实现。
 *
 * 两份实现分叉的后果不是「某个功能不好使」，而是：
 *   - 服务照常起在 8787，宿主拿着 9999 去调停机接口 → 停不下来，只能强杀；
 *   - 或者部署时按 9999 检查端口占用，占用的是另一个服务 → 误判「端口被占」；
 *   - 而且全程没有任何报错，症状还出现在部署完成之后很久。
 *
 * 所以这里不测「PowerShell 写得对不对」，而是直接把它和 Node 那份对齐：
 * 同一批 .env 样本，两边跑一遍，答案必须逐条相同。
 * 规则真源在 server/envFile.ts 与 tray/env.cjs，改了那边记得同步改
 * scripts/lib/env.ps1，这个测试会立刻报出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseEnvFile, envValue } = require('../../tray/env.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'env.ps1');

/** 找一个能用的 PowerShell（Windows 自带 powershell.exe，跨平台装的是 pwsh） */
function findShell() {
  for (const shell of ['powershell', 'pwsh']) {
    try {
      execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: 'ignore',
      });
      return shell;
    } catch {
      // 试下一个
    }
  }
  return null;
}

const SHELL = findShell();

/** 让 PowerShell 那套规则读一遍 .env，返回端口（读不到就是 0） */
function psPort(envText, { bom = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-env-'));
  try {
    const body = Buffer.from(envText, 'utf8');
    const bytes = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    writeFileSync(join(dir, '.env'), bytes);
    const script = `. '${LIB.replace(/'/g, "''")}'; Get-PortFromEnv -Dir '${dir.replace(/'/g, "''")}'`;
    const out = execFileSync(SHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    return Number(out.trim() || 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Node 那套规则读一遍 .env，返回端口（读不到就是 0） */
function jsPort(envText) {
  const table = parseEnvFile(envText);
  const raw = envValue(table, 'PORT');
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return 0;
}

/** .env 样本：每一条都对应一个真实会踩的写法 */
const CASES = [
  ['新名直接写', 'WORKHUB_PORT=8787\n'],
  ['旧名不再兜底', 'MDHUB_PORT=8788\n'],
  ['新旧都写时取新名', 'WORKHUB_PORT=8789\nMDHUB_PORT=9999\n'],
  ['双引号', 'WORKHUB_PORT="8790"\n'],
  ['单引号', "WORKHUB_PORT='8791'\n"],
  ['行尾注释（带空格）', 'WORKHUB_PORT=8792 # 主端口\n'],
  ['行尾注释（不带空格）', 'WORKHUB_PORT=8793#注释\n'],
  ['引号后面跟注释', 'WORKHUB_PORT="8794" # 主端口\n'],
  ['值前后有空格', 'WORKHUB_PORT= 8795 \n'],
  ['引号里带空格', 'WORKHUB_PORT=" 8796 "\n'],
  ['同一个键写多次，后写的赢', 'WORKHUB_PORT=8795\nWORKHUB_PORT=8796\n'],
  ['端口在第一个键（BOM 之后）', 'WORKHUB_PORT=8797\nWORKHUB_SECRET=abc\n'],
  ['端口不是第一个键', 'WORKHUB_SECRET=abc\nWORKHUB_PORT=8798\n'],
  ['端口没配', 'WORKHUB_SECRET=abc\n'],
  ['端口配成空', 'WORKHUB_PORT=\n'],
  ['端口配成非数字', 'WORKHUB_PORT=abc\n'],
  ['端口是 0', 'WORKHUB_PORT=0\n'],
  ['端口越界', 'WORKHUB_PORT=70000\n'],
  ['空文件', ''],
];

test('PowerShell 与 Node 对 .env 端口的判定一致', (t) => {
  if (!SHELL) {
    t.skip('这台机器上没有 PowerShell，跳过跨语言一致性校验');
    return;
  }
  for (const [name, text] of CASES) {
    assert.equal(psPort(text), jsPort(text), `用例「${name}」两边结果不一致`);
  }
});

test('PowerShell 与 Node 对带 BOM 的 .env 判定一致', (t) => {
  if (!SHELL) {
    t.skip('这台机器上没有 PowerShell，跳过跨语言一致性校验');
    return;
  }
  // Node 自带的 --env-file 碰到 BOM 会静默丢掉第一个变量，
  // 所以 BOM 后的第一个键是最容易分叉的地方：两边都得读得到。
  const withBom = 'WORKHUB_PORT=8801\nWORKHUB_SECRET=abc\n';
  assert.equal(psPort(withBom, { bom: true }), 8801);
  assert.equal(jsPort(`\uFEFF${withBom}`), 8801);
  assert.equal(psPort(withBom, { bom: true }), jsPort(`\uFEFF${withBom}`));
});

test('.env 不存在时返回 0，不报错', (t) => {
  if (!SHELL) {
    t.skip('这台机器上没有 PowerShell，跳过跨语言一致性校验');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'workhub-env-'));
  try {
    const script = `. '${LIB.replace(/'/g, "''")}'; Get-PortFromEnv -Dir '${dir.replace(/'/g, "''")}'`;
    const out = execFileSync(SHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(Number(out.trim() || 0), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
