/**
 * 钉钉接入层：群自定义机器人、企业内部应用工作通知、钉钉待办。
 *
 * 三条通道的取舍（配置里选其一）：
 * - webhook：群自定义机器人。只需一个 Webhook 地址，个人自用最省事，
 *   但受机器人频率限制（每分钟 20 条），且只能发到群里。
 * - notify：企业内部应用发「工作通知」。能单聊推到指定成员，不受群机器人
 *   频率限制，需要 AppKey/AppSecret 与「机器人工作通知」权限点。
 * - todo：企业内部应用建「钉钉待办」。会在钉钉客户端的待办列表里留下条目，
 *   需要待办写权限，且待办归属人要先拿到 unionId。
 *
 * 密钥（加签密钥、AppSecret）由服务端持有，浏览器只拿到「已配置 / 未配置」。
 */
import { createHmac } from 'node:crypto';
import type { DingTalkChannel, DingTalkConfig, Reminder, ReminderRepeat } from '../shared/types.ts';
import { redact } from '../shared/redact.ts';
import { logger } from './logger.ts';

/** 单次请求超时：钉钉正常在 1s 内返回，卡住时不必无限等待 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 钉钉访问令牌缓存（企业内部应用）。key 记录令牌对应哪组凭据，换配置后缓存自动失效 */
let tokenCache: { token: string; key: string; expireAt: number } | null = null;

/**
 * 计算群机器人的加签。
 *
 * 钉钉规定的算法：把时间戳与密钥拼成「timestamp + "\n" + secret」，
 * 以 secret 为密钥做 HMAC-SHA256，再 Base64 编码。
 *
 * 写成纯函数是为了能直接断言——加签少一个换行或多一次编码，
 * 钉钉只会回一句「sign not match」，排查起来全靠猜。
 */
export function signWebhook(secret: string, timestamp: number): string {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
}

/**
 * 拼出发送地址：需要加签时带上 timestamp 与 sign。
 *
 * 用 URL 接口而不是字符串拼接：签名里的 Base64 可能含 '+' '/' '='，
 * 手工拼进 query 会被服务端解析成空格。
 */
export function buildWebhookUrl(webhookUrl: string, secret: string, timestamp: number): string {
  const url = new URL(webhookUrl);
  if (secret.trim()) {
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', signWebhook(secret.trim(), timestamp));
  }
  return url.toString();
}

/**
 * 计算重复提醒的下一次触发时间。
 *
 * 以「上一次触发时刻」为基准顺延，而不是按自然日边界对齐：
 * 提醒是 9:30 触发的，那每天都是 9:30，不会因为巡检晚了几十秒就漂到 9:31。
 *
 * monthly 需处理「目标月份没有这一天」（1 月 31 日 → 2 月 28 日），
 * 顺延到该月最后一天，而不是让 setMonth 溢出到 3 月。
 */
export function computeNextFireAt(repeat: ReminderRepeat, from: number): number | null {
  if (repeat === 'once') return null;
  const d = new Date(from);
  if (repeat === 'daily') {
    d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (repeat === 'weekly') {
    d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d.getTime();
}

/** 本地时间格式化：YYYY-MM-DD HH:mm */
export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 顺延到「未来的第一个触发点」。
 *
 * 停机期间错过的重复提醒不补发：服务停了三天，恢复后不该连着响三遍。
 * 这里沿重复规则一路前推，直到落在 now 之后为止。
 */
export function computeNextFutureFireAt(
  repeat: ReminderRepeat,
  from: number,
  now: number,
): number | null {
  let next = computeNextFireAt(repeat, from);
  // 上限 1000 次：防御 repeat 规则异常时把循环变成死循环
  for (let guard = 0; next !== null && next <= now && guard < 1000; guard += 1) {
    next = computeNextFireAt(repeat, next);
  }
  return next;
}

/**
 * 把提醒渲染成推送文案。
 *
 * 待办通道会额外附上文档跳转链接，让人在钉钉里点一下就回到 WorkHub 对应文档。
 */
export function formatReminderText(
  reminder: Reminder,
  config: DingTalkConfig,
): { title: string; text: string } {
  const lines: string[] = [`### ${reminder.title}`];
  // 固定带上来源标记：机器人若用「自定义关键词」做安全设置，关键词取 WorkHub 即可命中
  lines.push('- 来源：WorkHub');
  const body = reminder.content.trim();
  if (body) lines.push(body);
  lines.push(`- 提醒时间：${formatDateTime(reminder.remindAt)}`);
  if (reminder.docName) lines.push(`- 关联文档：${reminder.docName}`);
  if (config.todoBaseUrl && reminder.docId) {
    lines.push(`- 打开文档：${config.todoBaseUrl}/?doc=${encodeURIComponent(reminder.docId)}`);
  }
  return { title: reminder.title, text: lines.join('\n') };
}

/** 钉钉错误：携带可读原因，供接口回给前端 */
export class DingTalkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DingTalkError';
  }
}

/**
 * 读取钉钉响应里的错误信息。
 *
 * 钉钉两代接口的报错形状不同：旧接口用 errcode/errmsg，新接口用 code/message，
 * 这里统一成一句话，避免前端拿到「HTTP 400」这种没信息量的提示。
 */
function describeDingTalkError(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = typeof b.errmsg === 'string' ? b.errmsg : typeof b.message === 'string' ? b.message : '';
    const code = typeof b.errcode === 'number' ? b.errcode : typeof b.code === 'number' ? b.code : undefined;
    if (msg) return code !== undefined ? `钉钉返回 ${code}：${msg}` : `钉钉返回：${msg}`;
  }
  return `钉钉接口返回 HTTP ${status}`;
}

/** 带超时的 JSON 请求 */
async function fetchJson(
  url: string,
  init: RequestInit & { accessToken?: string } = {},
): Promise<unknown> {
  const { accessToken, ...rest } = init;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  if (accessToken) headers['x-acs-dingtalk-access-token'] = accessToken;

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new DingTalkError('请求钉钉超时，请检查网络或稍后重试');
    }
    throw new DingTalkError(`无法连接钉钉：${(e as Error)?.message ?? '网络错误'}`);
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    throw new DingTalkError(describeDingTalkError(res.status, body));
  }
  return body;
}

/**
 * 取企业内部应用的 access_token。
 *
 * 钉钉的令牌有效期约 2 小时，缓存到过期前 5 分钟再取。
 * 缓存放在模块内存里：多实例部署时各取各的也无妨，这个接口本身很便宜。
 */
export async function getAccessToken(config: DingTalkConfig): Promise<string> {
  const appKey = config.appKey.trim();
  const appSecret = config.appSecret.trim();
  if (!appKey || !appSecret) throw new DingTalkError('未配置 AppKey / AppSecret，无法调用企业内部应用接口');

  const now = Date.now();
  if (tokenCache && tokenCache.expireAt > now && tokenCache.key === `${appKey}:${appSecret}`) {
    return tokenCache.token;
  }

  // 新版接口优先，旧版作为兜底：两版并存期间不同企业开通情况不一致
  try {
    const body = (await fetchJson('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      body: JSON.stringify({ appKey, appSecret }),
    })) as { accessToken?: string; expireIn?: number } | null;

    const token = body?.accessToken;
    if (token) {
      const expireIn = typeof body?.expireIn === 'number' ? body.expireIn : 7200;
      tokenCache = { token, key: `${appKey}:${appSecret}`, expireAt: now + expireIn * 1000 - 5 * 60 * 1000 };
      return token;
    }
    throw new DingTalkError(describeDingTalkError(200, body));
  } catch (e) {
    if (e instanceof DingTalkError && /返回/.test(e.message)) throw e;
    // 新版失败时回退旧版
    const url = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
    const legacy = (await fetchJson(url)) as { errcode?: number; errmsg?: string; access_token?: string } | null;
    if (legacy?.access_token) {
      tokenCache = {
        token: legacy.access_token,
        key: `${appKey}:${appSecret}`,
        expireAt: now + 2 * 60 * 60 * 1000 - 5 * 60 * 1000,
      };
      return legacy.access_token;
    }
    throw new DingTalkError(describeDingTalkError(200, legacy));
  }
}

/**
 * 发群自定义机器人消息（markdown）。
 *
 * 机器人若设置了「自定义关键词」，正文里必须含该关键词，否则钉钉会拒收——
 * 这类拒绝钉钉只回 errcode 310000，不说原因，故这里把它翻译成人话。
 */
export async function sendWebhookMessage(
  config: DingTalkConfig,
  payload: { title: string; text: string },
): Promise<void> {
  const webhook = config.webhookUrl.trim();
  if (!webhook) throw new DingTalkError('未配置机器人 Webhook 地址');

  const url = buildWebhookUrl(webhook, config.webhookSecret, Date.now());
  const body = (await fetchJson(url, {
    method: 'POST',
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { title: payload.title, text: payload.text },
      at: { isAtAll: false, atMobiles: [], atUserIds: [] },
    }),
  })) as { errcode?: number; errmsg?: string } | null;

  const code = body?.errcode;
  if (code !== undefined && code !== 0) {
    if (code === 310000) {
      throw new DingTalkError('消息被机器人拒绝：若设置了「自定义关键词」，正文必须包含该关键词');
    }
    throw new DingTalkError(describeDingTalkError(200, body));
  }
}

/**
 * 发工作通知（企业内部应用）。
 *
 * 需要应用开通「机器人工作通知」权限点；没开通时钉钉回 403，
 * 这里翻译成「去开放平台勾选权限」而不是把英文错误码丢给用户。
 */
export async function sendWorkNotification(
  config: DingTalkConfig,
  payload: { title: string; text: string },
): Promise<void> {
  const userIds = config.userIds.filter(Boolean);
  if (!userIds.length) throw new DingTalkError('未配置工作通知接收人（userid）');

  const token = await getAccessToken(config);
  const robotCode = config.robotCode.trim() || config.appKey.trim();

  const body = (await fetchJson('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    accessToken: token,
    body: JSON.stringify({
      robotCode,
      userIds,
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: payload.text }),
    }),
  })) as { code?: string; message?: string } | null;

  const code = body?.code;
  if (code) {
    if (code === 'Forbidden.AccessDenied' || code === '403') {
      throw new DingTalkError('无权发送工作通知：请在钉钉开放平台为应用开通「机器人工作通知」权限');
    }
    throw new DingTalkError(describeDingTalkError(200, body));
  }
}

/**
 * 创建钉钉待办。
 *
 * 2024 年 2 月起该接口只支持「工作待办」，detailUrl 变为必填——
 * 缺了它钉钉会直接拒收，故这里先检查再发，别让用户拿到一个没头没脑的错误码。
 */
export async function createDingTalkTodo(
  config: DingTalkConfig,
  payload: { subject: string; description: string; dueTime: number },
): Promise<string> {
  const unionId = config.unionId.trim();
  if (!unionId) throw new DingTalkError('未配置待办归属人 unionId');
  if (!config.todoBaseUrl.trim()) {
    throw new DingTalkError('未配置 WorkHub 访问地址：钉钉工作待办要求带跳转链接');
  }

  const token = await getAccessToken(config);
  const url = `https://api.dingtalk.com/v1.0/todo/users/${encodeURIComponent(unionId)}/tasks?operatorId=${encodeURIComponent(unionId)}`;

  const body = (await fetchJson(url, {
    method: 'POST',
    accessToken: token,
    body: JSON.stringify({
      sourceId: 'mdhub',
      subject: payload.subject,
      creatorId: unionId,
      description: payload.description,
      dueTime: payload.dueTime,
      executorIds: config.executorIds.filter(Boolean),
      detailUrl: { appUrl: config.todoBaseUrl.trim() },
    }),
  })) as { id?: string | number; taskId?: string | number; code?: string; message?: string } | null;

  const id = body?.id ?? body?.taskId;
  if (id === undefined || id === null) {
    throw new DingTalkError(describeDingTalkError(200, body));
  }
  return String(id);
}

/**
 * 按通道推送一条提醒。
 *
 * 返回钉钉待办 id（仅待办通道有），便于把「提醒记录」与「钉钉待办」对上号。
 */
export async function pushReminder(
  config: DingTalkConfig,
  reminder: Reminder,
  channel: DingTalkChannel,
): Promise<{ todoId?: string }> {
  const { title, text } = formatReminderText(reminder, config);

  if (channel === 'todo') {
    const todoId = await createDingTalkTodo(config, {
      subject: reminder.title,
      description: text,
      dueTime: reminder.remindAt,
    });
    return { todoId };
  }
  if (channel === 'notify') {
    await sendWorkNotification(config, { title, text });
    return {};
  }
  await sendWebhookMessage(config, { title, text });
  return {};
}

/**
 * 连通性测试：按当前通道发一条测试内容。
 *
 * 与真实推送走完全相同的代码路径——测试与实际行为不一致是配置排查里最费时间的一类问题。
 */
export async function testDingTalk(config: DingTalkConfig): Promise<string> {
  const channel = config.channel;
  const probe: Reminder = {
    id: 'test',
    title: 'WorkHub 钉钉连通性测试',
    content: '这是一条测试消息，看到即说明配置正确。',
    remindAt: Date.now(),
    repeat: 'once',
    channel,
    status: 'pending',
    docId: null,
    docName: null,
    createdAt: Date.now(),
    createdBy: 'u-admin',
    firedAt: null,
    doneAt: null,
    lastError: '',
    fireCount: 0,
    todoId: '',
  };

  const result = await pushReminder(config, probe, channel);
  logger.info(`钉钉连通性测试成功（通道：${channel}）`);
  return result.todoId
    ? '测试成功：已创建一条钉钉待办（可在钉钉「待办」里看到）'
    : '测试成功：测试消息已发送';
}

/** 导出脱敏后的错误文案，供接口直接回前端 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof DingTalkError) return redact(err.message);
  const raw = err instanceof Error ? err.message : String(err);
  return redact(raw).slice(0, 300);
}
