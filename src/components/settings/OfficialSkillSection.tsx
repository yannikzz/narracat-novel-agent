import { useEffect, useState } from 'react'
import { BadgeCheck, ChevronRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { MarkdownRenderer } from '@/components/workbench/MarkdownRenderer'
import { readOfficialSkillBody } from '@/lib/ipc'
import { getOfficialSkillDisplay, VERIFIED_OFFICIAL_SKILLS } from './official-skill-copy'
import { DIALOG_CONTENT_FORM_CLASS } from '@/design-system'

/**
 * 「它自带的本事」：该 Agent 自带、由 NarraCat 维护的能力，只读。
 *
 * 只列**确定到达模型**的（VERIFIED_OFFICIAL_SKILLS）——列出没生效的就是在骗作者。
 * 白名单里没有该 Agent 时整栏不渲染：没有就不提，不摆一个空状态让作者猜。
 * 不提供任何编辑入口——官方内容靠 Agent 直接读磁盘文件到达写作运行，App 内的修改不会生效。
 */
export function OfficialSkillSectionView({
  agentId,
  onOpen,
}: {
  agentId: string
  onOpen?: (skillId: string) => void
}) {
  const skillIds = VERIFIED_OFFICIAL_SKILLS[agentId] ?? []
  if (skillIds.length === 0) return null

  const interactive = typeof onOpen === 'function'

  return (
    <section aria-label="它自带的本事" className="space-y-3" data-official-skill-section={agentId}>
      <h3 className="text-sm font-semibold leading-tight text-foreground">它自带的本事</h3>
      <div className="space-y-2">
        {skillIds.map((skillId) => {
          const display = getOfficialSkillDisplay(skillId)
          return (
            <div
              key={skillId}
              role={interactive ? 'button' : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `查看 ${display.name} 详情` : undefined}
              data-official-skill-row={skillId}
              className="flex items-center gap-3 rounded-row border border-border bg-surface px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-hover focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={interactive ? () => onOpen?.(skillId) : undefined}
              onKeyDown={
                interactive
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onOpen?.(skillId)
                      }
                    }
                  : undefined
              }
            >
              <div
                className="flex size-10 shrink-0 items-center justify-center rounded-row border border-brand-border bg-brand-soft text-brand"
                aria-hidden="true"
              >
                <BadgeCheck className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-tight text-foreground">{display.name}</div>
                {display.description ? (
                  <div className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">{display.description}</div>
                ) : null}
              </div>
              {interactive ? (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function OfficialSkillSection({ agentId }: { agentId: string }) {
  const [openedSkillId, setOpenedSkillId] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!openedSkillId) return
    let cancelled = false
    setBody('')
    setLoading(true)
    void readOfficialSkillBody({ skillId: openedSkillId })
      .then((text) => {
        if (!cancelled) setBody(text)
      })
      .catch(() => {
        if (!cancelled) setBody('')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [openedSkillId])

  const display = openedSkillId ? getOfficialSkillDisplay(openedSkillId) : null

  return (
    <>
      <OfficialSkillSectionView agentId={agentId} onOpen={setOpenedSkillId} />
      <Dialog open={openedSkillId !== null} onOpenChange={(open) => (open ? undefined : setOpenedSkillId(null))}>
        <DialogContent
          className={DIALOG_CONTENT_FORM_CLASS}
          data-official-skill-detail-dialog={openedSkillId ?? undefined}
        >
          {display ? (
            <div className="min-w-0">
              <DialogHeader className="border-b border-border px-6 pb-5 pt-6 text-left">
                <DialogTitle className="text-lg leading-tight">{display.name}</DialogTitle>
                <DialogDescription>{display.description}</DialogDescription>
              </DialogHeader>
              <div className="min-w-0 px-6 py-5">
                <section className="max-h-[48vh] min-w-0 overflow-y-auto rounded-row border border-border bg-surface px-4 py-3">
                  {loading ? (
                    <p className="text-sm leading-6 text-muted-foreground">正在载入…</p>
                  ) : body ? (
                    <MarkdownRenderer text={body} />
                  ) : (
                    <p className="text-sm leading-6 text-muted-foreground">暂无内容。</p>
                  )}
                </section>
              </div>
              <DialogFooter className="border-t border-border bg-active/40 px-6 py-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  这部分由 NarraCat 维护，会随版本更新。想加自己的写法，用上面的「我对它的要求」。
                </p>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
