import { useEffect, useState, type ComponentType } from 'react'
import { Loader2, Maximize2, Minimize2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { useMemoryGraph } from '@/lib/use-memory-graph'
import { useAgentStore } from '@/lib/agent-store'
import { cn } from '@/lib/cn'
import { WorkbenchEmptyState } from './WorkbenchEmptyState'
import type { MemoryGraphSnapshot } from '@shared/types/memory-graph'

/**
 * 记忆星图视图壳（只读展示层）。
 *
 * 分层动机：three.js 画布约 600KB，且依赖 WebGL/真实 DOM，静态渲染与单测都跑不了。
 * 本壳只负责取数、状态分支、全屏切换，画布经 useEffect 内的动态 import() 载入
 * ——既让 three.js 走独立 chunk 不进主 bundle，也让 renderToStaticMarkup（不执行
 * effect）能稳定渲染壳本身做单测。
 *
 * 配色是全 App 唯一的暗色区域：发光点线是加法混色，只在暗底成立。心智同视频播放器
 * ——亮色界面里嵌一扇“深空之窗”，不是把 App 改暗。
 */

export interface MemoryGraphSummary {
  characters: number
  facts: number
  relationships: number
}

/** 星图规模摘要，供窗口页脚一行人读文案。 */
export function memoryGraphSummary(graph: MemoryGraphSnapshot): MemoryGraphSummary {
  return {
    characters: graph.nodes.filter((node) => node.kind === 'character').length,
    facts: graph.nodes.filter((node) => node.kind === 'fact').length,
    relationships: graph.links.filter((link) => link.kind === 'relationship').length,
  }
}

export interface MemoryGraphCanvasProps {
  graph: MemoryGraphSnapshot
  projectPath: string
}

/**
 * 左上角的标题与规模读数。
 *
 * 设计取向：标题定身份，读数竖排一行一条——数字右对齐成一列（等宽数字，8 与 394 也能
 * 对齐），标签跟在后面。不加边框底色卡片，信息直接浮在星图上，像仪表读数而不像一个控件。
 * `tabular-nums` 同时保证数值变化（Agent 写完一章后重拉）时不会左右抖动。
 * 整块 pointer-events-none：它只是读数，不该挡住底下画布的拖拽。
 *
 * 不写「N 个角色」：记忆库里被立成节点的不止人，还有门派、道具、地点（真机实测有
 * 「清河剑派」「苏见的剑」「自动贩卖机」），说成角色是把数字说假了。
 */
function MemoryGraphSummaryHud({ summary }: { summary: MemoryGraphSummary }) {
  const metrics: Array<{ value: number; label: string }> = [
    { value: summary.characters, label: '人物与事物' },
    { value: summary.facts, label: '记忆' },
    { value: summary.relationships, label: '关系' },
  ]

  return (
    <div
      className="pointer-events-none absolute left-5 top-4 z-10 select-none"
      data-memory-graph-summary="true"
    >
      <div className="text-[15px] font-medium leading-none tracking-[0.18em] text-white/85">记忆星图</div>
      <div aria-hidden className="mt-2.5 h-px w-7 bg-white/15" />
      {/* 左侧项目、右侧数字：数字列右对齐 + 等宽数字，8 与 394 的个位仍然对齐成一条竖线 */}
      <dl className="mt-2.5 grid min-w-[8.5rem] grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1.5">
        {metrics.map((metric) => (
          <div key={metric.label} className="contents">
            <dt className="text-[11px] leading-none tracking-[0.06em] text-white/35">{metric.label}</dt>
            <dd className="justify-self-end text-sm leading-none tabular-nums text-white/80">
              {metric.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function MemoryGraphView({
  projectPath,
  initialGraph,
}: {
  projectPath: string
  /** 测试注入用：给定时跳过 IPC 取数直接渲染该快照。 */
  initialGraph?: MemoryGraphSnapshot
}) {
  // 记忆星图这个 section 右侧同屏就是 Agent 面板，用户完全可以一边看星图一边让 Agent 写章节。
  // 写完记忆库会长出新事实，星图必须跟着长——reloadKey 原本传的就是 projectPath 自己（恒定不变），
  // 等于永不重拉。改成跟随「当前会话有没有在跑的 run」翻转：run 起来翻一次、跑完再翻一次，
  // 跑完那次正好把新写进 memory.db 的事实拉回来。取值姿势照 WorkbenchPrimarySidebar 先例。
  const activeRunFlag = useAgentStore((state) => Boolean(state.threadsById[state.activeThreadId]?.activeRun))
  const fetched = useMemoryGraph(
    initialGraph ? undefined : projectPath || undefined,
    `${projectPath}:${activeRunFlag}`,
  )
  const graph = initialGraph ?? fetched.graph
  const loading = initialGraph ? false : fetched.loading
  const [fullscreen, setFullscreen] = useState(false)
  const [Canvas, setCanvas] = useState<ComponentType<MemoryGraphCanvasProps> | null>(null)

  const summary = memoryGraphSummary(graph)
  const hasGraph = summary.characters > 0

  // 画布按需载入：只有真有内容要画时才拉 three.js chunk。载入失败保持占位，不炸整页。
  useEffect(() => {
    if (!hasGraph || Canvas) return
    let cancelled = false
    import('./MemoryGraphCanvas')
      .then((module) => {
        if (!cancelled) setCanvas(() => module.MemoryGraphCanvas)
      })
      .catch(() => {
        // 画布载入失败：窗口留在占位态，摘要仍可读
      })
    return () => {
      cancelled = true
    }
  }, [hasGraph, Canvas])

  // 全屏时按 ESC 退出
  useEffect(() => {
    if (!fullscreen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullscreen])

  if (!hasGraph) {
    return loading ? (
      <WorkbenchEmptyState density="compact" icon={Loader2} iconClassName="animate-spin" title="正在点亮星图">
        正在读取这本书的记忆。
      </WorkbenchEmptyState>
    ) : (
      <WorkbenchEmptyState icon={Sparkles} title="写下第一章，星图会亮起来">
        每写完一章，书里的人物和他们之间发生的事都会记进来，在这里连成一张图。
      </WorkbenchEmptyState>
    )
  }

  return (
    <div
      className={cn(
        // no-drag 不是可选项：窗口是 titleBarStyle:'hidden'，Agent 面板头部那条 h-14 拖拽带
        // （AgentPanel.tsx 的 -webkit-app-region:drag）横在窗口右上角。拖拽区是几何计算的，
        // 上层元素不显式声明 no-drag 就不会把下面的区域挖掉——全屏层即使 z-50 盖在最上面，
        // 右上角的退出按钮仍会被当成"拖窗口"吃掉点击。同 dialog.tsx 的既有约定。
        'flex min-h-0 flex-col overflow-hidden bg-[#05070f] [-webkit-app-region:no-drag]',
        fullscreen ? 'fixed inset-0 z-50' : 'h-full rounded-workspace',
      )}
      data-memory-graph-frame="true"
    >
      {/* 画布满幅铺开，信息与操作都浮在它之上——不切出工具栏与页脚，星图本身才是主体 */}
      <div className="relative min-h-0 flex-1" data-memory-graph-canvas-slot="true">
        {Canvas ? <Canvas graph={graph} projectPath={projectPath} /> : null}

        <MemoryGraphSummaryHud summary={summary} />

        {/* 右上角按钮：普通态卡片在 caption 带下方（方案 A），贴卡片右缘即可；
            全屏态 fixed inset-0 盖住整个窗口（含 caption 带），须给 min/max/close 让位。 */}
        <div
          className={cn(
            'absolute top-3 z-10',
            fullscreen ? 'right-[calc(var(--titlebar-inset-right)+0.75rem)]' : 'right-3',
          )}
        >
          <IconTooltip label={fullscreen ? '退出全屏' : '全屏查看星图'}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={fullscreen ? '退出全屏' : '全屏查看星图'}
              className="text-white/45 hover:bg-white/10 hover:text-white/85"
              onClick={() => setFullscreen((previous) => !previous)}
            >
              {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </Button>
          </IconTooltip>
        </div>
      </div>
    </div>
  )
}
