/**
 * 日志脱敏：把密钥、令牌、密码等敏感串从任意文本里抹掉。
 *
 * 背景：日志会被用户原样贴进 issue、截图、公开仓库的附件里。一旦 API Key、
 * 管理员密码或 JWT 令牌进了日志，就等于公开——脱敏必须发生在「写入日志的那一刻」，
 * 而不是指望每个人都记得别贴。
 *
 * 为什么放在 shared/ 而不是两端各写一份：服务端日志与浏览器控制台会打印同一批内容
 * （接口错误文案、配置回显、上游返回体），两份正则一定会漂移，漏掉的那一端就是泄漏点。
 *
 * 取舍说明：这里宁可过度脱敏。误伤一段普通文本（正文里恰好有 "token: xxx"）
 * 只是日志变得难看，漏掉一处则是凭据外泄。
 */

/** 敏感字段名：出现在 key=value / "key": "value" 形态中都按值脱敏 */
const SECRET_KEYS = [
  'api[_-]?key',
  'apikey',
  'access[_-]?token',
  'refresh[_-]?token',
  'id[_-]?token',
  'token',
  'password',
  'passwd',
  'pwd',
  'secret',
  'authorization',
  'cookie',
  'session[_-]?id',
].join('|');

/**
 * 依次套用的脱敏规则。
 *
 * 顺序有讲究：先按字段名脱敏（覆盖最广），再按密钥形态兜底（字段名被改写、
 * 或密钥直接出现在报文里的情况）。
 *
 * 字段名规则的取值处加了「不能以 bearer 开头」的否定前瞻：Authorization 头
 * 交给下一条规则处理，否则会出现 `Authorization: *** ***` 这种把 Bearer 一并
 * 抹掉、又看不出原文案的怪输出。
 */
const PATTERNS: Array<[RegExp, string]> = [
  // URL 里的 userinfo：https://user:pass@host —— 密码段单独抹掉，用户名留着（便于定位问题）
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@'],
  // key=value / "key":"value" / 'key': 'value'
  [
    new RegExp(`("?(?:${SECRET_KEYS})"?\\s*[:=]\\s*"?)(?!bearer\\b)([^"'\\s,}&]+)`, 'gi'),
    '$1***',
  ],
  // Authorization: Bearer <token>
  [/\b(bearer)\s+[\w~+/=-]{6,}/gi, '$1 ***'],
  // 常见密钥形态：sk-…（OpenAI 风格）、eyJ…（JWT）
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\beyJ[A-Za-z0-9._-]{8,}/g, '***'],
];

/** 对任意文本做脱敏 */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
