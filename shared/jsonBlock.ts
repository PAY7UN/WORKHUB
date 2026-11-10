/**
 * 从模型的自由文本里找出 JSON 代码块。
 *
 * 模型爱把结构化结果包在 ```json … ``` 里。这个解析器服务 agent 动作协议
 * （server/agent/runtime.ts）：正文给人看，JSON 块给机器读。
 *
 * 「块外正文」与「块内 JSON」必须按同一口径切分——
 * 不一致会导致同一个动作一边认为有效、另一边认为没有，两套口径迟早分叉。
 */

/** 从模型输出里找出 JSON 代码块 */
export function extractJsonBlock(text: string): string | null {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) {
    const body = fence[1].trim();
    if (body.startsWith('{') || body.startsWith('[')) return body;
  }
  // 没有代码块时，退而求其次：找第一段看起来像 JSON 的花括号块
  const start = text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

/** 把回答里的 JSON 代码块去掉，只留正文 */
export function stripJsonBlock(text: string): string {
  return text.replace(/```(?:json)?\s*\n[\s\S]*?```/gi, '').trim();
}

/**
 * 流式地滤掉 JSON 代码块，只吐给人看的正文。
 *
 * 模型一边写说明一边给动作块，两者混在同一个流里。
 * 界面要把说明实时显示出来、但不能把 JSON 甩到聊天框里，
 * 所以增量到达时要边收边剔——不能等整段收完再处理，那样说明就一个字都看不到。
 */
export class VisibleTextFilter {
  private text = '';
  /** 已经吐出去的字符数 */
  private emitted = 0;
  /** 当前是否在代码块里 */
  private inFence = false;

  /** 喂进一块增量，返回这段里「给人看的」新正文 */
  feed(chunk: string): string {
    this.text += chunk;
    let out = '';
    for (;;) {
      const rest = this.text.slice(this.emitted);
      if (!rest) break;

      if (!this.inFence) {
        const idx = rest.indexOf('```');
        if (idx === -1) {
          // 末尾可能是被切成两半的围栏标记，先扣住不吐。
          // 最多扣两个：一个 '`' 加上下一个块开头的 '``' 正好凑成围栏。
          let hold = 0;
          for (let i = rest.length - 1; i >= 0 && rest[i] === '`'; i -= 1) hold += 1;
          hold = Math.min(hold, 2);
          out += rest.slice(0, rest.length - hold);
          this.emitted += rest.length - hold;
          break;
        }
        out += rest.slice(0, idx);
        // 连开围栏一起跳过：留在原地的话，下一轮会把它当成收尾围栏，
        // 于是块内的 JSON 反而被当成正文吐出去。
        this.emitted += idx + 3;
        this.inFence = true;
        continue;
      }

      // 块内：整段吞掉，直到收尾围栏
      const idx = rest.indexOf('```');
      if (idx === -1) {
        this.emitted = this.text.length;
        break;
      }
      this.emitted += idx + 3;
      this.inFence = false;
    }
    return out;
  }

  /** 流结束：把还扣着的尾巴吐出来 */
  flush(): string {
    const rest = this.text.slice(this.emitted);
    this.emitted = this.text.length;
    return rest;
  }
}
