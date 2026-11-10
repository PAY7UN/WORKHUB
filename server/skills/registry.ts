/**
 * 能力注册表：运行时唯一的能力真源。
 *
 * 能力住在磁盘上，注册表负责把它们扫出来、缓存起来、按 id 找到。
 * 有了它，界面上那份清单、模型眼前那份清单、任务里那份清单，
 * 说的都是同一批能力——不会再出现「界面上有、模型看不到」这种两套账。
 */
import { mkdirSync } from 'node:fs';
import type { SkillSpec } from '../../shared/skills.ts';
import { resolveSkillsDirs } from '../paths.ts';
import { loadSkillsFromRoot } from './loader.ts';
import { findSkillRunner } from './runners.ts';

interface SkillRegistry {
  skills: SkillSpec[];
  warnings: string[];
}

let cache: SkillRegistry | null = null;

/** 有没有执行体：决定这份能力能不能直接跑 */
function hasRunner(id: string): boolean {
  return Boolean(findSkillRunner(id));
}

/**
 * 扫盘。
 *
 * 内置目录先扫、用户目录后扫：同一个 id 出现两次时，用户那份覆盖内置那份，
 * 这样用户可以拿自己的能力替换掉内置的，不用改代码发版。
 */
function scanSkills(): SkillRegistry {
  const byId = new Map<string, SkillSpec>();
  const warnings: string[] = [];

  for (const { dir, source } of resolveSkillsDirs()) {
    // 用户目录先建出来：不然「往里丢一份文件就多一份能力」的第一步
    // 变成了「先得自己建个目录」——那不是能力可插拔，是能力可插拔附带一份家务事。
    if (source === 'user') {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* 建不出来就当它不存在：扫描会返回空，界面照常显示 */
      }
    }
    const result = loadSkillsFromRoot(dir, source, hasRunner);
    warnings.push(...result.warnings);
    for (const skill of result.skills) byId.set(skill.id, skill);
  }

  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { skills, warnings };
}

/** 当前的能力清单（第一次调用时扫盘） */
export function getSkills(): SkillSpec[] {
  if (!cache) cache = scanSkills();
  return cache.skills;
}

/** 重新扫盘：用户刚放了一份新能力进来时用得上 */
export function refreshSkills(): SkillSpec[] {
  cache = scanSkills();
  return cache.skills;
}

/** 扫描时发现的问题（写坏的能力文件等） */
export function getSkillWarnings(): string[] {
  return getSkills() && cache ? cache.warnings : [];
}

/** 按 id 找一份能力 */
export function findSkill(id: string): SkillSpec | undefined {
  return getSkills().find((s) => s.id === id);
}
