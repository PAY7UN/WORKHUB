/**
 * 浏览器本地存储的键。
 *
 * 键名统一是 `workhub.*`。旧键（`mdhub.*`）不再回退读取：
 * 浏览器里留着的是本地偏好（登录令牌、界面偏好），不是业务数据，
 * 丢了顶多重新登一次；而长期保留两套键名，
 * 「旧键还在生效」的排查成本远高于那点便利。
 *
 * 存的是本地偏好，不是业务数据——真正的业务数据在服务端库里，不在这儿。
 */

/**
 * 读一个值。
 *
 * 读不到就是 null，不做旧键回退。
 */
export function readStore(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** 写一个值 */
export function writeStore(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 删一个值 */
export function removeStore(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* 隐私模式下忽略 */
  }
}
