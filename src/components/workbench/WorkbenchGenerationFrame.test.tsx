import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkbenchGenerationAnimation } from './WorkbenchGenerationAnimation'
import { WorkbenchGenerationEmptyState } from './WorkbenchGenerationFrame'

const generationState = {
  phase: 'running' as const,
  label: '参考作品',
  statusText: '正在生成参考作品',
}

const waitingState = {
  phase: 'waiting-user' as const,
  label: '核心设定',
  statusText: 'NarraCat 在等你回答',
  pendingQuestion: { questionRequestId: 'question-1', prompt: '这本书用第几人称讲？' },
}

describe('WorkbenchGenerationFrame', () => {
  test('renders the standard full-page Agent running state for empty generated content', () => {
    const html = renderToStaticMarkup(<WorkbenchGenerationEmptyState generationState={generationState} />)

    expect(html).toContain('data-workbench-generation-empty="true"')
    expect(html).toContain('data-workbench-generation-animation="main"')
    // 深色门控期间 effectiveTheme 恒为 light，生成动画使用浅色素材
    expect(html).toContain('generation-loading-light.webm')
    expect(html).toContain('正在生成参考作品')
    expect(html).toContain('完成后会自动刷新当前页面。')
    expect(html).not.toContain('animate-spin')
  })

  // 等作者回答时机器没在跑：不放生成动画（会假装还在干活），也绝不退回空态（会假装无事发生）。
  test('swaps the running animation for a jump-to-question prompt while waiting on the author', () => {
    const html = renderToStaticMarkup(
      <WorkbenchGenerationEmptyState generationState={waitingState} onAnswerQuestion={() => {}} />,
    )

    expect(html).toContain('data-workbench-generation-waiting="true"')
    // 主内容区空态用 primary empty 角色（docs/design.md），不回到硬写字号
    expect(html).toContain('text-lg')
    expect(html).toContain('NarraCat 在等你回答')
    expect(html).toContain('这本书用第几人称讲？')
    expect(html).toContain('data-workbench-waiting-answer="question-1"')
    expect(html).toContain('去回答')
    expect(html).not.toContain('data-workbench-generation-animation')
  })

  test('still holds the area, minus the jump button, when the question pointer is missing', () => {
    const { pendingQuestion: _omitted, ...withoutPointer } = waitingState
    const html = renderToStaticMarkup(<WorkbenchGenerationEmptyState generationState={withoutPointer} />)

    expect(html).toContain('data-workbench-generation-waiting="true"')
    expect(html).toContain('回答后会继续核心设定，问题在右侧对话里。')
    expect(html).not.toContain('data-workbench-waiting-answer')
  })

  // 生成中的内联指示已挪到 titlebar 标题右侧（见 WorkbenchObjectHeader），
  // 内容区不再需要包裹一条灰色运行状态横条；相关渲染条件覆盖见 WorkbenchObjectView.test.tsx。

  test('uses the theme-specific PNG fallback when reduced motion is enabled', () => {
    const html = renderToStaticMarkup(
      <WorkbenchGenerationAnimation size="mini" theme="light" reducedMotion />,
    )

    expect(html).toContain('data-workbench-generation-animation="mini"')
    expect(html).toContain('generation-loading-light.png')
    expect(html).not.toContain('<video')
  })
})
