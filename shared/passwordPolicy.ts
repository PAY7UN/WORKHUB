/**
 * 密码规则：前后端共用的唯一事实来源。
 *
 * 为什么必须共享：服务端负责最终校验（防止绕过 UI 直接打接口），前端负责即时提示
 * （避免用户填完一整张表单才被拒）。两边各写一份常量时，只要有一处漏改，就会出现
 * 「前端放行、后端拒绝」这类很难排查的错位。
 *
 * 刻意不设复杂度规则（大小写 + 符号混搭）：这类规则在实践中几乎只制造
 * 「Passw0rd!」式的 predictable 绕过，对内部工具得不偿失；长度下限 + 随机性
 * 已经能挡住绝大多数弱口令。
 */

/** 最小长度 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 最大长度。上限的作用是挡住异常输入（误粘整篇文档）与哈希前的无意义开销，
 * 而不是限制密码强度——正常密码远够不到。
 */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * 校验新密码是否可用，返回可直接展示给用户的原因；通过则返回 null。
 *
 * 放在 shared 而不是服务端，是因为前端表单需要用同一套规则做即时提示——
 * 两边各判一次、两套文案，用户就会遇到「前端放行、后端拒绝」的错位。
 * 本模块刻意不依赖 node:crypto，保持浏览器可引入。
 *
 * @param current 传入当前密码时会额外拒绝「新旧相同」这一无意义的改密。
 */
export function validateNewPassword(password: string, current?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `新密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `新密码过长（超过 ${MAX_PASSWORD_LENGTH} 位）`;
  }
  if (current && password === current) {
    return '新密码不能与当前密码相同';
  }
  return null;
}
