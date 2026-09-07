import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DIALOG_CONTENT_FORM_CLASS, DIALOG_SCROLL_SHELL_CLASS, READING_BODY_FONT_CLASS } from '@/design-system'
import { listStyleAnchors, submitStyleAnchor } from '@/lib/ipc'

export interface StyleAnchorItem {
  anchorId: string
  chapter: number
  excerpt: string
  createdAt: string
}

/**
 * 本书样章：作者在正文里划选标记的定稿段落，写手写新章时照这些段的语感写。
 * 与上方「叙事声音」摘要同页——说明书在上、实物在下。零样章时整块不渲染（页面保持干净）。
 */
export function BookVoiceAnchors({
  projectPath,
  reloadSignal,
  initialAnchors,
  max: initialMax = 3,
}: {
  projectPath: string
  reloadSignal?: unknown
  /** 测试注入用；运行时留空走 IPC 拉取 */
  initialAnchors?: StyleAnchorItem[]
  max?: number
}) {
  const [anchors, setAnchors] = useState<StyleAnchorItem[]>(initialAnchors ?? [])
  const [max, setMax] = useState(initialMax)
  const [openedAnchorId, setOpenedAnchorId] = useState<string | null>(null)
  // 请求序号护栏（同 CharacterStatePanel.tsx 的 requestSeq 套路）：projectPath 变化但组件不卸载
  // 时（挂载点没有按 projectPath 生成 key，见下方 reload 拆分的说明），旧项目的慢请求可能晚于
  // 新项目的请求返回——只让发出时最新的那次请求把结果写进 state，防止旧项目样章覆盖新项目的展示。
  const requestSeq = useRef(0)

  // clear=true：projectPath 变化时用（identity 变了，旧数据不可能属于新项目，必须先清空再取，
  // 不能等新数据回来才切换——读取失败时也按不可用处理清空，不静默保留旧项目数据）；
  // clear=false：reloadSignal 平滑重取（同项目内容更新，如 F5/agent run 后），不清空已渲染内容。
  const reload = useCallback(
    (clear: boolean) => {
      if (initialAnchors) return
      const seq = ++requestSeq.current
      if (clear) setAnchors([])
      void listStyleAnchors({ projectPath }).then((result) => {
        if (seq !== requestSeq.current) return
        if (!result.ok) {
          if (clear) setAnchors([])
          return
        }
        setAnchors(result.anchors)
        setMax(result.max)
      })
    },
    [initialAnchors, projectPath],
  )

  // projectPath 变化（含挂载）：立即清空 + 关弹窗，防止旧项目样章残留展示、删除操作带着旧
  // anchorId 发往新项目。挂载点（WorkbenchObjectView.tsx）未按 projectPath 加 key——同 App 内
  // CharacterStatePanel 的既有惯例，切换靠组件内部的 identity effect 处理，不靠卸载重挂。
  useEffect(() => {
    setOpenedAnchorId(null)
    reload(true)
  }, [reload])

  // 外部重载信号（F5/agent run 后 artifacts 重建）：平滑重取，不清空已渲染内容；首次渲染已由
  // 上面的 identity effect 覆盖，这里跳过首次避免同一次 mount 重复请求两次。
  const isFirstSignal = useRef(true)
  useEffect(() => {
    if (isFirstSignal.current) {
      isFirstSignal.current = false
      return
    }
    reload(false)
  }, [reloadSignal, reload])

  const remove = useCallback(
    (anchorId: string) => {
      void submitStyleAnchor({ projectPath, action: 'remove', anchorId }).then((result) => {
        if (result.ok) {
          setAnchors((prev) => prev.filter((item) => item.anchorId !== anchorId))
          setOpenedAnchorId((prev) => (prev === anchorId ? null : prev))
        } else toast.error(result.message ?? '删除失败，请稍后重试。')
      })
    },
    [projectPath],
  )

  if (anchors.length === 0) return null

  const openedAnchor = anchors.find((item) => item.anchorId === openedAnchorId) ?? null

  return (
    // 结构分隔只留 section 级这一条 hairline；内部条目靠 hover 态区分，不再逐行画线
    <section className="mb-6 border-b border-border pb-5" data-book-voice-anchors="true">
      <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
        <Bookmark className="size-3.5 shrink-0" />
        <span>
          本书样章 · {anchors.length}/{max}
        </span>
      </div>
      <ul className="mt-2 -mx-2">
        {anchors.map((anchor) => (
          <li key={anchor.anchorId}>
            <button
              type="button"
              className="flex w-full min-w-0 items-baseline gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-hover"
              data-book-voice-anchor-row="true"
              onClick={() => setOpenedAnchorId(anchor.anchorId)}
            >
              <span className="shrink-0 text-xs text-muted-foreground">第 {anchor.chapter} 章</span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{anchor.excerpt}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 px-0 text-xs text-hint-foreground">写手写新章时照这些段的语感写。</p>

      <Dialog open={openedAnchor !== null} onOpenChange={(open) => !open && setOpenedAnchorId(null)}>
        {/* 容器规范 docs/design.md §9.7：长文内容型弹窗须 flex flex-col + max-h 上限，
            否则 400 字多换行的样章在小窗口会把底部删除按钮挤出视口（对齐 PackDetailContent 三段式）。 */}
        <DialogContent className={`${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_FORM_CLASS}`}>
          {openedAnchor && (
            <>
              <DialogHeader className="shrink-0 border-b border-border px-6 pb-5 pt-6 text-left">
                <DialogTitle className="text-lg leading-tight">第 {openedAnchor.chapter} 章 · 本书样章</DialogTitle>
                <DialogDescription className="sr-only">
                  这段定稿正文被设为本书声音基准，写手写新章时照它的语感写。
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <p
                  className={`${READING_BODY_FONT_CLASS} whitespace-pre-wrap leading-8 text-foreground`}
                  data-book-voice-anchor-excerpt="true"
                >
                  {openedAnchor.excerpt}
                </p>
              </div>

              <div className="flex shrink-0 justify-end border-t border-border px-6 py-4">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => remove(openedAnchor.anchorId)}
                >
                  <Trash2 className="size-3.5" />
                  删除这段样章
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
