import {
  BookMarked,
  Check,
  ClipboardCheck,
  Copy,
  DatabaseZap,
  FilePlus2,
  Globe2,
  History,
  ListTree,
  PenLine,
  Pencil,
  RefreshCcw,
  RotateCw,
  SearchCheck,
  Trash2,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { WorkbenchAction } from '@/lib/workbench-actions'

export function getWorkbenchActionIcon(action: WorkbenchAction): { Icon: LucideIcon; key: string } {
  if (action.id === 'reset-reference-works') return { Icon: Trash2, key: 'reset-reference-works' }
  if (action.id === 'copy-visible-document') return { Icon: Copy, key: 'copy' }
  if (action.id === 'edit-manuscript') return { Icon: Pencil, key: 'edit-manuscript' }
  if (action.id === 'manuscript-history') return { Icon: History, key: 'manuscript-history' }
  if (action.id === 'polish-manuscript') return { Icon: Wand2, key: 'polish-manuscript' }
  if (action.id === 'sync-chapter-memory-entry') return { Icon: DatabaseZap, key: 'sync-chapter-memory-entry' }
  if (action.id === 'manuscript-save') return { Icon: Check, key: 'manuscript-save' }
  if (action.id === 'manuscript-cancel') return { Icon: X, key: 'manuscript-cancel' }
  // 必须排在下面的 client 兜底之前：兜底会把它画成刷新图标，语义不对。
  if (action.id === 'go-to-current-chapter') return { Icon: PenLine, key: 'go-to-current-chapter' }
  if (action.kind === 'client') return { Icon: RotateCw, key: 'refresh' }
  if (action.id.startsWith('generate-empty-')) return { Icon: FilePlus2, key: 'generate' }
  if (action.command === 'reference') return { Icon: BookMarked, key: 'reference' }
  if (action.command === 'setup') return { Icon: ClipboardCheck, key: 'setup' }
  if (action.command === 'world') return { Icon: Globe2, key: 'world' }
  if (action.command === 'plan') return { Icon: ListTree, key: 'plan' }
  if (action.command === 'write-next') return { Icon: PenLine, key: 'write-next' }
  if (action.command === 'recover-write') return { Icon: RotateCw, key: 'recover-write' }
  if (action.command === 'review') return { Icon: SearchCheck, key: 'review' }
  if (action.command === 'rewrite') return { Icon: RefreshCcw, key: 'rewrite' }
  return { Icon: FilePlus2, key: 'generate' }
}
