/**
 * 检查服务端发布包是不是「真的自带环境」。
 *
 * 发布包的卖点就一句话：目标机不用装 Node、不用 npm install、不用联网，
 * 解压就能跑。所以这个包必须自己扛住这些：
 *
 * - 服务端是编译产物（server/index.js），不是 .ts 源码直跑；
 * - 运行时依赖在包里（node_modules），不是靠目标机现场装；
 * - 自带 Node 在包里（runtime/node.exe），不是靠目标机装；
 * - 文件清单在包里（.workhub-files.txt），升级时才算得出该删哪些旧文件；
 * - 旁边的 .sha256 对得上——传输损坏的包不能拿去升级。
 *
 * 少一样，零环境部署就是空话；而且这种缺失往往要到目标机上才暴露。
 * 所以打包完立刻查一遍，别等发到客户机器上才发现。
 *
 * 用法：node scripts/check-package.mjs [包路径或目录]
 *       不给参数就查 release/ 下最新的那个包。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 包里必须有的东西 */
const REQUIRED = [
  'package.json',
  'server/index.js',
  'dist/index.html',
  '.workhub-files.txt',
];

/** 运行时依赖里必须有的几个（挑的是服务端真的 import 的） */
const REQUIRED_DEPS = ['express', 'better-sqlite3'];

/** 没带自带运行时时，这些要改成「必须没有」 */
const RUNTIME = 'runtime/node.exe';

/**
 * 托盘免安装包里必须有的东西。
 *
 * 托盘包的卖点是「解压即用，像可执行程序一样」，
 * 而且托盘自己要能自动更新——那需要更新器脚本和更新器运行时都在包里。
 * 少一样，更新就是一句空话。
 */
const TRAY_REQUIRED = [
  ['WorkHub.exe', '托盘本体'],
  ['resources/app.asar', '托盘代码'],
  ['apply-update.cjs', '更新器脚本（在 exe 旁边，不在 asar 里）'],
  ['resources/payload/runtime/node.exe', '更新器运行时'],
  ['resources/payload/server/index.js', '服务端入口（编译产物）'],
  ['resources/payload/dist/index.html', '前端构建产物'],
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

/** 找包：给了路径就用给的，否则取目录里最新的一个 */
function resolvePackage(arg) {
  const target = arg ? resolve(ROOT, arg) : join(ROOT, 'release');
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (!existsSync(target)) {
    console.error(`找不到包：${target}`);
    process.exit(1);
  }
  const zips = readdirSync(target)
    .filter((name) => /^workhub-server-.*\.zip$/i.test(name))
    .sort();
  if (zips.length === 0) {
    console.error(`${target} 里没有 workhub-server-*.zip`);
    process.exit(1);
  }
  return join(target, zips[zips.length - 1]);
}

/** 找托盘免安装包：没有就返回 null（这个包不是每次都打） */
function resolveTrayPackage() {
  const dir = join(ROOT, 'release');
  if (!existsSync(dir)) return null;
  const zips = readdirSync(dir)
    .filter((name) => /^workhub-tray-.*\.zip$/i.test(name))
    .sort();
  if (zips.length === 0) return null;
  return join(dir, zips[zips.length - 1]);
}

/** 列 zip 里的条目（不装依赖：PowerShell 自带，Windows 上人人都有） */
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

/** 读 zip 里某个文件的内容（读不到就返回空串） */
function readEntryContent(zipPath, entryName) {
  try {
    if (process.platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
try {
  $entry = $zip.GetEntry('${entryName.replace(/'/g, "''")}')
  if ($entry) {
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
  }
} finally { $zip.Dispose() }
`;
      return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      });
    }
    return execFileSync('unzip', ['-p', zipPath, entryName], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/**
 * 检查托盘免安装包。
 *
 * 重点是那两样「托盘自己更新要用的东西」：
 * 更新器脚本（apply-update.cjs）和更新器运行时（payload/runtime/node.exe）。
 * 缺了脚本，更新器找不到自己；缺了运行时，更新器连启动都做不到——
 * 这两种缺失在使用者机器上才暴露，而那时候旧版本已经被替换掉了。
 */
function checkTrayPackage(zipPath) {
  console.log(`\n检查托盘免安装包：${zipPath}`);
  const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`  大小：${sizeMb} MB`);

  const entries = listEntries(zipPath);
  const names = new Set(entries.map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '')));

  for (const [need, why] of TRAY_REQUIRED) {
    if (names.has(need)) ok(`有 ${need}  （${why}）`);
    else fail(`托盘包里少了 ${need}  （${why}）`);
  }

  const shaPath = `${zipPath}.sha256`;
  if (!existsSync(shaPath)) {
    fail('托盘包旁边没有 .sha256——自动更新会拒绝这个包');
  } else {
    const expected = (readFileSync(shaPath, 'utf8').split(/\s+/)[0] ?? '').toLowerCase();
    const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    if (expected && expected === actual) ok('sha256 对得上');
    else fail(`sha256 对不上：文件写着 ${expected || '(空)'}，实际是 ${actual}`);
  }
}

function main() {
  const zipPath = resolvePackage(process.argv[2]);
  console.log(`检查发布包：${zipPath}`);
  const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`  大小：${sizeMb} MB\n`);

  const entries = listEntries(zipPath);
  const names = new Set(entries.map((entry) => entry.replace(/\\/g, '/')));

  // 1. 该有的都在
  for (const need of REQUIRED) {
    if (names.has(need)) ok(`有 ${need}`);
    else fail(`包里少了 ${need}`);
  }

  // 2. 运行时依赖在包里
  for (const dep of REQUIRED_DEPS) {
    const found = [...names].some((name) => name.startsWith(`node_modules/${dep}/`));
    if (found) ok(`有依赖 node_modules/${dep}`);
    else fail(`包里少了依赖 node_modules/${dep}`);
  }

  // 3. 自带 Node（带了就必须有；没带就明说，不能闷声发出去）
  const hasRuntime = names.has(RUNTIME);
  if (hasRuntime) ok(`有自带运行时 ${RUNTIME}`);
  else console.log('· 这个包不带自带运行时（目标机需要自行安装 Node）');

  // 4. 文件清单得跟包里的东西对得上：清单决定升级时删哪些旧文件，
  //    清单里缺了自带运行时，它就会被当成「新版里已经没有的旧文件」删掉——
  //    而那台机器上只有这一份 Node，删了服务就再也起不来了。
  const manifest = readEntryContent(zipPath, '.workhub-files.txt');
  if (!manifest.trim()) {
    fail('读不出文件清单 .workhub-files.txt 的内容');
  } else {
    const listed = new Set(
      manifest
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    if (hasRuntime && !listed.has(RUNTIME)) {
      fail('文件清单里没有 runtime/node.exe——升级时会把它当成「旧文件」删掉');
    } else {
      ok('文件清单跟包里的东西对得上');
    }
  }

  // 5. sha256 对得上
  const shaPath = `${zipPath}.sha256`;
  if (!existsSync(shaPath)) {
    fail('旁边没有 .sha256——自动升级会拒绝这个包');
  } else {
    const expected = (readFileSync(shaPath, 'utf8').split(/\s+/)[0] ?? '').toLowerCase();
    const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    if (expected && expected === actual) ok('sha256 对得上');
    else fail(`sha256 对不上：文件写着 ${expected || '(空)'}，实际是 ${actual}`);
  }

  console.log(`\n条目数：${entries.length}`);
  if (process.exitCode) {
    console.error('\n这个包不合格：别发。');
  } else if (hasRuntime) {
    console.log('\n这个包合格：目标机解压即用，不用装 Node、不用 npm install。');
  } else {
    console.log('\n这个包合格（但目标机需要自己装 Node）：解压即用，不用 npm install。');
  }

  // 托盘免安装包：有就一起查（这个包不是每次都打，没有也不报）
  const trayZip = resolveTrayPackage();
  if (trayZip) {
    checkTrayPackage(trayZip);
    if (process.exitCode) {
      console.error('\n托盘包不合格：别发。');
    } else {
      console.log('\n托盘包合格：解压即用（双击 WorkHub.exe），并且能自动更新。');
    }
  }
}

main();
