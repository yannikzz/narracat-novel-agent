import { describe, expect, test } from 'bun:test'
import { EMPTY_COMPACT_TITLE_CLASS, EMPTY_PRIMARY_BODY_CLASS, EMPTY_PRIMARY_TITLE_CLASS } from '@/design-system'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { Dialog } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  LibraryEmptyState,
  LibraryFilterBar,
  LibraryFilteredEmptyState,
  LibraryHomeHero,
  LibraryInvalidProjectPanel,
  LibraryProjectDeletePanel,
  LIBRARY_PROJECT_METADATA_DIALOG_CONTENT_CLASS,
  LibraryNavBrand,
  LibraryProjectCard,
  LibraryProjectMetadataPanel,
  LibraryProjectGrid,
  LibraryRoute,
  isLibraryProjectDeleteConfirmationValid,
  libraryAutomationMenuLabel,
  summarizeLibraryProjects,
} from './library'
import { getLibraryCoverPreset } from '@/lib/library-covers'
import {
  filterLibraryProjects,
  getLibraryGenreFilters,
  normalizeLibraryGenre,
  sortLibraryProjects,
} from '@/lib/library-projects'
import type { NovelProjectSummary } from '@shared/types/novel'

const baseProject: NovelProjectSummary = {
  id: 'stars',
  title: '星辰大海',
  genre: '科幻',
  coverPreset: 'cover-03',
  path: '/novels/stars',
  status: 'needs-outline',
  chapterProgress: '3 / 30 章',
  wordCountLabel: '1.2万字',
  wordCountTotal: 12400,
  updatedAt: '2026-05-03T08:02:20.000Z',
}

describe('LibraryRoute presentation', () => {
  test('renders the library chrome with the governed brand lockup', () => {
    const html = renderToStaticMarkup(<LibraryNavBrand />)

    expect(html).toContain('data-library-nav-brand="true"')
    expect(html).toContain('data-brand-lockup="true"')
    expect(html).toContain('data-brand-mark="true"')
    expect(html).toContain('NarraCat')
    expect(html).not.toContain('text-base font-semibold">NarraCat')
  })

  test('places the library brand in the centered header slot', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <LibraryRoute />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(html).toContain('data-library-nav-brand="true"')
    expect(html).toContain('absolute left-1/2 top-0')
    expect(html).toContain('[-webkit-app-region:drag]')
    expect(html).toContain('select-none')
  })

  test('renders an empty library guide with one clear brand CTA', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryEmptyState loading={false} />
      </MemoryRouter>,
    )

    expect(html).toContain('data-library-empty-state="true"')
    expect(html).toContain('min-h-[328px]')
    expect(html).toContain('data-library-empty-illustration="true"')
    expect(html).toContain('h-40')
    expect(html).toContain('data-brand-illustration="empty-library"')
    expect(html).toContain('data-size="lg"')
    expect(html).toContain('reading-book-pile.webp')
    expect(html).toContain('开始第一部小说')
    expect(html).toContain('创建后会进入创作工作台，Agent 会继续协助完善设定。')
    // 主空态使用 primary empty 角色
    expect(html).toContain(EMPTY_PRIMARY_TITLE_CLASS)
    expect(html).toContain(EMPTY_PRIMARY_BODY_CLASS)
    expect(html).toContain('新建小说')
    expect(html).toContain('min-w-40 rounded-row')
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).not.toContain('border-dashed')
    expect(html).not.toContain('还没有 NarraCat 项目')
    expect(html).not.toContain('rounded-full bg-active')
  })

  test('summarizes projects into actionable library metrics', () => {
    expect(
      summarizeLibraryProjects([
        baseProject,
        {
          ...baseProject,
          id: 'ready',
          status: 'ready',
          chapterProgress: '30 / 30 章',
          wordCountLabel: '2.0万字',
          wordCountTotal: 20000,
        },
        { ...baseProject, id: 'invalid', status: 'invalid', wordCountLabel: '0 字', wordCountTotal: 0 },
      ]),
    ).toEqual({
      total: 3,
      completed: 1,
      // 原始数字精确求和，不从 wordCountLabel 反解（旧实现 "3.5万字"→"35" 的回归点）
      words: 32400,
    })
  })

  test('万字级原始数字精确求和，banner 缩写为「3.5万」而非误剥的「35」', () => {
    const summary = summarizeLibraryProjects([
      { ...baseProject, id: 'a', wordCountLabel: '3.5万字', wordCountTotal: 35000 },
    ])
    expect(summary.words).toBe(35000)

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <LibraryHomeHero summary={summary} />
        </MemoryRouter>
      </TooltipProvider>,
    )
    expect(html).toContain('3.5万')
    expect(html).not.toContain('>35<')
  })

  test('renders the accepted desktop home banner with overlay summary metrics', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <LibraryHomeHero
            summary={{
              total: 2,
              completed: 0,
              words: 8369,
            }}
          />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(html).toContain('data-library-home-hero="true"')
    expect(html).toContain('data-library-home-banner="true"')
    expect(html).toContain('bg-[#04c853]')
    expect(html).toContain('data-library-home-agents="true"')
    expect(html).toContain('agents.webp')
    expect(html).toContain('h-[clamp(340px,32vw,463px)]')
    expect(html).toContain('data-library-home-metrics="true"')
    expect(html).toContain('data-library-agent-profile-link="true"')
    expect(html).toContain('href="/settings?section=agents"')
    expect(html).toContain('aria-label="点击查看Agent档案"')
    expect(html).toContain('data-icon-tooltip="点击查看Agent档案"')
    expect(html).toContain('bottom-0 right-[6.2%]')
    expect(html).toContain('origin-bottom')
    expect(html).toContain('group-hover:scale-[1.025]')
    expect(readFileSync(new URL('./library.tsx', import.meta.url), 'utf8')).toContain(
      '<IconTooltip label="点击查看Agent档案" side="bottom" align="center">',
    )
    expect(html).not.toContain('了解 Agent')
    expect(html).toContain('bottom-[48px]')
    expect(html).toContain('left-[3.8%] top-[48px]')
    expect(html).toContain('w-[43%] max-w-[630px] text-white 2xl:w-[49%] 2xl:max-w-[740px]')
    expect(html).toContain('故事生于人，')
    expect(html).toContain('成于智能。')
    expect(html).toContain('作品数')
    expect(html).toContain('已完结')
    expect(html).toContain('字数')
    expect(html).toContain('8,369')
    expect(html).not.toContain('8,369 字</div>')
  })

  test('filters projects by status while preserving filtered summary counts', () => {
    const projects: NovelProjectSummary[] = [
      baseProject,
      { ...baseProject, id: 'ready', title: '可写', status: 'ready', wordCountLabel: '2.0万字', wordCountTotal: 20000 },
      { ...baseProject, id: 'setup', title: '设定', status: 'needs-setup', wordCountLabel: '1,000 字', wordCountTotal: 1000 },
    ]
    const filteredProjects = filterLibraryProjects(projects, { status: 'ready', genre: 'all' })

    expect(filteredProjects.map((project) => project.id)).toEqual(['ready'])
    expect(summarizeLibraryProjects(filteredProjects)).toEqual({
      total: 1,
      completed: 0,
      words: 20000,
    })
  })

  test('filters projects by title query, case-insensitively and stacked with other filters', () => {
    const projects: NovelProjectSummary[] = [
      baseProject,
      { ...baseProject, id: 'sea', title: '沧海拾遗', status: 'ready' },
      { ...baseProject, id: 'latin', title: 'Star Trek 同人', status: 'ready' },
    ]

    // 包含匹配 + 忽略大小写 + 首尾空白不影响
    expect(filterLibraryProjects(projects, { status: 'all', genre: 'all', title: ' star ' }).map((p) => p.id)).toEqual([
      'latin',
    ])
    // 空串/未传视为不过滤
    expect(filterLibraryProjects(projects, { status: 'all', genre: 'all', title: '  ' })).toHaveLength(3)
    expect(filterLibraryProjects(projects, { status: 'all', genre: 'all' })).toHaveLength(3)
    // 与状态筛选是「与」关系
    expect(filterLibraryProjects(projects, { status: 'needs-outline', genre: 'all', title: '海' }).map((p) => p.id)).toEqual([
      'stars',
    ])
    expect(filterLibraryProjects(projects, { status: 'all', genre: 'all', title: '不存在的书' })).toHaveLength(0)
  })

  test('derives genre filters from project metadata and keeps legacy projects under 未分类', () => {
    const projects: NovelProjectSummary[] = [
      baseProject,
      { ...baseProject, id: 'fantasy', genre: '仙侠' },
      { ...baseProject, id: 'legacy', genre: '   ' },
    ]

    expect(normalizeLibraryGenre('   ')).toBe('未分类')
    expect(getLibraryGenreFilters(projects)).toEqual(['科幻', '仙侠', '未分类'])
    expect(filterLibraryProjects(projects, { status: 'all', genre: '未分类' }).map((project) => project.id)).toEqual([
      'legacy',
    ])
  })


  test('an invalid project card no longer links into a workbench that must fail (#38)', () => {
    // 书架明知这本书坏了、卡上都标了红，仍旧让作者点进去，然后用一句开发黑话糊他脸上。
    // 入口必须先拦住：进到一个什么都读不出来的工作台对作者零价值。
    const invalid = { ...baseProject, status: 'invalid' as const, problem: '缺少 .narracat/config.yaml 或 .narracat/state.yaml' }
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryProjectCard project={invalid} />
      </MemoryRouter>,
    )

    expect(html).not.toContain('/workbench?project=')
    expect(html).toContain('data-library-invalid-trigger="true"')
    // 原始文件名不糊到作者脸上。
    expect(html).not.toContain('.narracat/config.yaml')
  })


  test('the broken-project notice leads with opening the folder, not with deleting', () => {
    // invalid 多半是误判——文件夹被移动、外置盘没插、config.yaml 被误删而正文还在。
    // 主动作必须是「去看一眼」，不能引导作者先删东西。
    const invalid = { ...baseProject, status: 'invalid' as const }
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dialog open>
        <LibraryInvalidProjectPanel
          canRemove
          project={invalid}
          removing={false}
          onCancel={() => {}}
          onRemove={() => {}}
          onReveal={() => {}}
        />
        </Dialog>
      </MemoryRouter>,
    )

    expect(html).toContain('data-library-invalid-reveal="true"')
    expect(html).toContain('打开所在文件夹')
    expect(html).toContain('data-library-invalid-remove="true"')
    expect(html).not.toContain('.narracat/config.yaml')
  })

  test('hides removal when the project sits inside the novel root, where removing cannot work', () => {
    // root 下的项目摘掉最近路径也没用，下次扫描照样出现。这时改为把删除入口指回「更多」，
    // 而不是给一个点了不生效的按钮。
    const invalid = { ...baseProject, status: 'invalid' as const }
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dialog open>
        <LibraryInvalidProjectPanel
          canRemove={false}
          project={invalid}
          removing={false}
          onCancel={() => {}}
          onRemove={() => {}}
          onReveal={() => {}}
        />
        </Dialog>
      </MemoryRouter>,
    )

    expect(html).not.toContain('data-library-invalid-remove="true"')
    expect(html).toContain('更多')
    expect(html).toContain('data-library-invalid-reveal="true"')
  })

  test('renders project cards in the desktop book-cover layout without redundant open copy', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryProjectCard project={baseProject} />
      </MemoryRouter>,
    )

    expect(html).toContain('星辰大海')
    expect(html).toContain('待大纲')
    expect(html).toContain('data-project-card')
    expect(html).toContain('data-library-card-menu-trigger="true"')
    expect(html).toContain('aria-label="更多"')
    expect(html).toContain('data-library-book-cover')
    expect(html).toContain('data-library-cover-preset="cover-03"')
    expect(html).toContain('data-library-card-content-layer="true"')
    expect(html).toContain('aspect-[2/3]')
    expect(html).toContain('group-hover:-translate-y-0.5 group-hover:rotate-[-1deg] group-hover:scale-[1.025]')
    expect(html).toContain('group-hover:scale-[1.055]')
    expect(html).toContain('grid-cols-[108px_minmax(0,1fr)]')
    expect(html).toContain('w-[108px]')
    expect(html).toContain('rounded-[8px]')
    expect(html).toContain('text-base font-semibold leading-tight text-foreground')
    expect(html).toContain('text-xs font-medium leading-tight text-[#b1b1b1]')
    expect(html).toContain('min-h-[52px]')
    expect(html).toContain('text-sm font-semibold leading-none text-foreground tabular')
    expect(html).toContain('cover-03.webp')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toContain('上次更新')
    expect(html).toContain('3/30章')
    expect(html).toContain('字数')
    expect(html).toContain('1.2万字')
    expect(html).toContain('href="/workbench?project=%2Fnovels%2Fstars"')
    expect(html.split('href="/workbench?project=%2Fnovels%2Fstars"')).toHaveLength(2)
    expect(html).toContain('data-library-card-content-layer="true"')
    expect(html).not.toContain('relative z-10 contents')
    expect(html).not.toContain('line-clamp-3')
    expect(html).not.toContain('继续写')
    expect(html).not.toContain('补齐角色与大纲')
    expect(html).not.toContain('进入写作工作台')
    expect(html).not.toContain('打开工作台')
    expect(html).not.toContain('删除小说')
    expect(html).not.toContain('font-family')
    expect(html).not.toContain('MiSans')
    expect(html).not.toMatch(/bg-blue-\d/)
    expect(html).not.toMatch(/shadow-(sm|md|lg|xl|2xl)/)
  })

  test('wires project deletion as a destructive item in the card menu', () => {
    const source = readFileSync('src/routes/library.tsx', 'utf8')

    expect(source).toContain('data-library-project-delete-menu-item="true"')
    expect(source).toContain('variant="destructive"')
    expect(source).toContain("setDeleteDialogOpen(true)")
  })

  test('opens the metadata dialog with distinct intents for title editing vs cover changing', () => {
    const source = readFileSync('src/routes/library.tsx', 'utf8')

    // 「编辑标题」与「更换封面」不再共用同一个无差别开关
    expect(source).toContain("setMetadataIntent('edit-title')")
    expect(source).toContain("setMetadataIntent('change-cover')")
    expect(source).not.toContain('setDialogOpen(true)')

    const html = renderToStaticMarkup(
      <Dialog open>
        <LibraryProjectMetadataPanel
          formError={null}
          intent="change-cover"
          onCoverPresetChange={() => {}}
          onSubmit={() => {}}
          onTitleChange={() => {}}
          project={baseProject}
          saving={false}
          selectedCoverPreset="cover-03"
          title="星辰大海"
        />
      </Dialog>,
    )

    // 封面区有可定位锚点，「更换封面」打开后滚动/聚焦落在这里
    expect(html).toContain('data-library-cover-section="true"')
  })

  test('merges checkpoint state into the status tag instead of a separate warning row', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryProjectCard
          project={{
            ...baseProject,
            status: 'ready',
            checkpoint: { lastCommand: '/narracat:write', lastStep: 4, timestamp: '2026-05-03T00:00:00.000Z' },
          }}
        />
      </MemoryRouter>,
    )

    expect(html).toContain('可写作 · 未完成')
    expect(html).not.toContain('未完成写作')
    expect(html).not.toContain('lucide-triangle-alert')
  })

  test('marks a fully-written book as 完结 on its card badge', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryProjectCard
          project={{
            ...baseProject,
            status: 'ready',
            chapterProgress: '386 / 386 章',
            // 即便残留断点，完结也是终态，覆盖「未完成」后缀。
            checkpoint: { lastCommand: '/narracat:write', lastStep: 1, timestamp: '2026-05-03T00:00:00.000Z' },
          }}
        />
      </MemoryRouter>,
    )

    expect(html).toContain('完结')
    expect(html).not.toContain('可写作')
    expect(html).not.toContain('未完成')
  })

  test('shows the current automation mode in the card menu and explains why it can be locked (#27)', () => {
    expect(libraryAutomationMenuLabel('auto', false)).toBe('自动化：全自动')
    expect(libraryAutomationMenuLabel('collaborative', false)).toBe('自动化：协作模式')
    expect(libraryAutomationMenuLabel('auto', true)).toBe('Agent 运行中，不能切换模式')
  })

  // 菜单本身渲染在 portal 里，静态渲染的卡片 HTML 抓不到——照删除菜单项的先例读源码锁住。
  test('wires the automation switch as a run-guarded card menu entry that spells out each mode (#27)', () => {
    const source = readFileSync('src/routes/library.tsx', 'utf8')
    const anchor = source.indexOf('data-library-project-automation-menu-item="true"')

    expect(anchor).toBeGreaterThan(-1)

    // 取该属性所在的那个 SubTrigger 元素，不认「文件里第一个 SubTrigger」，免得日后加了别的子菜单就测错块。
    const trigger = source.slice(
      source.lastIndexOf('<DropdownMenuSubTrigger', anchor),
      source.indexOf('</DropdownMenuSubTrigger>', anchor),
    )

    // 与备份/删除同一道闸：Agent 正在跑就不让改档。
    expect(trigger).toContain('disabled={deleteBlocked}')
    // 两档各自的后果说明必须挂进选项，不能只给光秃秃的单选项让作者盲选。
    expect(source).toContain('{LIBRARY_AUTOMATION_LEVEL_HELP.auto}')
    expect(source).toContain('{LIBRARY_AUTOMATION_LEVEL_HELP.collaborative}')
  })

  test('requires the visible title before deleting a project', () => {
    expect(isLibraryProjectDeleteConfirmationValid('星辰大海', ' 星辰大海 ')).toBe(true)
    expect(isLibraryProjectDeleteConfirmationValid('星辰大海', '星辰')).toBe(false)

    const html = renderToStaticMarkup(
      <Dialog open>
        <LibraryProjectDeletePanel
          confirmationTitle="星辰"
          deleteBlocked={false}
          deleting={false}
          formError={null}
          onCancel={() => {}}
          onConfirmationTitleChange={() => {}}
          onSubmit={() => {}}
          project={baseProject}
        />
      </Dialog>,
    )

    expect(html).toContain('data-library-project-delete-panel="true"')
    expect(html).toContain('删除小说')
    expect(html).toContain('移到系统废纸篓')
    expect(html).toContain('data-library-project-delete-confirmation="true"')
    expect(html).toContain('value="星辰"')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('disabled=""')
  })

  test('renders a restrained metadata edit panel with title and built-in cover choices only', () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <LibraryProjectMetadataPanel
          formError={null}
          onCoverPresetChange={() => {}}
          onSubmit={() => {}}
          onTitleChange={() => {}}
          project={baseProject}
          saving={false}
          selectedCoverPreset="cover-08"
          title="新的书名"
        />
      </Dialog>,
    )

    expect(html).toContain('data-library-project-metadata-panel="true"')
    expect(html).toContain('编辑小说信息')
    expect(html).toContain('value="新的书名"')
    expect(html).toContain('data-library-cover-option="cover-08"')
    expect(html).toContain('data-library-cover-selected="true"')
    expect(html).toContain('data-library-cover-selected-indicator="true"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('lucide-check')
    expect(html).toContain('group/cover rounded-row bg-transparent text-left')
    expect(html).toContain('bg-brand text-white ring-2 ring-surface')
    expect(html).toContain('size-3.5 text-white')
    expect(html).toContain('stroke-width="3"')
    expect(html).toContain('group-hover/cover:-translate-y-0.5 group-hover/cover:rotate-[-1deg] group-hover/cover:scale-[1.025]')
    expect(html).toContain('group-hover/cover:scale-[1.055]')
    expect(html).toContain('保存修改')
    expect(html).not.toContain('border-foreground bg-active shadow-[0_8px_20px_rgba(24,24,27,0.12)]')
    expect(html).not.toContain('border-brand ring-[3px] ring-brand-border')
    expect(html).not.toContain('rounded-card border bg-surface p-1.5')
    expect(html).not.toContain('hover:border-border-strong hover:bg-hover')
    expect(html).not.toContain('data-library-project-metadata-close')
    expect(html).not.toContain('aria-label="关闭弹窗"')
    expect(html).not.toContain('删除')
    expect(html).not.toContain('上传')
    expect(html).not.toContain('重命名目录')
  })

  test('keeps the metadata dialog bounded to the viewport with only the cover list scrolling', () => {
    const html = renderToStaticMarkup(
      <Dialog open>
        <LibraryProjectMetadataPanel
          formError={null}
          onCoverPresetChange={() => {}}
          onSubmit={() => {}}
          onTitleChange={() => {}}
          project={baseProject}
          saving={false}
          selectedCoverPreset="cover-08"
          title="新的书名"
        />
      </Dialog>,
    )

    expect(LIBRARY_PROJECT_METADATA_DIALOG_CONTENT_CLASS).toContain('max-h-[calc(100dvh-2rem)]')
    expect(html).toContain('grid-rows-[auto_minmax(0,1fr)_auto]')
    expect(html).toContain('data-library-project-metadata-scroll="true"')
    expect(html).toContain('min-h-0 overflow-y-auto')
    expect(html).toContain('data-library-project-metadata-footer="true"')
  })

  test('renders sorted book cards and keeps invalid projects visible', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LibraryProjectGrid
          projects={[
            { ...baseProject, id: 'invalid', title: '检查', status: 'invalid', problem: '缺少 config.yaml' },
            { ...baseProject, id: 'ready', title: '可写', status: 'ready' },
            {
              ...baseProject,
              id: 'checkpoint',
              title: '断点',
              status: 'ready',
              checkpoint: { lastCommand: '/narracat:write', lastStep: 4, timestamp: '2026-05-03T00:00:00.000Z' },
            },
          ]}
        />
      </MemoryRouter>,
    )

    // #38：invalid 仍然可见且仍排在最后，但卡上不再露 `缺少 config.yaml` 这类文件名，
    // 只留一句人话；缺什么、能怎么办放进点击后的说明浮层。
    expect(html).not.toContain('缺少 config.yaml')
    expect(html).toContain('项目文件不完整')
    expect(html.match(/loading="eager"/g) ?? []).toHaveLength(3)
    expect(html).not.toContain('loading="lazy"')
    expect(html.indexOf('断点')).toBeLessThan(html.indexOf('可写'))
    expect(html.indexOf('可写')).toBeLessThan(html.indexOf('检查'))
  })

  test('sorts projects by action priority before update time', () => {
    const projects: NovelProjectSummary[] = [
      { ...baseProject, id: 'invalid', title: '检查', status: 'invalid', updatedAt: '2026-05-05T00:00:00.000Z' },
      { ...baseProject, id: 'setup', title: '设定', status: 'needs-setup', updatedAt: '2026-05-06T00:00:00.000Z' },
      { ...baseProject, id: 'ready', title: '可写', status: 'ready', updatedAt: '2026-05-01T00:00:00.000Z' },
      { ...baseProject, id: 'outline', title: '大纲', status: 'needs-outline', updatedAt: '2026-05-07T00:00:00.000Z' },
      { ...baseProject, id: 'active', title: '写作中', status: 'in-progress', updatedAt: '2026-05-02T00:00:00.000Z' },
      {
        ...baseProject,
        id: 'checkpoint',
        title: '断点',
        status: 'ready',
        updatedAt: '2026-05-03T00:00:00.000Z',
        checkpoint: { lastCommand: '/narracat:write', lastStep: 4, timestamp: '2026-05-03T00:00:00.000Z' },
      },
    ]

    expect(sortLibraryProjects(projects).map((project) => project.id)).toEqual([
      'checkpoint',
      'active',
      'ready',
      'outline',
      'setup',
      'invalid',
    ])
  })

  test('preserves action-first sorting inside filtered results', () => {
    const projects: NovelProjectSummary[] = [
      { ...baseProject, id: 'ready-old', title: '旧可写', status: 'ready', updatedAt: '2026-05-01T00:00:00.000Z' },
      { ...baseProject, id: 'active', title: '写作中', status: 'in-progress', updatedAt: '2026-05-02T00:00:00.000Z' },
      {
        ...baseProject,
        id: 'checkpoint',
        title: '断点',
        status: 'ready',
        updatedAt: '2026-05-03T00:00:00.000Z',
        checkpoint: { lastCommand: '/narracat:write', lastStep: 4, timestamp: '2026-05-03T00:00:00.000Z' },
      },
      { ...baseProject, id: 'other-genre', title: '仙侠', genre: '仙侠', status: 'in-progress' },
    ]

    const filteredProjects = filterLibraryProjects(projects, { status: 'all', genre: '科幻' })

    expect(sortLibraryProjects(filteredProjects).map((project) => project.id)).toEqual([
      'checkpoint',
      'active',
      'ready-old',
    ])
  })

  test('renders compact status and genre dropdown controls instead of flat chips', () => {
    const html = renderToStaticMarkup(
      <LibraryFilterBar
        projects={[baseProject, { ...baseProject, id: 'legacy', genre: '' }]}
        filteredCount={1}
        statusFilter="in-progress"
        genreFilter="未分类"
        titleQuery=""
        onStatusFilterChange={() => {}}
        onGenreFilterChange={() => {}}
        onTitleQueryChange={() => {}}
      />,
    )

    expect(html).toContain('data-library-filter-bar="true"')
    expect(html).toContain('data-library-works-heading="true"')
    expect(html).toContain('我的作品')
    expect(html).toContain('data-library-title-search="true"')
    expect(html).toContain('placeholder="搜索书名"')
    expect(html).toContain('data-library-status-select="true"')
    expect(html).toContain('data-library-genre-select="true"')
    expect(html).toContain('写作中')
    expect(html).toContain('全部题材')
    expect(html).toContain('未分类')
    expect(html).not.toContain('data-library-status-filter="in-progress"')
    expect(html).not.toContain('data-library-genre-filter="未分类"')
  })

  test('renders the desktop home hero without the old prose header', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <LibraryRoute />
        </MemoryRouter>
      </TooltipProvider>,
    )

    expect(html).toContain('data-library-home-hero="true"')
    expect(html).toContain('agents.webp')
    expect(html).toContain('作品数')
    expect(html).toContain('已完结')
    expect(html).toContain('字数')
    expect(html).not.toContain('data-library-summary-line="true"')
    expect(html).not.toContain('我的小说')
    expect(html).not.toContain('NarraCat 0.')
    expect(html).not.toContain('小说库</div><h1')
    expect(html).not.toContain('部可写')
    expect(html).not.toContain('待处理')
  })

  test('renders restrained empty state for filters without looking like an empty library', () => {
    const html = renderToStaticMarkup(<LibraryFilteredEmptyState onReset={() => {}} />)

    expect(html).toContain('data-library-filtered-empty-state="true"')
    expect(html).toContain('没有符合筛选的小说')
    expect(html).toContain('清除筛选')
    // 筛选空态使用 compact 角色，与主空态的 primary 角色区分
    expect(html).toContain(EMPTY_COMPACT_TITLE_CLASS)
    expect(html).not.toContain(EMPTY_PRIMARY_TITLE_CLASS)
    expect(html).not.toContain('data-library-empty-illustration-frame')
    expect(html).not.toContain('还没有 NarraCat 项目')
    expect(html).not.toContain('新建小说')
  })

  test('resolves cover preset assets from the production registry', () => {
    expect(getLibraryCoverPreset('cover-03')).toMatchObject({
      id: 'cover-03',
      label: '内置书皮 03',
    })
    expect(getLibraryCoverPreset('cover-03').src).toContain('cover-03.webp')
    expect(getLibraryCoverPreset('missing').id).toBe('cover-01')
  })
})
