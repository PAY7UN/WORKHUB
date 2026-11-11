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
 * - 顶层只有一层目录：解压出来是一个文件夹，不是文件摊在根部；
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
import {
  FORBIDDEN_CREDENTIALS,
  findFilledCredentialsInEnvExample,
  isTextFile,
} from './lib/package-credentials.mjs';
import { readZipEntries, readZipEntryContent } from './lib/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 包里那层顶层目录的名字。
 *
 * 两个包（服务端、托盘）结构一致：解压出来是「一个文件夹」，
 * 而不是一堆文件摊在解压目录根部。检查时按同一个前缀找。
 */
const PACKAGE_DIR = 'workhub';

/** 包内路径（相对于那层顶层目录） */
function inPackage(rel) {
  return `${PACKAGE_DIR}/${rel}`;
}

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
 * 而且托盘自己要能自动更新——那需要更新器脚本在包里，
 * 更新器跑起来用的运行时是托盘自己的 Electron（复制一份到临时目录用），
 * 所以包里不再单独附带一份 node.exe。
 */
const TRAY_REQUIRED = [
  ['WorkHub.exe', '托盘本体'],
  ['resources/app.asar', '托盘代码'],
  ['resources/update/apply-update.cjs', '更新器脚本（在 resources 下，不在 asar 里）'],
  ['使用说明.txt', '安装目录里的说明（哪些是程序、哪些是数据）'],
  ['icudtl.dat', '托盘的运行时文件（更新器复制它当自己的运行时）'],
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

/**
 * 列 zip 里的条目。
 *
 * 自己读中央目录，不依赖外部解压器：
 * 之前这里在 Windows 上靠 PowerShell 读，中文条目名会被解码成乱码
 * （「使用说明.txt」变成乱码 → 检查误判 → 有时干脆抛异常）；
 * 在别的系统上靠 unzip，而 Windows 上根本没装 unzip——
 * 于是托盘包的「凭据扫描」在 Windows 上是直接跳过的，安全检查形同虚设。
 * 现在两处都用同一套读法，哪儿都能跑。
 */
function listEntries(zipPath) {
  return readZipEntries(zipPath).map((entry) => entry.name);
}

/** 读 zip 里某个文件的内容（读不到就返回空串） */
function readEntryContent(zipPath, entryName) {
  try {
    const entry = readZipEntries(zipPath).find((item) => item.name === entryName);
    if (!entry) return '';
    return readZipEntryContent(zipPath, entry).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 用系统自带的解压器再数一遍条目，跟我们自己读出来的对一下。
 *
 * 自己写、自己读的东西当然对得上——但「对得上」只说明我们没写坏，
 * 不说明别人能解开。这里借一个独立实现（Windows 的 .NET、其它系统的 unzip）
 * 数个数：对不上就说明这个包结构有问题，不能发。
 *
 * @param {string} zipPath
 * @returns {number|null} 数不出来就返回 null（工具不在，不算失败）
 */
function countEntriesWithSystemTool(zipPath) {
  try {
    if (process.platform === 'win32') {
      const script = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}')
try { $zip.Entries.Count } finally { $zip.Dispose() }
`;
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      });
      const count = Number.parseInt(out.trim(), 10);
      return Number.isNaN(count) ? null : count;
    }
    const out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return null;
  }
}

/**
 * 在包里找写死的凭据。
 *
 * 只看文本类文件（按扩展名），第三方代码和自带运行时不算——
 * 那些字符串不代表我们的包带了一把钥匙。
 *
 * @param {string} zipPath
 * @returns {{path: string, needle: string}[]}
 */
function scanZipForCredentials(zipPath) {
  const hits = [];
  for (const entry of readZipEntries(zipPath)) {
    if (entry.name.endsWith('/')) continue;
    if (!isTextFile(entry.name)) continue;
    if (entry.name.includes('/node_modules/') || entry.name.includes('/runtime/')) continue;
    if (entry.size > 8 * 1024 * 1024) continue;
    let text = '';
    try {
      text = readZipEntryContent(zipPath, entry).toString('utf8');
    } catch {
      continue;
    }
    for (const needle of FORBIDDEN_CREDENTIALS) {
      if (text.includes(needle)) hits.push({ path: entry.name, needle });
    }
  }
  return hits;
}

/**
 * 检查托盘免安装包。
 *
 * 重点是那两样「托盘自己更新要用的东西」：
 * 更新器脚本（apply-update.cjs）和托盘的运行时文件（ICU 数据、V8 快照）。
 * 缺了脚本，更新器找不到自己；缺了运行时文件，更新器连启动都做不到——
 * 这两种缺失在使用者机器上才暴露，而那时候旧版本已经被替换掉了。
 */
function checkTrayPackage(zipPath) {
  console.log(`\n检查托盘免安装包：${zipPath}`);
  const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`  大小：${sizeMb} MB`);

  const entries = listEntries(zipPath);
  const names = new Set(entries.map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '')));

  // 顶层只有一层目录：解压出来是一个文件夹，不是文件摊在根部
  const strays = [...names].filter((name) => !name.startsWith(`${PACKAGE_DIR}/`));
  if (strays.length === 0) ok(`顶层只有 ${PACKAGE_DIR}/ 一个目录`);
  else fail(`顶层散着 ${strays.length} 个文件（应该全部收在 ${PACKAGE_DIR}/ 里）`);

  // 让系统自带的解压器也数一遍条目：确认使用者电脑上的解压工具读得懂
  const systemCount = countEntriesWithSystemTool(zipPath);
  if (systemCount === null) console.log('· 找不到系统解压器，跳过交叉核对');
  else if (systemCount === names.size) ok(`条目数跟系统解压器对得上（${names.size} 个）`);
  else fail(`条目数跟系统解压器对不上：我们读出 ${names.size} 个，系统读出 ${systemCount} 个`);

  for (const [need, why] of TRAY_REQUIRED) {
    if (names.has(inPackage(need))) ok(`有 ${need}  （${why}）`);
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

  // 托盘包把服务 payload 原封不动装进去：payload 里也不许有写死的凭据
  const credentialHits = scanZipForCredentials(zipPath);
  if (credentialHits.length === 0) ok('托盘包里没有写死的凭据');
  else {
    for (const hit of credentialHits) fail(`托盘包里出现了写死的凭据：${hit.path} 里写着 ${hit.needle}`);
  }
}

function main() {
  const zipPath = resolvePackage(process.argv[2]);
  console.log(`检查发布包：${zipPath}`);
  const sizeMb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
  console.log(`  大小：${sizeMb} MB\n`);

  const entries = listEntries(zipPath);
  const names = new Set(entries.map((entry) => entry.replace(/\\/g, '/')));

  // 0. 顶层只有一层目录：解压出来是一个文件夹，不是文件摊在根部
  const strays = [...names].filter((name) => !name.startsWith(`${PACKAGE_DIR}/`));
  if (strays.length === 0) ok(`顶层只有 ${PACKAGE_DIR}/ 一个目录`);
  else fail(`顶层散着 ${strays.length} 个文件（应该全部收在 ${PACKAGE_DIR}/ 里）`);

  // 0.1 让系统自带的解压器也数一遍条目：自己写自己读不算数，
  //     得确认别人（使用者电脑上的解压工具）也读得懂这个包
  const systemCount = countEntriesWithSystemTool(zipPath);
  if (systemCount === null) console.log('· 找不到系统解压器，跳过交叉核对');
  else if (systemCount === names.size) ok(`条目数跟系统解压器对得上（${names.size} 个）`);
  else fail(`条目数跟系统解压器对不上：我们读出 ${names.size} 个，系统读出 ${systemCount} 个`);

  // 1. 该有的都在
  for (const need of REQUIRED) {
    if (names.has(inPackage(need))) ok(`有 ${need}`);
    else fail(`包里少了 ${need}`);
  }

  // 2. 运行时依赖在包里
  for (const dep of REQUIRED_DEPS) {
    const found = [...names].some((name) => name.startsWith(inPackage(`node_modules/${dep}/`)));
    if (found) ok(`有依赖 node_modules/${dep}`);
    else fail(`包里少了依赖 node_modules/${dep}`);
  }

  // 3. 自带 Node（带了就必须有；没带就明说，不能闷声发出去）
  const hasRuntime = names.has(inPackage(RUNTIME));
  if (hasRuntime) ok(`有自带运行时 ${RUNTIME}`);
  else console.log('· 这个包不带自带运行时（目标机需要自行安装 Node）');

  // 4. 文件清单得跟包里的东西对得上：清单决定升级时删哪些旧文件，
  //    清单里缺了自带运行时，它就会被当成「新版里已经没有的旧文件」删掉——
  //    而那台机器上只有这一份 Node，删了服务就再也起不来了。
  const manifest = readEntryContent(zipPath, inPackage('.workhub-files.txt'));
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

  // 6. 包里不能带写死的凭据。
  //    拿到包的人能自签管理员令牌、能解密库里的模型密钥——这正是要防的事，
  //    而包一旦发出去就收不回来了，只能在发之前查掉。
  const credentialHits = scanZipForCredentials(zipPath);
  if (credentialHits.length === 0) {
    ok('包里没有写死的凭据');
  } else {
    for (const hit of credentialHits) fail(`包里出现了写死的凭据：${hit.path} 里写着 ${hit.needle}`);
  }

  // .env.example 是给人抄的样例：里面带了值，凭据就等于发给了所有抄它的人
  const envExample = readEntryContent(zipPath, inPackage('.env.example'));
  const filled = findFilledCredentialsInEnvExample(envExample);
  if (filled.length === 0) {
    ok('.env.example 里的密钥与密码是空的');
  } else {
    for (const hit of filled) fail(`.env.example 里 ${hit.key}=${hit.value}（样例必须留空）`);
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
  // 单独判一次：服务端包不合格不该顺带把托盘包也判成不合格——
  // 那会让人去查一个其实没问题的包。
  const trayZip = resolveTrayPackage();
  if (trayZip) {
    const serverExitCode = process.exitCode ?? 0;
    process.exitCode = 0;
    checkTrayPackage(trayZip);
    const trayFailed = Boolean(process.exitCode);
    process.exitCode = serverExitCode || (trayFailed ? 1 : 0);
    if (trayFailed) {
      console.error('\n托盘包不合格：别发。');
    } else {
      console.log('\n托盘包合格：解压即用（双击 WorkHub.exe），并且能自动更新。');
    }
  }
}

main();
