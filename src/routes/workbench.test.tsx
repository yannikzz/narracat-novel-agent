import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'

describe('WorkbenchRoute', () => {
  test('does not render the checkpoint resume banner above the workbench stage', () => {
    const source = readFileSync(fileURLToPath(new URL('./workbench.tsx', import.meta.url)), 'utf-8')

    expect(source).not.toContain('CheckpointResumeBanner')
    expect(source).not.toContain('<CheckpointResumeBanner')
  })

  test('keeps the stale-load recovery banner below the Windows caption band', () => {
    // 方案 A 后横幅 top 消费 --titlebar-gutter-top（win32 56px+呼吸位）压到 caption 带下方，
    // 右缘不再需要 --titlebar-inset-right 让位（保留会把横幅右端无辜缩短 145px）。
    const source = readFileSync(fileURLToPath(new URL('./workbench.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('absolute left-4 right-4 top-[max(1rem,calc(var(--titlebar-gutter-top)+0.25rem))]')
    expect(source).not.toContain('right-[max(1rem,var(--titlebar-inset-right))]')
    expect(source).not.toContain('absolute left-4 right-4 top-4')
  })

  test('drops the stage cards below the Windows caption band (win32 gutter)', () => {
    // 方案 A 上下分区：win32 下舞台/状态卡顶部 padding 消费 --titlebar-gutter-top（56px），
    // caption 按钮悬于 canvas gutter 上，不再压 Agent 面板头部白底（视觉混排根因）。
    const source = readFileSync(fileURLToPath(new URL('./workbench.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('pt-[max(0px,var(--titlebar-gutter-top))]')
    expect(source).not.toContain('flex-1 p-3 pt-0')
  })

  test('uses one pixel-based resizable workbench grid for sidebar content and Agent widths', () => {
    const source = readFileSync(fileURLToPath(new URL('./workbench.tsx', import.meta.url)), 'utf-8')

    expect(source).not.toContain('react-resizable-panels')
    expect(source).toContain('useWorkbenchPanelLayout')
    expect(source).toContain('workbenchPanelGridTemplates(layout)')
    expect(source).toContain('createWorkbenchPanelDragSession')
    expect(source).toContain('applyWorkbenchPanelLayoutToDom(container, nextLayout)')
    expect(source).toContain('gridTemplateRows: WORKBENCH_GRID_TEMPLATE_ROWS')
    expect(source).toContain('data-workbench-layout-grid="true"')
    expect(source).toContain('data-workbench-sidebar-panel="true"')
    expect(source).toContain('data-workbench-sidebar-resize-handle="true"')
    expect(source).toContain('data-workbench-content-panel="true"')
    expect(source).toContain('agentWidth={layout.agent}')
    expect(source).toContain('onAgentResizeStart={startAgentResize}')
  })

  test('does not let resize sync restore the Agent columns for full-width sections', () => {
    // 拖拽同步是舞台布局的第二条写入路径（直接改 style），漏了它会在用户拖分隔条时
    // 把满宽板块的 Agent 栏塞回来。判定统一走 isFullWidthWorkbenchSection，不再各写字面量。
    const source = readFileSync(fileURLToPath(new URL('./workbench.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('isFullWidthWorkbenchSection(stage?.dataset.sectionId)')
    expect(source).toContain('WORKBENCH_STAGE_SINGLE_COLUMN_TEMPLATE')
    expect(source).toContain('fullWidthSection ? WORKBENCH_STAGE_SINGLE_COLUMN_TEMPLATE : templates.stage')
  })

  test('persists the resolved work location and routes chapter subviews through the URL', () => {
    const source = readFileSync(fileURLToPath(new URL('./workbench.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('readWorkbenchChapterView(searchParams)')
    expect(source).toContain('createWorkbenchLocation({')
    expect(source).toContain('writeWorkLocation(')
    expect(source).toContain("next.set('view', view)")
    expect(source).toContain('selectedChapterView={resolvedChapterView}')
  })
})
