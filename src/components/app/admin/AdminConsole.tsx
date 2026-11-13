import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { isAdminSection, type AdminSection } from '@/types';
import { AccessSection } from './AccessSection';
import { AdminTopBar } from './AdminTopBar';
import { AgentSection } from './AgentSection';
import { EncryptedDocsSection } from './EncryptedDocsSection';
import { OverviewSection } from './OverviewSection';
import { ProjectsSection } from './ProjectsSection';
import { SecuritySection } from './SecuritySection';

/**
 * 管理后台。
 *
 * 它是一个独立路由页（/admin/:section），不是弹窗：
 * 弹窗一关内容就没了，而后台里的「访问权限」常常要停下来核对再去别处取数。
 * 独立页面顺带解决了深链——把 /admin/access 直接发给别人，对方点开就落在同一处。
 *
 * 导航只有一条（见 AdminTopBar）：六个分区平铺在内容区顶部。
 * 以前左侧那一列导航把内容挤成窄条，仓库列表一屏放不下几行——
 * 导航一挪走，内容整块铺开，宽表格终于能横着看。
 *
 * 各分区内容各自独立成文件：这个文件只负责「现在该显示哪一块」，
 * 不再把六件事的界面细节堆在一个组件里。
 */
export function AdminConsole() {
  const { docs, pendingAccessCount, isAdmin } = useApp();
  const navigate = useNavigate();
  const params = useParams<{ section?: string }>();
  const [searchParams] = useSearchParams();

  // 旧链接：仓库管理已经并进文档区的「项目仓库」，留着旧路径的人别撞空
  if (params.section === 'repos') {
    return <Navigate to="/admin/projects" replace />;
  }

  // URL 里没带分区或带了不认识的分区，一律回落到概览
  if (!isAdminSection(params.section)) {
    return <Navigate to="/admin/overview" replace />;
  }
  const section: AdminSection = params.section;

  /**
   * 文档范围限定与申请单定位都走查询参数，不再靠全局 state：
   * 刷新一次、转发一次链接，看到的都还是同一处。
   */
  const docId = searchParams.get('doc') ?? undefined;
  const docName = docId ? docs.find((d) => d.id === docId)?.name : undefined;
  const focusRequestId = searchParams.get('req') ?? undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <AdminTopBar
        section={section}
        pending={pendingAccessCount}
        onSelect={(s) => navigate(`/admin/${s}`)}
      />

      {/* 分区内容：整块铺开，不再被左侧导航挤着 */}
      <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {!isAdmin ? (
            /*
             * 后台现在是可直达的 URL，访客顺着链接进来就会看到这里。
             * 与其让每个分区各自抛「仅管理员可以…」，
             * 不如在门口说清一句话——不然满屏报错像出了故障。
             */
            <div className="mx-auto max-w-sm py-16 text-center">
              <ShieldAlert className="mx-auto h-7 w-7 text-amber-500" />
              <p className="mt-3 text-sm font-medium">这一区需要管理员权限</p>
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                管理后台管的是整个站点，访客进来看不到东西是应该的。
                请用管理员账号登录后再来。
              </p>
              <Button size="sm" variant="outline" className="mt-4" onClick={() => navigate('/')}>
                回到工作区
              </Button>
            </div>
          ) : (
            <>
              {section === 'overview' && (
                <OverviewSection onNavigate={(s) => navigate(`/admin/${s}`)} />
              )}
              {section === 'projects' && <ProjectsSection />}
              {section === 'encrypted' && <EncryptedDocsSection />}
              {section === 'access' && (
                <AccessSection
                  docId={docId}
                  docName={docName}
                  onClearFilter={() => navigate('/admin/access')}
                  focusRequestId={focusRequestId}
                />
              )}
              {section === 'agent' && <AgentSection />}
              {section === 'security' && <SecuritySection />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
