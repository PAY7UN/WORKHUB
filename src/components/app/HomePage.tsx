import { useState, useEffect, useMemo } from 'react';
import {
  FileText,
  Sparkles,
  Shield,
  Edit3,
  Eye,
  Download,
  FolderTree,
  ArrowRight,
  ChevronLeft,
  ShieldCheck,
  LogOut,
  Lock,
  Package,
  ScrollText,
  Loader2,
} from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatBytes } from '@/utils';
import { toast } from 'sonner';

interface HomePageProps {
  onEnter: () => void;
}

export function HomePage({ onEnter }: HomePageProps) {
  const { loginAdmin, logoutAdmin, isAdmin, docs, repos, bootstrapping } = useApp();
  const [mounted, setMounted] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setMounted(true);
  }, []);

  /**
   * 首页概览：这里到底有什么。
   *
   * 之前首页只有一句宣传语，进来的人得先进工作区才知道里面是不是空的。
   * 概览把「有多少东西、都是些什么」摆到门口——
   * 一眼看出是个空站点的人，就不用白走一趟。
   *
   * 只报数，不列清单：具体文档与仓库清单在工作区里，
   * 首页重复一份只会让人两边看着像两套数据。
   */
  const overview = useMemo(() => {
    const files = docs.filter((d) => d.type === 'file');
    const notes = files.filter((d) => d.kind !== 'file');
    const originals = files.filter((d) => d.kind === 'file');
    const encrypted = files.filter((d) => d.encrypted);
    const bytes = files.reduce((sum, d) => sum + (d.size ?? 0), 0);
    return { notes: notes.length, originals: originals.length, encrypted: encrypted.length, bytes };
  }, [docs]);

  const handleAdminLogin = async () => {
    if (!password) return;
    const result = await loginAdmin(password);
    if (result.ok) {
      toast.success('管理员登录成功');
      setShowLogin(false);
      onEnter();
    } else {
      // 原样透出失败原因：笼统报「密码错误」会把限流、后端未启动、
      // 网络不可达一并伪装成密码打错，用户只会反复重输。
      setError(result.message || '密码错误，请重新输入');
    }
  };

  return (
    <div className="relative h-full overflow-y-auto scrollbar-thin">
      {/* 背景光斑 */}
      <div className="pointer-events-none fixed -top-32 -left-32 h-96 w-96 rounded-full bg-indigo-400/30 blur-3xl float-animation" />
      <div className="pointer-events-none fixed -bottom-32 -right-32 h-96 w-96 rounded-full bg-emerald-400/25 blur-3xl float-animation-delay" />
      <div className="pointer-events-none fixed top-1/3 right-1/4 h-72 w-72 rounded-full bg-violet-400/20 blur-3xl float-animation" />

      {/* 顶部导航 */}
      <header className="relative z-10 max-w-6xl mx-auto flex items-center justify-between px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-0 gradient-bg rounded-2xl blur-lg opacity-60" />
            <div className="relative h-11 w-11 rounded-2xl gradient-bg flex items-center justify-center shadow-lg">
              <FileText className="h-5.5 w-5.5 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-xl font-bold gradient-text leading-tight">WorkHub</h1>
            <p className="text-xs text-muted-foreground">个人记录网站</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Badge
              variant="secondary"
              className="bg-indigo-100/70 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
            >
              <ShieldCheck className="h-3 w-3 mr-1" /> 管理员已登录
            </Badge>
          )}
        </div>
      </header>

      {/* 主体 */}
      <div className="relative z-10 max-w-6xl mx-auto px-6 pb-16 grid lg:grid-cols-2 gap-10 items-start pt-8">
        {/* 左侧文案 */}
        <div
          className={`space-y-8 transition-all duration-700 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
          }`}
        >
          <div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full glass text-xs font-medium text-indigo-600 dark:text-indigo-300 mb-4">
              <Sparkles className="h-3.5 w-3.5" />
              笔记能写 · 文件能放 · 权限能收
            </div>
            <h2 className="text-4xl lg:text-5xl font-bold leading-tight">
              个人记录
              <br />
              <span className="gradient-text">各归其位</span>
            </h2>
            <p className="mt-5 text-lg text-muted-foreground max-w-md">
              WorkHub 把「要写的」和「要存的」分开对待：笔记用 Markdown 写，
              压缩包、图片、PDF 按原样存——上传一个 zip，不会凭空多出一篇同名备注。
            </p>
          </div>

          {/* 功能列表 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg">
            <FeatureCard icon={<Edit3 className="h-5 w-5" />} title="在线编辑" desc="分屏实时预览，工具栏快捷排版" />
            <FeatureCard icon={<Package className="h-5 w-5" />} title="原件直存" desc="zip/图片/PDF 原样保留，不配空备注" />
            <FeatureCard icon={<Download className="h-5 w-5" />} title="按格式下载" desc="笔记导出 .md，文件回传原件" />
            <FeatureCard icon={<Shield className="h-5 w-5" />} title="分级授权" desc="查看与下载分开给，全程留痕" />
          </div>
        </div>

        {/* 右侧：入口卡片 + 内容概览 */}
        <div
          className={`space-y-4 transition-all duration-700 delay-150 ${
            mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
          }`}
        >
          <Card className="glass-strong shadow-2xl border-0">
            <CardContent className="p-8 space-y-5">
              <div className="text-center">
                <h3 className="text-2xl font-bold">{isAdmin ? '欢迎回来 👋' : '开始使用 👋'}</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {isAdmin
                    ? '已以管理员身份登录，进入后可直接编辑、上传、移动、删除文档'
                    : '以访客身份直接浏览，或登录管理员解锁编辑'}
                </p>
              </div>

              {isAdmin ? (
                <>
                  <Button
                    onClick={onEnter}
                    className="w-full h-12 gradient-bg hover:opacity-90 transition-all shadow-lg shadow-indigo-500/30 text-base"
                  >
                    <ShieldCheck className="h-5 w-5 mr-2" />
                    进入个人记录网站
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      logoutAdmin();
                      toast.success('已退出管理员登录，当前为访客身份');
                    }}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    <LogOut className="h-4 w-4 mr-2" />
                    退出管理员登录
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    onClick={onEnter}
                    className="w-full h-12 gradient-bg hover:opacity-90 transition-all shadow-lg shadow-indigo-500/30 text-base"
                  >
                    <Eye className="h-5 w-5 mr-2" />
                    以访客身份进入
                    <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>

                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-muted-foreground">需要编辑文档？</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                </>
              )}

              {!isAdmin && (!showLogin ? (
                <Button
                  onClick={() => setShowLogin(true)}
                  variant="outline"
                  className="w-full h-12 border-indigo-300/60 hover:bg-indigo-50/60 text-base"
                >
                  <ShieldCheck className="h-5 w-5 mr-2 text-indigo-500" />
                  管理员登录
                </Button>
              ) : (
                <div className="space-y-3 animate-scale-in">
                  <div className="space-y-2">
                    <Label htmlFor="home-admin-password">管理员密码</Label>
                    <Input
                      id="home-admin-password"
                      type="password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError('');
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleAdminLogin();
                      }}
                      placeholder="请输入管理员密码"
                      className="h-11 bg-white/60 dark:bg-white/5 border-indigo-200/50 focus:border-indigo-400"
                      autoFocus
                    />
                  </div>
                  {error && (
                    <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">
                      {error}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setShowLogin(false);
                        setError('');
                        setPassword('');
                      }}
                      className="flex-1"
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" /> 返回
                    </Button>
                    <Button
                      onClick={() => void handleAdminLogin()}
                      className="flex-1 gradient-bg hover:opacity-90"
                      disabled={!password}
                    >
                      登录并进入
                    </Button>
                  </div>
                  <p className="text-center text-[10px] text-muted-foreground">
                    密码由管理员统一配置。首次使用的默认密码是 admin，登录后请到
                    「管理后台 → 账号安全」改掉。
                  </p>
                </div>
              ))}

              <p className="text-center text-xs text-muted-foreground">
                访客可浏览与预览全部文档（加密文档需申请授权，下载另行放行） · 管理员可编辑、上传、移动、删除
              </p>
            </CardContent>
          </Card>

          {/* 内容概览：站在门口就知道里面有没有东西、都是些什么 */}
          <Card className="glass shadow-lg">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <FolderTree className="h-4 w-4 text-indigo-500" />
                站点概览
              </div>

              {bootstrapping ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取…
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-2">
                    <Stat label="笔记" value={overview.notes} icon={<ScrollText className="h-3.5 w-3.5" />} />
                    <Stat label="原件" value={overview.originals} icon={<Package className="h-3.5 w-3.5" />} />
                    <Stat label="仓库" value={repos.length} icon={<FolderTree className="h-3.5 w-3.5" />} />
                    <Stat label="加密" value={overview.encrypted} icon={<Lock className="h-3.5 w-3.5" />} />
                  </div>

                  {overview.bytes > 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      正文与原件合计 {formatBytes(overview.bytes)}
                    </div>
                  )}

                  {overview.notes + overview.originals === 0 && (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                      站点还没有内容。上传第一个文件或文档就会出现在这里。
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 底部 */}
      <footer className="relative z-10 text-center text-xs text-muted-foreground pb-8">
        WorkHub 个人记录网站 · 文档与原件存储于服务端仓库目录
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-white/50 px-2 py-2 text-center dark:bg-white/5">
      <div className="flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-lg font-bold leading-none">{value}</div>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="glass rounded-xl p-4 hover:shadow-lg hover:scale-[1.02] transition-all cursor-default">
      <div className="h-9 w-9 rounded-lg gradient-bg flex items-center justify-center text-white mb-3">{icon}</div>
      <div className="font-semibold text-sm">{title}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
    </div>
  );
}
