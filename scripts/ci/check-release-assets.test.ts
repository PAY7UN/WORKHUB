/**
 * 发布资产清点：少一样就要炸。
 *
 * 这条防线是被真实事故逼出来的：v0.3.0 发出去时少了托盘的 .sha256
 * （托盘自动更新要用的校验值），打包与校验全都通过、流水线全绿，
 * 只有把 Release 上真正的资产清单拉下来对一遍才发现。
 *
 * 所以这里锁住两件事：
 * - 东西齐全时放行；
 * - 少一样时必须失败，而且要把缺的是什么写进注解（注解在 API 里公开可读）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'check-release-assets.mjs');
const VERSION = '9.9.9';

/** 这一版该有的资产（与脚本里的清单一致） */
const ASSETS = [
  `workhub-server-${VERSION}.zip`,
  `workhub-server-${VERSION}.zip.sha256`,
  `workhub-tray-${VERSION}.zip`,
  `workhub-tray-${VERSION}.zip.sha256`,
  `WorkHub-Setup-${VERSION}.exe`,
];

/** 摆一个发布目录：names 里的文件存在，其余不存在 */
function makeReleaseDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'workhub-release-assets-'));
  for (const name of names) writeFileSync(join(dir, name), 'x');
  return dir;
}

function runCheck(dir) {
  return spawnSync(process.execPath, [SCRIPT, VERSION], {
    env: { ...process.env, WORKHUB_RELEASE_DIR: dir },
    encoding: 'utf8',
  });
}

test('资产齐全：放行', () => {
  const result = runCheck(makeReleaseDir(ASSETS));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /资产齐全/);
});

test('少了托盘的 .sha256：必须失败，不能放过', () => {
  const kept = ASSETS.filter((name) => name !== `workhub-tray-${VERSION}.zip.sha256`);
  const result = runCheck(makeReleaseDir(kept));
  assert.notEqual(result.status, 0, '缺了校验值还放行，等于把坏包发出去');
  assert.match(result.stdout, /发布资产不完整/);
  assert.match(result.stdout, new RegExp(`workhub-tray-${VERSION}\\.zip\\.sha256`));
});

test('文件是空的：也算缺件', () => {
  const dir = makeReleaseDir(ASSETS);
  writeFileSync(join(dir, `workhub-tray-${VERSION}.zip.sha256`), '');
  const result = runCheck(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /发布资产不完整/);
});

test('找不到发布目录：直接失败', () => {
  const result = spawnSync(process.execPath, [SCRIPT, VERSION], {
    env: { ...process.env, WORKHUB_RELEASE_DIR: join(tmpdir(), 'workhub-no-such-dir-xyz') },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /发布资产缺失/);
});
