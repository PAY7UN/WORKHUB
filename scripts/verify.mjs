// 运行时端到端验证：临时库副本 + 独立端口，绝不触碰生产库
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, copyFileSync, cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envValue } from '../server/env.ts';

// 根目录按脚本自身位置推导：写死绝对路径会让脚本只在本机可用，
// 也会把本机目录名留进公开仓库
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = '8902';
const PW1 = 'RuntimeCheck#2026a';
const PW2 = 'RuntimeCheck#2026b';

const ENV_PATH = join(ROOT, '.env');
if (!existsSync(ENV_PATH)) {
  console.error(`找不到 ${ENV_PATH}`);
  console.error('先复制 .env.example 为 .env 并填写 WORKHUB_SECRET，再运行本脚本。');
  process.exit(1);
}
/**
 * 要验证的库必须是现役那个：v2 起服务端用的是 data/mdhub-v2.db。
 *
 * 原先这里写死 data/mdhub.db——那是旧库，拿它当验证对象等于验证一个
 * 早就不用的世界，脚本通过也不代表线上这套是好的。
 */
const SOURCE_DB = envValue('DB_V2') || join(ROOT, 'data/mdhub-v2.db');
if (!existsSync(SOURCE_DB)) {
  console.error(`找不到 ${SOURCE_DB}`);
  console.error('先运行一次 npm run server（示例文档需设 WORKHUB_SEED_DEMO=1），再运行本脚本。');
  process.exit(1);
}

/** 仓库目录（正文所在）也要复制一份：v2 的正文不在库里，在仓库目录里 */
const SOURCE_VAULT = envValue('VAULT_DIR') || join(ROOT, 'data/vault');
if (!existsSync(SOURCE_VAULT)) {
  console.error(`找不到 ${SOURCE_VAULT}`);
  console.error('先运行一次 npm run server 生成仓库目录，再运行本脚本。');
  process.exit(1);
}

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const tmp = mkdtempSync(join(tmpdir(), 'mdhub-rt-'));
const dbPath = join(tmp, 'rt.db');
copyFileSync(SOURCE_DB, dbPath);

/**
 * 仓库目录也要复制一份。
 *
 * v2 的正文存在仓库目录的文件里，不在库里。只复制数据库的话，
 * 这个脚本建的验证文档会直接落进生产仓库目录——
 * 脚本开头那句「绝不触碰生产库」就成了空话。
 */
const vaultPath = join(tmp, 'vault');
cpSync(SOURCE_VAULT, vaultPath, { recursive: true });

// 用副本重置密码为已知值
execFileSync(process.execPath, ['server/resetAdminPassword.ts', PW1], {
  cwd: ROOT, env: { ...process.env, WORKHUB_DB_V2: dbPath }, stdio: 'pipe',
});

const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ...env,
    WORKHUB_PORT: PORT,
    WORKHUB_DB_V2: dbPath,
    WORKHUB_VAULT_DIR: vaultPath,
    NODE_ENV: 'development',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', d => (out += d));
child.stderr.on('data', d => (out += d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = `http://localhost:${PORT}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};
const listOf = b => (Array.isArray(b) ? b : (b?.docs ?? []));

console.log('=== 运行时端到端验证（端口 ' + PORT + '，临时库副本）===');

let ready = false;
for (let i = 0; i < 25; i++) {
  try { const r = await fetch(base + '/api/docs'); if (r.status) { ready = true; break; } } catch {}
  await sleep(400);
}
check('服务启动', ready, ready ? '' : out.slice(0, 300));

if (ready) {
  const anon = await fetch(base + '/api/docs');
  const anonList = listOf(await anon.json());
  check('未登录 /api/docs → 200', anon.status === 200, `状态 ${anon.status}`);
  check('未登录可见全部文档（访客隐藏已下线）', anonList.length > 0, `返回 ${anonList.length} 个节点`);

  const bad = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-probe-123' }),
  });
  check('错误密码 → 401', bad.status === 401, `状态 ${bad.status}`);

  const good = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PW1 }),
  });
  const authBody = await good.json();
  const token = authBody.token ?? authBody.data?.token;
  check('重置后的密码可登录', good.status === 200 && !!token, `状态 ${good.status}`);

  if (token) {
    const H = { authorization: 'Bearer ' + token };
    const authed = await fetch(base + '/api/docs', { headers: H });
    const list = listOf(await authed.json());
    check('带令牌 /api/docs → 200', authed.status === 200, `状态 ${authed.status}`);
    check('访客与管理员看到同一份清单',
      list.length === anonList.length,
      `管理员 ${list.length} / 访客 ${anonList.length} 个（访客隐藏已下线，两者应一致）`);

    const usage = await fetch(base + '/api/agent/usage', { headers: H });
    check('/api/agent/usage 可读', usage.status === 200, `状态 ${usage.status}`);

    const cfg = await fetch(base + '/api/agent/config', { headers: H });
    const cfgBody = cfg.status === 200 ? await cfg.json() : null;
    const leak = cfgBody ? /api_key_enc|"apiKey"\s*:\s*"[^"]{20,}"/.test(JSON.stringify(cfgBody)) : false;
    check('/api/agent/config 不泄露明文密钥', !leak, cfg.status === 200 ? '已脱敏' : '接口 ' + cfg.status);

    // 关键安全性质：改密后旧令牌自动失效（密码指纹）
    // 注意要打 requireAdmin 保护的接口：/api/docs 对访客开放，
    // 指纹失效后按设计降级为访客视图（200），只有受保护接口才返回 401。
    const before = await fetch(base + '/api/agent/config', { headers: H });
    check('改密前旧令牌可访问受保护接口', before.status === 200, `状态 ${before.status}`);

    execFileSync(process.execPath, ['server/resetAdminPassword.ts', PW2], {
      cwd: ROOT, env: { ...process.env, WORKHUB_DB_V2: dbPath }, stdio: 'pipe',
    });
    const stale = await fetch(base + '/api/agent/config', { headers: H });
    check('改密后旧令牌在受保护接口失效', stale.status === 401, `状态 ${stale.status}（期望 401）`);

    const degraded = await fetch(base + '/api/docs', { headers: H });
    const degradedList = listOf(await degraded.json());
    check('改密后只读接口降级为访客视图', degraded.status === 200 && degradedList.length === anonList.length,
      `返回 ${degradedList.length} 个（访客视图）`);

    const relogin = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PW2 }),
    });
    check('新密码可重新登录', relogin.status === 200, `状态 ${relogin.status}`);

    // 文档加密：密文入库、访客拿不到正文、访问一律走申请制
    if (relogin.status === 200) {
      const H2 = { authorization: 'Bearer ' + (await relogin.json()).token };
      const created = await fetch(base + '/api/docs', {
        method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '__verify_enc__', type: 'file', parentId: null, content: '明文校验串 PLAIN-CHECK-9' }),
      });
      const createdBody = await created.json();
      const docId = createdBody.doc?.id;
      check('可创建待加密文档', (created.status === 200 || created.status === 201) && !!docId, `状态 ${created.status}`);

      const J = (o) => JSON.stringify(o);

      if (docId) {
        const enc = await fetch(base + `/api/docs/${docId}/encrypt`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
        });
        const encBody = await enc.json();
        check('加密接口不再签发访问密码', enc.status === 200 && encBody.password === undefined,
          `状态 ${enc.status} password=${J(encBody.password)}`);
        check('加密后响应不含正文', encBody.doc?.encrypted === true && encBody.doc?.content === undefined,
          `encrypted=${encBody.doc?.encrypted} content=${J(encBody.doc?.content)}`);

        const anonList2 = listOf(await (await fetch(base + '/api/docs')).json());
        const guestView = anonList2.find(d => d.id === docId);
        check('访客可见加密文档但拿不到正文',
          !!guestView && guestView.encrypted === true && guestView.content === undefined,
          guestView ? `encrypted=${guestView.encrypted} content=${J(guestView.content)}` : '访客列表里没有这篇');

        // 访问密码机制整体下线：这几个接口不该再存在
        const unlockGone = await fetch(base + `/api/docs/${docId}/unlock`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ password: 'VerifyEnc#2026' }),
        });
        check('密码解锁接口已下线（unlock → 404）', unlockGone.status === 404, `状态 ${unlockGone.status}`);

        const rotateGone = await fetch(base + `/api/docs/${docId}/rotate-password`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
        });
        check('换发密码接口已下线（rotate-password → 404）', rotateGone.status === 404, `状态 ${rotateGone.status}`);

        const revealPwGone = await fetch(base + `/api/docs/${docId}/password/reveal`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
        });
        check('取回密码接口已下线（password/reveal → 404）', revealPwGone.status === 404, `状态 ${revealPwGone.status}`);

        const vaultGone = await fetch(base + '/api/docs/passwords', { headers: H2 });
        check('访问密码清单接口已下线（docs/passwords → 404）', vaultGone.status === 404, `状态 ${vaultGone.status}`);

        // 单次密码逻辑早已下线：策略切换接口不再存在
        const policyGone = await fetch(base + `/api/docs/${docId}/access-policy`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({ oneTime: true }),
        });
        check('单次密码接口已下线（access-policy → 404）', policyGone.status === 404, `状态 ${policyGone.status}`);

        // 管理员免密查看：服务端凭主密钥直接解密
        const reveal = await fetch(base + `/api/docs/${docId}/reveal`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
        });
        const revealBody = await reveal.json();
        check('管理员免密查看加密文档正文',
          reveal.status === 200 && revealBody.doc?.content === '明文校验串 PLAIN-CHECK-9',
          `状态 ${reveal.status}`);

        const revealAsGuest = await fetch(base + `/api/docs/${docId}/reveal`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
        });
        check('访客免密查看被拒（403）', revealAsGuest.status === 403, `状态 ${revealAsGuest.status}`);

        /* ---------------- 访问授权（「获取权限」式申请）---------------- */
        // 访客的 cookie 就是他的身份：没有账号也要能指出「授权给谁」
        const jar = new Map();
        const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
        const guestFetch = async (path, init = {}) => {
          const headers = { ...(init.headers || {}) };
          const c = cookieHeader();
          if (c) headers.cookie = c;
          const res = await fetch(base + path, { ...init, headers });
          const setCookies = res.headers.getSetCookie
            ? res.headers.getSetCookie()
            : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
          for (const line of setCookies) {
            const pair = line.split(';')[0];
            const eq = pair.indexOf('=');
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
          }
          return res;
        };

        const gs = await guestFetch('/api/auth/guest');
        const gsBody = await gs.json();
        check('访客可取得会话身份', gs.status === 200 && !!gsBody.id, `状态 ${gs.status}`);

        const openNo = await guestFetch(`/api/docs/${docId}/access-open`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
        });
        const openNoBody = await openNo.json();
        check('无授权时凭授权打开 → 403 且 reason=none',
          openNo.status === 403 && openNoBody.reason === 'none',
          `状态 ${openNo.status} reason=${openNoBody.reason}`);

        const reqRes = await guestFetch(`/api/docs/${docId}/access-request`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: J({ reason: '需要核对线上配置' }),
        });
        const reqBody = await reqRes.json();
        const reqId = reqBody.request?.id;
        check('访客可提交访问申请', reqRes.status === 201 && !!reqId, `状态 ${reqRes.status}`);

        const dup = await guestFetch(`/api/docs/${docId}/access-request`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ reason: '再来一次' }),
        });
        check('同一访客重复申请被挡下（409）', dup.status === 409, `状态 ${dup.status}`);

        const listRes = await fetch(base + '/api/access-requests?status=pending', { headers: H2 });
        const listBody = await listRes.json();
        const pendingItem = listBody.items?.find((it) => it.id === reqId);
        check('管理员能看到待审批申请',
          listRes.status === 200 && !!pendingItem && pendingItem.guestName === gsBody.name,
          `状态 ${listRes.status}`);

        const listAsGuest = await guestFetch('/api/access-requests?status=pending');
        check('访客读不到申请列表（403）', listAsGuest.status === 403, `状态 ${listAsGuest.status}`);

        const approveAsGuest = await guestFetch(`/api/access-requests/${reqId}/approve`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
        });
        check('访客不能自行批准（403）', approveAsGuest.status === 403, `状态 ${approveAsGuest.status}`);

        const openPending = await guestFetch(`/api/docs/${docId}/access-open`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
        });
        const openPendingBody = await openPending.json();
        check('审批前仍打不开且 reason=pending',
          openPending.status === 403 && openPendingBody.reason === 'pending',
          `状态 ${openPending.status} reason=${openPendingBody.reason}`);

        const appr = await fetch(base + `/api/access-requests/${reqId}/approve`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
          body: J({ expiresInDays: 7 }),
        });
        const apprBody = await appr.json();
        check('管理员批准申请即授权', appr.status === 200 && !!apprBody.grant?.id, `状态 ${appr.status}`);

        const openOk = await guestFetch(`/api/docs/${docId}/access-open`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
        });
        const openOkBody = await openOk.json();
        check('获批后凭授权免密打开并取回明文',
          openOk.status === 200 && openOkBody.doc?.content === '明文校验串 PLAIN-CHECK-9',
          `状态 ${openOk.status}`);

        const grantsRes = await fetch(base + `/api/docs/${docId}/access-grants`, { headers: H2 });
        const grantsBody = await grantsRes.json();
        check('授权名单可列出该访客', grantsRes.status === 200 && grantsBody.items?.length === 1,
          `状态 ${grantsRes.status} 共 ${grantsBody.items?.length} 条`);

        const revoke = await fetch(base + `/api/docs/${docId}/access-grants/${apprBody.grant.id}`, {
          method: 'DELETE', headers: H2,
        });
        check('管理员可收回授权', revoke.status === 200, `状态 ${revoke.status}`);

        const openAfter = await guestFetch(`/api/docs/${docId}/access-open`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
        });
        check('收回后立刻打不开', openAfter.status === 403, `状态 ${openAfter.status}`);

        const dec = await fetch(base + `/api/docs/${docId}/decrypt`, {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
        });
        const decBody = await dec.json();
        check('取消加密后明文恢复',
          dec.status === 200 && decBody.doc?.encrypted === false && decBody.doc?.content === '明文校验串 PLAIN-CHECK-9',
          `状态 ${dec.status}`);

        await fetch(base + `/api/docs/${docId}`, { method: 'DELETE', headers: H2 });

        /* ---------------- 压缩包不解包 / 仓库统计随增删更新 ---------------- */
        // 压缩包上传的处理与前端一致：建同名条目 + 挂原件附件，不解包
        const zipName = '__verify_pack__.zip';
        const zipBytes = Buffer.from('PK not-a-real-zip');
        const repoStatsBefore = await (await fetch(base + '/api/repos', { headers: H2 })).json();
        const defaultRepoId = repoStatsBefore.repos?.[0]?.id;
        const statOf = (stats, repoId) =>
          stats.find((s) => s.repoId === repoId) ?? { docCount: 0, attachmentCount: 0 };
        const statBefore = statOf(repoStatsBefore.stats ?? [], defaultRepoId);

        const zipDocRes = await fetch(base + '/api/docs', {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
          body: J({ name: zipName, type: 'file', parentId: null, rawName: true }),
        });
        const zipDoc = (await zipDocRes.json()).doc;
        check('可创建压缩包同名条目', (zipDocRes.status === 200 || zipDocRes.status === 201) && !!zipDoc?.id,
          `状态 ${zipDocRes.status}`);

        if (zipDoc?.id) {
          const attRes = await fetch(
            base + `/api/docs/${zipDoc.id}/attachments?name=${encodeURIComponent(zipName)}&mime=application%2Fzip`,
            { method: 'POST', headers: { ...H2, 'content-type': 'application/octet-stream' }, body: zipBytes },
          );
          check('压缩包按原件存为附件', attRes.status === 201, `状态 ${attRes.status}`);

          const atts = await (await fetch(base + `/api/docs/${zipDoc.id}/attachments`, { headers: H2 })).json();
          check('压缩包没有被拆成多篇文档',
            atts.attachments?.length === 1 && atts.attachments[0]?.name === zipName,
            `附件 ${atts.attachments?.length} 个`);

          const repoStatsAfter = await (await fetch(base + '/api/repos', { headers: H2 })).json();
          const statAfter = statOf(repoStatsAfter.stats ?? [], zipDoc.repoId ?? defaultRepoId);
          check('仓库文件数随上传增加',
            statAfter.docCount === statBefore.docCount + 1 && statAfter.attachmentCount === statBefore.attachmentCount + 1,
            `文档 ${statBefore.docCount} → ${statAfter.docCount}，附件 ${statBefore.attachmentCount} → ${statAfter.attachmentCount}`);

          const zipImport = await fetch(base + '/api/import/zip', {
            method: 'POST', headers: { ...H2, 'content-type': 'application/octet-stream' }, body: zipBytes,
          });
          check('压缩包解包接口已下线（import/zip → 404）', zipImport.status === 404, `状态 ${zipImport.status}`);

          await fetch(base + `/api/docs/${zipDoc.id}`, { method: 'DELETE', headers: H2 });
          const repoStatsEnd = await (await fetch(base + '/api/repos', { headers: H2 })).json();
          const statEnd = statOf(repoStatsEnd.stats ?? [], zipDoc.repoId ?? defaultRepoId);
          check('仓库文件数随删除回落',
            statEnd.docCount === statBefore.docCount && statEnd.attachmentCount === statBefore.attachmentCount,
            `文档 ${statAfter.docCount} → ${statEnd.docCount}，附件 ${statAfter.attachmentCount} → ${statEnd.attachmentCount}`);
        }

        /* ---------------- 原件：文件即节点（不配同名备注）+ 不同格式的下载 ---------------- */
        // 上传一个 zip：结果应当只有一个 zip 节点，不附带任何同名 .md 备注
        const packName = '__verify_pack__.zip';
        const packBytes = Buffer.from('PK not-a-real-zip');
        const listBeforeUpload = listOf(await (await fetch(base + '/api/docs')).json());

        const uploadRes = await fetch(
          base + `/api/docs/upload?name=${encodeURIComponent(packName)}&mime=application%2Fzip`,
          { method: 'POST', headers: { ...H2, 'content-type': 'application/octet-stream' }, body: packBytes },
        );
        const uploadBody = await uploadRes.json();
        const packId = uploadBody.doc?.id;
        check('上传原件直接得到一个文件节点',
          (uploadRes.status === 200 || uploadRes.status === 201) && !!packId && uploadBody.doc?.kind === 'file',
          `状态 ${uploadRes.status} kind=${uploadBody.doc?.kind}`);

        if (packId) {
          const listAfterUpload = listOf(await (await fetch(base + '/api/docs')).json());
          check('上传 zip 不会配一篇同名 .md 备注',
            listAfterUpload.length === listBeforeUpload.length + 1 &&
            !listAfterUpload.some((d) => d.name === '__verify_pack__' || d.name === '__verify_pack__.md'),
            `节点 ${listBeforeUpload.length} → ${listAfterUpload.length}`);

          const dl = await fetch(base + `/api/docs/${packId}/download`, { headers: H2 });
          const dlBytes = Buffer.from(await dl.arrayBuffer());
          check('原件按原字节下载（不是 0 字节假文件）',
            dl.status === 200 && dlBytes.length === packBytes.length && dlBytes.equals(packBytes),
            `状态 ${dl.status} ${dlBytes.length} 字节`);

          const dlDisposition = dl.headers.get('content-disposition') ?? '';
          const dlType = dl.headers.get('content-type') ?? '';
          check('下载保留原文件名与原始 MIME',
            /filename\*=UTF-8''__verify_pack__\.zip/.test(dlDisposition) && dlType.includes('application/zip'),
            `${dlType} | ${dlDisposition}`);

          const rawRes = await fetch(base + `/api/docs/${packId}/raw`, { headers: H2 });
          const rawBytes = Buffer.from(await rawRes.arrayBuffer());
          check('原件可内联预览（inline + 字节一致）',
            rawRes.status === 200 && rawBytes.equals(packBytes) &&
            /inline/.test(rawRes.headers.get('content-disposition') ?? ''),
            `状态 ${rawRes.status}`);

          await fetch(base + `/api/docs/${packId}`, { method: 'DELETE', headers: H2 });
        }

        /* ---------------- 加密原件：能看不等于能拿走 ---------------- */
        const secretName = '__verify_secret__.txt';
        const secretBytes = Buffer.from('SECRET-BYTES-42', 'utf8');
        const encUpload = await fetch(
          base + `/api/docs/upload?name=${encodeURIComponent(secretName)}&mime=text%2Fplain`,
          { method: 'POST', headers: { ...H2, 'content-type': 'application/octet-stream' }, body: secretBytes },
        );
        const encId = (await encUpload.json()).doc?.id;
        if (encId) {
          await fetch(base + `/api/docs/${encId}/encrypt`, {
            method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
          });

          const guestDlNoGrant = await guestFetch(`/api/docs/${encId}/download`);
          check('无授权时下载加密原件被拒（403）', guestDlNoGrant.status === 403, `状态 ${guestDlNoGrant.status}`);

          const guestReq = await guestFetch(`/api/docs/${encId}/access-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ reason: '能力分级验证' }),
          });
          const guestReqId = (await guestReq.json()).request?.id;

          // 只给「查看」：能看，不能拿走
          const viewOnly = await fetch(base + `/api/access-requests/${guestReqId}/approve`, {
            method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
            body: J({ expiresInDays: 7, capabilities: ['view'] }),
          });
          const viewOnlyBody = await viewOnly.json();
          check('批准时可只给「查看」能力',
            viewOnly.status === 200 && JSON.stringify(viewOnlyBody.grant?.capabilities) === JSON.stringify(['view']),
            `状态 ${viewOnly.status} 能力 ${JSON.stringify(viewOnlyBody.grant?.capabilities)}`);

          const viewRaw = await guestFetch(`/api/docs/${encId}/raw`);
          check('有查看能力时能看加密原件', viewRaw.status === 200, `状态 ${viewRaw.status}`);

          const viewDl = await guestFetch(`/api/docs/${encId}/download`);
          const viewDlBody = await viewDl.json().catch(() => ({}));
          check('只有查看能力时下载被拒（403）',
            viewDl.status === 403 && /不包含下载/.test(viewDlBody?.error ?? ''),
            `状态 ${viewDl.status} ${viewDlBody?.error ?? ''}`);

          // 在线把口子放大：加 download
          const adjust = await fetch(base + `/api/docs/${encId}/access-grants/${viewOnlyBody.grant.id}`, {
            method: 'PATCH', headers: { ...H2, 'content-type': 'application/json' },
            body: J({ capabilities: ['view', 'download'] }),
          });
          check('授权能力可在线调整（PATCH）',
            adjust.status === 200 && JSON.stringify((await adjust.json()).capabilities) === JSON.stringify(['view', 'download']),
            `状态 ${adjust.status}`);

          const dlAfter = await guestFetch(`/api/docs/${encId}/download`);
          const dlAfterBytes = Buffer.from(await dlAfter.arrayBuffer());
          check('加上下载能力后能取回原始字节',
            dlAfter.status === 200 && dlAfterBytes.equals(secretBytes),
            `状态 ${dlAfter.status} ${dlAfterBytes.length} 字节`);

          const auditRes = await fetch(base + `/api/access-audit?docId=${encId}`, { headers: H2 });
          const auditBody = await auditRes.json();
          const actions = (auditBody.items ?? []).map((a) => a.action);
          check('访问审计记录了能力调整与下载',
            auditRes.status === 200 && actions.includes('adjust') && actions.includes('download'),
            `动作 ${JSON.stringify(actions)}`);

          const auditAsGuest = await guestFetch('/api/access-audit');
          check('访客读不到访问审计（403）', auditAsGuest.status === 403, `状态 ${auditAsGuest.status}`);

          await fetch(base + `/api/docs/${encId}`, { method: 'DELETE', headers: H2 });
        }

        /* ---------------- 批量授权、权限状态查询与即时收回 ---------------- */
        // 造两篇加密文档，用来验证「一次开通多篇」
        const makeEncDoc = async (name, content) => {
          const r = await fetch(base + '/api/docs', {
            method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
            body: J({ name, type: 'file', parentId: null, content }),
          });
          const id = (await r.json()).doc?.id;
          if (id) {
            await fetch(base + `/api/docs/${id}/encrypt`, {
              method: 'POST', headers: { ...H2, 'content-type': 'application/json' }, body: J({}),
            });
          }
          return id;
        };
        const doc2Id = await makeEncDoc('__verify_enc2__', '第二篇校验串 SECOND-PLAIN-7');
        const doc3Id = await makeEncDoc('__verify_enc3__', '第三篇校验串 THIRD-PLAIN-7');

        if (doc2Id) {
          const st0 = await guestFetch(`/api/docs/${doc2Id}/access-status`);
          const st0Body = await st0.json();
          check('访客可查权限状态（未申请 → none）',
            st0.status === 200 && st0Body.granted === false && st0Body.reason === 'none',
            `状态 ${st0.status} reason=${st0Body.reason}`);

          const req2Res = await guestFetch(`/api/docs/${doc2Id}/access-request`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ reason: '批量测试' }),
          });
          const req2Id = (await req2Res.json()).request?.id;

          const st1 = await guestFetch(`/api/docs/${doc2Id}/access-status`);
          const st1Body = await st1.json();
          check('申请在审时状态为 pending',
            st1.status === 200 && st1Body.reason === 'pending', `状态 ${st1.status} reason=${st1Body.reason}`);

          const bulkAppr = await fetch(base + '/api/access-requests/bulk-approve', {
            method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
            body: J({ requestIds: [req2Id], expiresInDays: 7 }),
          });
          const bulkApprBody = await bulkAppr.json();
          check('批量批准申请一次批掉多条',
            bulkAppr.status === 200 && bulkApprBody.approved === 1,
            `状态 ${bulkAppr.status} 已批 ${bulkApprBody.approved}`);

          const bulkBad = await fetch(base + '/api/access-requests/bulk-approve', {
            method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
            body: J({ requestIds: ['not-a-real-id'], expiresInDays: 0 }),
          });
          const bulkBadBody = await bulkBad.json();
          check('批量批准对无效申请逐条给出原因',
            bulkBad.status === 200 && bulkBadBody.approved === 0 && bulkBadBody.skipped?.length === 1,
            `状态 ${bulkBad.status} skipped=${JSON.stringify(bulkBadBody.skipped)}`);

          const bulkAsGuest = await guestFetch('/api/access-requests/bulk-approve', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: J({ requestIds: [req2Id] }),
          });
          check('访客不能批量批准（403）', bulkAsGuest.status === 403, `状态 ${bulkAsGuest.status}`);

          const st2 = await guestFetch(`/api/docs/${doc2Id}/access-status`);
          const st2Body = await st2.json();
          check('获批后状态变为 granted',
            st2.status === 200 && st2Body.granted === true, `状态 ${st2.status} reason=${st2Body.reason}`);

          const guestsRes = await fetch(base + '/api/access-guests', { headers: H2 });
          const guestsBody = await guestsRes.json();
          check('管理员可读已知访客清单',
            guestsRes.status === 200 && Array.isArray(guestsBody.items) && guestsBody.items.length >= 1,
            `状态 ${guestsRes.status} 共 ${guestsBody.items?.length} 人`);
          const guestsAsGuest = await guestFetch('/api/access-guests');
          check('访客读不到访客清单（403）', guestsAsGuest.status === 403, `状态 ${guestsAsGuest.status}`);

          // 批量授权：给同一个访客一次开通两篇
          const bulkGrant = await fetch(base + '/api/access-grants/bulk', {
            method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
            body: J({
              guestId: gsBody.id, guestName: gsBody.name,
              docIds: [doc2Id, doc3Id].filter(Boolean), expiresInDays: 30,
            }),
          });
          const bulkGrantBody = await bulkGrant.json();
          check('批量授权一次开通多篇文档',
            bulkGrant.status === 200 && bulkGrantBody.granted === 2,
            `状态 ${bulkGrant.status} 已授 ${bulkGrantBody.granted} 篇`);

          const bulkGrantAsGuest = await guestFetch('/api/access-grants/bulk', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: J({ guestId: gsBody.id, guestName: gsBody.name, docIds: [doc2Id] }),
          });
          check('访客不能批量授权（403）', bulkGrantAsGuest.status === 403, `状态 ${bulkGrantAsGuest.status}`);

          /* 收回授权必须让对方当场知道：SSE 推 revoked */
          const ac = new AbortController();
          const watchRes = await fetch(base + `/api/docs/${doc2Id}/access-watch`, {
            headers: { cookie: cookieHeader(), accept: 'text/event-stream' },
            signal: ac.signal,
          });
          const watchPromise = (async () => {
            if (!watchRes.ok || !watchRes.body) return `http-${watchRes.status}`;
            const reader = watchRes.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              if (buf.includes('event: revoked')) return 'revoked';
            }
            return 'closed';
          })();

          const grants2 = await fetch(base + `/api/docs/${doc2Id}/access-grants`, { headers: H2 });
          const grantItems = (await grants2.json()).items ?? [];
          for (const g of grantItems) {
            await fetch(base + `/api/docs/${doc2Id}/access-grants/${g.id}`, { method: 'DELETE', headers: H2 });
          }

          const watchEvent = await Promise.race([
            watchPromise,
            new Promise((r) => setTimeout(() => r('timeout'), 5000)),
          ]);
          ac.abort();
          check('收回授权后 SSE 立刻推送 revoked', watchEvent === 'revoked', `收到 ${watchEvent}`);

          const openGone = await guestFetch(`/api/docs/${doc2Id}/access-open`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: J({}),
          });
          check('全部收回后立刻打不开', openGone.status === 403, `状态 ${openGone.status}`);

          await fetch(base + `/api/docs/${doc2Id}`, { method: 'DELETE', headers: H2 });
          if (doc3Id) await fetch(base + `/api/docs/${doc3Id}`, { method: 'DELETE', headers: H2 });
        }

        /* ---------------- 覆盖式导入：不合格的载荷不能连坐清空整个资料库 ---------------- */
        // 导入是「全量替换」：整个资料库被换成导入的这一批。
        // 中途出岔子的代价是资料库没了——库里空了，盘上的内容也找不回来。
        // 所以载荷不合格必须就地退回，不能是「先清空，再报错」。
        const sentinelRes = await fetch(base + '/api/docs', {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
          body: J({ name: '__verify_import_sentinel__.md', type: 'file', parentId: null, content: '导入前哨兵' }),
        });
        check('导入前先放一篇哨兵文档', sentinelRes.status === 200 || sentinelRes.status === 201,
          `状态 ${sentinelRes.status}`);

        const badImport = await fetch(base + '/api/docs/import', {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
          body: J({
            docs: [
              { id: 'bad-1', name: '类型非法.md', type: '目录' },      // 类型只能是 file/folder
              { id: 'bad-2', name: '带/斜杠.md', type: 'file' },      // 名字不能当路径段
            ],
          }),
        });
        const badImportBody = await badImport.json();
        check('畸形导入载荷被拒（400，不是 500）',
          badImport.status === 400 && Array.isArray(badImportBody.problems) && badImportBody.problems.length >= 2,
          `状态 ${badImport.status} ${JSON.stringify(badImportBody.problems ?? badImportBody.error ?? '').slice(0, 100)}`);

        const afterBad = await (await fetch(base + '/api/docs', { headers: H2 })).json();
        const afterBadNames = (afterBad.docs ?? []).map(d => d.name);
        check('畸形导入没有连坐清空资料库',
          afterBadNames.includes('__verify_import_sentinel__.md'),
          `剩余 ${afterBadNames.length} 篇`);

        // 合法载荷：库被整体替换，正文能读回
        const goodImport = await fetch(base + '/api/docs/import', {
          method: 'POST', headers: { ...H2, 'content-type': 'application/json' },
          body: J({
            docs: [
              { id: 'imp-1', name: '__verify_imported_a__.md', type: 'file', parentId: null, content: '导入正文 A', createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'u-admin', updatedBy: 'u-admin' },
              { id: 'imp-2', name: '__verify_imported_b__.md', type: 'file', parentId: null, content: '导入正文 B', createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'u-admin', updatedBy: 'u-admin' },
            ],
          }),
        });
        const goodImportBody = await goodImport.json();
        check('合法载荷导入成功', goodImport.status === 200 && goodImportBody.imported === 2,
          `状态 ${goodImport.status} imported=${goodImportBody.imported}`);

        const afterGood = await (await fetch(base + '/api/docs', { headers: H2 })).json();
        const afterGoodNames = (afterGood.docs ?? []).map(d => d.name);
        check('导入后库被整体替换为新内容',
          afterGoodNames.includes('__verify_imported_a__.md') && !afterGoodNames.includes('__verify_import_sentinel__.md'),
          `现有 ${afterGoodNames.length} 篇`);

        const importedDoc = await (await fetch(base + '/api/docs/imp-1', { headers: H2 })).json();
        check('导入的正文可读回', importedDoc.doc?.content === '导入正文 A',
          `正文 ${JSON.stringify(importedDoc.doc?.content ?? '').slice(0, 40)}`);

        // 全文索引也要跟着重建：换了库就该能搜到新内容，搜不到旧内容
        const searchAfter = await (await fetch(base + '/api/docs/search?q=' + encodeURIComponent('导入正文'), { headers: H2 })).json();
        const hitIds = (searchAfter.hits ?? []).map(h => h.id);
        check('导入后全文索引被重建（新内容搜得到）',
          hitIds.includes('imp-1'),
          `命中 ${JSON.stringify(hitIds).slice(0, 80)}`);

        const searchOld = await (await fetch(base + '/api/docs/search?q=' + encodeURIComponent('哨兵'), { headers: H2 })).json();
        check('导入后旧文档不再留在索引里',
          (searchOld.hits ?? []).length === 0,
          `仍命中 ${(searchOld.hits ?? []).length} 条`);
      }
    }
  }
}

child.kill();
console.log('\n=== 汇总 ===');
const failed = results.filter(r => !r.ok);
console.log(`  通过 ${results.length - failed.length}/${results.length}` + (failed.length ? '，失败: ' + failed.map(f => f.name).join(', ') : '，全部通过'));
if (failed.length) console.log('\n--- 服务端日志 ---\n' + out.slice(0, 800));
process.exit(failed.length ? 1 : 0);
