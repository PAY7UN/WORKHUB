import { Wrench } from 'lucide-react';

/**
 * 工具区（接入与仿真）。
 *
 * 独立路由页，不在管理后台里：
 * 工具是对所有登录用户开放的，监听一旦跑起来还会在服务端长驻，
 * 实时数据流更不能被一个后台页面的生命周期绑住。
 *
 * 顶栏由 App 层统一提供（品牌 + 文档/工具/系统），这里只剩页面本身。
 *
 * 现在这一页是空的。
 *
 * 网页监听、串口监听、网口监听、虚拟服务器——这四样东西看着不一样，
 * 落到数据上其实是同一种东西的四种来源：字节流，
 * 共用同一条流水线「数据源 → 协议解析 → 落成文档」，
 * 区别只在「字节从哪儿来」和「按哪套协议拆」。
 *
 * 正因为如此，页里将来也只按这一条流水线组织，
 * 而不是把四种通道铺成四张卡片——每多一种通道就多一块，
 * 而它们对用户来说本来就不是四件事。
 */
export function ToolsPage() {
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-5 py-8">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5 text-indigo-500" />
          <h1 className="text-lg font-semibold">接入与仿真</h1>
        </div>
        <p className="mt-1 text-[12px] text-muted-foreground">
          还没进库的数据怎么进来：网页、串口、网口监听与虚拟服务器。
        </p>

        {/* 空状态：这一区现在确实还没有东西 */}
        <div className="mt-6 rounded-2xl border border-dashed border-border/70 px-6 py-16 text-center">
          <Wrench className="mx-auto h-7 w-7 text-indigo-400" />
          <h2 className="mt-4 text-base font-semibold">工具区还空着</h2>
          <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-muted-foreground">
            网页监听、串口监听、网口监听、虚拟服务器——这四类通道都在规划中。
            做好了会先放到这一页；现在这里什么都不摆，
            免得摆四个点不着的按钮，让人以为已经能用。
          </p>
          <p className="mx-auto mt-4 max-w-md text-[11px] leading-relaxed text-muted-foreground/80">
            这一区对所有登录用户开放：谁需要接设备、谁需要联调，不用先找管理员开权限。
            通道参数（端口、设备、协议模板）属于服务器上的配置，等通道发布时一并给出。
          </p>
        </div>
      </div>
    </div>
  );
}
