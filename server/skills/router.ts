/**
 * 能力（Skill）清单接口。
 *
 * 能力平时只活在两个地方：模型眼前的那份清单、任务里的那份清单。
 * 人想看得见它们时，就差这一个接口——「能力清单」那一页靠它摆条目。
 *
 * 只给摘要，不给正文（SKILL.md 的 instructions）：
 * - 摘要够画卡片了：叫什么、什么时候用、能传什么参数；
 * - 正文是给模型读的说明书，整份端到浏览器没有意义，还平白多一份可以拖下线的副本。
 *
 * 和别处一样：清单来自注册表，注册表扫的是磁盘——
 * 往 skills/ 或用户能力目录里丢一份能力，这页立刻就能看见，不用改代码。
 */
import { Router } from 'express';
import { getSkills, getSkillWarnings } from './registry.ts';
import type { SkillSummary } from '../../shared/skills.ts';

/** 建能力清单路由 */
export function createSkillsRouter(): Router {
  const router = Router();

  /** 能力清单：给界面摆条目用 */
  router.get('/', (_req, res) => {
    const skills: SkillSummary[] = getSkills().map(({ instructions: _instructions, ...rest }) => rest);
    res.json({ skills, warnings: getSkillWarnings() });
  });

  return router;
}
