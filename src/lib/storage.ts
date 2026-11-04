/**
 * 浏览器本地存储的键。
 *
 * 键名从 mdhub.* 换成 workhub.*，但旧键里还揣着用户的登录令牌、
 * 本地文档缓存和「已导入过」的标记。直接换掉，等于「升级后被登出、
 * 本地设置全丢」——这类故障没有任何提示，只是功能突然不见了。
 *
 * 所以读的时候两个都认：新键没有才回退旧键；读到旧键就顺手搬到新键，
 * 搬一次之后浏览器里就干净了。写只写新键。
 *
 * 存的是本地偏好，不是业务数据——所以这里只管「读得到、别丢」，
 * 不做版本协商。真正的业务数据在服务端库里，不在这儿。
 */

/** 现役键前缀 */
const PREFIX = 'workhub.';
/** 改名前的键前缀 */
const LEGACY_PREFIX = 'mdhub.';

/** 新键对应的旧键名；不是现役前缀的键没有旧名 */
function legacyKeyOf(key: string): string | null {
  return key.startsWith(PREFIX) ? LEGACY_PREFIX + key.slice(PREFIX.length) : null;
}

/**
 * 读一个值：新键优先，没有才看旧键。
 *
 * 命中旧键时顺手搬家（写新键、删旧键）——搬的动作失败了也不影响读取，
 * 最坏情况是每次读都多试一次。
 */
export function readStore(store: Storage, key: string): string | null {
  try {
    const current = store.getItem(key);
    if (current !== null) return current;

    const legacy = legacyKeyOf(key);
    if (!legacy) return null;
    const old = store.getItem(legacy);
    if (old === null) return null;

    try {
      store.setItem(key, old);
      store.removeItem(legacy);
    } catch {
      /* 隐私模式下写不进去，旧键照样能用 */
    }
    return old;
  } catch {
    return null;
  }
}

/** 写一个值：只写新键 */
export function writeStore(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 删一个值：新键与旧键一起删，免得旧键留下幽灵数据 */
export function removeStore(store: Storage, key: string): void {
  try {
    store.removeItem(key);
    const legacy = legacyKeyOf(key);
    if (legacy) store.removeItem(legacy);
  } catch {
    /* 隐私模式下忽略 */
  }
}
