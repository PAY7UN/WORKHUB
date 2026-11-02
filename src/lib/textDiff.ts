/**
 * 两个文本之间的最小差异。
 *
 * 用在「外部内容灌进编辑器」这件事上：整篇覆盖会把编辑器里的光标、
 * 选区和未保存的折叠状态一并抹掉，而外部改动往往只动了一小段。
 * 找出公共前后缀，就能只替换真正变了的那一段。
 */
export interface DiffRange {
  /** 替换起点（旧文本里的偏移） */
  from: number;
  /** 替换终点（旧文本里的偏移） */
  to: number;
  /** 替换成的新文本 */
  insert: string;
}

/**
 * 求出把 oldText 变成 newText 所需的最小替换区间。
 *
 * 只做公共前后缀的匹配，不做真正的 diff 算法：在正文编辑这种场景里，
 * 「末尾加了一行」「中间插入一段」这类改动都能被前后缀命中，
 * 剩下的整段替换也仍在正确位置上。
 */
export function diffRange(oldText: string, newText: string): DiffRange {
  const max = Math.min(oldText.length, newText.length);
  let start = 0;
  while (start < max && oldText[start] === newText[start]) start += 1;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) };
}
