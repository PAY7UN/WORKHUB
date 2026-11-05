/**
 * C# 宿主读 .env 端口的规则，必须与 Node 那份一致。
 *
 * 背景：Windows 服务宿主（scripts/service/WorkHubService.cs）在停机时要调服务端的
 * 停机接口，接口地址里的端口来自 .env。宿主是 C#，读不到 Node 的模块，
 * 只能自己实现一份解析规则——于是又有了第三份实现。
 *
 * 三份实现（Node 服务端 / Node 托盘 / PowerShell 部署脚本 / C# 宿主）
 * 只要有一份对不上，症状都是同一类：
 *   端口对不上 → 停机接口打不通 → 只能强杀 → 事务被腰斩，
 *   而报错永远不指向「端口读错了」。
 *
 * 所以这里直接把 C# 那份编译出来跑一遍，逐条与 Node 真源（tray/env.cjs）对答案。
 * 没有 csc.exe（Windows 之外的机器）就跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseEnvFile, envValue } = require('../../tray/env.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const HOST_SOURCE = join(ROOT, 'scripts', 'service', 'WorkHubService.cs');

/** 找系统自带的 C# 编译器（.NET Framework 4，Win10/11 与 Server 2012+ 都带） */
function findCsc() {
  const candidates = [];
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  candidates.push(join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'));
  candidates.push(join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'));
  for (const csc of candidates) {
    if (existsSync(csc)) return csc;
  }
  return null;
}

const CSC = findCsc();

/** 探针程序：读一个目录里的 .env，把端口打出来 */
const PROBE_SOURCE = `
using System;

namespace WorkHub
{
    internal static class EnvPortProbe
    {
        public static int Main(string[] args)
        {
            int? port = EnvPort.Detect(args.Length > 0 ? args[0] : "");
            Console.WriteLine(port.HasValue ? port.Value.ToString() : "0");
            return 0;
        }
    }
}
`;

let probeExe = null;

/** 编译一次探针（整个测试文件共用一个 exe） */
function buildProbe() {
  if (probeExe) return probeExe;
  if (!CSC) return null;
  const dir = mkdtempSync(join(tmpdir(), 'workhub-csc-'));
  const src = join(dir, 'probe.cs');
  const exe = join(dir, 'probe.exe');
  writeFileSync(src, PROBE_SOURCE, 'utf8');
  execFileSync(
    CSC,
    [
      '/nologo',
      '/target:exe',
      '/codepage:65001',
      '/reference:System.ServiceProcess.dll',
      '/main:WorkHub.EnvPortProbe',
      `/out:${exe}`,
      HOST_SOURCE,
      src,
    ],
    { stdio: 'pipe' },
  );
  probeExe = { exe, dir };
  return probeExe;
}

/** Node 那套规则读一遍 .env，返回端口（读不到就是 0） */
function jsPort(envText) {
  const table = parseEnvFile(envText);
  const raw = envValue(table, 'PORT');
  const port = Number(raw);
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return 0;
}

/** C# 那套规则读一遍 .env，返回端口（读不到就是 0） */
function csharpPort(envText, { bom = false } = {}) {
  const probe = buildProbe();
  const dir = mkdtempSync(join(tmpdir(), 'workhub-env-'));
  try {
    const body = Buffer.from(envText, 'utf8');
    writeFileSync(join(dir, '.env'), bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body);
    const out = execFileSync(probe.exe, [dir], { encoding: 'utf8' });
    return Number(out.trim() || 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES = [
  ['新名直接写', 'WORKHUB_PORT=8787\n'],
  ['旧名兜底', 'MDHUB_PORT=8788\n'],
  ['新旧都写时取新名', 'WORKHUB_PORT=8789\nMDHUB_PORT=9999\n'],
  ['双引号', 'WORKHUB_PORT="8790"\n'],
  ['单引号', "WORKHUB_PORT='8791'\n"],
  ['行尾注释（带空格）', 'WORKHUB_PORT=8792 # 主端口\n'],
  ['行尾注释（不带空格）', 'WORKHUB_PORT=8793#注释\n'],
  ['引号后面跟注释', 'WORKHUB_PORT="8794" # 主端口\n'],
  ['值前后有空格', 'WORKHUB_PORT= 8795 \n'],
  ['引号里带空格', 'WORKHUB_PORT=" 8796 "\n'],
  ['同一个键写多次，后写的赢', 'WORKHUB_PORT=8797\nWORKHUB_PORT=8798\n'],
  ['端口没配', 'WORKHUB_SECRET=abc\n'],
  ['端口配成空', 'WORKHUB_PORT=\n'],
  ['端口配成非数字', 'WORKHUB_PORT=abc\n'],
  ['端口是 0', 'WORKHUB_PORT=0\n'],
  ['端口越界', 'WORKHUB_PORT=70000\n'],
  ['空文件', ''],
];

test('C# 宿主与 Node 对 .env 端口的判定一致', (t) => {
  if (!CSC) {
    t.skip('这台机器上没有 csc.exe，跳过跨语言一致性校验');
    return;
  }
  for (const [name, text] of CASES) {
    assert.equal(csharpPort(text), jsPort(text), `用例「${name}」两边结果不一致`);
  }
});

test('C# 宿主读带 BOM 的 .env 也不丢第一个变量', (t) => {
  if (!CSC) {
    t.skip('这台机器上没有 csc.exe，跳过跨语言一致性校验');
    return;
  }
  // Node 的 --env-file 碰到 BOM 会静默丢掉第一个变量；
  // 宿主这边要是也丢，端口就会退回到默认值，停机接口照样打不通。
  const text = 'WORKHUB_PORT=8801\nWORKHUB_SECRET=abc\n';
  assert.equal(csharpPort(text, { bom: true }), 8801);
  assert.equal(csharpPort(text, { bom: true }), jsPort(`\uFEFF${text}`));
});

test('C# 宿主编译产物能正常跑起来', (t) => {
  if (!CSC) {
    t.skip('这台机器上没有 csc.exe，跳过编译校验');
    return;
  }
  const probe = buildProbe();
  assert.ok(existsSync(probe.exe), '探针没编译出来');
});
