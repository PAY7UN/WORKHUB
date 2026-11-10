/**
 * 能力加载器：把磁盘上的目录扫成运行时可用的能力清单。
 *
 * 一份能力 = 一个目录：
 *
 *   skills/web-fetch/
 *     SKILL.md      说明书：frontmatter(name/description) + 正文用法
 *     skill.json    执行契约：方法、路径、入参、返回、权限
 *
 * 为什么要落成文件：
 * - 用户能自己加一份能力，不用等发版；
 * - 模型能按渐进式披露的方式读它：发现阶段只花 name + description 的钱，
 *   真要用到时才读正文；
 * - 能力说明书和代码放在一起，改代码的时候顺手就改坏了说明。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SkillCategory,
  SkillMode,
  SkillParamSpec,
  SkillSessionSpec,
  SkillSpec,
} from '../../shared/skills.ts';

/** skill.json 的形状：执行契约 */
interface SkillManifest {
  id?: string;
  name?: string;
  category?: SkillCategory;
  summary?: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  endpoint?: string;
  adminOnly?: boolean;
  composable?: boolean;
  mode?: SkillMode;
  session?: SkillSessionSpec;
  params?: SkillParamSpec[];
  returns?: string;
  /** 关掉这份能力而不删目录 */
  enabled?: boolean;
}

/** 解析出来的 frontmatter */
export interface SkillFrontmatter {
  /** 顶层键值对 */
  fields: Record<string, string>;
  /** metadata 下的键值对 */
  metadata: Record<string, string>;
  /** 正文 */
  body: string;
}

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 只认一小撮 YAML：顶层 `key: value` 与一层 `metadata:` 缩进块。
 * 能力说明书不需要更复杂的 YAML，写复杂了反而说明文件该拆开。
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};

  if (!normalized.startsWith('---\n')) {
    return { fields, metadata, body: normalized.trim() };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    return { fields, metadata, body: normalized.trim() };
  }
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');

  let inMetadata = false;
  for (const raw of head.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;

    const indented = /^\s+/.test(raw);
    const line = raw.trim();
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = unquote(line.slice(idx + 1).trim());

    if (indented) {
      if (inMetadata) metadata[key] = value;
      continue;
    }
    inMetadata = key === 'metadata';
    if (!inMetadata) fields[key] = value;
  }

  return { fields, metadata, body: body.trim() };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** 读一个能力目录，得到它的规格 */
export interface LoadedSkill {
  spec: SkillSpec;
  /** 目录路径：界面上让人知道这份能力躺在哪儿 */
  dir: string;
  /** 加载时发现的问题 */
  warnings: string[];
  /**
   * 这份能力能不能进清单。
   *
   * name 与 description 缺一不可：模型靠它们决定「什么时候该想起这份能力」，
   * 缺了的能力既认不出来，也没法被搜到——摆进清单只会占位误导人。
   */
  valid: boolean;
}

/**
 * 读一个能力目录。
 *
 * 读不出来就说明白为什么，不静默跳过——一份写坏的能力如果悄没声地不见了，
 * 用户会以为是功能没了。
 */
export function loadSkillDir(dir: string, source: 'builtin' | 'user', slug: string, hasRunner: (id: string) => boolean): LoadedSkill | null {
  const warnings: string[] = [];
  const mdPath = join(dir, 'SKILL.md');
  if (!existsSync(mdPath)) return null;

  const { fields, metadata, body } = parseSkillFrontmatter(readFileSync(mdPath, 'utf8'));
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  if (!name) warnings.push('frontmatter 缺 name');
  if (!description) warnings.push('frontmatter 缺 description');

  let manifest: SkillManifest = {};
  const jsonPath = join(dir, 'skill.json');
  if (existsSync(jsonPath)) {
    try {
      manifest = JSON.parse(readFileSync(jsonPath, 'utf8')) as SkillManifest;
    } catch (err) {
      warnings.push(`skill.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (manifest.enabled === false) return null;

  const id = manifest.id ?? metadata.id ?? slug;
  const category = (manifest.category ?? metadata.category ?? 'system') as SkillCategory;
  const mode = (manifest.mode ?? metadata.mode ?? 'request') as SkillMode;

  const spec: SkillSpec = {
    id,
    slug,
    name: manifest.name ?? name ?? slug,
    category,
    summary: manifest.summary ?? '',
    description: description || manifest.summary || '',
    instructions: body,
    method: manifest.method,
    endpoint: manifest.endpoint,
    adminOnly: manifest.adminOnly ?? false,
    composable: manifest.composable ?? false,
    mode,
    session: manifest.session,
    params: manifest.params ?? [],
    returns: manifest.returns,
    source,
    executable: hasRunner(id) || Boolean(manifest.endpoint),
    hasRunner: hasRunner(id),
  };

  return { spec, dir, warnings, valid: Boolean(name) && Boolean(description) };
}

/**
 * 扫一个能力根目录。
 *
 * 目录名以 `_` 开头的跳过：那是放模板与说明的地方，不是能力。
 */
export function loadSkillsFromRoot(root: string, source: 'builtin' | 'user', hasRunner: (id: string) => boolean): { skills: SkillSpec[]; warnings: string[] } {
  const skills: SkillSpec[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { skills, warnings };

  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch (err) {
    warnings.push(`读不了能力目录 ${root}：${err instanceof Error ? err.message : String(err)}`);
    return { skills, warnings };
  }

  for (const slug of entries.sort()) {
    if (slug.startsWith('_') || slug.startsWith('.')) continue;
    const dir = join(root, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const loaded = loadSkillDir(dir, source, slug, hasRunner);
    if (!loaded) continue;
    for (const w of loaded.warnings) warnings.push(`${slug}：${w}`);
    // 写坏的能力不进清单：模型靠 name + description 认人，缺了就等于没有
    if (!loaded.valid) continue;
    skills.push(loaded.spec);
  }

  return { skills, warnings };
}
