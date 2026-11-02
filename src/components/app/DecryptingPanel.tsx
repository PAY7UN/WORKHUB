import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DecryptingPanelProps {
  /** 解密失败的原因；为空表示仍在解密中 */
  error?: string;
  /** 重试解密 */
  onRetry?: () => void;
}

/**
 * 管理员免密查看加密文档时的中间态。
 *
 * 解密发生在服务端：浏览器从头到尾拿不到正文密文，
 * 前端也没有任何解密运算要做。这里只负责交代「在等什么」，
 * 以及失败时把原因说清楚——最常见的原因是服务端密钥被换过，
 * 此时 enc_master_dek 再也解不开，正文永远取不回来了。
 */
export function DecryptingPanel({ error, onRetry }: DecryptingPanelProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 overflow-auto">
      <div className="w-full max-w-sm rounded-xl border border-indigo-200/60 dark:border-indigo-900/60 bg-white/60 dark:bg-white/5 p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100/70 dark:bg-indigo-950/50">
          {error ? (
            <AlertCircle className="h-6 w-6 text-rose-500" />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
          )}
        </div>
        <h3 className="mb-1 text-sm font-semibold text-foreground">
          {error ? '无法解密该文档' : '正在解密…'}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {error ?? '管理员凭服务端主密钥直接解密，无需任何口令。'}
        </p>
        {error && onRetry && (
          <Button onClick={onRetry} className="gradient-bg mt-4 w-full hover:opacity-90">
            重试
          </Button>
        )}
      </div>
    </div>
  );
}
