/**
 * PowerShell 脚本的编码与可解析性。
 *
 * 这两个坑都会让部署脚本「跑不起来」，而且报错完全指不到病根：
 *
 * 坑一：没有 UTF-8 BOM。
 *   Windows PowerShell 5.1 读 .ps1 时，文件开头没有 BOM 就按**系统 ANSI 代码页**解码。
 *   中文 Windows（代码页 936）上，UTF-8 里的中文被拆成乱码；
 *   运气好只是提示信息变乱码，运气不好——某些 UTF-8 字节序列在 GBK 里正好落成
 *   引号或反引号，脚本直接「解析失败」，一行都跑不起来。
 *   实测 deploy.ps1 与 install-service.ps1 都中过招，报错是
 *   "Missing closing '}' in statement block"，指向的行跟真正的原因毫无关系，
 *   很容易被误判成「脚本被改坏了」，其实是文件编码不对。
 *   （PowerShell 7 不受影响——但目标机装的是系统自带的 5.1。）
 *
 * 坑二：脚本本身有语法错误。
 *   同样表现为「跑不起来」，而报错行号常常对不上真正出问题的那行。
 *
 * 所以这里做两件事：
 *   1. 每个 .ps1 都必须以 UTF-8 BOM 开头（5.1 才会按 UTF-8 读）；
 *   2. 每个 .ps1 都能被 PowerShell 自己的解析器解析通过——用真的解析器，不靠猜。
 *
 * 注意 .gitattributes 里 `*.ps1 text eol=crlf` 只管换行，不管 BOM；
 * BOM 是内容的一部分，git 会原样保留，所以提交上去不会丢。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** 不扫的目录：不是我们的代码 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'coverage', '.git', '.vite']);

/** 递归找出仓库里所有 .ps1 */
function findPsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findPsFiles(join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ps1')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

const PS_FILES = findPsFiles(ROOT).sort();

/** 找一个能用的 PowerShell */
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

test('仓库里确实有 PowerShell 脚本可查', () => {
  assert.ok(PS_FILES.length > 0, '没找到任何 .ps1——扫描逻辑坏了');
  const names = PS_FILES.map((f) => relative(ROOT, f).split('\\').join('/'));
  assert.ok(names.includes('scripts/deploy.ps1'), 'scripts/deploy.ps1 不在');
  assert.ok(names.includes('scripts/install-service.ps1'), 'scripts/install-service.ps1 不在');
});

test('每个 .ps1 都以 UTF-8 BOM 开头', () => {
  // 少了 BOM，5.1 就按系统代码页读——中文 Windows 上直接解析失败
  const bad = PS_FILES.filter((f) => {
    const head = readFileSync(f).subarray(0, 3);
    return !(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf);
  });
  assert.deepEqual(
    bad.map((f) => relative(ROOT, f).split('\\').join('/')),
    [],
    '这些 .ps1 没有 UTF-8 BOM：5.1 会按系统 ANSI 代码页解码，中文 Windows 上会解析失败',
  );
});

test('每个 .ps1 都能被 PowerShell 解析器解析通过', (t) => {
  if (!SHELL) {
    t.skip('这台机器上没有 PowerShell，跳过语法校验');
    return;
  }
  const list = PS_FILES.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
  const script = `
$bad = 0
foreach ($f in @(${list})) {
  $tokens = $null
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    $bad++
    Write-Output ("FAIL " + $f + " line " + $errors[0].Extent.StartLineNumber + ": " + $errors[0].Message)
  }
}
Write-Output ("BADCOUNT=" + $bad)
`;
  const out = execFileSync(SHELL, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const count = Number((out.match(/BADCOUNT=(\d+)/) ?? [])[1] ?? '-1');
  assert.equal(count, 0, out);
});

test('脚本文件不是空壳（解析器认得，说明内容确实读到了）', () => {
  for (const file of PS_FILES) {
    const size = statSync(file).size;
    assert.ok(size > 100, `${relative(ROOT, file)} 只有 ${size} 字节，像是空文件`);
  }
});
