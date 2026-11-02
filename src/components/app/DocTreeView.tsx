import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderInput,
  FilePlus,
  FolderPlus,
  Upload,
  Lock,
  Unlock,
  UserCheck,
  Boxes,
} from 'lucide-react';
import type { DocTree, DocNode } from '@/types';
import { useApp } from '@/context/AppContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/utils';
import { FileTypeIcon } from './fileIcons';
import { useEffect, useRef } from 'react';

interface DocTreeViewProps {
  tree: DocTree[];
  selectedId: string | null;
  expanded: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  onSelect: (node: DocNode) => void;
  onRequestCreate: (parentId: string | null, type: 'file' | 'folder') => void;
  onRequestRename: (node: DocNode) => void;
  onRequestDelete: (node: DocNode) => void;
  onRequestMove: (node: DocNode) => void;
  onRequestUpload: (parentId: string | null) => void;
  /**
   * 请求加密相关的操作（仅管理员，且只对文件有意义）。
   * encrypt=首次加密；decrypt=取消加密。
   */
  onRequestEncrypt?: (node: DocNode, mode: 'encrypt' | 'decrypt') => void;
  /**
   * 打开这篇文档的访问授权（仅管理员，且只对已加密的文件有意义）。
   * 加密文档的访客访问只有这一条路：给某个人开一道口子、可随时收回。
   */
  onRequestAccessGrant?: (node: DocNode) => void;
  /**
   * 打开仓库归属选择（跨仓库迁移，仅管理员）。
   * 搬的是整棵子树：孩子跟着爹走，父子不会分属两个仓库。
   */
  onRequestRepo?: (node: DocNode) => void;
}

type TreeNodeProps = Omit<DocTreeViewProps, 'tree'> & { node: DocTree; depth: number };

/**
 * 找出最近的可滚动祖先。
 *
 * 不用 scrollIntoView：它会连带滚动所有可滚动的祖先，
 * 页面本身被拽一下是很别扭的。这里只动树自己的滚动容器。
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

export function DocTreeView({ tree, ...rest }: DocTreeViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * 选中项滚出视野时把它带回视野。
   *
   * 新建文档后必须立刻在树里看见它：否则「创建成功」只剩一条 toast，
   * 用户不知道自己的新文件落在树的哪个位置——树一长，它就淹没在里面了。
   */
  useEffect(() => {
    const selectedId = rest.selectedId;
    if (!selectedId) return;
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(selectedId)}"]`);
    if (!el) return;
    const box = scrollParent(root);
    if (!box) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (Math.abs(delta) <= 8) return;
    box.scrollTo({ top: Math.max(0, box.scrollTop + delta - 8), behavior: 'smooth' });
  }, [rest.selectedId, tree]);

  return (
    <div ref={rootRef} className="space-y-0.5">
      {tree.map((node) => (
        <TreeNode key={node.id} node={node} depth={0} {...rest} />
      ))}
      {tree.length === 0 && (
        <div className="text-center text-sm text-muted-foreground py-12 px-4">
          <Folder className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <div>暂无文档</div>
          <div className="text-xs mt-1">点击下方按钮创建</div>
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  selectedId,
  expanded,
  onToggleExpand,
  onSelect,
  onRequestCreate,
  onRequestRename,
  onRequestDelete,
  onRequestMove,
  onRequestUpload,
  onRequestEncrypt,
  onRequestAccessGrant,
  onRequestRepo,
}: TreeNodeProps) {
  const { hasPermission, isAdmin } = useApp();
  const isOpen = expanded[node.id] ?? depth < 1;
  const isSelected = selectedId === node.id;
  const canEdit = hasPermission('doc.edit');
  const canDelete = hasPermission('doc.delete');
  const canCreate = hasPermission('doc.create');
  const canMove = hasPermission('doc.move');
  const canUpload = hasPermission('doc.upload');
  // 访客模式不显示任何操作入口
  const showMenu = isAdmin || canEdit || canDelete || canCreate || canMove || canUpload;

  return (
    <div className="animate-slide-in">
      <div
        data-tree-id={node.id}
        className={cn(
          'group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition-all',
          isSelected
            ? 'bg-gradient-to-r from-indigo-500/20 to-violet-500/15 text-indigo-700 dark:text-indigo-300 shadow-sm'
            : 'hover:bg-white/60 dark:hover:bg-white/5',
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => {
          if (node.type === 'folder') onToggleExpand(node.id);
          onSelect(node);
        }}
      >
        {node.type === 'folder' ? (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0',
              isOpen && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {node.type === 'folder' ? (
          isOpen ? (
            <FolderOpen className="h-4 w-4 text-amber-500 shrink-0" />
          ) : (
            <Folder className="h-4 w-4 text-amber-500 shrink-0" />
          )
        ) : node.kind === 'file' ? (
          /* 原件按真实格式给图标：一排全是同一个文件形的时候，
             人是分不出哪个是 zip、哪个是图片的。 */
          <FileTypeIcon name={node.name} ext={node.ext} />
        ) : (
          <FileText className="h-4 w-4 text-indigo-500 shrink-0" />
        )}
        {node.encrypted && (
          <span title="已加密（需申请访问后方可查看）" className="shrink-0 text-indigo-500">
            <Lock className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="flex-1 text-sm truncate">{node.name}</span>
        <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          {formatRelativeTime(node.updatedAt)}
        </span>

        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="h-6 w-6 rounded-md flex items-center justify-center outline-none focus-visible:bg-white/80 dark:focus-visible:bg-white/10 opacity-0 group-hover:opacity-100 hover:bg-white/80 dark:hover:bg-white/10 transition-all"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44 glass-strong">
              {node.type === 'folder' && canCreate && (
                <>
                  <DropdownMenuItem className="rounded-md transition-colors" onClick={() => onRequestCreate(node.id, 'file')}>
                    <FilePlus className="h-4 w-4 mr-2" /> 新建文档
                  </DropdownMenuItem>
                  <DropdownMenuItem className="rounded-md transition-colors" onClick={() => onRequestCreate(node.id, 'folder')}>
                    <FolderPlus className="h-4 w-4 mr-2" /> 新建文件夹
                  </DropdownMenuItem>
                  {canUpload && (
                    <DropdownMenuItem className="rounded-md transition-colors" onClick={() => onRequestUpload(node.id)}>
                      <Upload className="h-4 w-4 mr-2" /> 上传 Markdown
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              {canEdit && (
                <DropdownMenuItem className="rounded-md transition-colors" onClick={() => onRequestRename(node)}>
                  <Pencil className="h-4 w-4 mr-2" /> 重命名
                </DropdownMenuItem>
              )}
              {canMove && (
                <DropdownMenuItem className="rounded-md transition-colors" onClick={() => onRequestMove(node)}>
                  <FolderInput className="h-4 w-4 mr-2" /> 移动
                </DropdownMenuItem>
              )}
              {isAdmin && onRequestRepo && (
                <DropdownMenuItem className="rounded-md transition-colors" onClick={() => onRequestRepo(node)}>
                  <Boxes className="h-4 w-4 mr-2" /> 归入仓库
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => onRequestDelete(node)}
                    className="rounded-md transition-colors text-red-600 focus:bg-red-50 dark:focus:bg-red-950/40 focus:text-red-600"
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> 删除
                  </DropdownMenuItem>
                </>
              )}
              {isAdmin && node.type === 'file' && onRequestEncrypt && (
                <>
                  <DropdownMenuSeparator />
                  {node.encrypted ? (
                    <>
                      {onRequestAccessGrant && (
                        <DropdownMenuItem
                          onClick={() => onRequestAccessGrant(node)}
                          className="rounded-md transition-colors"
                        >
                          <UserCheck className="h-4 w-4 mr-2 text-indigo-500" /> 访问授权
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() => onRequestEncrypt(node, 'decrypt')}
                        className="rounded-md transition-colors text-amber-600 focus:bg-amber-50 dark:focus:bg-amber-950/40 focus:text-amber-600"
                      >
                        <Unlock className="h-4 w-4 mr-2" /> 取消加密
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      onClick={() => onRequestEncrypt(node, 'encrypt')}
                      className="rounded-md transition-colors"
                    >
                      <Lock className="h-4 w-4 mr-2 text-indigo-500" /> 加密文档
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {node.type === 'folder' && isOpen && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSelect={onSelect}
              onRequestCreate={onRequestCreate}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              onRequestMove={onRequestMove}
              onRequestUpload={onRequestUpload}
              onRequestEncrypt={onRequestEncrypt}
              onRequestAccessGrant={onRequestAccessGrant}
              onRequestRepo={onRequestRepo}
            />
          ))}
        </div>
      )}
    </div>
  );
}
