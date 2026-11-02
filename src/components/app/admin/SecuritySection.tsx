import { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from '@/context/AppContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const MIN_LEN = 8;

/**
 * 账号安全（管理后台 · 账号安全分区）。
 *
 * 改密要填当前密码——不是形式主义：没有这一步，任何人捡到一台没锁屏的电脑
 * 就能把管理员密码换掉，等于直接接管整个工作区。
 *
 * 改完服务端会让所有旧令牌失效并给本机换发新的，所以这里不需要额外处理登录态。
 */
export function SecuritySection() {
  const { changeAdminPassword } = useApp();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const validate = (): string => {
    if (!currentPassword) return '请输入当前密码';
    if (newPassword.length < MIN_LEN) return `新密码至少 ${MIN_LEN} 位`;
    if (newPassword !== confirm) return '两次输入不一致';
    if (newPassword === currentPassword) return '新密码不能与当前密码相同';
    return '';
  };

  const handleSubmit = async () => {
    const msg = validate();
    setError(msg);
    if (msg) return;
    setSaving(true);
    try {
      await changeAdminPassword(currentPassword, newPassword);
      toast.success('密码已修改，其他设备需重新登录');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (e) {
      setError((e as Error)?.message ?? '修改失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        修改后服务端会立即清空其它设备上的会话；本机会自动换发新令牌，无需重新登录。
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="current-password">当前密码</Label>
        <Input
          id="current-password"
          type="password"
          value={currentPassword}
          onChange={(e) => {
            setCurrentPassword(e.target.value);
            setError('');
          }}
          placeholder="验证身份用"
          autoComplete="current-password"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="new-password">新密码</Label>
        <Input
          id="new-password"
          type="password"
          value={newPassword}
          onChange={(e) => {
            setNewPassword(e.target.value);
            setError('');
          }}
          placeholder={`至少 ${MIN_LEN} 位`}
          autoComplete="new-password"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">确认新密码</Label>
        <Input
          id="confirm-password"
          type="password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSubmit();
          }}
          placeholder="再输入一次"
          autoComplete="new-password"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-500 dark:border-red-900 dark:bg-red-950/30">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => void handleSubmit()} disabled={saving}>
          {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          修改密码
        </Button>
      </div>
    </div>
  );
}
