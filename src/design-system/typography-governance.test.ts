import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

// 代表组件对 typography role contract 的 adoption——覆盖 Workbench 空态、Agent 对话与提问、
// 以及 App 级 Library / 通知 surface，证明迁移后的角色被实际引用，而不是各自硬写字号。
const ADOPTERS: Array<[string, string]> = [
  ['src/components/workbench/WorkbenchEmptyState.tsx', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/components/workbench/WorkbenchEmptyGuide.tsx', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/components/workbench/ReferenceWorksView.tsx', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/components/workbench/MarkdownRenderer.tsx', 'AGENT_BODY_CLASS'],
  ['src/components/workbench/agent/AgentQuestionCard.tsx', 'AGENT_QUESTION_OPTION_CLASS'],
  ['src/components/workbench/agent/AgentComposer.tsx', 'AGENT_BODY_CLASS'],
  ['src/routes/library.tsx', 'EMPTY_PRIMARY_TITLE_CLASS'],
  ['src/components/notifications/GlobalNotificationBell.tsx', 'EMPTY_PRIMARY_BODY_CLASS'],
]

describe('typography drift governance', () => {
  test('representative surfaces adopt the typography role contract', () => {
    for (const [file, token] of ADOPTERS) {
      expect(readFileSync(file, 'utf8')).toContain(token)
    }
  })

  test('check:design guards off-scale font sizes in production code', () => {
    const checkScript = readFileSync('scripts/check-design-system.mjs', 'utf8')
    expect(checkScript).toContain('offScaleFontSizeGuards')
    expect(checkScript).toContain('typography scale guard')
    // 守卫只扫生产代码，避免误伤测试里对 text-[13px] 的负向断言。这里只认语义命名，
    // 不再钉具体循环写法（原来钉的是 `for (const file of productionSourceFiles)`，
    // 一次内部重构就假红）；真正的行为验证在 scripts/check-design-system.test.mjs
    // ——那边直接喂 .test.tsx 与生产文件断言豁免与命中。
    expect(checkScript).toContain('isProductionSource')
  })

  test('design.md documents drift rules, visual verification and accepted debt', () => {
    const design = readFileSync('docs/design.md', 'utf8')
    expect(design).toContain('Typography 漂移治理')
    expect(design).toContain('人工视觉验收路径')
    expect(design).toContain('剩余可接受债务')
  })
})
