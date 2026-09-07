import { useCallback, useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { type ConfirmDialogCopy, useConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/cn'
import type { ProseBlockView } from '@shared/types/prose-block'
import { DIALOG_CONTENT_FORM_CLASS } from '@/design-system'

/**
 * 「恢复默认」二次确认文案：必须指名当前 Agent，不能读起来像全局操作——按钮长在这个 Agent 的
 * 面板里，作者的合理预期就是只影响它。抽成纯函数，脱离 Dialog 交互也能单测覆盖措辞正确性。
 */
export function resetAllConfirmCopy(agentName: string): ConfirmDialogCopy {
  return {
    title: `恢复「${agentName}」的默认写法？`,
    description: `你在「${agentName}」上做的调整都会清空，改回官方原本的写法，且无法撤销。标着「已不存在」的旧调整不算在内，不会被这次操作清掉。`,
    confirmLabel: '恢复默认',
    danger: true,
  }
}

/**
 * 写作指令详情弹窗正文（与 Dialog 容器解耦，便于直接快照测试）：
 * 官方原文只读展示 + 可编辑区（保存 / 取消，清空可保存）；official-updated 时额外给三栏对照；
 * missing（孤儿）时不给编辑区，只给说明 + 删除入口。
 */
export function ProseBlockDetailBody({
  view,
  draft = '',
  onDraftChange,
  onSave,
  onCancel,
  onReset,
}: {
  view: ProseBlockView
  draft?: string
  onDraftChange?: (text: string) => void
  onSave?: () => void
  onCancel?: () => void
  onReset?: () => void
}) {
  const isMissing = view.status === 'missing'

  return (
    <div className="min-w-0">
      <DialogHeader className="border-b border-border px-6 pb-5 pt-6 text-left">
        <DialogTitle className="text-lg leading-tight">{view.title}</DialogTitle>
        {view.hint ? (
          <DialogDescription>{view.hint}</DialogDescription>
        ) : (
          <DialogDescription className="sr-only">写作指令详情。</DialogDescription>
        )}
      </DialogHeader>

      <div className="min-w-0 space-y-4 px-6 py-5" data-prose-block-detail-body={view.id}>
        {isMissing ? (
          <p className="text-sm leading-6 text-muted-foreground">
            这段内容在新版里已经没有了，你之前的调整不再起作用。
          </p>
        ) : (
          <>
            <section className="space-y-1.5" data-prose-block-detail-official="true">
              <h4 className="text-xs font-medium leading-none text-hint-foreground">官方原文</h4>
              <p className="whitespace-pre-wrap rounded-row border border-border bg-surface px-3 py-2 text-sm leading-7 text-body-foreground">
                {view.officialText}
              </p>
            </section>

            {view.status === 'official-updated' ? (
              <section
                className="space-y-1 rounded-row bg-active px-3 py-2 text-xs leading-6"
                data-prose-block-detail-diff="true"
              >
                <p className="text-muted-foreground">你当初改的是这一版：</p>
                <p className="whitespace-pre-wrap text-body-foreground">{view.baseText}</p>
                <p className="text-muted-foreground">现在官方写的是：</p>
                <p className="whitespace-pre-wrap text-body-foreground">{view.officialText}</p>
                <p className="text-muted-foreground">你的版本：</p>
                <p className="whitespace-pre-wrap text-body-foreground">{view.userText}</p>
              </section>
            ) : null}

            <section className="space-y-2" data-prose-block-detail-editor="true">
              <Textarea
                value={draft}
                rows={6}
                aria-label={`编辑「${view.title}」`}
                onChange={(event) => onDraftChange?.(event.target.value)}
                className="text-sm leading-7"
              />
            </section>
          </>
        )}
      </div>

      <DialogFooter className="border-t border-border bg-active/40 px-6 py-4">
        {isMissing ? (
          <>
            <Button type="button" variant="outline" onClick={onCancel}>
              关闭
            </Button>
            <Button type="button" variant="destructive" data-prose-block-detail-delete={view.id} onClick={onReset}>
              删除
            </Button>
          </>
        ) : (
          <>
            {view.userText !== null ? (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                data-prose-block-detail-reset={view.id}
                onClick={onReset}
              >
                复原为官方默认
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
            <Button type="button" data-prose-block-detail-save={view.id} onClick={onSave}>
              保存
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  )
}

/** 纯展示层：不碰 IPC，便于快照测试。 */
export function AgentProseBlockPanelView({
  views,
  agentName = '这个 Agent',
  selectedId = null,
  draft = '',
  onOpen,
  onDraftChange,
  onSave,
  onCancel,
  onReset,
  onResetAll,
}: {
  views: ProseBlockView[]
  /** 当前 Agent 的展示名（如「章节写手」），用于把「恢复默认」的影响范围说清楚 */
  agentName?: string
  /** 当前点开详情弹窗的块 id；null = 弹窗关闭 */
  selectedId?: string | null
  draft?: string
  onOpen?: (id: string) => void
  onDraftChange?: (text: string) => void
  onSave?: () => void
  onCancel?: () => void
  onReset?: (id: string) => void
  onResetAll?: () => void
}) {
  if (views.length === 0) return null

  // 只数「当前这个 Agent 还在用的块」上的调整。孤儿行（status === 'missing'）本来就不再起作用
  // （详情弹窗会说明这一点），既不该算进「N 处调整正在生效」的回执，也不该被
  // 「恢复默认」按钮的承诺范围覆盖——按钮只清得动、也只承诺清当前仍在用的调整。
  const changedCount = views.filter((view) => view.userText !== null && view.status !== 'missing').length
  const selectedView = views.find((view) => view.id === selectedId) ?? null

  return (
    <section aria-label="它是谁" className="space-y-3" data-prose-block-panel="true">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-foreground">它是谁</h3>
        {changedCount > 0 ? (
          <span className="text-xs text-muted-foreground" data-prose-block-receipt="true">
            你的 {changedCount} 处调整正在生效
          </span>
        ) : null}
      </div>

      <ul className="space-y-2">
        {views.map((view) => (
          <li
            key={view.id}
            role="button"
            tabIndex={0}
            aria-label={`查看「${view.title}」详情`}
            data-prose-block-row={view.id}
            data-prose-block-status={view.status}
            className="flex cursor-pointer items-center gap-3 rounded-row border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-hover focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => onOpen?.(view.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onOpen?.(view.id)
              }
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium leading-tight text-foreground">{view.title}</div>
              <div className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
                {view.userText ?? view.officialText}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-xs">
              {view.status === 'official-updated' ? <span className="text-warning">官方已更新</span> : null}
              {view.status === 'missing' ? <span className="text-muted-foreground">已不存在</span> : null}
              <span className={cn('text-muted-foreground', view.userText !== null && 'text-foreground')}>
                {view.userText !== null ? '已调整' : '官方'}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </div>
          </li>
        ))}
      </ul>

      {changedCount > 0 ? (
        <div className="flex justify-end">
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onResetAll}>
            恢复「{agentName}」的默认写法
          </button>
        </div>
      ) : null}

      <Dialog
        open={selectedView !== null}
        onOpenChange={(open) => {
          if (!open) onCancel?.()
        }}
      >
        <DialogContent
          className={DIALOG_CONTENT_FORM_CLASS}
          data-prose-block-detail-dialog={selectedView?.id}
        >
          {selectedView ? (
            <ProseBlockDetailBody
              view={selectedView}
              draft={draft}
              onDraftChange={onDraftChange}
              onSave={onSave}
              onCancel={onCancel}
              onReset={() => onReset?.(selectedView.id)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}

export function AgentProseBlockPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const [views, setViews] = useState<ProseBlockView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const { confirm, confirmDialog } = useConfirmDialog()

  const load = useCallback(async () => {
    try {
      setViews(await window.electron.listProseBlocks({ agentId }))
    } catch {
      setViews([]) // 读不出来就当没有可调整内容，绝不把报错糊在设置页上
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

  const handleOpen = useCallback(
    (id: string) => {
      const view = views.find((item) => item.id === id)
      setDraft(view?.userText ?? view?.officialText ?? '')
      setSelectedId(id)
    },
    [views],
  )

  const handleSave = useCallback(async () => {
    if (!selectedId) return
    try {
      setViews(await window.electron.setProseBlock({ agentId, id: selectedId, text: draft }))
      setSelectedId(null)
    } catch (error) {
      // 主进程已把超限等错误翻成作者词汇，原样透出即可，不要吞掉——作者按了保存，静默失败最坏
      toast.error(error instanceof Error ? error.message : '保存失败，请稍后再试。')
    }
  }, [agentId, draft, selectedId])

  const handleReset = useCallback(
    async (id: string) => {
      try {
        setViews(await window.electron.resetProseBlock({ agentId, id }))
        // 复原/删除的正是弹窗里正打开的这块：动作已完成，关掉弹窗，不留一份对不上的旧草稿。
        setSelectedId((current) => (current === id ? null : current))
      } catch {
        toast.error('恢复失败，请稍后再试。')
      }
    },
    [agentId],
  )

  const handleResetAll = useCallback(async () => {
    const confirmed = await confirm(resetAllConfirmCopy(agentName))
    if (!confirmed) return
    try {
      setViews(await window.electron.resetAllProseBlocks({ agentId }))
      setSelectedId(null)
      toast.success(`已恢复「${agentName}」的默认写法。`)
    } catch {
      toast.error('恢复失败，请稍后再试。')
    }
  }, [agentId, agentName, confirm])

  return (
    <>
      <AgentProseBlockPanelView
        views={views}
        agentName={agentName}
        selectedId={selectedId}
        draft={draft}
        onOpen={handleOpen}
        onDraftChange={setDraft}
        onSave={handleSave}
        onCancel={() => setSelectedId(null)}
        onReset={handleReset}
        onResetAll={handleResetAll}
      />
      {confirmDialog}
    </>
  )
}
