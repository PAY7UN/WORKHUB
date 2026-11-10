/**
 * 数据分析：把表格与接口数据算清楚。
 *
 * 这里的分工是硬的：**程序算数，模型解读**。
 * 模型心算平均值会错，会把两行数据数成三行——所以数字必须从这里出来，
 * 模型只负责把算好的数字说成人话。
 *
 * 支持四种操作：
 * - describe：整份数据的画像（每列的类型、缺失、极值、分布）
 * - groupby：按列分组，组内对数值列做汇总
 * - filter：按条件筛行
 * - top：按列排序取前 N
 */

/** 分析操作 */
export type AnalyzeOp = 'describe' | 'groupby' | 'filter' | 'top';

/** 数据分析的参数 */
export interface AnalyzeParams {
  /** 数据来源：URL，或者直接粘过来的 JSON/CSV 文本 */
  source: string;
  /** 数据格式，默认自动判断 */
  format?: 'auto' | 'json' | 'csv' | 'tsv';
  /** 操作，默认 describe */
  op?: AnalyzeOp;
  /** groupby：分组列（多列用逗号隔开） */
  groupBy?: string;
  /** filter/top：作用的列 */
  column?: string;
  /** filter：比较方式；top 时表示升序还是降序 */
  condition?: string;
  /** filter：比较值 */
  value?: string;
  /** top：取前几条 */
  limit?: number;
}

/** 一列的统计画像 */
export interface ColumnProfile {
  name: string;
  /** 推断出的类型 */
  type: 'number' | 'boolean' | 'string';
  /** 有值的行数 */
  count: number;
  /** 缺失的行数 */
  missing: number;
  /** 不同取值的个数 */
  unique: number;
  min?: number;
  max?: number;
  sum?: number;
  mean?: number;
  median?: number;
  std?: number;
  p25?: number;
  p75?: number;
  /** 出现最多的取值 */
  top?: Array<{ value: string; count: number }>;
}

/** 分析结果 */
export interface AnalyzeResult {
  /** 总行数 */
  rows: number;
  /** 列名 */
  columns: string[];
  /** 每列画像 */
  profiles?: ColumnProfile[];
  /** groupby 的分组结果 */
  groups?: Array<{ key: string; count: number; stats: Record<string, number> }>;
  /** filter/top 命中的行 */
  matched?: Array<Record<string, unknown>>;
  /** 命中的行数 */
  matchedCount?: number;
}

/** 数据分析失败：message 是给用户看的原因 */
export class AnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeError';
  }
}

/* ------------------------------ 解析 ------------------------------ */

/** 猜分隔符：数第一行里各候选出现得最多 */
function detectDelimiter(header: string): string {
  const candidates = [',', '\t', ';'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = header.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 解析分隔文本。
 *
 * 手写而不用 csv 库：CSV 的坑就那么几个（引号包裹、双引号转义、字段里的换行），
 * 为这几行代码引一个依赖不划算。
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** 从原始文本里把值转成合适的类型 */
function coerce(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  return value;
}

/** 把原始行变成对象行 */
function toObjectRows(raw: unknown[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      rows.push(item as Record<string, unknown>);
    } else {
      rows.push({ value: item });
    }
  }
  return rows;
}

/** 猜格式 */
function guessFormat(text: string): 'json' | 'csv' | 'tsv' {
  if (/^[[{]/.test(text)) return 'json';
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.includes('\t')) return 'tsv';
  return 'csv';
}

/** 解析出统一的行与列 */
export function parseTable(source: string, format?: string): { rows: Record<string, unknown>[]; columns: string[] } {
  const text = source.trim();
  if (!text) throw new AnalyzeError('没有数据可分析');

  const guess = format && format !== 'auto' ? format : guessFormat(text);

  if (guess === 'json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new AnalyzeError(`内容看起来是 JSON 但解析不了：${(err as Error).message}`);
    }
    if (Array.isArray(parsed)) {
      if (!parsed.length) throw new AnalyzeError('JSON 是个空数组，没有可分析的数据');
      if (Array.isArray(parsed[0])) {
        const header = (parsed[0] as unknown[]).map((v, i) => String(v ?? `列${i + 1}`));
        const rows = (parsed as unknown[][]).slice(1).map((r) => {
          const obj: Record<string, unknown> = {};
          header.forEach((key, i) => {
            obj[key] = coerce(r[i] ?? '');
          });
          return obj;
        });
        return { rows, columns: header };
      }
      const rows = toObjectRows(parsed);
      const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      return { rows, columns };
    }
    if (parsed && typeof parsed === 'object') {
      const rows = toObjectRows([parsed]);
      return { rows, columns: Object.keys(rows[0]) };
    }
    throw new AnalyzeError('JSON 顶层既不是数组也不是对象，没法按表格分析');
  }

  // 分隔文本：第一行当表头
  const delimiter = guess === 'tsv' ? '\t' : detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
  const table = parseDelimited(text, delimiter);
  if (!table.length) throw new AnalyzeError('没有解析出任何数据行');
  const header = table[0].map((h, i) => h.trim() || `列${i + 1}`);
  const body = table.slice(1);
  // 只有表头没有数据：这不是一张能分析的表，多半是把一句普通话当成了 CSV。
  // 说清楚比给出一张空表强。
  if (!body.length) throw new AnalyzeError('没有解析出任何数据行：这看起来不像一张表');
  const rows = body.map((r) => {
    const obj: Record<string, unknown> = {};
    header.forEach((key, i) => {
      obj[key] = coerce(r[i] ?? '');
    });
    return obj;
  });
  return { rows, columns: header };
}

/* ------------------------------ 统计 ------------------------------ */

/** 一列的取值（跳过空） */
function columnValues(rows: Record<string, unknown>[], column: string): unknown[] {
  return rows.map((r) => r[column]).filter((v) => v !== '' && v !== null && v !== undefined);
}

/** 推断列类型 */
export function inferType(values: unknown[]): 'number' | 'boolean' | 'string' {
  if (!values.length) return 'string';
  const meaningful = values.filter((v) => v !== '' && v !== null && v !== undefined);
  if (!meaningful.length) return 'string';
  if (meaningful.every((v) => typeof v === 'number')) return 'number';
  if (meaningful.every((v) => typeof v === 'boolean')) return 'boolean';
  if (
    meaningful.every(
      (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))),
    )
  ) {
    return 'number';
  }
  return 'string';
}

/** 分位数 */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 数值列的统计量 */
export function numericStats(values: number[]): Record<string, number> {
  if (!values.length) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sum,
    mean,
    median: percentile(sorted, 0.5),
    std: Math.sqrt(variance),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
  };
}

/** 一列的画像 */
export function profileColumn(rows: Record<string, unknown>[], column: string): ColumnProfile {
  const raw = columnValues(rows, column);
  const type = inferType(raw);
  const unique = new Set(raw.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))));
  const profile: ColumnProfile = {
    name: column,
    type,
    count: raw.length,
    missing: rows.length - raw.length,
    unique: unique.size,
  };

  if (type === 'number') {
    const nums = raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    Object.assign(profile, numericStats(nums));
  }

  const counts = new Map<string, number>();
  for (const v of raw) {
    const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  profile.top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));

  return profile;
}

/* ------------------------------ 操作 ------------------------------ */

/** 筛选：把值转成可比的再比 */
function compare(value: unknown, op: string, target: string): boolean {
  const num = Number(value);
  const targetNum = Number(target);
  const bothNumeric = Number.isFinite(num) && Number.isFinite(targetNum) && target.trim() !== '';
  const a = bothNumeric ? num : String(value ?? '').toLowerCase();
  const b = bothNumeric ? targetNum : target.toLowerCase();
  switch (op) {
    case 'eq':
    case '=':
      return a === b;
    case 'ne':
    case '!=':
      return a !== b;
    case 'gt':
    case '>':
      return a > b;
    case 'gte':
    case '>=':
      return a >= b;
    case 'lt':
    case '<':
      return a < b;
    case 'lte':
    case '<=':
      return a <= b;
    case 'contains':
      return String(value ?? '').toLowerCase().includes(target.toLowerCase());
    default:
      return false;
  }
}

/** 保留几位小数：算出来的数不用摆到小数点后十几位 */
function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** 跑一次分析 */
export function analyze(params: AnalyzeParams): AnalyzeResult {
  const { rows, columns } = parseTable(params.source, params.format);
  const op: AnalyzeOp = params.op || 'describe';

  if (op === 'describe') {
    return { rows: rows.length, columns, profiles: columns.map((c) => profileColumn(rows, c)) };
  }

  if (op === 'groupby') {
    const keys = (params.groupBy || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!keys.length) throw new AnalyzeError('要分组就得说清楚按哪一列分（groupBy）');
    const missing = keys.filter((k) => !columns.includes(k));
    if (missing.length) throw new AnalyzeError(`没有这些列：${missing.join('、')}。可用的列：${columns.join('、')}`);

    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const key = keys.map((k) => String(row[k] ?? '')).join(' / ');
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }

    const numericColumns = columns.filter((c) => inferType(columnValues(rows, c)) === 'number');
    const result = [...groups.entries()]
      .map(([key, bucket]) => {
        const stats: Record<string, number> = {};
        for (const col of numericColumns) {
          const nums = columnValues(bucket, col).map(Number).filter((n) => Number.isFinite(n));
          const s = numericStats(nums);
          stats[`${col}_sum`] = round(s.sum ?? 0);
          stats[`${col}_mean`] = round(s.mean ?? 0);
          stats[`${col}_min`] = round(s.min ?? 0);
          stats[`${col}_max`] = round(s.max ?? 0);
        }
        return { key, count: bucket.length, stats };
      })
      .sort((a, b) => b.count - a.count);

    return { rows: rows.length, columns, groups: result };
  }

  if (op === 'filter') {
    const column = (params.column || '').trim();
    if (!column) throw new AnalyzeError('要筛选就得说清楚按哪一列筛（column）');
    if (!columns.includes(column)) throw new AnalyzeError(`没有这一列：${column}。可用的列：${columns.join('、')}`);
    const condition = (params.condition || 'eq').trim().toLowerCase();
    const target = params.value ?? '';
    const matched = rows.filter((r) => compare(r[column], condition, target));
    const limit = Math.max(Number(params.limit) || 50, 1);
    return { rows: rows.length, columns, matchedCount: matched.length, matched: matched.slice(0, limit) };
  }

  // top
  const column = (params.column || '').trim();
  if (!column) throw new AnalyzeError('要排序就得说清楚按哪一列排（column）');
  if (!columns.includes(column)) throw new AnalyzeError(`没有这一列：${column}。可用的列：${columns.join('、')}`);
  const limit = Math.max(Number(params.limit) || 10, 1);
  const desc = (params.condition || 'desc').toLowerCase() !== 'asc';
  const sorted = [...rows].sort((a, b) => {
    const av = a[column];
    const bv = b[column];
    const an = Number(av);
    const bn = Number(bv);
    const bothNumeric = Number.isFinite(an) && Number.isFinite(bn) && av !== '' && bv !== '';
    if (bothNumeric) return desc ? bn - an : an - bn;
    const cmp = String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN');
    return desc ? -cmp : cmp;
  });
  return { rows: rows.length, columns, matchedCount: sorted.length, matched: sorted.slice(0, limit) };
}

/** 把结果写成给人看的样子 */
export function formatAnalyzeResult(result: AnalyzeResult, op: AnalyzeOp): string {
  const lines: string[] = [];

  if (op === 'describe' && result.profiles) {
    lines.push(`共 ${result.rows} 行，${result.columns.length} 列`);
    for (const p of result.profiles) {
      const head = `列「${p.name}」类型 ${p.type}，有效 ${p.count}，缺失 ${p.missing}，不同取值 ${p.unique}`;
      if (p.type === 'number') {
        lines.push(
          `${head}；最小 ${p.min}，最大 ${p.max}，平均 ${round(p.mean ?? 0)}，中位 ${round(p.median ?? 0)}，标准差 ${round(p.std ?? 0)}`,
        );
      } else {
        lines.push(head);
      }
      if (p.top?.length) {
        lines.push(`  最常见取值：${p.top.map((t) => `${t.value}（${t.count} 次）`).join('、')}`);
      }
    }
    return lines.join('\n');
  }

  if (op === 'groupby' && result.groups) {
    lines.push(`共 ${result.rows} 行，分成 ${result.groups.length} 组`);
    for (const g of result.groups) {
      const stats = Object.entries(g.stats)
        .map(([k, v]) => `${k}=${v}`)
        .join('，');
      lines.push(`组「${g.key}」共 ${g.count} 行${stats ? '；' + stats : ''}`);
    }
    return lines.join('\n');
  }

  const matched = result.matched ?? [];
  lines.push(`共 ${result.rows} 行，命中 ${result.matchedCount ?? matched.length} 行`);
  for (const row of matched) {
    lines.push(
      Object.entries(row)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('，'),
    );
  }
  return lines.join('\n');
}
