import { useEffect, useRef, useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * 内容区右下角的「回到顶部」。
 *
 * 滚动容器是工作台内容区那一层（`[data-workbench-object-scroll-frame]`），不是 window——
 * 所以既不能监听 window 的滚动，也不能用 `window.scrollTo`。用一个零高的锚点 `closest` 上去
 * 拿到它，避免把容器引用一路 props 透传下来。
 *
 * 定位用 `sticky bottom-*` 而不是 `fixed`：滚动容器本身没有定位上下文，fixed 会贴到整个窗口
 * （盖住右侧 Agent 面板）。sticky 天然贴在滚动视口内。
 */
export function BackToTopButton({
  /** 滚过这个距离才出现——短章节里它只是噪声。 */
  threshold = 400,
}: {
  threshold?: number
}) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  function scrollFrame(): HTMLElement | null {
    const frame = anchorRef.current?.closest('[data-workbench-object-scroll-frame]')
    return frame instanceof HTMLElement ? frame : null
  }

  useEffect(() => {
    const frame = scrollFrame()
    if (!frame) return

    const handleScroll = (): void => setVisible(frame.scrollTop > threshold)
    handleScroll()
    frame.addEventListener('scroll', handleScroll, { passive: true })
    return () => frame.removeEventListener('scroll', handleScroll)
  }, [threshold])

  return (
    <div
      ref={anchorRef}
      className="pointer-events-none sticky bottom-6 z-20 flex h-0 justify-end"
      data-back-to-top-anchor="true"
    >
      {visible && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="回到顶部"
          className="pointer-events-auto -translate-y-full shadow-[var(--shadow-floating)]"
          onClick={() => scrollFrame()?.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          <ArrowUp />
        </Button>
      )}
    </div>
  )
}
