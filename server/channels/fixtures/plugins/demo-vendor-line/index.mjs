/**
 * 夹具插件：一行一个 JSON 对象。
 *
 * 只给测试用——测的是「装载器能把开发者发布的插件装上」这条路径，
 * 不是这套协议本身。所以它放在 fixtures/ 下，不进仓库根的 plugins/，
 * 界面上也就看不到它。
 */

/** 换行符：这么写不用在源码里放转义，免得被别的工具改坏 */
const NL = String.fromCharCode(10);

/** 按换行切帧：一行一条消息 */
export function createParser() {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      const frames = [];
      let index = buffer.indexOf(NL);
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) frames.push(Buffer.from(line, 'utf8'));
        index = buffer.indexOf(NL);
      }
      return frames;
    },
    flush() {
      const rest = buffer.trim();
      buffer = '';
      return rest ? [Buffer.from(rest, 'utf8')] : [];
    },
    pending() {
      return buffer.length;
    },
  };
}

/** 一行 JSON 摊成字段 */
export function decode(frame) {
  const text = frame.toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const entries = parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
  const fields = entries.map(([key, value]) => ({ key, value: String(value) }));
  return {
    text,
    hex: frame.toString('hex'),
    parsed,
    fields,
    summary: fields.length ? fields.map((f) => f.key).join('、') : undefined,
  };
}
