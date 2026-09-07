import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Textarea } from '@/components/ui/textarea'
import { addAuthorRequest, listAuthorRequests, listProseBlocks, removeAuthorRequest, updateAuthorRequest } from '@/lib/ipc'
import { computeAgentInstructionBudget } from '@shared/lib/skill-budget'
import type { AuthorRequest } from '@shared/types/author-request'
import { DIALOG_CONTENT_FORM_CLASS } from '@/design-system'

/** 列表行摘要：取第一段有内容的行，超长截断。作者写的是一段话，行上只需认得出是哪条。 */
export function summarizeRequest(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find(Boolean) ?? ''
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

/**
 * 「我对它的要求」：作者用自己的话告诉这个 Agent 该注意什么。
 *
 * 机制上是把这段文本追加进该 Agent 的 prompt 末尾（不是 skill，没有按需加载）。产品面不出现
 * 「Skill」「挂载」「token」这类黑话。
 */
export function AuthorRequestPanelView({
  requests,
  personaText = '',
  onAdd,
  onOpen,
}: {
  requests: AuthorRequest[]
  /** 该 Agent 当前生效的 persona 正文，计入预算口径（spec §5.2） */
  personaText?: string
  onAdd?: () => void
  onOpen?: (id: string) => void
}) {
  const budget = computeAgentInstructionBudget({
    texts: [personaText, ...requests.map((request) => request.text)],
  })

  return (
    <section aria-label="我对它的要求" className="space-y-3" data-author-request-panel="true">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold leading-tight text-foreground">我对它的要求</h3>
        <IconTooltip label="写一条要求">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="写一条要求"
            data-author-request-add="true"
            onClick={onAdd}
          >
            <Plus className="size-4" />
          </Button>
        </IconTooltip>
      </div>

      {requests.length === 0 ? (
        <div
          className="rounded-row border border-dashed border-border px-3 py-4 text-sm leading-6 text-muted-foreground"
          data-author-request-empty="true"
        >
          还没有。你可以直接用自己的话告诉它，比如「少写环境描写，多写对话」。
        </div>
      ) : (
        <ul className="space-y-2">
          {requests.map((request) => (
            <li
              key={request.id}
              role="button"
              tabIndex={0}
              aria-label={`编辑「${summarizeRequest(request.text)}」`}
              data-author-request-row={request.id}
              className="flex cursor-pointer items-center gap-3 rounded-row border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-hover focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => onOpen?.(request.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen?.(request.id)
                }
              }}
            >
              <div className="min-w-0 flex-1 truncate text-sm leading-tight text-foreground">
                {summarizeRequest(request.text)}
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </li>
          ))}
        </ul>
      )}

      {budget.overLimit ? (
        <p className="text-xs leading-5 text-warning" data-author-request-budget-warning="true">
          你给它的交代有点多了，它可能顾不过来。要求照样会带上，但精简一些通常更有效。
        </p>
      ) : null}
    </section>
  )
}

/** 新增 / 编辑弹窗正文（与 Dialog 容器解耦，便于快照测试）。 */
export function AuthorRequestDetailBody({
  draft,
  existing,
  onDraftChange,
  onSave,
  onCancel,
  onRemove,
}: {
  draft: string
  /** true = 编辑已有条目（给删除入口）；false = 新增 */
  existing: boolean
  onDraftChange?: (text: string) => void
  onSave?: () => void
  onCancel?: () => void
  onRemove?: () => void
}) {
  return (
    <div className="min-w-0">
      <DialogHeader className="border-b border-border px-6 pb-5 pt-6 text-left">
        <DialogTitle className="text-lg leading-tight">{existing ? '改一条要求' : '写一条要求'}</DialogTitle>
        <DialogDescription>用你自己的话说就行。下次写作时会带上。</DialogDescription>
      </DialogHeader>

      <div className="min-w-0 px-6 py-5">
        <Textarea
          value={draft}
          rows={6}
          aria-label="要求内容"
          placeholder="比如：少写环境描写，多写对话；每章结尾留一个悬念。"
          onChange={(event) => onDraftChange?.(event.target.value)}
          className="text-sm leading-7"
        />
      </div>

      <DialogFooter className="border-t border-border bg-active/40 px-6 py-4">
        {existing ? (
          <Button
            type="button"
            variant="ghost"
            className="sm:mr-auto"
            data-author-request-remove="true"
            onClick={onRemove}
          >
            删除
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button type="button" disabled={!draft.trim()} data-author-request-save="true" onClick={onSave}>
          保存
        </Button>
      </DialogFooter>
    </div>
  )
}

export function AuthorRequestPanel({ agentId }: { agentId: string }) {
  const [requests, setRequests] = useState<AuthorRequest[]>([])
  // null = 弹窗关闭；'' = 新增；其他 = 正在编辑的条目 id
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // 预算口径含 persona（spec §5.2）。persona 正文由「它是谁」那块的同一条 IPC 提供，这里独立读一次——
  // 让本组件自洽，不必把状态提到父级、也不影响两块各自的加载时序。读失败按空串降级（预算算少了
  // 顶多是该提示没出，不影响任何功能）。
  const [personaText, setPersonaText] = useState('')

  const load = useCallback(async () => {
    try {
      setRequests(await listAuthorRequests({ agentId }))
    } catch {
      setRequests([]) // 读不出来就当没有，绝不把报错糊在设置页上
    }
  }, [agentId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void listProseBlocks({ agentId })
      .then((views) => {
        if (cancelled) return
        // 当前生效正文 = 有作者覆盖用覆盖，否则官方原文
        setPersonaText(views.map((view) => view.userText ?? view.officialText).join('\n'))
      })
      .catch(() => {
        if (!cancelled) setPersonaText('')
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleOpen = useCallback(
    (id: string) => {
      setDraft(requests.find((request) => request.id === id)?.text ?? '')
      setEditingId(id)
    },
    [requests],
  )

  const handleSave = useCallback(async () => {
    if (editingId === null || !draft.trim()) return
    try {
      setRequests(
        editingId === ''
          ? await addAuthorRequest({ agentId, text: draft })
          : await updateAuthorRequest({ agentId, id: editingId, text: draft }),
      )
      setEditingId(null)
    } catch (error) {
      // 作者按了保存，静默失败最坏——主进程的错误原样透出
      toast.error(error instanceof Error ? error.message : '保存失败，请稍后再试。')
    }
  }, [agentId, draft, editingId])

  const handleRemove = useCallback(async () => {
    if (!editingId) return
    try {
      setRequests(await removeAuthorRequest({ agentId, id: editingId }))
      setEditingId(null)
    } catch {
      toast.error('删除失败，请稍后再试。')
    }
  }, [agentId, editingId])

  return (
    <>
      <AuthorRequestPanelView
        requests={requests}
        personaText={personaText}
        onAdd={() => {
          setDraft('')
          setEditingId('')
        }}
        onOpen={handleOpen}
      />
      <Dialog open={editingId !== null} onOpenChange={(open) => (open ? undefined : setEditingId(null))}>
        <DialogContent
          className={DIALOG_CONTENT_FORM_CLASS}
          data-author-request-dialog={agentId}
        >
          {editingId !== null ? (
            <AuthorRequestDetailBody
              draft={draft}
              existing={editingId !== ''}
              onDraftChange={setDraft}
              onSave={() => void handleSave()}
              onCancel={() => setEditingId(null)}
              onRemove={() => void handleRemove()}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
