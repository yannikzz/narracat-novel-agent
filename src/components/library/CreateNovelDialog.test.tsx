import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dialog } from '@/components/ui/dialog'
import {
  CREATE_NOVEL_AUTOMATION_AUTO_HELP,
  CREATE_NOVEL_AUTOMATION_AUTO_LABEL,
  CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP,
  CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL,
  CREATE_NOVEL_GENRE_HELP,
  CREATE_NOVEL_GENRE_PLACEHOLDER,
  CREATE_NOVEL_INITIAL_AUTOMATION_LEVEL,
  CREATE_NOVEL_INITIAL_GENRE,
  CREATE_NOVEL_TITLE_PLACEHOLDER,
  CreateNovelDialogPanel,
  buildCreatedNovelWorkbenchHref,
} from './CreateNovelDialog'

/**
 * 分档按钮按渲染顺序还原成「标签 → 选中态」。选中态与点击回调分别写在两个块上，最容易的手误就是
 * 把它们在两块之间对调，而顺序/徽标那几条断言全都照样绿——所以这里逐块锁死配对。
 */
function readAutomationOptions(html: string): { active: string; label: string }[] {
  const start = html.indexOf('data-create-novel-automation="segmented"')
  const end = html.indexOf('data-create-novel-automation-help="true"')
  const segmented = html.slice(start, end)

  return [...segmented.matchAll(/data-active="(true|false)"[^>]*><span>([^<]*)<\/span>/g)].map(
    ([, active, label]) => ({ active, label }),
  )
}

describe('CreateNovelDialogPanel', () => {
  test('opens a newly created novel on the core premise tab', () => {
    expect(buildCreatedNovelWorkbenchHref('/novels/星辰大海')).toBe(
      '/workbench?project=%2Fnovels%2F%E6%98%9F%E8%BE%B0%E5%A4%A7%E6%B5%B7&section=settings&tab=bible-premise',
    )
  })

  test('renders the create form with governed modal structure and design-system surfaces', () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <CreateNovelDialogPanel
          automationLevel="auto"
          creating={false}
          formError="请输入小说标题。"
          genre="赛博朋克悬疑"
          title="星辰大海"
          onAutomationLevelChange={() => {}}
          onGenreChange={() => {}}
          onSubmit={() => {}}
          onTitleChange={() => {}}
        />
      </Dialog>,
    )

    expect(html).toContain('data-create-novel-panel="true"')
    expect(html).not.toContain('data-create-novel-brand-illustration')
    expect(html).not.toContain('data-brand-illustration="create-novel"')
    expect(html).not.toContain('feather-writing.webp')
    expect(html).toContain('data-create-novel-foundation-note="true"')
    expect(html).toContain('先填写基础设定即可，小说详细设定后续会由 Agent 一起帮助你完成。')
    expect(html).toContain('data-create-novel-fields="true"')
    expect(html).toContain('mt-3 grid')
    expect(html).not.toContain('divide-y divide-border')
    expect(html).toContain('grid-cols-[84px_minmax(0,1fr)]')
    expect(html).toContain(`placeholder="${CREATE_NOVEL_TITLE_PLACEHOLDER}"`)
    expect(html).not.toContain('placeholder="星辰大海"')
    expect(html).toContain('题材')
    expect(html).toContain('data-create-novel-genre-input="true"')
    expect(html).toContain('value="赛博朋克悬疑"')
    expect(html).toContain(`placeholder="${CREATE_NOVEL_GENRE_PLACEHOLDER}"`)
    expect(html).toContain('data-create-novel-genre-help="true"')
    expect(html).toContain(CREATE_NOVEL_GENRE_HELP)
    expect(html).not.toContain('可写：玄幻、仙侠、都市、科幻、悬疑、历史、赛博朋克、无限流等，也可以自定义。')
    expect(html).not.toContain('data-create-novel-chapter-select="true"')
    expect(html).not.toContain('data-create-novel-word-target-select="true"')
    expect(html).not.toContain('目标章节')
    expect(html).not.toContain('章节字数')
    expect(html.indexOf('data-create-novel-genre-input="true"')).toBeLessThan(
      html.indexOf('data-create-novel-automation="segmented"'),
    )
    expect(html).toContain('data-create-novel-automation="segmented"')
    expect(html).toContain('data-create-novel-automation-recommended="true"')
    expect(html).toContain('推荐')
    expect(html).toContain(CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL)
    expect(html).toContain(CREATE_NOVEL_AUTOMATION_AUTO_LABEL)
    // 推荐徽标挂在全自动选项上，且全自动排在协作模式前面（默认档=全自动，#27）。
    expect(html.indexOf(CREATE_NOVEL_AUTOMATION_AUTO_LABEL)).toBeLessThan(
      html.indexOf(CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL),
    )
    expect(html.indexOf(CREATE_NOVEL_AUTOMATION_AUTO_LABEL)).toBeLessThan(
      html.indexOf('data-create-novel-automation-recommended="true"'),
    )
    expect(html.indexOf('data-create-novel-automation-recommended="true"')).toBeLessThan(
      html.indexOf(CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL),
    )
    // automationLevel="auto" → 只有「全自动」那块高亮（接反了这条会红）。
    expect(readAutomationOptions(html)).toEqual([
      { active: 'true', label: CREATE_NOVEL_AUTOMATION_AUTO_LABEL },
      { active: 'false', label: CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL },
    ])
    expect(html).toContain('data-create-novel-automation-help="true"')
    // 传入 automationLevel="auto" 时，说明文案应讲清全程不打断换来的代价（时间与花费）。
    expect(html).toContain(CREATE_NOVEL_AUTOMATION_AUTO_HELP)
    expect(html).not.toContain(CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP)
    expect(html).toContain('rounded-row bg-active p-1')
    expect(html).toContain('rounded-md border border-destructive/30 bg-destructive/10')
    expect(html).toContain('创建并打开')
    expect(html).not.toContain('data-create-novel-group="true"')
    expect(html).not.toContain('<option value="其他"')
    expect(html).not.toContain('type="number"')
    expect(html).not.toContain('value="2000-2500 （适用于快节奏网文）"')
    expect(html).not.toContain('sm:grid-cols-2 sm:divide-x sm:divide-y-0')
    expect(html).not.toMatch(/shadow-(sm|md|lg|xl|2xl)/)
    expect(html).not.toMatch(/bg-(blue|purple|green|orange|red|gray|slate)-\d/)
  })

  test('does not prefill a genre before the author chooses one', () => {
    expect(CREATE_NOVEL_INITIAL_GENRE).toBe('')
  })

  test('defaults a new novel to the recommended fully automatic mode (#27)', () => {
    expect(CREATE_NOVEL_INITIAL_AUTOMATION_LEVEL).toBe('auto')
  })

  test('collaborative automation shows its own consequence copy (dogfood #5 default)', () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <CreateNovelDialogPanel
          automationLevel="collaborative"
          creating={false}
          formError={null}
          genre="赛博朋克悬疑"
          title="星辰大海"
          onAutomationLevelChange={() => {}}
          onGenreChange={() => {}}
          onSubmit={() => {}}
          onTitleChange={() => {}}
        />
      </Dialog>,
    )

    // automationLevel="collaborative" → 高亮跟着换到「协作模式」那块，「推荐」徽标不跟着跑。
    expect(readAutomationOptions(html)).toEqual([
      { active: 'false', label: CREATE_NOVEL_AUTOMATION_AUTO_LABEL },
      { active: 'true', label: CREATE_NOVEL_AUTOMATION_COLLABORATIVE_LABEL },
    ])
    expect(html).toContain(CREATE_NOVEL_AUTOMATION_COLLABORATIVE_HELP)
    expect(html).not.toContain(CREATE_NOVEL_AUTOMATION_AUTO_HELP)
  })
})
