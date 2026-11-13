import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, X } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';

/**
 * 管理员密码还停在初始值时的提醒条。
 *
 * 它挂在 App 层而不是工作台里：先前只有工作台有这一条，
 * 从工作台点进后台、工具页，整块内容会突然上移四十几像素——
 * 同一个提示在页面之间时有时无，看起来就像布局没搭稳。
 *
 * 现在所有页面共用一个高度的提示条，页面切换时内容位置不动。
 * 关掉它只是本次的事：密码没改，刷新后提醒就该回来。
 */
export function PasswordNotice() {
  const { adminPasswordState } = useApp();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);

  if (adminPasswordState === 'custom' || dismissed) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-200/80 bg-amber-50/90 px-3 py-2 text-[12px] leading-snug text-amber-900 sm:px-4 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {adminPasswordState === 'initial-default'
          ? '管理员密码还是默认的 admin，请尽快改掉——这个值谁都知道。'
          : '管理员密码还是部署时设定的初始密码，建议尽快改掉。'}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigate('/admin/security')}
        className="h-6 shrink-0 border-amber-300 px-2 text-[11px] text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/40"
      >
        去修改
      </Button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        title="本次先这样（刷新页面还会再提醒）"
        className="shrink-0 cursor-pointer rounded p-0.5 text-amber-700/70 hover:bg-amber-200/60 hover:text-amber-900 dark:text-amber-300/70 dark:hover:bg-amber-900/40"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
