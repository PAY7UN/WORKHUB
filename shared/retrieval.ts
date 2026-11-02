/**
 * 文档检索与上下文组装：浏览器与服务端共用，保证 RAG 召回逻辑一致。
 * 不依赖任何运行时环境 API，可同时运行于 Vite 浏览器与 Node。
 */
import type { DocNode } from './types.ts';

/** 把一篇文档包装成检索单元 */
export function docToUnit(doc: DocNode): RetrievalUnit {
  return {
    id: doc.id,
    name: doc.name,
    content: doc.content || '',
    kind: 'doc',
    docId: doc.id,
  };
}

const CN_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '及', '也', '就', '都', '而', '并', '等', '对', '把', '被', '让',
  '我', '你', '他', '她', '它', '们', '这', '那', '哪', '什么', '怎么', '如何', '请', '帮', '一下', '一个',
  '可以', '需要', '进行', '通过', '以及', '其中', '因为', '所以', '但是', '如果', '这个', '那个', '吗', '呢',
  'a', 'an', 'the', 'of', 'to', 'is', 'are', 'and', 'or', 'in', 'on', 'for', 'with', 'how', 'what',
]);

/** 轻量分词：英文数字按词，中文按二元组（bigram），不引入额外依赖 */
export function tokenize(text: string): string[] {
  const lower = (text || '').toLowerCase();
  const tokens: string[] = [];

  lower.replace(/[a-z0-9_+#.-]+/g, (m) => {
    if (!CN_STOPWORDS.has(m)) tokens.push(m);
    return m;
  });

  lower
    .replace(/[^a-z0-9_+#.\-一-龥]+/g, ' ')
    .split(/\s+/)
    .forEach((seg) => {
      if (!seg) return;
      if (!/[一-龥]/.test(seg)) {
        if (!CN_STOPWORDS.has(seg)) tokens.push(seg);
        return;
      }
      if (seg.length === 1) {
        if (!CN_STOPWORDS.has(seg)) tokens.push(seg);
        return;
      }
      for (let i = 0; i < seg.length - 1; i += 1) {
        const bg = seg.slice(i, i + 2);
        if (!CN_STOPWORDS.has(bg)) tokens.push(bg);
      }
    });

  return tokens;
}

/**
 * 检索单元：一份可供模型阅读的文本。
 *
 * 原本只有「文档正文」一种来源；附件抽出的文本也是同样性质的东西，
 * 于是两者统一成同一个结构——检索、打分、组装上下文都不必分叉，
 * 差别只留在 kind 这个标记上，供界面区分引用来源。
 */
export interface RetrievalUnit {
  /** 唯一标识；文档为 doc.id，附件为 att:<attachmentId> */
  id: string;
  /** 参与标题命中的名字；附件用「宿主文档名 › 附件名」 */
  name: string;
  /** 可检索的正文 */
  content: string;
  /** 来源类型 */
  kind: 'doc' | 'attachment';
  /** 所属文档 id（附件为其宿主文档） */
  docId: string;
}

export interface RetrievedUnit {
  unit: RetrievalUnit;
  score: number;
  /** 命中片段（已截断），用于展示引用 */
  snippet: string;
}

/** 在候选单元中按相关度检索：标题命权重高于正文 */
export function retrieveDocs(
  query: string,
  units: RetrievalUnit[],
  options: { topK?: number; maxSnippet?: number } = {},
): RetrievedUnit[] {
  const { topK = 5, maxSnippet = 600 } = options;
  const qTokens = Array.from(new Set(tokenize(query)));
  if (qTokens.length === 0) return [];

  const scored = units.map((unit) => {
    const nameTokens = new Set(tokenize(unit.name));
    const contentCount = new Map<string, number>();
    tokenize(unit.content || '').forEach((t) => contentCount.set(t, (contentCount.get(t) || 0) + 1));

    let nameHits = 0;
    let contentHits = 0;
    qTokens.forEach((t) => {
      if (nameTokens.has(t)) nameHits += 1;
      contentHits += contentCount.get(t) || 0;
    });
    if (nameHits === 0 && contentHits === 0) return null;

    const score = (nameHits / qTokens.length) * 3 + Math.log1p(contentHits);
    return { unit, score };
  });

  return scored
    .filter((s): s is { unit: RetrievalUnit; score: number } => s !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ unit, score }) => ({
      unit,
      score,
      snippet: buildSnippet(unit.content || unit.name, qTokens, maxSnippet),
    }));
}

/** 截取包含命中词的上下文片段 */
function buildSnippet(content: string, qTokens: string[], maxLen: number): string {
  if (content.length <= maxLen) return content;
  const lower = content.toLowerCase();
  let best = -1;
  for (const t of qTokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return `${content.slice(0, maxLen)}…`;
  const start = Math.max(0, best - Math.floor(maxLen / 3));
  return `${start > 0 ? '…' : ''}${content.slice(start, start + maxLen)}${
    start + maxLen < content.length ? '…' : ''
  }`;
}

/** 组装送入模型的上下文（受总字符预算约束） */
export function buildContext(retrieved: RetrievedUnit[], budget = 24000): string {
  const parts: string[] = [];
  let used = 0;
  retrieved.forEach((r, i) => {
    const header = `\n===== 资料 ${i + 1}：${r.unit.name} =====\n`;
    const room = budget - used - header.length;
    if (room <= 200) return;
    const body = (r.unit.content || '').slice(0, room);
    used += header.length + body.length;
    parts.push(header + body);
  });
  return parts.join('');
}

export const SYSTEM_PROMPT = [
  '你是一个严谨的文档分析助手。',
  '请**只依据**用户提供的「资料」内容回答问题，不要编造资料中不存在的信息。',
  '若资料不足以回答，直接说明「现有资料无法回答」，并指出还需要哪些信息。',
  '引用资料时使用 [资料N] 的格式标注来源。',
  '回答使用与提问相同的语言，结构清晰，可用要点列表。',
].join('\n');
