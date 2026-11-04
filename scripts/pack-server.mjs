/**
 * 打服务端升级包：workhub-server-<版本>.zip
 *
 * 这个包是「自动升级」的原料——更新器下载它、解开、替换掉正在跑的代码。
 * 所以打包时要守住几条：
 *
 * - 代码进包，数据不进包：data/、logs/、node_modules/、.env 一律不带。
 *   把数据打进包里，等于每次升级都拿旧数据盖掉新数据（或者反过来）。
 * - 带一份文件清单（.workhub-files.txt）：升级时靠它算出「新版里已经
 *   没有的旧文件」并删掉。不删的话，改名加版本号的老文件会永远留在
 *   目录里，那种 bug 极难查。
 * - 附带 sha256：更新器下载后要核对，传输损坏或半截文件不能直接用。
 *
 * 用法：node scripts/pack-server.mjs [--out <目录>]
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * 打进包里的东西。
 *
 * shared/ 一定要在：服务端到处从 ../shared/ 导入（类型、检索、附件、密码策略…），
 * 漏了它升级上去的服务直接起不来。
 * 数据目录（data/）不在里面：升级换的是代码，不是数据。
 */
const INCLUDE = ['server', 'shared', 'dist', 'scripts', 'package.json', '.env.example', 'README.md'];

/** 永远不进包的东西 */
const EXCLUDE_DIRS = new Set(['node_modules', 'data', 'logs', '.git', 'release', 'coverage', '.vite']);
const EXCLUDE_FILES = new Set(['.env', '.workhub-files.txt']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

/** 递归列出目录下的所有文件（相对路径，斜杠分隔） */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...listFiles(join(dir, entry.name), base));
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push(relative(base, join(dir, entry.name)).split('\\').join('/'));
    }
  }
  return out;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => rejectPromise(new Error(`${command} 启动失败：${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} 退出码 ${code}：${stderr.trim() || stdout.trim()}`));
    });
  });
}

/** 打 zip：Windows 用 PowerShell 自带的 Compress-Archive，其它系统用 zip */
async function zipDirectory(stagingDir, zipPath) {
  if (process.platform === 'win32') {
    // 直接点名每个顶层项，不用通配符。
    // readdirSync 本来就把 .workhub-files.txt 列出来了——再单独加一遍，
    // Compress-Archive 会因为「重复路径」整个失败。
    const items = readdirSync(stagingDir).map((name) => join(stagingDir, name));
    await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path ${items.map((p) => `'${p}'`).join(',')} -DestinationPath '${zipPath}' -Force`,
    ]);
    return;
  }
  await run('zip', ['-q', '-r', zipPath, '.'], { cwd: stagingDir });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(ROOT, args.out ?? 'release');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version ?? '0.0.0';

  const missing = INCLUDE.filter((name) => !existsSync(join(ROOT, name)));
  if (missing.length > 0) {
    console.error(`以下内容不存在，打不了包：${missing.join('、')}`);
    if (missing.includes('dist')) {
      console.error('dist/ 是前端构建产物，先跑 npm run build。');
    }
    process.exit(1);
  }

  const staging = join(outDir, `.pack-staging-${version}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const files = [];
  for (const name of INCLUDE) {
    const from = join(ROOT, name);
    const to = join(staging, name);
    if (!statSync(from).isDirectory()) {
      copyFileSync(from, to);
      files.push(name);
      continue;
    }
    // 逐个文件复制，不用 cpSync 整棵树：
    // cpSync 会把 node_modules、.env 之类一起带走（体积暴涨，还可能把
    // 服务器上的密钥打进公开的 Release），而 EXCLUDE_* 的排除只对清单生效，
    // 对实际内容不生效——包内容和清单对不上，升级时的清理就全乱了
    mkdirSync(to, { recursive: true });
    for (const rel of listFiles(from)) {
      const src = join(from, rel);
      const dst = join(to, rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      files.push(`${name}/${rel}`);
    }
  }

  // 文件清单：升级时靠它清理新版里已经没有的旧文件
  const manifest = [...files].sort().join('\n');
  writeFileSync(join(staging, '.workhub-files.txt'), `${manifest}\n`, 'utf8');

  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `workhub-server-${version}.zip`);
  rmSync(zipPath, { force: true });
  await zipDirectory(staging, zipPath);

  const hash = createHash('sha256');
  hash.update(readFileSync(zipPath));
  const sha256 = hash.digest('hex');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  workhub-server-${version}.zip\n`, 'utf8');

  rmSync(staging, { recursive: true, force: true });

  const sizeMb = (readFileSync(zipPath).length / 1024 / 1024).toFixed(1);
  console.log(`已打出升级包：${zipPath}`);
  console.log(`  版本：${version}`);
  console.log(`  大小：${sizeMb} MB`);
  console.log(`  文件：${files.length} 个`);
  console.log(`  校验：${sha256}`);
  console.log('');
  console.log('把它挂到 GitHub Release（资产名保持 workhub-server-<版本>.zip）就能被自动升级认到。');
}

main().catch((err) => {
  console.error(`打包失败：${err?.stack ?? err}`);
  process.exit(1);
});
