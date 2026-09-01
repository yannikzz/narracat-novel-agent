import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { isOptionalNextStep, resolveStatusNextStep } from '@/lib/workbench-actions'
import { buildWorkbenchTargetHref } from '@/lib/workbench-selection'
import { getWorkbenchActionIcon } from './workbench-action-icons'
import type { NovelProjectDetail } from '@shared/types/novel'

/** 变化后高亮多久（毫秒）。够一眼看见，短到不会变成持续闪烁的噪声。 */
const CHANGE_HIGHLIGHT_MS = 2400

/**
 * 当前任务指针（ADR-0040）：侧边栏固定区常驻的一行，恒定回答「这本小说现在该做什么」。
 *
 * 三条与状态页那颗「下一步」按钮不同的地方，都是常驻带来的：
 *
 * 1. **只导航，不发起 Agent run。** 状态页那颗是 kind: 'agent'，一点就跑；常驻元素误触的代价是
 *    意外启动一个十几分钟、要花钱、不好取消的任务。这里只把人带到位置，由目的地既有的主按钮
 *    二次确认。所以它复用 action.target，却刻意不碰 action.command。
 * 2. **状态一变就短暂高亮**，让「我推进了一格」被看见——完成感依附在这里，不再额外弹 toast
 *    （run 完成已有通知铃 + 系统通知，再加一条就是同一件事被告知三次）。
 * 3. **全书完结（done）或项目无效时不渲染**，不占位。常驻的东西一旦在没意义时还杵着，
 *    很快就会被看成背景噪声。
 */
export function WorkbenchTaskPointer({
  project,
  projectPath,
  onNavigate,
}: {
  project: NovelProjectDetail | null
  projectPath: string
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void
}) {
  const nextStep = resolveStatusNextStep(project)
  const action = nextStep?.kind === 'action' ? nextStep.action : null
  /**
   * 变化判据用 `id + label` 而不是 `id`：连载是最高频的路径，而那一路的 id 恒为
   * `status-next-write`（章号只出现在 label 里）——只看 id 的话，「写第 1 章」变成
   * 「写第 2 章」不会被认为变过，完成感恰恰在最需要它的地方失效。
   */
  const actionKey = action ? `${action.id}:${action.label}` : null

  const [justChanged, setJustChanged] = useState(false)
  const previousActionKey = useRef<string | null>(null)

  useEffect(() => {
    const previous = previousActionKey.current
    previousActionKey.current = actionKey
    // 首次渲染不算「变了」：否则每次打开项目都闪一下，高亮就贬值成了纯装饰。
    if (previous === null || previous === actionKey || !actionKey) return

    setJustChanged(true)
    const timer = setTimeout(() => setJustChanged(false), CHANGE_HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [actionKey])

  // 项目损坏（structure problem）时不指路：先让作者去处理损坏，别把人往写作里推。
  // status 为 invalid 只是损坏的一种，带 problem 的 ready / in-progress 同样不该显示。
  if (!project || project.problem || !action?.target) return null

  const { Icon } = getWorkbenchActionIcon(action)
  const href = buildWorkbenchTargetHref({ project, projectPath, target: action.target })
  const optional = isOptionalNextStep(action)

  return (
    <Link
      to={href}
      title={action.label}
      aria-label={`下一步：${action.label}`}
      data-workbench-task-pointer="true"
      data-workbench-task-pointer-action={action.id}
      data-workbench-task-pointer-changed={justChanged ? 'true' : undefined}
      className={cn(
        `
          mb-4 flex h-9 w-full items-center gap-2 rounded-md border px-2
          transition-colors duration-200
        `,
        justChanged
          ? 'border-transparent bg-active text-foreground'
          : 'border-border bg-transparent text-muted-foreground hover:bg-hover hover:text-foreground',
      )}
      onClick={(event) => onNavigate?.(event, href)}
    >
      <Icon className="size-4 shrink-0 text-hint-foreground" />
      {/* 侧栏可缩到 200px：文字 truncate 自然降级，图标与右箭头始终在，title 兜住被裁的部分。 */}
      <span className="min-w-0 flex-1 truncate text-left text-sm leading-none">{action.label}</span>
      {/* 「可跳过」必须看得见。它此前只写在 action.description 里，而这一行从不渲染
          description——作者看到的只有命令式的「创建主要角色」，读不出这是条建议。 */}
      {optional ? <span className="shrink-0 text-xs leading-none text-hint-foreground">可跳过</span> : null}
      <ChevronRight className="size-3.5 shrink-0 text-hint-foreground" />
    </Link>
  )
}
