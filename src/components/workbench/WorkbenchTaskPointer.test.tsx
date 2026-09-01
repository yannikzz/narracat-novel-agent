import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { WorkbenchTaskPointer } from './WorkbenchTaskPointer'
import { resolveStatusNextStep } from '@/lib/workbench-actions'
import type { NovelProjectDetail, NovelChapterStatus, NovelProjectStatus } from '@shared/types/novel'

function projectWith(
  status: NovelProjectStatus,
  chapters: Array<{ n: number; status: NovelChapterStatus }> = [],
  hasCharacters = true,
): NovelProjectDetail {
  return {
    id: 'novel-1',
    title: '星辰大海',
    path: '/novels/stars',
    status,
    chapterProgress: '0 / 0 章',
    wordCountLabel: '0 字',
    tocItems: chapters.map(({ n, status: chapterStatus }) => ({
      id: `chapter-${n}`,
      kind: 'chapter',
      title: `第 ${n} 章`,
      chapterNumber: n,
      status: chapterStatus,
    })),
    treeItems: [],
    hasCharacters,
  }
}

function render(project: NovelProjectDetail | null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WorkbenchTaskPointer project={project} projectPath="/novels/stars" />
    </MemoryRouter>,
  )
}

describe('WorkbenchTaskPointer', () => {
  test('缺立项卡 → 指向建立创作根基', () => {
    const html = render(projectWith('needs-setup'))
    expect(html).toContain('data-workbench-task-pointer="true"')
    expect(html).toContain('建立创作根基')
    expect(html).toContain('bible-premise')
  })

  test('有立项卡但还没角色 → 指向创建主要角色（创作链那一格）', () => {
    const html = render(projectWith('needs-outline', [], false))
    expect(html).toContain('创建主要角色')
    expect(html).toContain('characters')
  })

  test('有角色缺大纲 → 指向规划全书大纲', () => {
    const html = render(projectWith('needs-outline'))
    expect(html).toContain('规划全书大纲')
    expect(html).toContain('master-outline')
  })

  test('连载中 → 指向下一章，且 href 落在该章', () => {
    const html = render(projectWith('in-progress', [{ n: 3, status: 'planned' }]))
    expect(html).toContain('写第 3 章')
    expect(html).toContain('chapter-3')
  })

  /**
   * 常驻元素的核心纪律：只导航。链接的 href 必须是工作台路由，
   * 绝不能出现任何会被当成「点了就跑」的痕迹。
   */
  test('永远只导航：渲染成 a[href] 指向工作台，不带 Agent 命令', () => {
    const html = render(projectWith('needs-outline'))
    expect(html).toContain('href="/workbench?')
    expect(html).not.toContain('command')
    expect(html).not.toContain('start-run')
  })

  test('全书完结 → 不渲染，不占位', () => {
    expect(render(projectWith('in-progress', [{ n: 1, status: 'completed' }]))).toBe('')
  })

  test('项目无效或缺失 → 不渲染', () => {
    expect(render(projectWith('invalid'))).toBe('')
    expect(render(null)).toBe('')
  })

  test('首次渲染不带变化高亮——否则每次打开项目都闪一下，高亮就贬值成装饰', () => {
    const html = render(projectWith('needs-setup'))
    expect(html).not.toContain('data-workbench-task-pointer-changed')
  })

  /**
   * 外审抓到的三个缺陷，各钉一条。共同点是「旧测试全绿但功能是坏的」——
   * 旧用例断言的是 action 里的数据，而作者看见的是 DOM。
   */

  test('「可跳过」必须出现在 DOM 里，不能只躺在 action.description', () => {
    const html = render(projectWith('needs-outline', [], false))
    expect(html).toContain('可跳过')
    // 反面：不可跳过的步骤不许出现这个标记，否则它就成了永久噪声。
    expect(render(projectWith('needs-outline'))).not.toContain('可跳过')
    expect(render(projectWith('needs-setup'))).not.toContain('可跳过')
  })

  test('连载路径的变化判据必须含章号：写第 1 章 → 写第 2 章 是「变了」', () => {
    // id 恒为 status-next-write，章号只在 label 里；只看 id 的话高亮永远不触发。
    const first = projectWith('in-progress', [{ n: 1, status: 'planned' }])
    const second = projectWith('in-progress', [
      { n: 1, status: 'completed' },
      { n: 2, status: 'planned' },
    ])
    const keyOf = (project: NovelProjectDetail) => {
      const step = resolveStatusNextStep(project)
      return step?.kind === 'action' ? `${step.action.id}:${step.action.label}` : null
    }
    expect(keyOf(first)).not.toBe(keyOf(second))
    // 同时确认 id 本身确实分不出来——这正是原实现失效的原因。
    const idOf = (project: NovelProjectDetail) => {
      const step = resolveStatusNextStep(project)
      return step?.kind === 'action' ? step.action.id : null
    }
    expect(idOf(first)).toBe(idOf(second))
  })

  test('项目带 structure problem 时不指路，哪怕 status 还是 ready', () => {
    const broken: NovelProjectDetail = {
      ...projectWith('ready', [{ n: 1, status: 'planned' }]),
      problem: '全书结构数据损坏',
    }
    expect(render(broken)).toBe('')
  })
})
