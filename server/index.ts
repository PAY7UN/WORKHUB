/**
 * WorkHub 服务端入口。
 * 职责：鉴权、按身份过滤文档、持有模型凭据并以 SSE 转发模型流。
 * 启动：node server/index.ts（Node 22+ 原生 TypeScript，无需编译）
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  AccessCapability,
  AgentSettings,
  DocNode,
} from '../shared/types.ts';
import { ACCESS_CAPABILITY_LABELS } from '../shared/types.ts';
import { MAX_POLISH_CHARS, MAX_RUNNING_POLISH_TASKS } from '../shared/polish.ts';
import { extOf } from '../shared/attachments.ts';
import { DEFAULT_FILE_MIME, guessMime } from '../shared/files.ts';
import { DEFAULT_API_PORT } from '../shared/constants.ts';
import { attachUser, requireAdmin, signToken } from './auth.ts';
import { clearLoginFailures, loginGate, noteLoginFailure } from './loginThrottle.ts';
import { IS_PRODUCTION, SECRET_ORIGIN } from './config.ts';
import { envValue } from './env.ts';
import { displayPath, logger } from './logger.ts';
import {
  countRunningPolishTasks,
  createPolishTask,
  clearFinishedPolishTasks,
  listPolishTasks,
  removePolishTasks,
  subscribePolishTask,
  toView,
} from './polishTasks.ts';
import { readUpstreamStream, type UpstreamMessage } from './upstream.ts';
import { buildAskMessages, retrieveForAsk } from './agentContext.ts';
import { runAgent } from './agent/runtime.ts';
import { DEFAULT_AGENT_ROLE_ID, findAgentRole } from './agent/roles.ts';
import { purgeStashed, stashFile, sweepStashed } from './storage/v2/vault.ts';
import {
  adminPasswordState,
  bulkApproveAccessRequests,
  bulkInsertAccessGrants,
  clearDocAccess,
  countPendingAccessRequests,
  decideAccessRequest,
  decryptDocRow,
  decryptBinaryDocRow,
  defaultRepoId,
  detachSubtree,
  DekUnavailableError,
  encryptBinaryDocRow,
  encryptDocRow,
  findActiveGrant,
  findLatestRequest,
  findPendingRequest,
  findUserById,
  findUserByUsername,
  getAccessGrant,
  getAccessRequest,
  getAgentConfig,
  getAgentConfigPublic,
  getAgentUsageSummary,
  getDoc,
  getDocEncryptionRow,
  insertAccessAudit,
  insertAccessGrant,
  insertAccessRequest,
  insertAgentUsage,
  insertBinaryDoc,
  insertDoc,
  kindOf,
  listAccessAudit,
  listAccessGrants,
  listAccessRequests,
  listAllAccessGrants,
  listAllDocs,
  listKnownGuests,
  parseCapabilities,
  readDocCipher,
  readNodeBytes,
  readNodeRawBytes,
  renameGuestSession,
  revokeAccessGrant,
  rowToUser,
  saveAgentConfig,
  searchDocs,
  updateAccessGrant,
  updateDocRow,
  updateUserPassword,
} from './db.ts';
import { notifyAccessRevoked, subscribeAccessWatch } from './accessWatch.ts';
import { db, DB_PATH, MASTER_KEY } from './db.ts';
import {
  decryptBytes,
  decryptDocContent,
  encryptBytes,
  encryptDocContent,
  unwrapDekWithMaster,
} from './docCrypto.ts';
import { normalizeRagScope } from './docAccess.ts';
import {
  addAttachment,
  checkAttachmentAllowed,
  getAttachment,
  HARD_MAX_FILE_SIZE,
  listAttachments,
  moveAttachment,
  readAttachmentContent,
  removeAttachment,
  renameAttachment,
} from './attachments.ts';
import {
  createRepo,
  deleteRepo,
  findRepoByName,
  getRepo,
  listRepoEvents,
  listRepos,
  moveDocsToRepo,
  repoStats,
  updateRepo,
} from './repos.ts';
import { ensureGuestSession } from './guests.ts';
import { createManageRouter } from './manage.ts';
import { checkForUpdate, startUpgrade } from './updater.ts';
import {
  passwordFingerprint,
  validateNewPassword,
  verifyPassword,
} from './password.ts';

const app = express();
const PORT = Number(envValue('PORT') || DEFAULT_API_PORT);

/**
 * 能力数组的中文标签。
 *
 * 审计流水与日志是给人读的：写成 "view,download" 得让人在脑子里翻译一遍，
 * 而这行字本来就是给人判断「当时开了多大口子」用的。
 */
function capLabel(caps: AccessCapability[]): string {
  return caps.map((c) => ACCESS_CAPABILITY_LABELS[c] ?? c).join('、') || '无';
}

/**
 * 调用上游模型并把增量正文以 SSE 转发给客户端（问答链路，边读边转发）。
 *
 * 上游读取本身已抽出到 server/upstream.ts，与润色后台任务共用同一份实现，
 * 错误映射与空响应判定因此不会在两条链路之间出现分歧；本函数只负责
 * Express 响应的生命周期，包括客户端断开时取消上游请求。
 *
 * 调用方负责创建 SSE 响应头并提供 send/fail。
 */
async function streamUpstream(opts: {
  cfg: AgentSettings;
  messages: UpstreamMessage[];
  res: express.Response;
  send: (event: string, data: unknown) => void;
  fail: (message: string) => void;
}): Promise<void> {
  const { cfg, messages, res, send, fail } = opts;
  const abort = new AbortController();
  // 注意：必须监听 res 而非 req。req 的 close 在请求体读取完毕时即触发，
  // 若绑定在 req 上会在上游返回第一个字节前就取消请求，导致只有 sources 而无正文。
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  await readUpstreamStream({
    cfg,
    messages,
    signal: abort.signal,
    handlers: {
      onReasoning: (text) => send('reasoning', { text }),
      onDelta: (text) => {
        send('delta', { text });
        return true;
      },
      onError: (message) => fail(message),
      onUsage: (usage) => {
        // 落库失败不得影响本次回答：统计是旁路能力，抛错会把已生成完的正文带崩
        try {
          insertAgentUsage({ scene: 'chat', model: cfg.model, usage });
        } catch (e) {
          logger.warn('token 用量记录失败', e);
        }
        send('usage', { ...usage });
      },
    },
  });

  // 上游读取结束时若既未报错也未收到 done，说明是调用方主动中止
  if (!res.writableEnded) res.end();
}

/** 建立 SSE 响应头，返回 send/fail；调用方负责在结束后自行 end() */
function openSse(res: express.Response): {
  send: (event: string, data: unknown) => void;
  fail: (message: string) => void;
} {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  return {
    send: (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    fail: (message: string) => {
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    },
  };
}

/* ------------------------------ 基础中间件 ------------------------------ */

/**
 * 请求体上限。
 *
 * 主要服务于文档导入：单个 md 文件可能相当大，8mb 足够覆盖正常用法，
 * 同时又能防止异常请求把内存吃满。超限会返回 413。
 */
app.use(express.json({ limit: '8mb' }));
// 原件上传走原始字节，不能被 JSON 解析器接管。
// 上限放得比较宽（仓库自己还有一道 maxFileSize 的闸），
// 这里只是防止无界的请求把内存吃满。
app.use(express.raw({ type: 'application/octet-stream', limit: '512mb' }));
app.use((req, res, next) => {
  // 开发期同源部署（Vite 代理）；放开 CORS 便于本地联调
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use('/api', attachUser);

/* ------------------------------ 身份过滤 ------------------------------ */

// 可见性判定与 Agent 检索范围都放在 docAccess.ts：
// 那是安全边界，需要能被单元测试直接覆盖（见 docAccess.test.ts）。

const nowUserId = (req: express.Request) => req.user?.id ?? 'u-admin';

/**
 * 解析请求里的能力项。
 *
 * 只认白名单里的两个值，缺省给 view（只读）。
 * 传了不认的值就当没传——宁可给少，也不要因为一个拼错的字段名
 * 把权限开得比管理员以为的更大。
 */
function readCapabilities(raw: unknown): AccessCapability[] {
  if (!Array.isArray(raw)) return ['view'];
  const valid = raw.filter((c): c is AccessCapability => c === 'view' || c === 'download');
  return valid.length ? valid : ['view'];
}

/* ------------------------------ 认证接口 ------------------------------ */

/**
 * 登录限流的计数键。
 *
 * 取 req.ip 而非用户名：本项目只有 admin 一个账号，按来源统计才能区分
 * 「一个人连输错几次」和「多来源轮番试猜」——后者才是真正需要被拖慢的对象。
 * 取不到 IP 时统一退化为同一个 key，效果等价于全局限流，偏保守但可接受。
 */
const loginThrottleKey = (req: express.Request): string =>
  req.ip ?? req.socket.remoteAddress ?? 'unknown';

app.post('/api/auth/login', (req, res) => {
  const key = loginThrottleKey(req);
  const gate = loginGate(key);
  if (!gate.allowed) {
    res.status(429).json({ error: `登录尝试过于频繁，请 ${gate.retryAfterSeconds} 秒后再试` });
    return;
  }

  const password = String(req.body?.password ?? '');
  const user = findUserByUsername('admin');
  if (!user || !verifyPassword(password, user.password_hash)) {
    // 失败一律计数，不因「账号不存在」而免记——否则那条分支就成了免计数的探针
    noteLoginFailure(key);
    res.status(401).json({ error: '密码错误' });
    return;
  }
  clearLoginFailures(key);
  res.json({
    token: signToken(rowToUser(user), false, passwordFingerprint(user.password_hash)),
    user: rowToUser(user),
    // 密码还是初始值（admin 或 .env 里定的那个）时明确告诉前端，
    // 由它提醒一次「该改了」——服务端只说事实，要不要提醒、怎么提醒是界面的事。
    passwordState: adminPasswordState(),
  });
});

/**
 * 健康检查：进程活着吗，库还能读吗。
 *
 * 只答「能不能用」，不答版本、路径、连接串这类可被利用的信息——
 * 这类接口往往无需鉴权就暴露在对外端口上，报得越细，等于替人做侦察。
 * 库不可用时回 503 而非 200：探针看到 200 就会以为服务健康，把流量继续打过来。
 */
app.get('/api/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'ok', uptime: Math.floor(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'error' });
  }
});

/**
 * 管理接口：给运维面板（托盘 remote 模式）用。
 *
 * 挂在这里而不是散在各处，是为了让「谁能做什么」一目了然：
 * /api/manage/* 认机器令牌，其余接口认用户会话，两套凭证互不通用。
 * 详细说明见 server/manage.ts。
 */
app.use('/api/manage', createManageRouter(db, DB_PATH, { shutdown: gracefulShutdown }));

// 管理员会话版的升级接口。
//
// /api/manage/* 只认机器令牌，而浏览器里的管理后台带的是用户会话——
// 两套凭据互不通用，所以升级这件事得开两扇门。
app.get('/api/admin/update', requireAdmin, async (_req, res) => {
  res.json(await checkForUpdate());
});

app.post('/api/admin/update', requireAdmin, async (_req, res) => {
  const result = await startUpgrade({
    onReady: () => {
      // 响应先发出去再退出，否则前端看到的是连接被掐断，
      // 分不清是「升级失败」还是「服务正在重启」
      setTimeout(() => gracefulShutdown('自动升级'), 300);
    },
  });
  if (!result.ok) {
    res.status(result.status ?? 500).json({ error: result.error ?? '升级失败' });
    return;
  }
  res.json(result);
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    user: req.user,
    isAnon: Boolean(req.isAnon),
    // 带了令牌但服务端不认（已过期 / 密钥轮换 / 改密后指纹不符）时必须明确告知：
    // 否则客户端只看到 role=viewer，无法区分「本来就没登录」与「登录被作废」，
    // 于是继续用本地残留的令牌自称管理员，界面与实际权限长期不一致。
    tokenInvalid: Boolean(req.tokenInvalid),
    // 刷新页面后仍要提醒改密码：这条提醒的依据是「密码还是初始值」这一事实，
    // 不是「刚刚登录过」。只靠登录那一刻回报的话，刷新一次提醒就没了。
    passwordState: req.user?.role === 'admin' ? adminPasswordState() : 'custom',
  });
});

/**
 * 访客会话。
 *
 * 访客不需要账号，但「申请访问 → 审批 → 授权」这条链子得落到具体的人身上，
 * 否则批准之后既给不出去也收不回来。这里发一个 httpOnly cookie 当作访客身份，
 * 服务端据此记住他是谁、改过什么名字。
 *
 * 访客第一次打开页面就会拿到会话——不打扰他，也不记录他在看什么。
 */
app.get('/api/auth/guest', (req, res) => {
  const guest = ensureGuestSession(req, res);
  res.json({ id: guest.id, name: guest.name });
});

/** 访客自报姓名：申请单与授权名单上显示的就是它 */
app.post('/api/auth/guest', (req, res) => {
  const guest = ensureGuestSession(req, res);
  const name = String(req.body?.name ?? '').trim().slice(0, 40);
  if (name) {
    renameGuestSession(guest.id, name);
    res.json({ id: guest.id, name });
    return;
  }
  res.json({ id: guest.id, name: guest.name });
});

/**
 * 修改管理员密码。
 *
 * 要求校验当前密码，而非只看是否已登录：令牌可能在共享设备上残留，
 * 拿到令牌的人不该能在受害者不知情时把密码换掉——那样他就再也进不来了。
 *
 * 改密后返回新令牌：指纹变化会让全部旧令牌立即失效（见 auth.ts verifyToken），
 * 当前这个设备必须换发，否则用户改完密码自己被踢下线。
 */
app.post('/api/auth/change-password', requireAdmin, (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');
  const user = findUserById(req.user!.id);
  if (!user) {
    res.status(404).json({ error: '账号不存在' });
    return;
  }
  if (!verifyPassword(currentPassword, user.password_hash)) {
    // 用 403 而不是 401：前端把 401 一律当成「令牌已作废」，
    // 会清掉本地令牌并把人踢回访客（见 src/lib/api.ts 的 401 分支）。
    // 当前密码输错属于「凭证不对」，不是「未登录」——与文档解锁的口径一致。
    // 用 401 的实际后果：改密失败反而把管理员踢下线，且真正的错因被
    // 「登录已失效，请重新登录」覆盖，用户看到的提示与真实原因完全无关。
    res.status(403).json({ error: '当前密码错误' });
    return;
  }
  const invalid = validateNewPassword(newPassword, currentPassword);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const newHash = updateUserPassword(user.id, newPassword);
  const userView = rowToUser(user);
  res.json({
    token: signToken(userView, false, passwordFingerprint(newHash)),
    user: userView,
  });
});

/* ------------------------------ 文档接口 ------------------------------ */

app.get('/api/docs', (_req, res) => {
  // 访客与管理员看到同一份清单：「对访客隐藏」已下线，保密由加密承担
  res.json({ docs: listAllDocs() });
});

/**
 * 全文搜索：在标题与正文里找关键词。
 *
 * 访客与管理员都能搜：搜的只是非加密文档的明文，访客本来就能读这些正文；
 * 加密文档的正文在库里只有密文，搜不到内容——这条边界由存储方式自动成立，
 * 不靠这里额外的判断分支撑着。
 *
 * 路由顺序要紧：Express 按注册顺序匹配，
 * 「/api/docs/:id」必须排在「/api/docs/search」后面，
 * 否则 search 会被当成一个 id 为 search 的文档。
 */
app.get('/api/docs/search', (req, res) => {
  const query = String(req.query.q ?? '');
  res.json({ query: query.trim(), hits: searchDocs(query, 50) });
});

/**
 * 取单篇文档（含正文）。
 *
 * 清单接口只回元数据：正文已经落到仓库目录的文件里，
 * 一次列全站就等于把整个仓库读一遍——打开一篇要一篇，
 * 这条接口就是打开那一篇的入口。
 *
 * 加密文档这里不给正文：服务端只有密文，明文要走 reveal / access-open，
 * 那两条路才带权限判断。
 */
app.get('/api/docs/:id', (req, res) => {
  const doc = getDoc(String(req.params.id));
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  res.json({ doc });
});

app.post('/api/docs', requireAdmin, (req, res) => {
  const { name, type, parentId, content } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: '名称不能为空' });
    return;
  }
  if (type !== 'file' && type !== 'folder') {
    res.status(400).json({ error: '类型必须是 file 或 folder' });
    return;
  }
  const all = listAllDocs();
  // 「承载附件的文档条目」要保留原始文件名（如「方案.docx」），
  // 不能被自动补成「方案.docx.md」——rawName 就是这个开关。
  const keepRawName = req.body?.rawName === true;
  const finalName =
    type === 'file' && !keepRawName && !name.toLowerCase().endsWith('.md') ? `${name}.md` : name.trim();
  if (all.some((d) => d.parentId === (parentId ?? null) && d.name === finalName)) {
    res.status(409).json({ error: '同级目录下已存在同名文档' });
    return;
  }
  if (parentId) {
    const parent = all.find((d) => d.id === parentId);
    if (!parent || parent.type !== 'folder') {
      res.status(400).json({ error: '父节点不存在或不是文件夹' });
      return;
    }
  }
  const ts = Date.now();
  const text = type === 'file' ? String(content ?? '') : '';
  // 仓库归属是必填的：文档没有「未归档」这种状态。
  // 取值顺序是「显式指定 → 跟随父节点 → 默认仓库」，
  // 这样「新建在某个仓库的目录下」自然就属于那个仓库。
  const requestedRepoId = typeof req.body?.repoId === 'string' ? req.body.repoId.trim() : '';
  const parentRepoId = parentId ? all.find((d) => d.id === parentId)?.repoId ?? '' : '';
  const repoId = requestedRepoId || parentRepoId || defaultRepoId();
  if (!getRepo(repoId)) {
    res.status(400).json({ error: '仓库不存在' });
    return;
  }
  const doc: DocNode = {
    id: `d-${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: finalName,
    type,
    parentId: parentId ?? null,
    content: type === 'file' ? text : undefined,
    size: type === 'file' ? Buffer.byteLength(text, 'utf8') : undefined,
    createdAt: ts,
    updatedAt: ts,
    createdBy: nowUserId(req),
    updatedBy: nowUserId(req),
    repoId,
  };
  const inserted = insertDoc(doc);
  res.status(201).json({ doc: inserted });
});

/**
 * 上传原件：请求体就是文件的字节，文件名与 MIME 走 query。
 *
 * 为什么单独开一条路，而不是把文件塞进 POST /api/docs 的 JSON：
 * JSON 装不下二进制（得 base64 膨胀三分之一），
 * 而「上传一个 zip，顺手给它造一篇同名空笔记」正是这里要消灭的行为。
 * 上传 zip 就该得到一个 zip 节点——不需要谁再给它配一份备注。
 */
app.post('/api/docs/upload', requireAdmin, (req, res) => {
  const name = String(req.query.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: '缺少文件名' });
    return;
  }
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (data.length === 0) {
    res.status(400).json({ error: '文件内容为空' });
    return;
  }

  const all = listAllDocs();
  const parentId = typeof req.query.parentId === 'string' && req.query.parentId ? req.query.parentId : null;
  let parentRepoId = '';
  if (parentId) {
    const parent = all.find((d) => d.id === parentId);
    if (!parent || parent.type !== 'folder') {
      res.status(400).json({ error: '父节点不存在或不是文件夹' });
      return;
    }
    parentRepoId = parent.repoId ?? '';
  }
  const requestedRepoId = typeof req.query.repoId === 'string' ? req.query.repoId.trim() : '';
  const repoId = requestedRepoId || parentRepoId || defaultRepoId();
  const repo = getRepo(repoId);
  if (!repo) {
    res.status(400).json({ error: '仓库不存在' });
    return;
  }

  // 仓库的格式白名单与体积上限在这里生效，与附件走同一道闸
  const check = checkAttachmentAllowed(repo, name, data.length);
  if (!check.ok) {
    res.status(400).json({ error: check.reason });
    return;
  }

  const mime = guessMime(name, typeof req.query.mime === 'string' ? req.query.mime : undefined);
  const ext = extOf(name);
  const ts = Date.now();
  const doc = insertBinaryDoc({
    id: `d-${ts.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    repoId,
    name,
    parentId,
    mime,
    ext,
    data,
    createdBy: nowUserId(req),
    createdAt: ts,
  });
  logger.info('已上传原件', name, `${data.length} 字节`);
  res.status(201).json({ doc });
});

/**
 * 取原件的字节；加密态下顺带解密。
 *
 * 权限判定留给调用方：这里只管「把字节拿出来」。
 *
 * 加密态下盘上是密文，不是「原件丢了」——所以这里读的是盘上那份密文，
 * 用主密钥取回数据密钥解开，再交出明文字节。
 */
function originalBytesOf(doc: DocNode): Buffer | null {
  if (!doc.encrypted) return readNodeBytes(doc.id) ?? null;
  const row = getDocEncryptionRow(doc.id);
  const dek = row?.enc_master_dek ? unwrapDekWithMaster(row.enc_master_dek, MASTER_KEY) : null;
  if (!dek) return null;
  const cipher = readNodeRawBytes(doc.id);
  if (!cipher) return null;
  return decryptBytes(cipher.toString('utf8'), dek);
}

/**
 * 取加密笔记的明文正文。
 *
 * 笔记的「原件」就是它的正文：下载加密笔记要拿到的是明文 .md，
 * 不是空文件（doc.content 对加密文档一律是 undefined），
 * 更不是密文。解密在服务端做完，浏览器拿到的始终是明文。
 */
function plainNoteOf(docId: string): string | null {
  const row = getDocEncryptionRow(docId);
  const dek = row?.enc_master_dek ? unwrapDekWithMaster(row.enc_master_dek, MASTER_KEY) : null;
  if (!dek) return null;
  const cipher = readDocCipher(docId);
  if (!cipher) return null;
  return decryptDocContent(cipher, dek);
}

/**
 * 下载原件或导出笔记。
 *
 * 一条路由覆盖「不同文件的下载」：
 * - kind='file' → 原样回传字节，Content-Type 是它自己的 MIME，文件名保留原名；
 * - kind='note' → 导出为 .md 文本，文件名补 .md 后缀。
 *
 * 加密文档要走权限：管理员直接放行；访客得有有效授权，
 * 而且授权里必须显式带 download 能力——「能看」不等于「能拿走」。
 */
app.get('/api/docs/:id/download', (req, res) => {
  const id = String(req.params.id);
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }

  if (doc.encrypted) {
    const isAdmin = req.user?.role === 'admin';
    if (!isAdmin) {
      const guest = ensureGuestSession(req, res);
      const grant = findActiveGrant(id, guest.id);
      if (!grant) {
        res.status(403).json({ error: '你没有该文档的访问权限' });
        return;
      }
      if (!parseCapabilities(grant.capabilities).includes('download')) {
        res.status(403).json({ error: '你的访问授权只允许查看，不包含下载' });
        return;
      }
      insertAccessAudit({
        docId: id,
        action: 'download',
        actorId: guest.id,
        actorName: guest.name,
        detail: '下载加密文档',
      });
    }
  }

  if (doc.kind === 'file') {
    const data = originalBytesOf(doc);
    if (!data) {
      res.status(404).json({ error: '文件不存在或内容已丢失' });
      return;
    }
    res.setHeader('Content-Type', doc.mime || DEFAULT_FILE_MIME);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
    );
    res.send(data);
    return;
  }

  // 笔记导出为 .md：名字里已经有 .md 就不重复加
  const fileName = doc.name.toLowerCase().endsWith('.md') ? doc.name : `${doc.name}.md`;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  if (doc.encrypted) {
    // 加密笔记的正文是密文，doc.content 拿不到明文——
    // 直接发出去会得到一个「下载成功但内容为空」的 .md。
    const plain = plainNoteOf(doc.id);
    if (plain === null) {
      res.status(500).json({ error: '无法解密该文档，请检查服务端密钥是否被更换' });
      return;
    }
    res.send(plain);
    return;
  }
  res.send(doc.content ?? '');
});

/**
 * 内联预览原件：<img>、<iframe> 直接指这里。
 *
 * 与 download 的区别只在 Content-Disposition：这里是 inline，
 * 浏览器自己决定是显示还是另存。
 *
 * 加密原件也允许内联，但得先过权限：管理员直接放行，访客要有一条
 * 有效的「查看」授权。解密在服务端做完——密文进了 <img> 只会是一片噪点。
 */
app.get('/api/docs/:id/raw', (req, res) => {
  const id = String(req.params.id);
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  if (doc.kind !== 'file') {
    res.status(400).json({ error: '该文档不是文件' });
    return;
  }
  if (doc.encrypted) {
    const isAdmin = req.user?.role === 'admin';
    if (!isAdmin) {
      const guest = ensureGuestSession(req, res);
      const grant = findActiveGrant(id, guest.id);
      if (!grant) {
        res.status(403).json({ error: '你没有该文档的访问权限' });
        return;
      }
      if (!parseCapabilities(grant.capabilities).includes('view')) {
        res.status(403).json({ error: '你的访问授权不包含查看' });
        return;
      }
    }
  }
  const data = originalBytesOf(doc);
  if (!data) {
    res.status(404).json({ error: '文件不存在或内容已丢失' });
    return;
  }
  res.setHeader('Content-Type', doc.mime || DEFAULT_FILE_MIME);
  res.setHeader('Content-Length', String(data.length));
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
  );
  // 内容寻址：原件的字节不会变，浏览器可以安心缓存
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(data);
});

app.patch('/api/docs/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!getDoc(id)) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  const body = req.body ?? {};
  const patch: Partial<DocNode> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.content === 'string') patch.content = body.content;
  if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
  if (body.parentId !== undefined) {
    const target = body.parentId as string | null;
    if (target) {
      const all = listAllDocs();
      const parent = all.find((d) => d.id === target);
      if (!parent || parent.type !== 'folder') {
        res.status(400).json({ error: '目标目录不存在' });
        return;
      }
      // 禁止移动到自身或自身子孙
      const stmt = db.prepare('WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id = ? UNION ALL SELECT d.id FROM nodes d JOIN sub ON d.parent_id = sub.id) SELECT id FROM sub');
      if ((stmt.all(id) as { id: string }[]).some((r) => r.id === target)) {
        res.status(400).json({ error: '不能移动到自身或其子目录' });
        return;
      }
    }
    patch.parentId = target ?? null;
  }
  try {
    updateDocRow(id, patch, nowUserId(req));
  } catch (err) {
    // 加密文档的数据密钥取不回：主密钥（WORKHUB_SECRET）与库里的密文已对不上。
    // 这时必须让保存失败并说清楚原因——返回 200 的话，编辑器会以为存好了，
    // 而正文其实还停在旧版本，是一场看不见的数据丢失。
    if (err instanceof DekUnavailableError) {
      res.status(500).json({
        error: '保存失败：服务端密钥无法解密该文档，请检查 WORKHUB_SECRET 是否被更换',
      });
      return;
    }
    throw err;
  }
  res.json({ doc: getDoc(id) });
});

/**
 * 删除文档。
 *
 * 没有回收站：删就是删，连子孙带正文一起消失，不可恢复。
 * 之所以敢这么做，是因为正文本来就有版本管理的诉求在别处解决
 * （内容层面的备份、导出），而不是靠「先留着再删」这种假后悔。
 */
app.delete('/api/docs/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!getDoc(id)) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  // 库里的痕迹先摘干净，正文和附件挪进暂存区（改名几乎不花钱），
  // 真正的删除丢给后台。
  //
  // 为什么不能同步删：Windows 上 unlink 一个文件要一百多毫秒——杀软要逐个
  // 扫一遍才肯放手。删一个装着几十个文件的文件夹就是好几秒，这几秒里
  // 请求线程被占着，整个 API 都在打转，前端干等着收不到响应，界面看着
  // 像「点了没反应」。
  //
  // 为什么后台删也不能放在主线程上：那串 unlink 排队能把事件循环饿死——
  // 定时器和 socket 都排不上队，删完那一下的下一个请求直接 ECONNRESET。
  // 所以真正的删除发生在清道夫线程里（见 vault.ts）。
  const { removed, files, dirs } = detachSubtree(id);
  const stashed = files.map(stashFile).filter((p): p is string => !!p);
  res.json({ removed });
  purgeStashed(stashed, dirs);
});

/* ------------------------------ 仓库 ------------------------------ */

/**
 * 仓库清单。
 *
 * 访客也能读：仓库只是资料的组织方式，不是保密边界。
 * 保密仍然只由加密承担——这里放开不会让不该看的人看到密文。
 */
app.get('/api/repos', (_req, res) => {
  res.json({ repos: listRepos(), stats: repoStats() });
});

/**
 * 仓库历史（项目仓库的流水）。
 *
 * 只给管理员：仓库名与规则不算秘密，但「这个项目什么时候没的、
 * 当时带走了多少东西」这种账没必要让访客也看见。
 */
app.get('/api/repos/events', requireAdmin, (_req, res) => {
  res.json({ events: listRepoEvents() });
});

app.post('/api/repos', requireAdmin, (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: '仓库名称不能为空' });
    return;
  }
  if (findRepoByName(name)) {
    res.status(409).json({ error: '已存在同名仓库' });
    return;
  }
  const repo = createRepo({
    name,
    description: typeof req.body?.description === 'string' ? req.body.description : '',
    color: typeof req.body?.color === 'string' ? req.body.color : undefined,
    allowedExts: Array.isArray(req.body?.allowedExts)
      ? req.body.allowedExts.map((e: unknown) => String(e).toLowerCase().trim()).filter(Boolean)
      : [],
    maxFileSize: typeof req.body?.maxFileSize === 'number' ? req.body.maxFileSize : undefined,
    ragEnabled: req.body?.ragEnabled !== false,
    createdBy: nowUserId(req),
  });
  res.status(201).json({ repo });
});

app.patch('/api/repos/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!getRepo(id)) {
    res.status(404).json({ error: '仓库不存在' });
    return;
  }
  const body = req.body ?? {};
  const patch: Parameters<typeof updateRepo>[1] = {};
  if (typeof body.name === 'string' && body.name.trim()) {
    const name = body.name.trim();
    const clash = findRepoByName(name);
    if (clash && clash.id !== id) {
      res.status(409).json({ error: '已存在同名仓库' });
      return;
    }
    patch.name = name;
  }
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.color === 'string') patch.color = body.color;
  if (Array.isArray(body.allowedExts)) {
    patch.allowedExts = body.allowedExts.map((e: unknown) => String(e).toLowerCase().trim()).filter(Boolean);
  }
  if (typeof body.maxFileSize === 'number') patch.maxFileSize = body.maxFileSize;
  if (typeof body.ragEnabled === 'boolean') patch.ragEnabled = body.ragEnabled;
  res.json({ repo: updateRepo(id, patch, nowUserId(req)) });
});

/**
 * 删仓库。
 *
 * 没有回收站：目录整个删掉，里面的文档与附件一并消失，不可恢复。
 */
app.delete('/api/repos/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!getRepo(id)) {
    res.status(404).json({ error: '仓库不存在' });
    return;
  }
  try {
    res.json(deleteRepo(id, nowUserId(req)));
  } catch (e) {
    // 目录没删掉就等于没删成功：仓库行留着，用户能看见、还能再试一次。
    // 把原因说清楚，比报个 500 然后留下满地孤儿文件强。
    res.status(500).json({ error: `仓库删不掉：${(e as Error).message}` });
  }
});

/**
 * 把文档归入仓库（跨仓库迁移）。
 *
 * 搬的是整棵子树：孩子跟着爹走，否则父子会分属两个仓库，
 * 按仓库过滤文件树时就会出现「爹在、孩子不在」的错位。
 */
app.post('/api/repos/:id/docs', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!getRepo(id)) {
    res.status(404).json({ error: '仓库不存在' });
    return;
  }
  const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds.map(String) : [];
  if (!docIds.length) {
    res.status(400).json({ error: '请至少选择一篇文档' });
    return;
  }
  res.json({ moved: moveDocsToRepo(docIds, id, nowUserId(req)) });
});

/* ------------------------------ 附件 ------------------------------ */

/**
 * 上传附件。
 *
 * 请求体是**原始二进制**，不是 multipart：
 * 文件格式千差万别，但「一个文件一段字节」这件事是统一的，
 * 用裸二进制可以省掉一套 multipart 解析，也避免 base64 带来的三分之一体积膨胀。
 * 文件名放在查询参数里（前端做了 URL 编码）。
 */
app.post(
  '/api/docs/:id/attachments',
  requireAdmin,
  express.raw({ type: '*/*', limit: HARD_MAX_FILE_SIZE }),
  async (req, res) => {
    const docId = String(req.params.id);
    const doc = getDoc(docId);
    if (!doc) {
      res.status(404).json({ error: '文档不存在' });
      return;
    }
    if (doc.encrypted) {
      res.status(403).json({ error: '加密文档不接收附件：附件正文会进入检索范围' });
      return;
    }

    const rawName = String(req.query.name ?? '');
    let filename = '';
    try {
      filename = decodeURIComponent(rawName);
    } catch {
      filename = rawName;
    }
    if (!filename.trim()) {
      res.status(400).json({ error: '缺少文件名' });
      return;
    }

    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const repo = doc.repoId ? getRepo(doc.repoId) : undefined;
    const check = checkAttachmentAllowed(repo, filename, data.length);
    if (!check.ok) {
      res.status(400).json({ error: check.reason });
      return;
    }

    // 真实 MIME 走查询参数：请求体固定用 application/octet-stream，
    // 否则上传 .json 文件时会被全局的 JSON 解析器抢走并报「非法 JSON」。
    let mime = 'application/octet-stream';
    try {
      const rawMime = String(req.query.mime ?? '');
      if (rawMime) mime = decodeURIComponent(rawMime);
    } catch {
      mime = 'application/octet-stream';
    }

    const attachment = await addAttachment({
      docId,
      name: filename.trim(),
      mime,
      data,
      createdBy: nowUserId(req),
    });
    res.status(201).json({ attachment });
  },
);

/** 某篇文档的附件清单 */
app.get('/api/docs/:id/attachments', (req, res) => {
  const docId = String(req.params.id);
  if (!getDoc(docId)) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  res.json({ attachments: listAttachments(docId) });
});

/** 下载附件：按原始文件名回传，浏览器据此决定怎么打开 */
app.get('/api/attachments/:id/download', (req, res) => {
  const id = String(req.params.id);
  const found = readAttachmentContent(id);
  if (!found) {
    res.status(404).json({ error: '附件不存在或内容已丢失' });
    return;
  }
  res.setHeader('Content-Type', found.attachment.mime || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(found.attachment.name)}`,
  );
  res.send(found.data);
});

/** 附件改名 */
app.patch('/api/attachments/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: '文件名不能为空' });
    return;
  }
  const attachment = renameAttachment(id, name);
  if (!attachment) {
    res.status(404).json({ error: '附件不存在' });
    return;
  }
  res.json({ attachment });
});

/**
 * 移动附件：换一篇文档挂着。
 *
 * 只改宿主指针，不搬字节——内容寻址下同一份内容在磁盘上只有一份。
 */
app.post('/api/attachments/:id/move', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const targetDocId = typeof req.body?.docId === 'string' ? req.body.docId : '';
  if (!targetDocId) {
    res.status(400).json({ error: '请指定目标文档' });
    return;
  }
  const attachment = moveAttachment(id, targetDocId);
  if (!attachment) {
    res.status(404).json({ error: '附件不存在，或目标文档不在架上' });
    return;
  }
  res.json({ attachment });
});

/**
 * 删除附件。
 *
 * 没有回收站：行与磁盘上的文件一起消失，不可恢复。
 */
app.delete('/api/attachments/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  if (!getAttachment(id)) {
    res.status(404).json({ error: '附件不存在' });
    return;
  }
  res.json({ removed: removeAttachment(id) });
});

/* ------------------------------ 文档加密 ------------------------------ */

/**
 * 把文档置为加密态。
 *
 * 加密后正文只以密文落库，访客一律看不到内容。
 * 访问方式只有一条路：访客提交访问申请 → 管理员批准 → 访客凭授权免密打开。
 *
 * 服务端不再签发、也不再存储任何访客口令：
 * 数据密钥只由主密钥包裹，没有第二把钥匙，也就没有「密码被拖库」的风险。
 */
app.post('/api/docs/:id/encrypt', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  if (doc.type !== 'file') {
    res.status(400).json({ error: '文件夹没有正文，无需加密' });
    return;
  }
  if (doc.encrypted) {
    res.status(409).json({ error: '文档已加密' });
    return;
  }
  // 原件与笔记走两条路：笔记加密的是正文文本，原件加密的是字节本身。
  // 原件也必须真的加密——把 zip 标成「已加密」却让它继续以明文躺在磁盘上，
  // 只是给用户一个它加密了的错觉。
  if (doc.kind === 'file') {
    const plain = readNodeBytes(id);
    if (!plain) {
      res.status(404).json({ error: '文件不存在或内容已丢失，无法加密' });
      return;
    }
    const material = encryptBytes(plain, MASTER_KEY);
    if (!encryptBinaryDocRow(id, material, nowUserId(req))) {
      res.status(500).json({ error: '加密失败：无法写入文件' });
      return;
    }
    logger.info('原件已加密', doc.name, `${plain.length} 字节`);
    res.json({ doc: getDoc(id) });
    return;
  }
  const material = encryptDocContent(doc.content ?? '', MASTER_KEY);
  encryptDocRow(id, material, nowUserId(req));
  logger.info('文档已加密', doc.name);
  res.json({ doc: getDoc(id) });
});

/**
 * 申请访问一篇加密文档。
 *
 * 这是「获取权限」而不是「索取密码」：访客说明来意，管理员看到后决定批不批。
 * 批了之后访客凭自己的会话就能打开，不必再记一个密码、也不必再问一次人。
 */
app.post('/api/docs/:id/access-request', (req, res) => {
  const id = String(req.params.id);
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  if (!doc.encrypted) {
    res.status(400).json({ error: '该文档未加密，无需申请' });
    return;
  }
  const guest = ensureGuestSession(req, res);
  if (findActiveGrant(id, guest.id)) {
    res.status(409).json({ error: '你已获得该文档的访问权限' });
    return;
  }
  if (findPendingRequest(id, guest.id)) {
    res.status(409).json({ error: '申请已在处理中，请等待管理员确认' });
    return;
  }
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200);
  const request = insertAccessRequest({
    id: randomUUID(),
    docId: id,
    guestId: guest.id,
    guestName: guest.name,
    reason,
  });
  insertAccessAudit({
    docId: id,
    action: 'request',
    actorId: guest.id,
    actorName: guest.name,
    detail: reason || '（未填写理由）',
  });
  logger.info('收到文档访问申请', doc.name, guest.name);
  res.status(201).json({ request });
});

/**
 * 凭已批准的授权打开文档（访客免密）。
 *
 * 打开失败时会把「为什么」一并告诉前端：没申请、正在审、被拒——
 * 前端据此显示不同的界面，而不是笼统一句「无权限」。
 */
app.post('/api/docs/:id/access-open', (req, res) => {
  const id = String(req.params.id);
  const row = getDocEncryptionRow(id);
  if (!row || row.encrypted !== 1) {
    res.status(404).json({ error: '文档不存在或未加密' });
    return;
  }
  const guest = ensureGuestSession(req, res);
  const grant = findActiveGrant(id, guest.id);
  if (!grant) {
    const pending = findPendingRequest(id, guest.id);
    const latest = pending ?? findLatestRequest(id, guest.id);
    const reason = pending ? 'pending' : latest?.status === 'rejected' ? 'rejected' : 'none';
    res.status(403).json({
      error:
        reason === 'pending'
          ? '申请正在等待管理员确认'
          : reason === 'rejected'
            ? '你的访问申请被拒绝了'
            : '你还没有该文档的访问权限',
      reason,
    });
    return;
  }
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  if (kindOf(row) === 'file') {
    // 原件没有「正文」可解：它的字节由 /raw 与 /download 在授权下解密回传。
    // 这里只确认授权有效，并把「谁打开了它」记进审计流水。
    insertAccessAudit({
      docId: id,
      action: 'open',
      actorId: guest.id,
      actorName: guest.name,
      detail: `能力：${capLabel(parseCapabilities(grant.capabilities))}`,
    });
    logger.info('访客凭授权打开加密原件', doc.name, guest.name);
    res.json({ doc: { ...doc, content: '', unlocked: true } });
    return;
  }
  const dek = row.enc_master_dek ? unwrapDekWithMaster(row.enc_master_dek, MASTER_KEY) : null;
  const cipher = readDocCipher(id);
  if (!dek || !cipher) {
    res.status(500).json({ error: '无法解密该文档，请检查服务端密钥是否被更换' });
    return;
  }
  const plain = decryptDocContent(cipher, dek);
  if (plain === null) {
    res.status(500).json({ error: '文档解密失败' });
    return;
  }
  insertAccessAudit({
    docId: id,
    action: 'open',
    actorId: guest.id,
    actorName: guest.name,
    detail: `能力：${capLabel(parseCapabilities(grant.capabilities))}`,
  });
  logger.info('访客凭授权打开加密文档', doc.name, guest.name);
  res.json({ doc: { ...doc, content: plain, unlocked: true } });
});

/**
 * 查访客此刻对某篇加密文档的权限状态（不返回正文）。
 *
 * 这是给轮询用的：访客提交申请后就该盯着这个接口，
 * 管理员一批准，界面自己就翻到正文——而不是让人守在页面上
 * 手动点「我已获批，重新检查」。
 *
 * 刻意不返回正文：轮询每几秒就跑一次，每次捎一份明文既费带宽
 * 也扩大明文在网络上的暴露面。真要正文时另走 access-open。
 */
app.get('/api/docs/:id/access-status', (req, res) => {
  const id = String(req.params.id);
  const row = getDocEncryptionRow(id);
  if (!row || row.encrypted !== 1) {
    res.status(404).json({ error: '文档不存在或未加密' });
    return;
  }
  const guest = ensureGuestSession(req, res);
  const active = findActiveGrant(id, guest.id);
  if (active) {
    // 把口子开多大一并告诉前端：只给了「查看」的授权，
    // 前端就不该摆出下载按钮——让用户点下去再吃一个 403 是白折腾。
    res.json({
      granted: true,
      reason: 'granted',
      capabilities: parseCapabilities(active.capabilities),
    });
    return;
  }
  const pending = findPendingRequest(id, guest.id);
  const latest = pending ?? findLatestRequest(id, guest.id);
  const reason = pending ? 'pending' : latest?.status === 'rejected' ? 'rejected' : 'none';
  res.json({ granted: false, reason });
});

/**
 * 访问权监听（SSE）：授权一失效就通知访客。
 *
 * 撤销与过期都走这条通道——管理员点「收回」，对方屏幕上那份明文
 * 必须在同一秒消失，而不是等他下次请求才发现。
 * 详见 server/accessWatch.ts。
 */
app.get('/api/docs/:id/access-watch', (req, res) => {
  const id = String(req.params.id);
  const row = getDocEncryptionRow(id);
  if (!row || row.encrypted !== 1) {
    res.status(404).json({ error: '文档不存在或未加密' });
    return;
  }
  const guest = ensureGuestSession(req, res);
  if (!findActiveGrant(id, guest.id)) {
    res.status(403).json({ error: '你还没有该文档的访问权限' });
    return;
  }
  subscribeAccessWatch(req, res, id, guest.id);
});

/**
 * 管理员免密查看加密文档的正文。
 *
 * 访客侧的口令不是把管理员挡在门外的锁：
 * 服务端本就持有被主密钥包裹的数据密钥（enc_master_dek），
 * 管理员用自己的主密钥就能把它解开——取消加密走的也是这条路。
 * 让管理员先向自己要一次审批才看得到自己管理的文档，
 * 只是把一次点击换成了一次点击，并没有多出任何安全性。
 *
 * 解密全程在服务端完成：正文密文从不下发到浏览器，
 * 免密只免掉「先申请再打开」这一步，不免掉密文本身。
 */
app.post('/api/docs/:id/reveal', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const row = getDocEncryptionRow(id);
  if (!row || row.encrypted !== 1) {
    res.status(404).json({ error: '文档不存在或未加密' });
    return;
  }
  const dek = row.enc_master_dek ? unwrapDekWithMaster(row.enc_master_dek, MASTER_KEY) : null;
  const cipher = readDocCipher(id);
  if (!dek || !cipher) {
    res.status(500).json({ error: '无法解密该文档，请检查服务端密钥是否被更换' });
    return;
  }
  const plain = decryptDocContent(cipher, dek);
  if (plain === null) {
    res.status(500).json({ error: '文档解密失败' });
    return;
  }
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  // 留痕：谁在什么时候看了加密文档的正文，事后查得到
  logger.info('管理员已解密查看加密文档', doc.name);
  res.json({ doc: { ...doc, content: plain, unlocked: true } });
});

/**
 * 取消加密：明文写回 content 列，加密材料全部清空。
 * 之后这篇文档就回到普通文档的行列（访客可见、Agent 可检索）。
 */
app.post('/api/docs/:id/decrypt', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const row = getDocEncryptionRow(id);
  if (!row || row.encrypted !== 1) {
    res.status(404).json({ error: '文档不存在或未加密' });
    return;
  }
  const dek = row.enc_master_dek ? unwrapDekWithMaster(row.enc_master_dek, MASTER_KEY) : null;
  if (!dek) {
    res.status(500).json({ error: '无法解密该文档' });
    return;
  }
  // 原件解出来的是字节，笔记解出来的是文本：两条路都要走
  if (kindOf(row) === 'file') {
    const cipher = readNodeRawBytes(id);
    if (!cipher) {
      res.status(404).json({ error: '文件不存在或内容已丢失' });
      return;
    }
    const plain = decryptBytes(cipher.toString('utf8'), dek);
    if (plain === null) {
      res.status(500).json({ error: '文档解密失败' });
      return;
    }
    decryptBinaryDocRow(id, plain, nowUserId(req));
    clearDocAccess(id);
    logger.info('原件已取消加密', row.name);
    res.json({ doc: getDoc(id) });
    return;
  }
  const cipher = readDocCipher(id);
  if (!cipher) {
    res.status(500).json({ error: '无法解密该文档' });
    return;
  }
  const plain = decryptDocContent(cipher, dek);
  if (plain === null) {
    res.status(500).json({ error: '文档解密失败' });
    return;
  }
  decryptDocRow(id, plain, nowUserId(req));
  // 文档不再加密，挂在它身上的申请与授权也就没有意义了，清掉免得管理端显示一堆过期授权
  clearDocAccess(id);
  logger.info('文档已取消加密', row.name);
  res.json({ doc: getDoc(id) });
});

/* ------------------------------ 访问授权管理 ------------------------------ */

/**
 * 访问申请列表（管理员）。
 *
 * 默认只看待处理：管理员打开面板要处理的是「等着回话的人」，
 * 已批过的历史在另一处（授权名单）看。
 */
app.get('/api/access-requests', requireAdmin, (req, res) => {
  const statusParam = String(req.query.status ?? 'pending');
  const status = (['pending', 'approved', 'rejected', 'all'] as const).includes(
    statusParam as 'pending',
  )
    ? (statusParam as 'pending' | 'approved' | 'rejected' | 'all')
    : 'pending';
  const docId = typeof req.query.docId === 'string' && req.query.docId ? req.query.docId : undefined;
  const items = listAccessRequests({ status, docId }).map((r) => ({
    id: r.id,
    docId: r.doc_id,
    docName: r.doc_name ?? '（文档已删除）',
    guestId: r.guest_id,
    guestName: r.guest_name,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
  }));
  res.json({ items, pending: countPendingAccessRequests() });
});

/**
 * 批准访问申请。
 *
 * 批准即授权：给这个访客在这篇文档上开一道口子，之后他打开即见，不必再问密码。
 * expiresInDays 为 0 或不传表示长期有效；给了天数就是到期自动失效——
 * 「临时给看一眼」和「长期开放」是两种需求，不该只有一个开关。
 *
 * capabilities 决定这条口子开多大：默认只有 view（能看），
 * 要放行下载得显式勾 download（能拿走）。默认收紧而不是默认放开——
 * 「顺手多给一个权限」造成的泄露，事后没人会记得是自己点的。
 */
app.post('/api/access-requests/:rid/approve', requireAdmin, (req, res) => {
  const rid = String(req.params.rid);
  const request = getAccessRequest(rid);
  if (!request) {
    res.status(404).json({ error: '申请不存在' });
    return;
  }
  if (request.status !== 'pending') {
    res.status(409).json({ error: '该申请已被处理' });
    return;
  }
  const doc = getDoc(request.doc_id);
  if (!doc || !doc.encrypted) {
    res.status(400).json({ error: '文档不存在或已取消加密' });
    return;
  }
  const days = Number(req.body?.expiresInDays ?? 0);
  const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
  const capabilities = readCapabilities(req.body?.capabilities);
  const grant = insertAccessGrant({
    id: randomUUID(),
    docId: request.doc_id,
    guestId: request.guest_id,
    guestName: request.guest_name,
    grantedBy: nowUserId(req),
    expiresAt,
    capabilities,
  });
  decideAccessRequest(rid, 'approved', nowUserId(req), expiresAt);
  insertAccessAudit({
    docId: request.doc_id,
    action: 'approve',
    actorId: nowUserId(req),
    actorName: req.user?.username ?? '管理员',
    detail: `批准给 ${request.guest_name}；能力：${capLabel(capabilities)}${
      expiresAt ? `；${days} 天后到期` : '；长期有效'
    }`,
  });
  logger.info('已批准文档访问申请', doc.name, request.guest_name);
  res.json({ grant: { ...grant, capabilities } });
});

/** 拒绝访问申请 */
app.post('/api/access-requests/:rid/reject', requireAdmin, (req, res) => {
  const rid = String(req.params.rid);
  const request = getAccessRequest(rid);
  if (!request) {
    res.status(404).json({ error: '申请不存在' });
    return;
  }
  if (request.status !== 'pending') {
    res.status(409).json({ error: '该申请已被处理' });
    return;
  }
  decideAccessRequest(rid, 'rejected', nowUserId(req), null);
  insertAccessAudit({
    docId: request.doc_id,
    action: 'reject',
    actorId: nowUserId(req),
    actorName: req.user?.username ?? '管理员',
    detail: `拒绝 ${request.guest_name} 的申请`,
  });
  logger.info('已拒绝文档访问申请', getDoc(request.doc_id)?.name ?? request.doc_id, request.guest_name);
  res.json({ ok: true });
});

/** 全部授权总览：跨文档看「谁被授权看过什么」 */
app.get('/api/access-grants', requireAdmin, (_req, res) => {
  res.json({
    items: listAllAccessGrants().map((g) => ({
      id: g.id,
      docId: g.doc_id,
      docName: g.doc_name ?? '（文档已删除）',
      guestId: g.guest_id,
      guestName: g.guest_name,
      grantedAt: g.granted_at,
      expiresAt: g.expires_at,
      revokedAt: g.revoked_at,
      capabilities: parseCapabilities(g.capabilities),
    })),
  });
});

/** 某篇文档的授权名单（含已撤销的，方便看出「谁曾经能看」） */
app.get('/api/docs/:id/access-grants', requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: '文档不存在' });
    return;
  }
  res.json({
    items: listAccessGrants(id).map((g) => ({
      id: g.id,
      docId: g.doc_id,
      docName: doc.name,
      guestId: g.guest_id,
      guestName: g.guest_name,
      grantedAt: g.granted_at,
      expiresAt: g.expires_at,
      revokedAt: g.revoked_at,
      capabilities: parseCapabilities(g.capabilities),
    })),
  });
});

/**
 * 访问审计流水（管理员）。
 *
 * 权限授出去之后，真正会被追问的是「谁在什么时候看过、下载过什么」。
 * 这个问题只能由流水回答，所以它是一份账，不是一份日志——
 * 它跟授权本身一样有保留期、有查询入口。
 */
app.get('/api/access-audit', requireAdmin, (req, res) => {
  const docId = typeof req.query.docId === 'string' && req.query.docId ? req.query.docId : undefined;
  res.json({
    items: listAccessAudit(docId).map((a) => ({
      id: a.id,
      docId: a.doc_id,
      docName: a.doc_name ?? '（文档已删除）',
      action: a.action,
      actorId: a.actor_id,
      actorName: a.actor_name,
      detail: a.detail,
      createdAt: a.created_at,
    })),
  });
});

/**
 * 调整已有授权的口子大小。
 *
 * 批准时给错能力是常事（本想只给查看，却顺手勾了下载）。
 * 撤销再重批也能改，但那样会把中间那段的口子状态从流水里抹掉——
 * 「那段时间到底能不能下载」就再也查不出来。
 * 直接改能力、并另留一条 adjust 审计，才是对现状的如实记录。
 *
 * 收口子要立刻生效：访客那边不需要重新登录，
 * 下一次请求就会按新能力判定。
 */
app.patch('/api/docs/:id/access-grants/:gid', requireAdmin, (req, res) => {
  const docId = String(req.params.id);
  const gid = String(req.params.gid);
  const grant = getAccessGrant(gid);
  if (!grant || grant.doc_id !== docId) {
    res.status(404).json({ error: '授权不存在或不属于该文档' });
    return;
  }
  if (grant.revoked_at) {
    res.status(409).json({ error: '授权已撤销，请重新授权' });
    return;
  }
  const capabilities = readCapabilities(req.body?.capabilities);
  // expiresAt：给了数字就用它，给 null 就是长期有效，不给则保持原样
  const expiresAt =
    req.body?.expiresAt === null
      ? null
      : typeof req.body?.expiresAt === 'number'
        ? req.body.expiresAt
        : grant.expires_at;
  if (!updateAccessGrant(gid, capabilities, expiresAt)) {
    res.status(500).json({ error: '调整授权失败' });
    return;
  }
  const before = parseCapabilities(grant.capabilities);
  insertAccessAudit({
    docId,
    action: 'adjust',
    actorId: nowUserId(req),
    actorName: req.user?.username ?? '管理员',
    detail: `${grant.guest_name} 的授权：${capLabel(before)} → ${capLabel(capabilities)}`,
  });
  logger.info(
    '已调整文档访问授权',
    getDoc(docId)?.name ?? docId,
    `${grant.guest_name}：${capLabel(before)} → ${capLabel(capabilities)}`,
  );
  res.json({ ok: true, capabilities });
});

/**
 * 撤销授权：访客下一次打开就该被挡住。
 *
 * 更要紧的是「正在看的那一屏」也得当场失效——不然这个撤销只是
 * 心理安慰：对方屏幕上的明文还在，人也还在看。所以撤完之后
 * 立刻推一条 revoked 事件过去，让前端把明文从内存里抹掉。
 */
app.delete('/api/docs/:id/access-grants/:gid', requireAdmin, (req, res) => {
  const gid = String(req.params.gid);
  const grant = getAccessGrant(gid);
  const ok = revokeAccessGrant(gid);
  if (!ok) {
    res.status(404).json({ error: '授权不存在或已撤销' });
    return;
  }
  if (grant) {
    notifyAccessRevoked(grant.doc_id, grant.guest_id, 'revoked');
    insertAccessAudit({
      docId: grant.doc_id,
      action: 'revoke',
      actorId: nowUserId(req),
      actorName: req.user?.username ?? '管理员',
      detail: `收回 ${grant.guest_name} 的授权`,
    });
  }
  logger.info('已撤销文档访问授权', getDoc(String(req.params.id))?.name ?? String(req.params.id));
  res.json({ ok: true });
});

/**
 * 批量批准访问申请。
 *
 * 同一访客对多篇加密文档各提一次申请时，管理员不必连点 N 次「批准」、
 * 挨个选有效期——勾上一起批，共享一个有效期。
 * 部分申请不可批时（已被处理、文档已取消加密）不牵连其余，
 * 逐条给出原因。
 */
app.post('/api/access-requests/bulk-approve', requireAdmin, async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.requestIds)
    ? req.body.requestIds.map((v: unknown) => String(v)).slice(0, 200)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: '请先勾选要批准的申请' });
    return;
  }
  const days = Number(req.body?.expiresInDays ?? 0);
  const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : null;
  const capabilities = readCapabilities(req.body?.capabilities);
  const result = bulkApproveAccessRequests(ids, nowUserId(req), expiresAt, capabilities);
  logger.info(
    '已批量批准文档访问申请',
    `批准 ${result.approved} 条`,
    `跳过 ${result.skipped.length} 条`,
  );
  res.json({ approved: result.approved, skipped: result.skipped, capabilities });
});

/**
 * 批量授权：直接给某个访客在多篇文档上开口子，不经过申请。
 *
 * 管理员已经清楚「该让谁看哪几篇」时（比如把整个项目目录给某某），
 * 没必要先制造一堆申请单再逐条批准。
 */
app.post('/api/access-grants/bulk', requireAdmin, (req, res) => {
  const guestId = String(req.body?.guestId ?? '').trim();
  const guestName = String(req.body?.guestName ?? '').trim().slice(0, 60);
  const docIds: string[] = Array.isArray(req.body?.docIds)
    ? req.body.docIds.map((v: unknown) => String(v)).slice(0, 200)
    : [];
  if (!guestId) {
    res.status(400).json({ error: '缺少访客标识' });
    return;
  }
  if (docIds.length === 0) {
    res.status(400).json({ error: '请先勾选要授权的文档' });
    return;
  }
  const days = Number(req.body?.expiresInDays ?? 0);
  const expiresAt = Number.isFinite(days) && days > 0 ? Date.now() + days * 86_400_000 : null;
  const capabilities = readCapabilities(req.body?.capabilities);

  // 只有仍处于加密状态的文档才值得授权
  const targets = docIds
    .map((docId: string) => getDoc(docId))
    .filter((d): d is DocNode => !!d && d.encrypted === true);
  const skipped = docIds.length - targets.length;
  const granted = bulkInsertAccessGrants(
    targets.map((d) => ({
      docId: d.id,
      guestId,
      guestName: guestName || guestId,
      grantedBy: nowUserId(req),
      expiresAt,
      capabilities,
    })),
  );
  for (const d of targets) {
    insertAccessAudit({
      docId: d.id,
      action: 'approve',
      actorId: nowUserId(req),
      actorName: req.user?.username ?? '管理员',
      detail: `直接授权给 ${guestName || guestId}；能力：${capLabel(capabilities)}`,
    });
  }
  logger.info('已批量授予文档访问权', `${granted} 篇`, guestName || guestId);
  res.json({ granted, skipped, capabilities });
});

/** 已知访客清单：批量授权时供管理员「选谁」 */
app.get('/api/access-guests', requireAdmin, (_req, res) => {
  res.json({ items: listKnownGuests() });
});

/* ------------------------------ Agent 配置 ------------------------------ */

app.get('/api/agent/config', requireAdmin, (_req, res) => {
  res.json({ config: getAgentConfigPublic() });
});

app.put('/api/agent/config', requireAdmin, (req, res) => {
  const body = req.body ?? {};
  saveAgentConfig({
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : undefined,
    model: typeof body.model === 'string' ? body.model.trim() : undefined,
    groupId: typeof body.groupId === 'string' ? body.groupId.trim() : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    allowGuest: typeof body.allowGuest === 'boolean' ? body.allowGuest : undefined,
    topK: typeof body.topK === 'number' ? body.topK : undefined,
    contextBudget: typeof body.contextBudget === 'number' ? body.contextBudget : undefined,
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    clearApiKey: body.clearApiKey === true,
    ragScope: normalizeRagScope(body.ragScope),
  });
  res.json({ config: getAgentConfigPublic() });
});

/** Agent 可用性：供前端展示悬浮按钮状态与面板提示 */
app.get('/api/agent/status', (req, res) => {
  const cfg = getAgentConfig();
  const isAdmin = req.user?.role === 'admin';
  const hasKey = Boolean(cfg.apiKey.trim());
  let canUse = false;
  let reason = '';
  if (!hasKey) reason = isAdmin ? 'NO_API_KEY' : 'NO_API_KEY';
  else if (!isAdmin && !cfg.allowGuest) reason = 'GUEST_DISABLED';
  else canUse = true;
  res.json({
    canUse,
    reason,
    model: cfg.model,
    hasApiKey: hasKey,
    allowGuest: cfg.allowGuest,
    role: isAdmin ? 'admin' : 'viewer',
  });
});

/**
 * token 用量统计。
 *
 * 限管理员：累计消耗属于运营成本数据，与润色任务同属不应向访客暴露的信息。
 * 前端仅在管理员视角渲染面板底部那一行。
 */
app.get('/api/agent/usage', requireAdmin, (_req, res) => {
  res.json({ usage: getAgentUsageSummary() });
});

/* ------------------------------ Agent 问答（SSE） ------------------------------ */

app.post('/api/agent/ask', async (req, res) => {
  const cfg = getAgentConfig();
  const isAdmin = req.user?.role === 'admin';

  const { send, fail } = openSse(res);

  if (!cfg.apiKey.trim()) return fail('尚未配置 API Key，请联系管理员');
  if (!isAdmin && !cfg.allowGuest) return fail('管理员尚未开放访客使用 Agent');

  const question = String(req.body?.question ?? '').trim();
  if (!question) return fail('问题不能为空');

  // 检索与范围判定抽到 server/agentContext.ts：
  // 任务里的「智能问答」步骤要跑出同样的结果，复制一份必然走样。
  const retrieval = retrieveForAsk({ question, cfg, rawScope: req.body?.scope });

  send('sources', {
    sources: retrieval.sources,
    // 本次实际落在哪几个仓库：让界面上显示的检索范围与实际检索一致
    scopeRepos: retrieval.scopeRepos,
  });

  const history = Array.isArray(req.body?.history)
    ? (req.body.history as { role: string; content: string }[])
        .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content)
        .slice(-8)
        .map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content.slice(0, 4000) }))
    : [];

  const messages = buildAskMessages(question, retrieval, history);

  await streamUpstream({ cfg, messages, res, send, fail });
});

/* ------------------------------ 对话式 Agent（SSE） ------------------------------ */

/**
 * 对话式 agent。
 *
 * 与上面的 /api/agent/ask 是两种东西，别混：
 * - ask 是「拿资料回答问题」：一次检索、一次作答，检索范围由用户圈定。
 * - chat 是「自己动手把事做完」：agent 自己决定调什么能力、要不要拆给别人、
 *   中间缺信息就反问，做完给结论。
 *
 * 权限沿用问答那一套：有 Key、且访客被允许时才放行。
 */
app.post('/api/agent/chat', async (req, res) => {
  const cfg = getAgentConfig();
  const isAdmin = req.user?.role === 'admin';

  const { send, fail } = openSse(res);

  if (!cfg.apiKey.trim()) return fail('尚未配置 API Key，请联系管理员');
  if (!isAdmin && !cfg.allowGuest) return fail('管理员尚未开放访客使用 Agent');

  const message = String(req.body?.message ?? '').trim();
  if (!message) return fail('说点什么吧');

  const role =
    findAgentRole(String(req.body?.agentId ?? '').trim()) ??
    findAgentRole(DEFAULT_AGENT_ROLE_ID);
  if (!role) return fail('没有可用的 agent');

  const history = Array.isArray(req.body?.history)
    ? (req.body.history as { role: string; content: string }[])
        .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content)
        .slice(-8)
        .map((h) => ({ role: h.role as 'user' | 'assistant', content: h.content.slice(0, 4000) }))
    : [];

  const controller = new AbortController();
  // 必须监听 res 而非 req：req 的 close 在请求体读取完毕时即触发，
  // 绑在 req 上会在上游返回第一个字节前就把自己取消掉。
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const outcome = await runAgent({
    role,
    task: message,
    history,
    cfg,
    userId: nowUserId(req),
    isAdmin,
    signal: controller.signal,
    onEvent: (event) => send('agent', event),
  });

  send('done', {
    answer: outcome.text,
    usedSkills: outcome.usedSkills,
    asked: outcome.asked,
  });
  if (!res.writableEnded) res.end();
});

/* ------------------------------ 文章润色（SSE，仅管理员） ------------------------------ */

/**
 * 润色指定文章的正文。
 *
 * 三点与问答不同，需刻意区分：
 * 1. 权限只看管理员身份，不看 allowGuest——该开关只放宽「只读问答」，
 *    润色会产出可回填的正文，绝不能因它对访客开放。
 * 2. 正文由客户端传入（取编辑器中的最新内容，而非库里的版本），因为编辑器存在
 *    600ms 防抖未落库的改动；服务端不读库，也就不会与前端视图不一致。
 * 3. 服务端只返回结果、不落库。是否应用由前端决定并走既有 PATCH 链路，
 *    这样润色结果与手工编辑共用同一套权限校验与失败回滚。
 */
app.post('/api/agent/polish', requireAdmin, async (req, res) => {
  const cfg = getAgentConfig();
  if (!cfg.apiKey.trim()) {
    return res.status(400).json({ error: '尚未配置 API Key，请先在 Agent 设置中配置' });
  }

  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction : '';
  const docId = typeof req.body?.docId === 'string' ? req.body.docId : '';
  const docName = typeof req.body?.docName === 'string' ? req.body.docName : '未命名文档';

  const trimmed = content.trim();
  if (!trimmed) return res.status(400).json({ error: '文章内容为空，无需润色' });
  if (content.length > MAX_POLISH_CHARS) {
    return res.status(400).json({
      error: `文章长度为 ${content.length} 字符，超过润色上限 ${MAX_POLISH_CHARS} 字符，请拆分后再试`,
    });
  }
  // 文件夹没有正文，润色无意义；提前拒绝可省下一次模型调用
  if (req.body?.type === 'folder') return res.status(400).json({ error: '文件夹没有正文，无法润色' });
  // 加密文档不参与 Agent 处理：即使内容由客户端传入，也不让模型接触它的正文
  if (docId) {
    const target = getDoc(docId);
    if (target?.encrypted) {
      return res.status(403).json({ error: '加密文档不参与 Agent 处理：其正文不应进入模型' });
    }
  }

  // 并发上限。此处是唯一的权威判定点：客户端预检可以被绕过（多标签页、
  // 直接调接口），而超限提交的后果是几十条上游连接同时占用，最终所有任务都被拖慢。
  // 与上面的参数校验之间没有 await，检查与 createPolishTask 构成原子步骤。
  const running = countRunningPolishTasks();
  if (running >= MAX_RUNNING_POLISH_TASKS) {
    return res.status(429).json({
      error:
        `已有 ${running} 个润色任务正在生成，最多同时支持 ${MAX_RUNNING_POLISH_TASKS} 个。` +
        '请等现有任务完成，或在 Agent 面板取消部分任务后再提交。',
    });
  }

  // 立即返回任务 id，生成在后台推进。用户关闭弹窗或刷新页面都不影响任务。
  const task = createPolishTask({ docId, docName, content, instruction });
  res.json({ taskId: task.id });
});

/** 润色任务列表：供 Agent 面板展示进行中/已完成/失败的任务 */
app.get('/api/agent/polish-tasks', requireAdmin, (_req, res) => {
  res.json({ tasks: listPolishTasks().map(toView) });
});

/** 订阅任务进度。任务已完成时立即补发终态，无需前端记住增量 */
app.get('/api/agent/polish-tasks/:id/stream', requireAdmin, (req, res) => {
  if (!subscribePolishTask(req, res, String(req.params.id))) {
    res.status(404).json({ error: '任务不存在或已过期' });
  }
});

/**
 * 删除单个润色任务，进行中的任务先中止生成再删记录。
 *
 * 这里**不能**只中止而保留记录：界面上「取消生成」与「删除记录」是同一个按钮
 * （running 时显示停止图标，其余显示垃圾桶，但走的是同一个 DELETE），前端也一律
 * 乐观移除。服务端若只 abort 就返回成功，任务就变成「界面上已消失、重新进入面板
 * 又冒出来还得再删一次」——实测正是这样。所以单条删除必须与批量删除共用
 * `removePolishTasks(cancelRunning: true)`：既断上游，也从任务表移除，两端口径一致。
 */
app.delete('/api/agent/polish-tasks/:id', requireAdmin, (req, res) => {
  const result = removePolishTasks([String(req.params.id)], { cancelRunning: true });
  if (result.cancelled.length) return res.json({ ok: true, removed: 1, cancelled: true });
  if (result.removed.length) return res.json({ ok: true, removed: 1 });
  res.status(404).json({ error: '任务不存在或已过期' });
});

/**
 * 清空所有已结束的润色任务（已完成与失败），进行中的原样保留。
 *
 * 与单条删除共用 removePolishTasks(cancelRunning: true) 的实现：
 * 勾选删除传 true（显式勾选即预期中断），清空历史恒为 false（不该顺手打断正在生成的润色）。
 */
app.post('/api/agent/polish-tasks/clear-finished', requireAdmin, (_req, res) => {
  res.json(clearFinishedPolishTasks());
});

/* ------------------------------ 前端静态资源 ------------------------------ */

/**
 * 一个进程 = 完整应用：同一个端口既提供 API 也提供前端页面。
 *
 * 以前得另摆一个 Caddy/nginx 托 dist/，于是多出一个组件——多一处配置、多一张证书、
 * 多一个「页面能开但接口 404」的排查点。现在构建产物直接由 Express 托管，
 * `npm run build` 之后 `npm run server` 就是完整可用的 WorkHub，
 * 托盘工具点「打开网页」指向的也正是这个端口。
 *
 * 放在所有 API 路由之后注册：Express 按注册顺序匹配，
 * 这样 `/api/xxx` 永远先落到 API 上，不会被静态中间件截走。
 *
 * 前端用 BrowserRouter（真实路径如 /tools、/admin/overview），刷新与深链
 * 由下面的 SPA 兜底接住：静态文件没命中、路径又带不出文件扩展名的 GET
 * 一律回 index.html，由前端路由决定渲染什么。两个排除缺一不可——
 * 放过 /api/ 是为了接口打错路径时仍返回 Express 原生的 404（前端 api.ts
 * 对非 JSON 响应有专门文案，拿到 HTML 反而能说出「重启后端」这句有用的话）；
 * 放过带扩展名的路径是为了让静态中间件处理 404，而不是把 favicon 请求
 * 也回一整页 HTML。
 */
const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    if (extname(req.path)) return next();
    res.sendFile(join(DIST_DIR, 'index.html'));
  });
  logger.info(`前端静态资源: ${displayPath(DIST_DIR)}`);
} else {
  logger.warn('未找到 dist/，本次只提供 API（前端请跑 npm run dev，或先执行 npm run build）');
}

/* ------------------------------ 启动 ------------------------------ */

/**
 * 列出本机的局域网 IPv4 地址，供启动日志打印访问入口。
 *
 * Node 的 `listen(port)` 不传 host 时已经会绑全部网卡，故服务端本身不需要额外配置；
 * 但启动日志只打 localhost 的话，使用者根本不知道该把哪个地址发给同事，
 * 「打不开」的第一大原因就是照着 localhost 去输局域网地址。这里直接从网卡枚举出来，
 * 拿不到就返回空数组——不猜、不写死 IP，换了网络也不会给出过期地址。
 */
function lanAddresses(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      // 内部回环与虚拟网卡（Docker/WSL 常见的 172.17.x、vEthernet）都可能存在，
      // 但它们不是同事能访问到的入口，全部排除
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push(`http://${info.address}:${port}`);
    }
  }
  return out;
}

/* ------------------------------ 统一错误出口 ------------------------------ */

/**
 * 从错误对象里取 HTTP 状态码。
 *
 * 只认 4xx：那类错误是调用方的问题（请求体不是合法 JSON 之类），按原状态码回；
 * 5xx 属于内部问题，一律按「服务器内部错误」处理，并且不把细节带给客户端。
 */
function clientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const code = typeof status === 'number' ? status : statusCode;
  return typeof code === 'number' && code >= 400 && code < 500 ? code : null;
}

/**
 * 全局错误处理中间件。
 *
 * 没有它的话，Express 的兜底处理器会做两件我们不想要的事：
 * 1. 在非 production 环境下把完整堆栈写进响应体——等于把服务器目录结构、
 *    依赖版本与内部文件路径交给任何一个能发请求的人；
 * 2. 用它自己的格式把错误打到 stderr，绕开了本项目的日志格式与脱敏。
 *
 * 这里统一收口：细节只进日志（经脱敏），客户端只拿到一句不含内部信息的话。
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = clientErrorStatus(err) ?? 500;
  if (status >= 500) logger.error('未处理的服务端异常', err);
  else logger.warn('请求不合法', err);
  // 响应已经开始下发（例如 SSE 推流途中出错）时不能再改状态码，只能断流
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: status >= 500 ? '服务器内部错误，请查看服务端日志' : '请求不合法' });
});

/**
 * 进程级兜底：未捕获异常与未处理的 Promise 拒绝。
 *
 * Node 的默认行为是打印堆栈并终止进程——这里保留「终止」这个行为（进程状态已不可信，
 * 继续跑只会产生更诡异的问题），只是改走本项目的日志出口：格式一致、照样脱敏。
 *
 * 用 fatal 而不是 error：进程马上就要没了，这一行是最后一条消息，
 * 不能被 WORKHUB_LOG_LEVEL=silent 一起静默掉。
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal('未处理的 Promise 拒绝，进程即将退出', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal('未捕获的异常，进程即将退出', err);
  process.exit(1);
});

// 上次没清完的暂存文件顺手扫掉：删除是尽力而为的后台任务，
// 进程被杀或机器断电都会留下 .trash 文件，它们已经不在索引里了。
// 扫在清道夫线程里做，不占着启动不放。
sweepStashed();

/**
 * 监听端口。
 *
 * 端口被占时重试一小会儿，而不是直接死掉。
 *
 * 重启场景下旧进程刚退出、socket 还没完全释放，这时候新进程 listen 会撞
 * EADDRINUSE，进程当场退出——表现是「重启接口返回成功，但服务没起来」，
 * 比直接报错更难查。重试几秒就能接上。
 */
let listenAttempts = 0;
/** 提出来是为了能关掉它：优雅停机要先停止收新请求 */
let httpServer: ReturnType<typeof app.listen> | null = null;

function listenForPort(): void {
  const server = app.listen(PORT, '0.0.0.0', () => {
    const cfg = getAgentConfigPublic();
    logger.info(`服务已启动: http://localhost:${PORT}`);
    for (const addr of lanAddresses(PORT)) logger.info(`局域网访问: ${addr}`);
    // 路径给相对形式：启动日志常被原样贴进 issue，绝对路径会带出本机用户名目录
    logger.info(`数据库: ${displayPath(DB_PATH)}`);
    logger.info(`模型: ${cfg.model} @ ${cfg.baseUrl}，API Key ${cfg.hasApiKey ? '已配置' : '未配置'}`);
    // 密码相关的两个入口都指到启动日志里：登录后才能改密，忘了密码反而进不去，
    // 所以离线重置这条退路必须让人在第一时间看见，而不是等到真忘了再去翻文档
    logger.info('修改管理员密码: 管理员可在「管理后台 → 账号安全」里改');
    logger.info('已忘记密码: npm run admin:password -- <新密码>');
    logger.info(
      `密钥来源: ${SECRET_ORIGIN === 'local' ? '本地自动生成（存在数据库旁边）' : IS_PRODUCTION ? '生产环境变量' : '.env / 系统环境变量'}`,
    );
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && listenAttempts < 20) {
      listenAttempts += 1;
      logger.warn(`端口 ${PORT} 还被占用，500ms 后重试（第 ${listenAttempts} 次）`);
      setTimeout(listenForPort, 500);
      return;
    }
    logger.error(`监听端口失败：${err.message}`);
    process.exit(1);
  });
  httpServer = server;
}

/**
 * 优雅停机。
 *
 * 被 Windows 服务宿主调用（它收到 SCM 的停止指令时，会先请求这个接口让服务自己收摊）。
 *
 * 顺序有讲究：
 * 1. 先答完 HTTP 响应，再关连接——反过来的话，调用方看到的是连接被掐断，
 *    分不清是「服务停了」还是「服务挂了」
 * 2. server.close() 只停收新连接，已经建立的长连接（比如 Agent 的 SSE）还挂着，
 *    所以要给一个兜底超时，不然永远等不到 close 回调
 */
function gracefulShutdown(reason: string): void {
  logger.notice(`收到停止请求（${reason}），正在关闭`);
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    try {
      db.close();
    } catch {
      // 关库失败没什么可补救的：要退出就退出
    }
    logger.notice('服务已停止');
    process.exit(0);
  };
  // 兜底：5 秒后无论如何都退，长连接不该拖住整个停机
  setTimeout(finish, 5000).unref();
  if (!httpServer) {
    finish();
    return;
  }
  httpServer.close(() => finish());
}

listenForPort();
