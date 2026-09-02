import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const setupSource = readFileSync(fileURLToPath(new URL('./PolishSetupDialog.tsx', import.meta.url)), 'utf-8')
const versionsSource = readFileSync(
  fileURLToPath(new URL('./ChapterPolishVersions.tsx', import.meta.url)),
  'utf-8',
)

/**
 * 守的是 ADR-0041 的产品边界，不是实现细节——边界一旦被顺手改掉功能定位就变了，
 * 而那种改动在 review 里长得像「顺便补个默认值」。
 */
describe('责任边界（ADR-0041 §2）', () => {
  test('空槽只给骨架三行，一个风格词都没有', () => {
    expect(setupSource).toContain('要它做什么…')
    expect(setupSource).toContain('不要它做什么…')
    expect(setupSource).toContain('必须保留什么…')
  })

  test('不携带任何出厂风格模板——内置模板等于效果背书，锅会回到产品身上', () => {
    for (const forbidden of ['去 AI 味', '更像人写', '短句', '长句', '少用比喻', '网文感', '画面感']) {
      expect(setupSource).not.toContain(forbidden)
    }
  })

  test('文案不承诺效果，只承诺事实不被改动', () => {
    expect(setupSource).toContain('改成什么样由你的要求决定')
    expect(setupSource).not.toContain('润色后更好')
  })
})

describe('配置弹窗形态', () => {
  test('三槽横版并排，窄窗降成单栏（design.md §9.7 对比型弹窗档）', () => {
    expect(setupSource).toContain('lg:grid-cols-3')
    expect(setupSource).toContain('grid-cols-1')
  })

  test('未通过连接测试的模型置灰并注明原因，不静默可选', () => {
    expect(setupSource).toContain('isEntryVerified')
    expect(setupSource).toContain('（还没测试连接）')
    // ⚠️ 只断言字符串存在会被「算了但没渲染」骗过（真机上所有置灰项都显示成 OpenAI 那条）。
    // 必须断言它真的进了 JSX，且写死的那句已经不在。
    expect(setupSource).toContain('{option.reason}')
    expect(setupSource).not.toContain("{option.disabled ? '（OpenAI 兼容协议，润色暂不支持）' : ''}")
  })

  test('主力槽自己没验证时，「跟随主力模型」同样置灰', () => {
    expect(setupSource).toContain('disabled={primaryUnverified}')
    expect(setupSource).toContain('（主力模型还没测试连接）')
  })

  test('容器遵 design.md §9.7：bg-workspace + p-0 三段式，不用默认的 bg-floating/p-6', () => {
    expect(setupSource).toContain('bg-workspace p-0')
    // p-0 管不到段间距：DialogContent 默认的 gap-4 会在标题下方留出一片空白（真机看出来的）
    expect(setupSource).toContain('gap-0')
    // 按语义分片断言，不钉整串 class——整串一改就红，而红的原因往往与规范无关
    expect(setupSource).toContain('border-b border-border px-6 pb-5 pt-6 text-left') // header
    expect(setupSource).toContain('overflow-y-auto px-6 py-5') // 内容区自滚 + 规范内边距
    expect(setupSource).toContain('border-t border-border bg-active/40 px-6 py-4') // 按钮条
  })

  test('弹窗够宽——三栏并排读得下要求正文', () => {
    expect(setupSource).toContain('sm:max-w-[1320px]')
  })

  test('高度吃满可用空间，要求输入框跟着长高（不靠 min-h 撑）', () => {
    expect(setupSource).toContain('h-[min(860px,calc(100dvh-4rem))]')
    expect(setupSource).toContain('min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-3')
    expect(setupSource).toContain('flex-1 resize-none')
  })

  test('可见说明进内容区、DialogDescription 走 sr-only（规范的三段式要求）', () => {
    expect(setupSource).toContain('<DialogDescription className="sr-only">')
  })

  test('主按钮是「开始润色」，跑起来后弹窗即关（结果不在弹窗里看）', () => {
    expect(setupSource).toContain('开始润色（')
    expect(setupSource).toContain('onOpenChange(false)')
  })

  test('openai wire 的条目灰显并注明原因，不静默消失', () => {
    expect(setupSource).toContain('OpenAI 兼容协议，润色暂不支持')
    expect(setupSource).toContain('disabled={option.disabled}')
  })
})

describe('版本呈现在正文区', () => {
  test('版本 tab 与章节视图 tab 同一套视觉语言，不另造一套', () => {
    expect(versionsSource).toContain('h-7 shrink-0 items-center gap-1.5 rounded-row px-2.5 text-xs')
    expect(versionsSource).toContain('bg-active font-semibold text-foreground')
  })

  test('原稿永远是第一个 tab', () => {
    expect(versionsSource).toContain("{ value: 'original', label: '原稿', busy: false }")
  })

  test('界面判断只有一处派生：标签/忙碌/三个按钮都读同一个 view', () => {
    // 曾经各处各判 status，加一个状态要改五处、漏一处就是只在某状态下出现的怪 bug
    expect(versionsSource).toContain('derivePolishVersionView')
    expect(versionsSource).toContain('disabled={!view.canAdopt || adopting}')
    expect(versionsSource).toContain('{slotId && view.canAbort && (')
    expect(versionsSource).toContain('disabled={!view.canCompare}')
  })

  test('基线过期时禁用采用，不只是提示', () => {
    expect(versionsSource).toContain('canAdopt: !stale && version.text.trim().length > 0')
  })

  test('对照原稿要等全文到齐——半截文本上算 diff 只会显示「后面全被删了」', async () => {
    const { derivePolishVersionView } = await import('./ChapterPolishVersions')
    const view = (status: 'pending' | 'streaming' | 'done' | 'failed' | 'aborted') =>
      derivePolishVersionView({
        version: { slotId: 'slot-1', status, text: '半截' },
        elapsed: '',
        originalText: '原稿',
        stale: false,
      })
    expect(view('streaming').canCompare).toBe(false)
    expect(view('pending').canCompare).toBe(false)
    expect(view('done').canCompare).toBe(true)
    // diff 只认派生结果，不再自己判 status——判断只能有一处。
    expect(versionsSource).toContain('comparing && view.canCompare')
    expect(versionsSource).not.toContain("version?.status === 'done'")
  })

  test('丢弃 / 采用都要先停掉还在跑的版本，不能只清渲染端状态', () => {
    const view = readFileSync(
      fileURLToPath(new URL('./ChapterManuscriptView.tsx', import.meta.url)),
      'utf-8',
    )
    expect(view).toContain('usePolishRun.getState().cancelAll()')
    // 采用路径：落盘成功 → 立刻取消其余版本 → 刷正文 → 问常驻 → 清状态。
    // 取消排在提议框之前（框可能一直开着），且取消失败不能把已落盘的采用报成失败。
    const adoptBody = versionsSource.slice(versionsSource.indexOf('async function adopt('))
    const cancelAt = adoptBody.indexOf('await cancelAll().catch(')
    const adoptedAt = adoptBody.indexOf('onAdopted()')
    const proposeAt = adoptBody.indexOf('await proposeStanding(slotId)')
    const resetAt = adoptBody.indexOf('reset()')
    expect(cancelAt).toBeGreaterThan(-1)
    expect(cancelAt).toBeLessThan(adoptedAt)
    expect(adoptedAt).toBeLessThan(proposeAt)
    expect(proposeAt).toBeLessThan(resetAt)
  })

  test('成功态不发 toast（design.md：Toast 不做操作确认）', () => {
    expect(versionsSource).not.toContain('toast.success')
    expect(setupSource).not.toContain('toast.success')
  })

  test('随手关掉确认框不算「回答过」——只有明确选择才记下不再问', () => {
    expect(versionsSource).toContain("if (outcome !== 'dismiss')")
    expect(versionsSource).toContain('confirmWithOutcome')
  })

  test('版本 tab 的过渡时长跟规范走（hover/tab = duration-200）', () => {
    expect(versionsSource).toContain('transition-colors duration-200')
    expect(versionsSource).not.toContain('duration-150')
  })

  test('版本归属同时判书和章——只判章号会跨小说串数据', () => {
    const view = readFileSync(
      fileURLToPath(new URL('./ChapterManuscriptView.tsx', import.meta.url)),
      'utf-8',
    )
    expect(view).toContain('polishChapter === chapter && polishProjectPath === projectPath')
  })

  test('旧章漂移必须先确认再采用', () => {
    expect(versionsSource).toContain('needsDivergenceAck')
    expect(versionsSource).toContain('divergenceAcknowledged: acknowledged')
  })

  test('常驻提议默认不勾：走确认框且取消文案是「这次就好」', () => {
    expect(versionsSource).toContain('这次就好')
    expect(versionsSource).toContain('设为常驻')
  })

  test('常驻提议一本书只问一次——已常驻或已答过就不再弹', () => {
    expect(versionsSource).toContain('settings.standingPromptAnswered || settings.standingSlotId')
    // 无论答哪个都记成答过：「这次就好」是回答，不是「下次再问我」
    expect(versionsSource).toContain('await markStandingPromptAnswered(projectPath)')
  })

  test('所有动作收在同一条操作条上，tab 行只切视图不放按钮', () => {
    expect(versionsSource).toContain('onDiscard')
    // 「丢弃」与「采用/中止/对照」同处一条；tab 组件不再接收任何动作回调
    expect(versionsSource).toContain('export function PolishVersionTabs({\n  active,\n  onChange,\n}')
  })

  test('润色稿与原稿同一条阅读栏、同一个渲染路径——差异只该来自文字本身', () => {
    // 定稿走 ArtifactDocumentBody（= 原稿用的 MarkdownRenderer document 变体）
    expect(versionsSource).toContain('<ArtifactDocumentBody>{version.text}</ArtifactDocumentBody>')
    // 正文用与原稿相同的阅读画布；tab 与操作条对齐到同宽的列
    expect(versionsSource).toContain('WORKBENCH_READING_CANVAS_CLASS')
    expect(versionsSource).toContain("const POLISH_READING_COLUMN_CLASS = 'mx-auto w-full max-w-[820px]'")
  })

  test('版本不随离开页面消失——切到别的 tab 再回来还在', () => {
    const view = readFileSync(
      fileURLToPath(new URL('./ChapterManuscriptView.tsx', import.meta.url)),
      'utf-8',
    )
    // 曾经挂在 unmount 上清空，切到「章节大纲」看一眼再回来三版就没了（真机撞出来的）。
    // 切章由 polishChapter === chapter 守，不需要也不该用卸载来清。
    expect(view).not.toContain('return () => {\n      resetPolish()')
    expect(view).toContain('polishChapter === chapter')
  })

  test('正文在跑完之后被改过 → 明示版本已过期，而不是等采用时撞乐观锁', () => {
    const view = readFileSync(
      fileURLToPath(new URL('./ChapterManuscriptView.tsx', import.meta.url)),
      'utf-8',
    )
    expect(view).toContain('polishBaseline !== visibleText')
    expect(view).toContain('data-polish-stale')
  })

  test('常驻润色跑完要刷新正文，不能只刷横幅', () => {
    const view = readFileSync(
      fileURLToPath(new URL('./ChapterManuscriptView.tsx', import.meta.url)),
      'utf-8',
    )
    expect(view).toContain('if (standingVersion === 0) return')
    expect(view).toContain('onChanged?.()')
  })

  test('操作条随滚动置顶：读到第三屏还想采用时不该先滚回去找按钮', () => {
    expect(versionsSource).toContain('sticky top-0 z-20 bg-workspace')
  })

  test('流式期间不走 markdown 解析——一章两千多个增量会把主线程拖垮', async () => {
    const { derivePolishVersionView } = await import('./ChapterPolishVersions')
    const complete = (status: 'streaming' | 'done') =>
      derivePolishVersionView({
        version: { slotId: 'slot-1', status, text: '正文' },
        elapsed: '',
        originalText: '原稿',
        stale: false,
      }).complete
    expect(complete('streaming')).toBe(false)
    expect(complete('done')).toBe(true)
    // 只有定稿才进 ArtifactDocumentBody（markdown 渲染），分支只认派生结果。
    expect(versionsSource).toContain('view.complete && version ? (')
  })

  test('改动比例贴在状态里——一版几乎没动时，作者不必读三千字才发现要求没落地', () => {
    expect(versionsSource).toContain('改动 ${changed}% 段落')
  })

  test('推理模式是每槽的开关，默认关', () => {
    expect(setupSource).toContain('推理模式（更慢更贵，复杂要求可能更好）')
    expect(setupSource).toContain('checked={recipe?.thinking ?? false}')
  })
})
