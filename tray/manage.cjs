/**
 * 远端管理客户端：remote 模式下托盘跟服务器说话的那条线。
 *
 * 走 HTTP + 机器令牌（x-workhub-token 头）。令牌只管 /api/manage/* 这一组端点，
 * 拿它翻不了文档、也拿不到模型里的 API Key——它是「运维视角」的钥匙，
 * 不是管理员账号。服务器那边怎么划的界，见 server/manageTokens.ts。
 *
 * 令牌从哪来：环境变量 WORKHUB_MANAGE_TOKEN 优先于配置文件。
 * 环境变量优先是有意的：配置文件是明文，容易被同步盘、截图、备份带走；
 * 令牌应该由运维自己放进系统环境变量，而不是躺在某个随手能拷走的文件里。
 */
const { envValue } = require('./env.cjs');

const MANAGE_TOKEN_HEADER = 'x-workhub-token';

/** 取令牌：环境变量优先于配置文件（旧名 MDHUB_MANAGE_TOKEN 也认） */
function manageToken(config) {
  return envValue(process.env, 'MANAGE_TOKEN') || String(config?.token || '').trim();
}

/**
 * 调一次管理接口。
 *
 * 错误一律转成 Error，消息直接给人看——
 * 运维看不懂的报错等于没有报错。
 */
async function callManageApi(config, path, { method = 'GET', body, timeout = 8000 } = {}) {
  const token = manageToken(config);
  if (!token) {
    throw new Error(
      '没配机器令牌：请在 tray.config.json 里填 token，或设环境变量 WORKHUB_MANAGE_TOKEN',
    );
  }
  // 令牌要塞进 HTTP 头，只能是 ASCII。非 ASCII 的值会在编码时炸掉，
  // 报出来的错（ByteString 之类）运维看不懂，也猜不到是自己贴错了字符。
  if (/[^\x20-\x7E]/.test(token)) {
    throw new Error('机器令牌格式不对：只能包含 ASCII 可见字符（多半是复制时带进了中文或空格）');
  }
  let res;
  try {
    res = await fetch(`${config.target}/api/manage${path}`, {
      method,
      headers: {
        [MANAGE_TOKEN_HEADER]: token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const name = err?.name || '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`连接 ${config.target} 超时（${timeout}ms）`);
    }
    throw new Error(`连不上 ${config.target}：${err?.message ?? err}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data?.error || `服务器返回 ${res.status}`);
  }
  return data;
}

/** 服务器状态：版本、运行时长、库大小、各类计数 */
function fetchStatus(config) {
  return callManageApi(config, '/status');
}

/** 最近若干行日志 */
function fetchLogs(config, tail = 60) {
  return callManageApi(config, `/logs?tail=${Math.max(1, Math.min(500, Math.floor(tail)))}`);
}

/** 请求重启服务器 */
function restartServer(config) {
  return callManageApi(config, '/restart', { method: 'POST' });
}

/**
 * 查服务器有没有新版本。
 *
 * 服务器那边把「查不到」也当 200 返回（错误放在 error 字段里），
 * 所以这里拿到 200 就说明请求本身是通的。
 */
function fetchUpdate(config) {
  return callManageApi(config, '/update');
}

/**
 * 让服务器升级。
 *
 * 服务器收下请求后会自己退出（换完代码再起来），
 * 所以连接多半会在响应回来之前就被掐断——那是升级成功，不是失败。
 * 这里把「连接断开」也当成成功返回，交给调用方按成功处理。
 */
async function startUpdate(config) {
  try {
    return await callManageApi(config, '/update', { method: 'POST', timeout: 60000 });
  } catch (err) {
    const message = String(err?.message ?? err);
    // 服务器升级中途退出，连接被重置属于正常
    if (/ECONNRESET|socket hang up|连接被重置|terminated/i.test(message)) {
      return { ok: true, detail: '服务器已收到升级请求，正在换代码' };
    }
    throw err;
  }
}

module.exports = {
  manageToken,
  callManageApi,
  fetchStatus,
  fetchLogs,
  fetchUpdate,
  restartServer,
  startUpdate,
};
