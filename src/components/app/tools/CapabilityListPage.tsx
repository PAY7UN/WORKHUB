import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { SKILL_CATEGORY_ORDER, type SkillCategory, type SkillSummary } from '../../../../shared/skills';

/** 分类的中文名 */
const CATEGORY_LABELS: Record<SkillCategory, string> = {
  web: '网页',
  data: '数据',
  search: '检索',
  ai: '智能',
  content: '文档',
  access: '权限',
  system: '系统',
};

/**
 * 能力清单：接进来之后能干哪些活。
 *
 * 这一页只摆「有什么」：名字、干什么、要传什么。
 *
 * 不摆用法：能力平时是跟 AI 助手说的，说法只有一句，
 * 在页头说一次就够；每张卡再抄一遍「在对话里说一句就能用上」就成了噪音——
 * 同一句话在四张卡上重复四遍，读者只会觉得界面很吵。
 *
 * **排版：一层横排网格，不再按分类分段。**
 * 原来按分类分五段、每段竖着铺大卡片，九项能力撑成五屏，
 * 而每张卡里大半是空白——分类标题占了位置，能力本身反而被拉散了。
 * 现在：
 *
 * - 分类降级成每项上的一个小标签（描边，弱），信息还在，不占版面；
 * - 能力按分类顺序排平，宽屏三列、窄屏两列，一屏能看完；
 * - 参数从一行灰字改成小 chip：横着排、密一点，一眼扫过去就知道要传什么。
 */
export function CapabilityListPage() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api.skills.list();
        if (alive) setSkills(result.skills);
      } catch {
        /* 拿不到就空着 */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /** 排平：先按分类顺序，同类里按名字排 */
  const items = useMemo(() => {
    const order = new Map(SKILL_CATEGORY_ORDER.map((category, index) => [category, index]));
    return [...skills].sort((a, b) => {
      const byCategory = (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99);
      return byCategory !== 0 ? byCategory : a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }, [skills]);

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4 overflow-y-auto px-6 py-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold tracking-tight">能力清单</h1>
          {loading ? null : (
            <span className="text-[12px] text-muted-foreground/80">{skills.length} 项</span>
          )}
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          接进来之后能干哪些活。在 AI 助手里说一句就行，比如「把这份 PDF 转成 Markdown」。
        </p>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在读取能力清单…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-[12px] text-muted-foreground">
          还没有能力。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {items.map((skill) => (
            <article
              key={skill.id}
              className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/30 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="text-[13px] font-medium">{skill.name}</span>
                <span className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {CATEGORY_LABELS[skill.category]}
                </span>
                {skill.adminOnly ? (
                  <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                    仅管理员
                  </Badge>
                ) : null}
                <code className="ml-auto font-mono text-[10px] text-muted-foreground/60">{skill.id}</code>
              </div>
              <p className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                {skill.summary}
              </p>
              {skill.params.length ? (
                <div className="flex flex-wrap gap-1">
                  {skill.params.map((param) => (
                    <span
                      key={param.key}
                      className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground/90"
                    >
                      {param.label}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
