import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { MemoryGraphSnapshot } from '@shared/types/memory-graph'
import { MemoryGraphView, memoryGraphSummary } from './MemoryGraphView'

const emptyGraph: MemoryGraphSnapshot = { nodes: [], links: [] }

const populatedGraph: MemoryGraphSnapshot = {
  nodes: [
    { id: 'uid-a', kind: 'character', label: '苏见', ownerId: null, predicate: null, predicateLabel: null, factCount: 2, chapter: null },
    { id: 'uid-b', kind: 'character', label: '阿九', ownerId: null, predicate: null, predicateLabel: null, factCount: 0, chapter: null },
    { id: 'f1', kind: 'fact', label: '找到师父下落', ownerId: 'uid-a', predicate: 'goal', predicateLabel: '目标', factCount: 0, chapter: 1 },
    { id: 'f2', kind: 'fact', label: '其实是仇家之子', ownerId: 'uid-a', predicate: 'secret', predicateLabel: '秘密', factCount: 0, chapter: 3 },
  ],
  links: [
    { source: 'uid-a', target: 'uid-b', kind: 'relationship', label: '同门相护' },
    { source: 'uid-a', target: 'f1', kind: 'belongs-to', label: null },
    { source: 'uid-a', target: 'f2', kind: 'belongs-to', label: null },
  ],
}

describe('memoryGraphSummary', () => {
  test('counts characters, facts and relationships', () => {
    expect(memoryGraphSummary(populatedGraph)).toEqual({ characters: 2, facts: 2, relationships: 1 })
  })

  test('reports zeros for an empty graph', () => {
    expect(memoryGraphSummary(emptyGraph)).toEqual({ characters: 0, facts: 0, relationships: 0 })
  })
})

describe('MemoryGraphView', () => {
  test('renders the empty guide when there is nothing to draw', () => {
    const html = renderToStaticMarkup(<MemoryGraphView projectPath="" />)

    expect(html).toContain('写下第一章，星图会亮起来')
    // 空态不挂画布容器
    expect(html).not.toContain('data-memory-graph-canvas-slot="true"')
  })

  test('renders a dark canvas frame with the summary HUD when data exists', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryGraphView projectPath="/p" initialGraph={populatedGraph} />
      </TooltipProvider>,
    )

    expect(html).toContain('data-memory-graph-canvas-slot="true"')

    // 读数是「数字 + 标签」两段分开渲染的。必须按**配对**断言：只断言"页面某处有 2"
    // 是句空话——三项里有两项恰好都是 2，把人物数写死成 0 也照样能搜到 2 而不报错
    // （初版就这么漏过一次）。这里把每个 metric 块解析成 标签 → 数值 再整体比对。
    const pairs = [...html.matchAll(/<dt[^>]*>([^<]+)<\/dt><dd[^>]*tabular-nums[^>]*>(\d+)<\/dd>/g)]
    const readings = Object.fromEntries(pairs.map(([, label, value]) => [label, Number(value)]))

    // populatedGraph = 2 个人物与事物 / 2 条记忆 / 1 段关系
    expect(readings).toEqual({ 人物与事物: 2, 记忆: 2, 关系: 1 })
    expect(html).toContain('记忆星图')

    // 记忆库里被立成节点的不止人（真机有门派/道具/地点），不能说成「N 个角色」
    expect(html).not.toContain('个角色')
    expect(html).not.toContain('角色</span>')
  })

  test('spins the loading icon while the graph is still being read', () => {
    // 加载态图标不转 = 看起来卡死了
    const html = renderToStaticMarkup(<MemoryGraphView projectPath="/p" />)

    expect(html).toContain('正在点亮星图')
    expect(html).toContain('animate-spin')
  })

  test('exposes an accessible fullscreen toggle', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryGraphView projectPath="/p" initialGraph={populatedGraph} />
      </TooltipProvider>,
    )

    expect(html).toContain('aria-label="全屏查看星图"')
  })

  test('positions the fullscreen toggle by mode: card edge normally, clear of caption when fullscreen', () => {
    // 方案 A（上下分区）后普通态卡片在 caption 带下方，按钮贴卡片右缘（right-3）即可——
    // 固定带 inset 会把按钮无辜推离右缘 145px。全屏态 fixed inset-0 盖住整个窗口
    // （含 caption 带），仍须给 min/max/close 让位（WCO 实测宽度覆盖，150px 回退兜底）。
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryGraphView projectPath="/p" initialGraph={populatedGraph} />
      </TooltipProvider>,
    )
    const source = readFileSync(fileURLToPath(new URL('./MemoryGraphView.tsx', import.meta.url)), 'utf-8')

    // 普通态：贴卡片右缘
    expect(html).toContain('right-3')
    expect(html).not.toContain('right-[calc(var(--titlebar-inset-right)+0.75rem)]')
    // 全屏态：源码里保留 caption 让位条件分支
    expect(source).toContain(
      "fullscreen ? 'right-[calc(var(--titlebar-inset-right)+0.75rem)]' : 'right-3'",
    )
  })

  test('keeps the graph frame out of the frameless window drag region', () => {
    // 真机走查抓到：全屏后右上角退出按钮点不动。窗口是 titleBarStyle:'hidden'，Agent 面板
    // 头部那条 h-14 拖拽带横在窗口右上角；拖拽区按几何计算，上层不声明 no-drag 就挖不掉
    // 下面的区域，z-50 也救不了——点击被当成拖窗口吃掉。同 dialog.test.tsx 钉的同一类约定。
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryGraphView projectPath="/p" initialGraph={populatedGraph} />
      </TooltipProvider>,
    )

    const frame = html.match(/<div class="([^"]*)"[^>]*data-memory-graph-frame="true"/)?.[1] ?? ''
    expect(frame).toContain('[-webkit-app-region:no-drag]')
  })
})
