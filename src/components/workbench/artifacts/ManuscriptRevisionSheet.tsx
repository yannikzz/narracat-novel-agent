import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { cn } from '@/lib/cn'
import {
  listManuscriptRevisions,
  readManuscriptRevision,
  restoreManuscriptRevision,
} from '@/lib/ipc'
import { diffManuscriptRevision } from '@/lib/manuscript-revision-diff'
import type {
  ManuscriptRevisionContent,
  ManuscriptRevisionEntry,
  ManuscriptRevisionList,
  ManuscriptRevisionSource,
} from '@shared/types/manuscript-revision'

const SOURCE_LABELS: Record<ManuscriptRevisionSource, string> = {
  'author-save': '作者保存',
  'agent-write': 'Agent 写作',
  'agent-rewrite': 'Agent 重写',
  'revision-restore': '版本恢复',
  'llm-polish': '润色采用',
}

function formatStorage(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatRevisionTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function summaryText(revision: ManuscriptRevisionEntry): string {
  const parts: string[] = []
  if (revision.summary.addedChars > 0) parts.push(`+${revision.summary.addedChars} 字`)
  if (revision.summary.removedChars > 0) parts.push(`−${revision.summary.removedChars} 字`)
  return parts.length > 0 ? parts.join('  ') : '正文内容发生变化'
}

export function ManuscriptRevisionSheet({
  open,
  onOpenChange,
  projectPath,
  chapter,
  currentVisibleText,
  agentBusy,
  draftBlocked,
  onRestored,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  chapter: number
  currentVisibleText: string
  agentBusy: boolean
  draftBlocked: boolean
  onRestored: () => void
}) {
  const [history, setHistory] = useState<ManuscriptRevisionList | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedContent, setSelectedContent] = useState<ManuscriptRevisionContent | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingList(true)
    setListError(null)
    setHistory(null)
    setSelectedId(null)
    setSelectedContent(null)
    listManuscriptRevisions({ projectPath, chapter })
      .then((result) => {
        if (cancelled) return
        setHistory(result)
        setSelectedId(result.revisions[0]?.id ?? null)
      })
      .catch((error) => {
        console.error(error)
        if (!cancelled) setListError(error instanceof Error ? error.message : '读取正文版本历史失败。')
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectPath, chapter])

  useEffect(() => {
    if (!open || !selectedId) {
      setSelectedContent(null)
      return
    }
    let cancelled = false
    setLoadingContent(true)
    setContentError(null)
    readManuscriptRevision({ projectPath, chapter, revisionId: selectedId })
      .then((result) => {
        if (!cancelled) setSelectedContent(result)
      })
      .catch((error) => {
        console.error(error)
        if (!cancelled) setContentError(error instanceof Error ? error.message : '读取正文版本失败。')
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectPath, chapter, selectedId])

  const diff = useMemo(
    () => (selectedContent ? diffManuscriptRevision(selectedContent.visibleText, currentVisibleText) : null),
    [selectedContent, currentVisibleText],
  )
  const selectedMatchesCurrent =
    selectedContent?.visibleText.replace(/\r\n?/g, '\n').trimEnd() ===
    currentVisibleText.replace(/\r\n?/g, '\n').trimEnd()
  const restoreDisabled = agentBusy || draftBlocked || restoring || !selectedContent || selectedMatchesCurrent

  async function confirmRestore() {
    if (!selectedContent || restoreDisabled) return
    setRestoring(true)
    try {
      const result = await restoreManuscriptRevision({
        projectPath,
        chapter,
        revisionId: selectedContent.revision.id,
        expectedVisibleText: currentVisibleText,
      })
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      toast.success('正文版本已恢复')
      setRestoreConfirmOpen(false)
      onOpenChange(false)
      onRestored()
    } catch (error) {
      console.error(error)
      toast.error('恢复正文版本失败')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-[min(96vw,960px)] gap-0 bg-workspace p-0 sm:max-w-[960px]"
        data-manuscript-revision-sheet="true"
      >
          <SheetHeader className="border-b border-border px-5 py-4">
            <SheetTitle>第 {chapter} 章版本历史</SheetTitle>
            <SheetDescription>
              {history ? `项目版本历史占用 ${formatStorage(history.storageBytes)}` : '读取已保存的正文版本'}
            </SheetDescription>
          </SheetHeader>

          <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
            <ScrollArea className="min-h-0 border-r border-border">
              <div className="space-y-1 p-3" data-manuscript-revision-list="true">
                {loadingList && <p className="px-2 py-3 text-sm text-muted-foreground">正在读取版本历史…</p>}
                {listError && <p className="px-2 py-3 text-sm text-destructive">{listError}</p>}
                {!loadingList && !listError && history?.revisions.length === 0 && (
                  <p className="px-2 py-3 text-sm leading-6 text-muted-foreground">
                    还没有可恢复版本。下一次保存、写作或重写正文时会开始记录。
                  </p>
                )}
                {history?.revisions.map((revision) => (
                  <button
                    key={revision.id}
                    type="button"
                    className={cn(
                      'w-full rounded-row px-3 py-2.5 text-left transition-colors',
                      selectedId === revision.id ? 'bg-active' : 'hover:bg-hover',
                    )}
                    data-manuscript-revision-entry={revision.id}
                    aria-pressed={selectedId === revision.id}
                    onClick={() => setSelectedId(revision.id)}
                  >
                    <span className="block text-sm font-medium text-foreground">
                      {SOURCE_LABELS[revision.source]}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {formatRevisionTime(revision.createdAt)}
                    </span>
                    <span className="mt-1 block text-xs text-hint-foreground">{summaryText(revision)}</span>
                  </button>
                ))}
              </div>
            </ScrollArea>

            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                <p className="text-xs text-muted-foreground">
                  {diff
                    ? `与当前正文相比：+${diff.addedLines} 行，−${diff.removedLines} 行${
                        diff.simplified ? '（长文本简化比较）' : ''
                      }`
                    : '选择一个版本查看差异'}
                </p>
              </div>
              <ScrollArea className="min-h-0 flex-1 bg-canvas">
                <div className="min-w-0 py-3 font-mono text-xs leading-5" data-manuscript-revision-diff="true">
                  {loadingContent && <p className="px-4 py-3 text-muted-foreground">正在比较正文…</p>}
                  {contentError && <p className="px-4 py-3 text-destructive">{contentError}</p>}
                  {!loadingContent &&
                    !contentError &&
                    diff?.lines.map((line, index) => (
                      <div
                        key={`${line.type}-${line.oldLine ?? ''}-${line.newLine ?? ''}-${index}`}
                        className={cn(
                          'grid grid-cols-[42px_42px_20px_minmax(0,1fr)] px-3',
                          line.type === 'added' && 'bg-success/10 text-success',
                          line.type === 'removed' && 'bg-destructive/10 text-destructive',
                          line.type === 'context' && 'text-body-foreground',
                        )}
                        data-diff-line={line.type}
                      >
                        <span className="select-none text-right text-hint-foreground">{line.oldLine ?? ''}</span>
                        <span className="select-none text-right text-hint-foreground">{line.newLine ?? ''}</span>
                        <span className="select-none text-center">
                          {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
                        </span>
                        <span className="min-w-0 whitespace-pre-wrap break-words">{line.text || ' '}</span>
                      </div>
                    ))}
                </div>
              </ScrollArea>
            </div>
          </div>

        <SheetFooter className="flex-row items-center justify-between border-t border-border px-5 py-3">
            <p className="text-xs text-muted-foreground">
              恢复会保留当前正文为新版本，不会自动回滚小说记忆。
            </p>
            <Button
              type="button"
              disabled={restoreDisabled}
              data-manuscript-revision-restore="true"
              onClick={() => setRestoreConfirmOpen(true)}
            >
              {agentBusy
                ? 'Agent 运行中'
                : draftBlocked
                  ? '请先处理正文草稿'
                  : selectedMatchesCurrent
                    ? '已是当前版本'
                    : '恢复此版本'}
            </Button>
        </SheetFooter>

        {restoreConfirmOpen && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 p-5 backdrop-blur-[1px]"
            data-manuscript-revision-restore-confirm="true"
            role="presentation"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target && !restoring) setRestoreConfirmOpen(false)
            }}
          >
            <section
              aria-describedby="manuscript-revision-restore-description"
              aria-labelledby="manuscript-revision-restore-title"
              className="w-full max-w-md rounded-panel border border-border bg-floating p-5 shadow-[var(--shadow-floating)]"
              role="alertdialog"
            >
              <h2 id="manuscript-revision-restore-title" className="text-base font-semibold text-foreground">
                恢复这个正文版本？
              </h2>
              <p
                id="manuscript-revision-restore-description"
                className="mt-2 text-sm leading-6 text-muted-foreground"
              >
                当前正文会先保存为一个新的“版本恢复”记录，再替换为所选内容。章节元数据保持最新，小说记忆不会自动回滚。
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={restoring}
                  onClick={() => setRestoreConfirmOpen(false)}
                >
                  取消
                </Button>
                <Button type="button" autoFocus disabled={restoring} onClick={() => void confirmRestore()}>
                  {restoring ? '正在恢复…' : '确认恢复'}
                </Button>
              </div>
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
