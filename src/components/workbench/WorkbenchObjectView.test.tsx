import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ObjectArtifactDocument, WorkbenchObjectView } from './WorkbenchObjectView'
import type { WorkbenchAction } from '@/lib/workbench-actions'
import type { WorkbenchTabItem } from '@/lib/workbench-navigation'
import type { NovelWorkbenchArtifacts, NovelWorkbenchTreeItem } from '@shared/types/novel'

const blueprintTabs: WorkbenchTabItem[] = [
  {
    id: 'master-outline',
    title: '全局大纲',
    objectId: 'master-outline',
    exists: true,
    emptyTitle: '全局大纲尚未生成',
    emptyDescription: '全局大纲缺失。',
    emptyAction: { label: '生成全局大纲', prompt: '请生成全局大纲。' },
  },
]

const settingsTabs: WorkbenchTabItem[] = [
  {
    id: 'foundation',
    title: '创作根基',
    objectId: 'foundation',
    exists: true,
    emptyTitle: '创作根基尚未生成',
    emptyDescription: '创作根基缺失。',
    emptyAction: { label: '生成创作根基', prompt: '请生成创作根基。' },
  },
  {
    id: 'bible-scenes',
    title: '场景设定',
    objectId: 'bible-scenes',
    exists: false,
    emptyTitle: '场景设定尚未生成',
    emptyDescription: '场景设定缺失。',
    emptyAction: { label: '生成场景设定', prompt: '请生成场景设定。' },
  },
]

const generateFoundationAction: WorkbenchAction = {
  id: 'generate-empty-foundation',
  kind: 'agent',
  label: '生成创作根基',
  description: '创作根基缺失。',
  enabled: true,
  command: 'setup',
}

const masterOutlineWithNarratorVoice = [
  '# 全书大纲',
  '',
  '## 叙述者腔调（required，双路产出）',
  '- **archetype**: 猛文热血',
  '- **dimensions**:',
  '  - pacing: 急',
  '  - ornamentation: mid',
  '  - digression: 谨慎',
  '  - address: 限知',
  '  - tone: 冷硬但有爆发力',
  '  - style_keywords: [压迫感, 爽点放写]',
  '- **reference_inspiration**: [无参考作品，按题材推演]',
  '',
  '## 主要叙事弧线',
  '主线。',
].join('\n')

function renderWorkbenchObjectView(props: Parameters<typeof WorkbenchObjectView>[0]): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>
        <WorkbenchObjectView {...props} />
      </MemoryRouter>
    </TooltipProvider>,
  )
}

function textFromDataRegion(html: string, attribute: string): string {
  const match = html.match(new RegExp(`<[^>]+${attribute}[^>]*>(.*?)</[^>]+>`))
  return match?.[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim() ?? ''
}

function tabLinkClass(html: string, tabId: string): string {
  return html.match(new RegExp(`<a[^>]+class="([^"]+)"[^>]+section=settings&amp;tab=${tabId}`))?.[1] ?? ''
}

function classFromDataRegion(html: string, attribute: string): string {
  return html.match(new RegExp(`<[^>]+class="([^"]+)"[^>]+${attribute}`))?.[1] ?? ''
}

describe('WorkbenchObjectView', () => {
  test('renders markdown for non-chapter objects as a read-only browser surface without chapter tabs', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [
        {
          id: 'master-outline',
          kind: 'markdown',
          title: '全书大纲',
          exists: true,
          content: '# 全书大纲\n\n- 主线\n\n| 检查项 | 状态 |\n|---|---|\n| 根基 | 已完成 |',
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '创作蓝图',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('data-workbench-titlebar="true"')
    expect(html).toContain('data-workbench-tabbar="true"')
    expect(textFromDataRegion(html, 'data-workbench-titlebar="true"')).toBe('创作蓝图')
    expect(html).toContain('data-reading-canvas="true"')
    expect(html).toContain('data-reading-metadata="true"')
    expect(html).toContain('文件信息')
    expect(html).toContain('生成状态')
    expect(html).toContain('data-markdown-viewer="true"')
    expect(html).toContain('<h1')
    expect(html).toContain('<li')
    expect(html).toContain('<table')
    expect(html).toContain('全书大纲')
    expect(html).toContain('主线')
    expect(html).not.toContain('<textarea')
    expect(html).not.toContain('contenteditable')
    expect(html).not.toContain('NarraCat 项目对象')
    expect(html).not.toContain('NarraCat 文件')
    expect(html).not.toContain('源文件')
    expect(html).not.toContain('text-xs text-hint-foreground">状态</div>')
    expect(html).not.toContain('grid grid-cols-2')
    expect(html).not.toContain('rounded-panel border border-border bg-surface')
    expect(html).not.toContain('data-chapter-view-tabs="true"')
    expect(html).not.toContain('正文')
    expect(html).not.toContain('上下文')
  })

  test('shows a pure icon copy action only when the visible document has copyable content', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [
        {
          id: 'master-outline',
          kind: 'markdown',
          title: '全书大纲',
          exists: true,
          content: '# 全书大纲\n\n- 主线',
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '创作蓝图',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('data-workbench-titlebar-copy-action="copy-visible-document"')
    expect(html).toContain('data-workbench-titlebar-action="copy-visible-document"')
    expect(html).toContain('aria-label="复制当前文档"')
    expect(html).toContain('data-action-icon="copy"')

    const emptyHtml = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '创作蓝图',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem: { ...selectedItem, exists: false },
      artifacts: null,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(emptyHtml).not.toContain('data-workbench-titlebar-copy-action="copy-visible-document"')
  })

  test('does not surface the narrator voice summary on the master outline', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [
        {
          id: 'master-outline',
          kind: 'markdown',
          title: '全书大纲',
          exists: true,
          content: masterOutlineWithNarratorVoice,
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    // 叙事声音摘要不再出现在全局大纲页（只在「叙事声音」页展示）；大纲正文仍正常渲染。
    expect(html).not.toContain('data-narrator-voice-summary="true"')
    expect(html).not.toContain('叙事声音 / 写作风格')
    expect(html).toContain('主要叙事弧线')
  })

  test('renders the settings narrator voice projection from the master outline section', () => {
    const narratorTab: WorkbenchTabItem = {
      id: 'narrator-voice',
      title: '叙事声音',
      objectId: 'narrator-voice',
      exists: true,
      emptyTitle: '叙事声音尚未确定',
      emptyDescription: '全局大纲尚未写入叙事声音。',
      emptyAction: { label: '规划全局大纲', prompt: '请规划全局大纲。' },
    }
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'narrator-voice',
      kind: 'narrator-voice',
      title: '叙事声音',
      level: 1,
      parentId: 'foundation',
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'narrator-voice',
      objectKind: 'narrator-voice',
      title: '叙事声音',
      artifacts: [
        {
          id: 'narrator-voice',
          kind: 'markdown',
          title: '叙事声音 / 写作风格',
          exists: true,
          content: masterOutlineWithNarratorVoice.split('## 主要叙事弧线')[0]?.trim(),
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '设定集',
      projectPath: '/novels/stars',
      tabs: [...settingsTabs, narratorTab],
      activeTab: narratorTab,
      activeTabId: 'narrator-voice',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('data-narrator-voice-summary="true"')
    expect(html).toContain('来自全局大纲')
    expect(html).toContain('压迫感, 爽点放写')
    expect(html).not.toContain('主要叙事弧线')
  })

  test('hides the copy action while the current document target is generating', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-1',
      kind: 'chapter',
      title: '第 001 章 · 铃声',
      level: 1,
      chapterNumber: 1,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-1',
      selectedItem,
      artifacts: {
        projectPath: '/novels/stars',
        objectId: 'chapter-1',
        objectKind: 'chapter',
        title: '第 001 章 · 铃声',
        artifacts: [{ id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' }],
      },
      chapterView: 'text',
      generationState: {
        label: '章节正文',
        statusText: '正在生成正文',
      },
      onChapterViewChange: () => {},
    })

    expect(html).toContain('正在生成正文')
    expect(html).not.toContain('data-workbench-titlebar-copy-action="copy-visible-document"')
  })

  test('renders tab links from the workbench section tab model', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[1],
      activeTabId: 'bible-scenes',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      onChapterViewChange: () => {},
      titlebarActions: [
        {
          id: 'refresh-project',
          kind: 'client',
          label: '刷新',
          description: '重新读取项目文件',
          enabled: true,
        },
        {
          id: 'world-foundation',
          kind: 'agent',
          label: '补齐角色/世界观',
          description: '创建或调整角色与世界观设定',
          enabled: true,
          command: 'world',
        },
      ],
      onTitlebarAction: () => {},
    })

    expect(html).toContain('data-workbench-titlebar="true"')
    expect(html).toContain('data-workbench-titlebar-action="refresh-project"')
    expect(html).toContain('data-workbench-titlebar-action="world-foundation"')
    expect(html).toContain('aria-label="刷新"')
    expect(html).toContain('aria-label="补齐角色/世界观"')
    expect(html).toContain('data-icon-tooltip="补齐角色/世界观"')
    expect(html).not.toContain('title="创建或调整角色与世界观设定"')
    expect(html).toContain('data-action-icon="world"')
    expect(html).toContain('data-workbench-tabbar="true"')
    expect(textFromDataRegion(html, 'data-workbench-titlebar="true"')).toBe('小说设定')
    expect(html).toContain('创作根基')
    expect(html).toContain('场景设定')
    expect(html).toContain('aria-label="场景设定，未生成"')
    expect(html).toContain('section=settings&amp;tab=bible-scenes')
    expect(tabLinkClass(html, 'bible-scenes')).toContain('h-7')
    expect(tabLinkClass(html, 'bible-scenes')).toContain('px-2.5')
    expect(tabLinkClass(html, 'bible-scenes')).toContain('text-xs')
    expect(tabLinkClass(html, 'bible-scenes')).not.toContain('h-8')
    expect(tabLinkClass(html, 'bible-scenes')).not.toContain('px-3')
    expect(tabLinkClass(html, 'bible-scenes')).not.toContain('text-sm')
    expect(html).not.toContain('NarraCat 项目对象')
  })

  test('renders reference works with the custom management module', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'references',
      kind: 'reference-list',
      title: '参考作品',
      level: 0,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'reference-works',
      sectionTitle: '参考作品',
      projectPath: '/novels/stars',
      tabs: [
        {
          id: 'references',
          title: '参考作品',
          objectId: 'references',
          exists: true,
          emptyTitle: '还没有参考作品',
          emptyDescription: '参考作品是可选输入。',
          emptyAction: { label: '粘贴片段', prompt: '添加参考作品。' },
        },
      ],
      activeTab: null,
      activeTabId: 'references',
      selectedItem,
      artifacts: {
        projectPath: '/novels/stars',
        objectId: 'references',
        objectKind: 'reference-list',
        title: '参考作品',
        artifacts: [],
        referenceWorksSummary: {
          sources: [],
          status: {
            guidanceState: 'empty',
            sourceCount: 0,
            needsAnalysis: false,
            stale: false,
            guidanceExists: false,
          },
        },
      },
      chapterView: 'text',
      onChapterViewChange: () => {},
      onReferenceChanged: () => {},
    })

    expect(html).toContain('data-reference-works-view="true"')
    expect(html).toContain('还没有参考作品')
    expect(html).toContain('粘贴一个片段')
    expect(html).toContain('导入文本')
    expect(html).not.toContain('让 NarraCat 生成风格')
    expect(html).not.toContain('data-workbench-tabbar="true"')
    expect(textFromDataRegion(html, 'data-workbench-titlebar="true"')).toContain('参考作品')
    expect(html).not.toContain('文件尚未生成')
  })

  test('renders reference works generation as a loading state without page actions', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'references',
      kind: 'reference-list',
      title: '参考作品',
      level: 0,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'reference-works',
      sectionTitle: '参考作品',
      projectPath: '/novels/stars',
      tabs: [
        {
          id: 'references',
          title: '参考作品',
          objectId: 'references',
          exists: true,
          emptyTitle: '还没有参考作品',
          emptyDescription: '参考作品是可选输入。',
          emptyAction: { label: '粘贴片段', prompt: '添加参考作品。' },
        },
      ],
      activeTab: null,
      activeTabId: 'references',
      selectedItem,
      artifacts: {
        projectPath: '/novels/stars',
        objectId: 'references',
        objectKind: 'reference-list',
        title: '参考作品',
        artifacts: [],
        referenceWorksSummary: {
          sources: [
            {
              id: 'reference-a.md',
              fileName: 'a.md',
              title: '参考 A',
              relativePath: 'bible/references/a.md',
              path: '/novels/stars/bible/references/a.md',
              extension: '.md',
              size: 12,
              wordCount: 6,
              updatedAt: '2026-05-20T00:00:00.000Z',
            },
          ],
          status: {
            guidanceState: 'needs-analysis',
            sourceCount: 1,
            needsAnalysis: true,
            stale: false,
            guidanceExists: false,
          },
        },
      },
      chapterView: 'text',
      onChapterViewChange: () => {},
      generationState: {
        label: '参考作品',
        statusText: '正在生成参考作品',
      },
    })

    expect(html).toContain('data-workbench-generation-empty="true"')
    expect(html).toContain('正在生成参考作品')
    expect(html).toContain('完成后会自动刷新当前页面。')
    expect(html).not.toContain('分析参考作品')
    expect(html).not.toContain('删除')
    expect(html).not.toContain('data-reference-works-actions="pending"')
  })

  test('renders titlebar actions as primary, refresh, and more slots', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'completed',
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts: {
        projectPath: '/novels/stars',
        objectId: 'chapter-2',
        objectKind: 'chapter',
        title: '第 002 章 · 远行',
        artifacts: [{ id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' }],
      },
      chapterView: 'text',
      titlebarActions: [
        {
          id: 'adjust-chapter-manuscript',
          kind: 'composer-handoff',
          label: '调整内容',
          description: '调整当前章节正文',
          enabled: true,
          command: 'rewrite',
          placement: 'primary',
        },
        {
          id: 'refresh-project',
          kind: 'client',
          label: '刷新',
          description: '重新读取项目文件',
          enabled: true,
          placement: 'refresh',
        },
        {
          id: 'review-chapter-again',
          kind: 'composer-handoff',
          label: '重新审修',
          description: '重新审修当前章节',
          enabled: true,
          command: 'review',
          placement: 'more',
        },
      ],
      onChapterViewChange: () => {},
      onTitlebarAction: () => {},
    })

    expect(html).toContain('data-workbench-titlebar-primary-action="adjust-chapter-manuscript"')
    expect(html).toContain('调整内容')
    expect(html).toContain('data-workbench-titlebar-refresh-action="refresh-project"')
    expect(html).toContain('aria-label="刷新"')
    expect(html).toContain('data-workbench-titlebar-more-trigger="true"')
    expect(html).toContain('aria-label="更多操作"')
    expect(html).not.toContain('data-workbench-titlebar-action="review-chapter-again"')
  })

  test('lets the content titlebar drag the frameless window while keeping title actions clickable', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      titlebarActions: [
        {
          id: 'refresh-project',
          kind: 'client',
          label: '刷新',
          description: '重新读取项目文件',
          enabled: true,
          placement: 'refresh',
        },
      ],
      onChapterViewChange: () => {},
      onTitlebarAction: () => {},
    })

    expect(classFromDataRegion(html, 'data-workbench-titlebar="true"')).toContain('[-webkit-app-region:drag]')
    expect(classFromDataRegion(html, 'data-workbench-titlebar-actions="true"')).toContain(
      '[-webkit-app-region:no-drag]',
    )
    expect(html).toContain('data-workbench-titlebar-refresh-action="refresh-project"')
  })

  test('keeps the more menu tooltip controlled while the dropdown opens and closes', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchObjectHeader.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('moreMenuOpen')
    expect(source).toContain('moreTooltipOpen')
    expect(source).toContain('suppressMoreTooltip')
    expect(source).toContain('open={moreMenuOpen}')
    expect(source).toContain('onOpenChange={handleMoreMenuOpenChange}')
    expect(source).toContain('open={moreTooltipOpen}')
    expect(source).toContain('onOpenChange={handleMoreTooltipOpenChange}')
    expect(source).toContain('setMoreTooltipOpen(true)')
    expect(source).toContain('onPointerEnter={handleMoreTriggerPointerEnter}')
    expect(source).toContain('onPointerLeave={handleMoreTriggerPointerLeave}')
    expect(source).toContain('onPointerDown={handleMoreTriggerPointerDown}')
    expect(source).toContain('onBlur={handleMoreTriggerBlur}')
  })

  test('copies the visible document through the Clipboard API with toast feedback', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchObjectView.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('navigator.clipboard?.writeText')
    expect(source).toContain("toast.success('已复制当前文档')")
    expect(source).toContain("toast.error('复制失败')")
    expect(source).toContain('COPY_VISIBLE_DOCUMENT_ACTION')
    expect(source).toContain('resolveVisibleWorkbenchCopyDocument')
  })

  test('renders the first existing artifact for non-chapter objects', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '基础设定',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'foundation',
      objectKind: 'foundation',
      title: '基础设定',
      artifacts: [
        {
          id: 'missing-foundation',
          kind: 'markdown',
          title: '缺失设定',
          exists: false,
          content: '不应显示',
          path: '/novels/stars/foundation/missing.md',
        },
        {
          id: 'foundation',
          kind: 'markdown',
          title: '基础设定',
          exists: true,
          content: '第一份已生成设定',
          path: '/novels/stars/foundation/foundation.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('第一份已生成设定')
    expect(html).not.toContain('文件尚未生成')
    expect(html).not.toContain('不应显示')
    expect(html).not.toContain('data-workbench-subcontent-directory="true"')
  })

  test('renders multiple non-chapter artifacts as switchable subcontent', () => {
    const tabs: WorkbenchTabItem[] = [
      ...settingsTabs,
      {
        id: 'characters',
        title: '小说角色',
        objectId: 'characters',
        exists: true,
        emptyTitle: '小说角色尚未生成',
        emptyDescription: '角色档案缺失。',
        emptyAction: { label: '生成小说角色', prompt: '请生成小说角色。' },
      },
    ]
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'characters',
      kind: 'character-list',
      title: '小说角色',
      level: 1,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'characters',
      objectKind: 'character-list',
      title: '小说角色',
      artifacts: [
        {
          id: 'character-林舟',
          kind: 'markdown',
          title: '林舟',
          exists: true,
          content: '# 林舟\n\n林舟正文。',
          path: '/novels/stars/bible/characters/林舟.md',
        },
        {
          id: 'character-沈雁',
          kind: 'markdown',
          title: '沈雁',
          exists: true,
          content: '# 沈雁\n\n沈雁正文。',
          path: '/novels/stars/bible/characters/沈雁.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs,
      activeTab: tabs[2],
      activeTabId: 'characters',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('data-workbench-subcontent-browser="true"')
    expect(html).toContain('data-workbench-subcontent-directory="true"')
    expect(html).toContain('data-workbench-subcontent-panel="true"')
    expect(html).toContain('data-workbench-object-scroll-frame="subcontent"')
    expect(html).toContain('data-workbench-object-body-frame="subcontent"')
    expect(html).toContain('data-workbench-subcontent-panel-inner="true"')
    expect(classFromDataRegion(html, 'data-workbench-object-scroll-frame="subcontent"')).toContain('overflow-hidden')
    expect(classFromDataRegion(html, 'data-workbench-object-scroll-frame="subcontent"')).not.toContain('overflow-auto')
    expect(classFromDataRegion(html, 'data-workbench-object-body-frame="subcontent"')).not.toContain('p-6')
    expect(classFromDataRegion(html, 'data-workbench-subcontent-panel="true"')).toContain('overflow-auto')
    expect(classFromDataRegion(html, 'data-workbench-subcontent-panel="true"')).not.toContain('pr-1')
    expect(classFromDataRegion(html, 'data-workbench-subcontent-panel-inner="true"')).toContain('p-6')
    expect(classFromDataRegion(html, 'data-workbench-subcontent-browser="true"')).toContain('w-full')
    expect(classFromDataRegion(html, 'data-workbench-subcontent-browser="true"')).not.toContain('mx-auto')
    expect(classFromDataRegion(html, 'data-workbench-subcontent-browser="true"')).not.toContain('max-w-[1040px]')
    expect(html).toContain('data-workbench-subcontent-option="character-林舟"')
    expect(html).toContain('data-workbench-subcontent-option="character-沈雁"')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('overflow-hidden')
    expect(html).toContain('overflow-auto')
    expect(html).not.toContain('shadow-[inset_2px_0_0_var(--color-foreground)]')
    expect(html).toContain('林舟正文')
    expect(html).not.toContain('沈雁正文')
  })

  test('角色档案分支挂载状态面板容器且 SSR 下不渲染面板内容', () => {
    const tabs: WorkbenchTabItem[] = [
      ...settingsTabs,
      {
        id: 'characters',
        title: '小说角色',
        objectId: 'characters',
        exists: true,
        emptyTitle: '小说角色尚未生成',
        emptyDescription: '角色档案缺失。',
        emptyAction: { label: '生成小说角色', prompt: '请生成小说角色。' },
      },
    ]
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'characters',
      kind: 'character-list',
      title: '小说角色',
      level: 1,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'characters',
      objectKind: 'character-list',
      title: '小说角色',
      artifacts: [
        {
          id: 'character-林舟',
          kind: 'markdown',
          title: '林舟',
          exists: true,
          content: '# 林舟\n\n林舟正文。',
          path: '/novels/stars/bible/characters/林舟.md',
          characterUid: '11111111-1111-4111-8111-111111111111',
          characterName: '林舟',
        },
        {
          id: 'character-沈雁',
          kind: 'markdown',
          title: '沈雁',
          exists: true,
          content: '# 沈雁\n\n沈雁正文。',
          path: '/novels/stars/bible/characters/沈雁.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs,
      activeTab: tabs[2],
      activeTabId: 'characters',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('character-林舟')
    expect(html).not.toContain('data-character-state-panel')
  })

  test('renders world and dynamic settings groups as switchable flat subcontent', () => {
    const scenarios: Array<{
      activeTab: WorkbenchTabItem
      artifacts: NovelWorkbenchArtifacts
      optionIds: string[]
      selectedContent: string
      hiddenContent: string
      selectedItem: NovelWorkbenchTreeItem
    }> = [
      {
        activeTab: {
          id: 'world',
          title: '世界观',
          objectId: 'world',
          exists: true,
          emptyTitle: '世界观尚未生成',
          emptyDescription: '世界观缺失。',
          emptyAction: { label: '生成世界观', prompt: '请生成世界观。' },
        },
        selectedItem: {
          id: 'world',
          kind: 'world-list',
          title: '世界观',
          level: 1,
          exists: true,
        },
        artifacts: {
          projectPath: '/novels/stars',
          objectId: 'world',
          objectKind: 'world-list',
          title: '世界观',
          artifacts: [
            {
              id: 'world-边城',
              kind: 'markdown',
              title: '边城',
              exists: true,
              content: '# 边城\n\n边城正文。',
              path: '/novels/stars/bible/world/边城.md',
            },
            {
              id: 'world-学院',
              kind: 'markdown',
              title: '学院',
              exists: true,
              content: '# 学院\n\n学院正文。',
              path: '/novels/stars/bible/world/学院.md',
            },
          ],
        },
        optionIds: ['world-边城', 'world-学院'],
        selectedContent: '边城正文',
        hiddenContent: '学院正文',
      },
      {
        activeTab: {
          id: 'bible-rules',
          title: '规则设定',
          objectId: 'bible-rules',
          exists: true,
          emptyTitle: '规则设定尚未生成',
          emptyDescription: '规则设定缺失。',
          emptyAction: { label: '生成规则设定', prompt: '请生成规则设定。' },
        },
        selectedItem: {
          id: 'bible-rules',
          kind: 'bible-group',
          title: '规则设定',
          level: 1,
          exists: true,
        },
        artifacts: {
          projectPath: '/novels/stars',
          objectId: 'bible-rules',
          objectKind: 'bible-group',
          title: '规则设定',
          artifacts: [
            {
              id: 'bible-rules-limits.md',
              kind: 'markdown',
              title: 'limits',
              exists: true,
              content: '# Limits\n\n规则正文。',
              path: '/novels/stars/bible/rules/limits.md',
            },
            {
              id: 'bible-rules-notes.txt',
              kind: 'markdown',
              title: 'notes',
              exists: true,
              content: '规则备注。',
              path: '/novels/stars/bible/rules/notes.txt',
            },
          ],
        },
        optionIds: ['bible-rules-limits.md', 'bible-rules-notes.txt'],
        selectedContent: '规则正文',
        hiddenContent: '规则备注',
      },
    ]

    for (const scenario of scenarios) {
      const tabs = [...settingsTabs, scenario.activeTab]
      const html = renderWorkbenchObjectView({
        sectionId: 'settings',
        sectionTitle: '小说设定',
        projectPath: '/novels/stars',
        tabs,
        activeTab: scenario.activeTab,
        activeTabId: scenario.activeTab.id,
        selectedItem: scenario.selectedItem,
        artifacts: scenario.artifacts,
        chapterView: 'text',
        onChapterViewChange: () => {},
      })

      expect(html).toContain('data-workbench-subcontent-browser="true"')
      expect(html).toContain('data-workbench-subcontent-directory="true"')
      for (const optionId of scenario.optionIds) {
        expect(html).toContain(`data-workbench-subcontent-option="${optionId}"`)
      }
      expect(html).toContain(scenario.selectedContent)
      expect(html).not.toContain(scenario.hiddenContent)
    }
  })

  test('resets the content panel scroll position when switching subcontent', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchObjectView.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('data-workbench-subcontent-panel="true"')
    expect(source).toContain('panelRef.current?.scrollTo({ top: 0')
    expect(source).toContain('selectedArtifactKey')
  })

  test('resets the standard content scroll position when switching workbench objects or chapter tabs', () => {
    const source = readFileSync(fileURLToPath(new URL('./WorkbenchObjectView.tsx', import.meta.url)), 'utf-8')

    expect(source).toContain('scrollFrameRef.current?.scrollTo({ top: 0')
    expect(source).toContain('selectedObjectKey')
    expect(source).toContain('[chapterView, hasSubcontentBrowser, selectedObjectKey]')
  })

  test('renders chapter objects with the shared titlebar and tabbar structure', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'planned',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
        { id: 'context-pack', kind: 'context-pack', title: '上下文包', exists: false },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'outline',
      onChapterViewChange: () => {},
    })

    expect(textFromDataRegion(html, 'data-workbench-titlebar="true"')).toBe('第002章·远行')
    expect(html).toContain('data-workbench-tabbar="true"')
    expect(html).toContain('aria-label="第 002 章 · 远行文档"')
    expect(html).toContain('正文')
    expect(html).toContain('章节大纲')
    expect(html).not.toContain('data-workbench-chapter-tab="context"')
    expect(html).not.toContain('上下文')
    expect(html).toContain('审修')
    expect(html).toContain('大纲')
    expect(html).toContain('data-workbench-chapter-tab="outline"')
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('data-chapter-view-tabs="true"')
    expect(html).not.toContain('role="group"')
    expect(html).toContain('focus-visible:ring-2')
  })

  test('falls back to the manuscript view when a legacy context chapter view is selected', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-1',
      kind: 'chapter',
      title: '第 001 章 · 铃声',
      level: 1,
      chapterNumber: 1,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-1',
      objectKind: 'chapter',
      title: '第 001 章 · 铃声',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲内容' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '# 正文标题\n\n第一章正文内容' },
        { id: 'context-pack', kind: 'context-pack', title: '上下文包', exists: true, data: { target_chapter: 1 } },
        { id: 'review', kind: 'review', title: '审修报告', exists: true, content: '审修内容' },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-1',
      selectedItem,
      artifacts,
      chapterView: 'context',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('data-workbench-chapter-tab="text"')
    expect(html).toContain('第一章正文内容')
    expect(html).not.toContain('data-workbench-chapter-tab="context"')
    expect(html).not.toContain('上下文包')
    expect(html).not.toContain('target_chapter')
  })

  test('guides missing chapter outlines through the sequential planning action', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-4',
      kind: 'chapter',
      title: '第 004 章 · 夜航',
      level: 1,
      chapterNumber: 4,
      volumeNumber: 2,
      status: 'missing-outline',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-4',
      objectKind: 'chapter',
      title: '第 004 章 · 夜航',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: false },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-4',
      selectedItem,
      artifacts,
      chapterView: 'outline',
      currentChapterId: 'chapter-2',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('章节大纲尚未规划')
    expect(html).toContain('NarraCat 会按章节顺序从最前面缺少大纲的章节开始补齐。')
    expect(html).toContain('data-brand-illustration="outline-needed"')
    expect(html).toContain('data-workbench-empty-guide-action="plan-next-missing-outline"')
    expect(html).toContain('按序补充大纲')
    expect(html).not.toContain('规划第 4 章')
  })

  test('disables the sequential outline action while an agent is busy', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-4',
      kind: 'chapter',
      title: '第 004 章 · 夜航',
      level: 1,
      chapterNumber: 4,
      volumeNumber: 2,
      status: 'missing-outline',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-4',
      objectKind: 'chapter',
      title: '第 004 章 · 夜航',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: false },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-4',
      selectedItem,
      artifacts,
      chapterView: 'outline',
      currentChapterId: 'chapter-2',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
      selectionHandoffDisabled: true,
    })

    expect(html).toContain('data-workbench-empty-guide-action="plan-next-missing-outline"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Agent 正在运行，请等待当前任务完成。')
  })

  test('offers writing only from the current chapter manuscript empty state', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'planned',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-2',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('正文尚未生成')
    expect(html).toContain('当前阶段应该写这一章')
    expect(html).toContain('data-brand-illustration="draft-needed"')
    expect(html).toContain('data-workbench-empty-guide-action="write-current-chapter"')
    // 已知章号时按钮文案具体化为「写第 N 章」（术语统一，见 createWriteCurrentChapterAction）。
    expect(html).toContain('写第 2 章')
  })

  test('uses review guidance illustration when the review tab has no report yet', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'in-progress',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'review',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('审修报告尚未生成')
    expect(html).toContain('data-brand-illustration="review-needed"')
    expect(html).not.toContain('data-workbench-empty-guide-action=')
  })

  test('review subview shows both the light review report and the deep-review annotation', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        {
          id: 'review',
          kind: 'review',
          title: '审修报告',
          exists: true,
          data: { chapter: 2, verdict: 'pass', issues: [] },
        },
        {
          id: 'deep-review',
          kind: 'deep-review',
          title: '深审标注',
          exists: true,
          content: '# 深审标注\n\n第 3 段钩子有力。',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'review',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('审修报告')
    expect(html).toContain('深审标注')
    expect(html).toContain('第 3 段钩子有力')
    expect(html).not.toContain('审修报告尚未生成')
  })

  test('review subview surfaces a deep-review annotation even when no light review exists', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
        {
          id: 'deep-review',
          kind: 'deep-review',
          title: '深审标注',
          exists: true,
          content: '# 深审标注\n\n节奏在中段稍平。',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'review',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('深审标注')
    expect(html).toContain('节奏在中段稍平')
    expect(html).not.toContain('审修报告尚未生成')
  })

  test('offers explicit recovery for recoverable chapter manuscript empty states', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'recoverable',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-2',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('写作中断待恢复')
    expect(html).toContain('继续完成本章')
    expect(html).toContain('data-workbench-empty-guide-action="recover-current-chapter"')
    expect(html).toContain('data-action-icon="recover-write"')
    expect(html).not.toContain('data-workbench-empty-guide-action="write-current-chapter"')
  })

  test('surfaces recovery guidance above existing recoverable manuscripts', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-3',
      kind: 'chapter',
      title: '第 003 章 · 面谈室',
      level: 1,
      chapterNumber: 3,
      volumeNumber: 1,
      status: 'recoverable',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-3',
      objectKind: 'chapter',
      title: '第 003 章 · 面谈室',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: true, content: '审修' },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-3',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-3',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('正文')
    expect(html).toContain('data-workbench-recoverable-notice="true"')
    expect(html).toContain('写作中断待恢复')
    expect(html).toContain('继续完成本章')
    expect(html).toContain('data-workbench-recoverable-action="recover-current-chapter"')
    expect(html).not.toContain('data-workbench-empty-guide-action="write-current-chapter"')
  })

  test('surfaces a read-only banner for an interrupted-draft chapter and hides copy of the staging draft', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'interrupted-draft',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        {
          id: 'manuscript',
          kind: 'manuscript',
          title: '章节正文',
          exists: true,
          content: '中断前热写的草稿',
          isDraft: true,
        },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-3',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('中断前热写的草稿')
    expect(html).toContain('data-workbench-interrupted-draft-notice="true"')
    expect(html).toContain('写作中断的草稿（只读）')
    expect(html).toContain('继续写作后会自动完成验收')
    expect(html).not.toContain('data-workbench-titlebar-copy-action="copy-visible-document"')
  })

  test('hides the interrupted-draft banner while the chapter is actively generating (titlebar already says so)', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'interrupted-draft',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章 · 远行',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        {
          id: 'manuscript',
          kind: 'manuscript',
          title: '章节正文',
          exists: true,
          content: '中断前热写的草稿',
          isDraft: true,
        },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-2',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-3',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
      generationState: {
        label: '第 002 章 · 远行',
        statusText: '正在生成第 002 章 · 远行',
      },
    })

    // 正在续写同一章时，titlebar 已经表达「正在生成」；「写作中断的草稿」横幅与之语义打架，须隐藏。
    expect(html).toContain('中断前热写的草稿')
    expect(html).not.toContain('data-workbench-interrupted-draft-notice="true"')
    expect(html).not.toContain('写作中断的草稿（只读）')
    expect(html).toContain('data-workbench-titlebar-generation="true"')
    // 只读行为本身不受影响：编辑入口依旧封锁。
    expect(html).not.toContain('data-workbench-titlebar-copy-action="copy-visible-document"')
  })

  test('disables the recoverable chapter action and shows the reason while an agent is busy', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-3',
      kind: 'chapter',
      title: '第 003 章 · 面谈室',
      level: 1,
      chapterNumber: 3,
      volumeNumber: 1,
      status: 'recoverable',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-3',
      objectKind: 'chapter',
      title: '第 003 章 · 面谈室',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: true, content: '审修' },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-3',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-3',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
      selectionHandoffDisabled: true,
    })

    expect(html).toContain('data-workbench-recoverable-notice="true"')
    expect(html).toContain('data-workbench-recoverable-action="recover-current-chapter"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Agent 正在运行，请等待当前任务完成。')
  })

  test('hides recovery guidance while a matching recovery run is active', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-3',
      kind: 'chapter',
      title: '第 003 章 · 面谈室',
      level: 1,
      chapterNumber: 3,
      volumeNumber: 1,
      status: 'recoverable',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-3',
      objectKind: 'chapter',
      title: '第 003 章 · 面谈室',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: true, content: '审修' },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-3',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-3',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
      generationState: {
        label: '第 003 章 · 面谈室',
        statusText: '正在生成第 003 章 · 面谈室',
      },
    })

    expect(html).toContain('data-workbench-titlebar-generation="true"')
    expect(html).toContain('正在生成第 003 章 · 面谈室')
    expect(html).toContain('正文')
    expect(html).not.toContain('data-workbench-recoverable-notice="true"')
    expect(html).not.toContain('data-workbench-recoverable-action="recover-current-chapter"')
  })

  // 未来章的空态不提供写作动作（那会破坏顺序写作），但也不能是死胡同——给一条回到当前章的路。
  test('points a future chapter empty state back at the current chapter', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-5',
      kind: 'chapter',
      title: '第 005 章 · 潜流',
      level: 1,
      chapterNumber: 5,
      volumeNumber: 2,
      status: 'planned',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-5',
      objectKind: 'chapter',
      title: '第 005 章 · 潜流',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-5',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: 'chapter-2',
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('正文尚未生成')
    expect(html).toContain('本章还没轮到')
    expect(html).toContain('data-brand-illustration="draft-needed"')
    // 出路：跳到当前章（chapter-2），按钮文字带上章号。
    expect(html).toContain('data-workbench-empty-guide-action="go-to-current-chapter"')
    expect(html).toContain('去写第 2 章')
    // 但绝不能在这一章上提供写作动作——顺序写作的约束仍然成立。
    expect(html).not.toContain('data-workbench-empty-guide-action="write-current-chapter"')
    expect(html).not.toContain('写本章')
  })

  test('falls back to the passive copy when there is no current chapter to point at', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-5',
      kind: 'chapter',
      title: '第 005 章 · 潜流',
      level: 1,
      chapterNumber: 5,
      volumeNumber: 2,
      status: 'planned',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-5',
      objectKind: 'chapter',
      title: '第 005 章 · 潜流',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-5',
      selectedItem,
      artifacts,
      chapterView: 'text',
      currentChapterId: null,
      onChapterViewChange: () => {},
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('请按章节顺序写作')
    expect(html).not.toContain('data-workbench-empty-guide-action="go-to-current-chapter"')
  })

  test('keeps volume pages focused on the outline without an inline chapter list', () => {
    const tabs: WorkbenchTabItem[] = [
      ...blueprintTabs,
      {
        id: 'volume-outline-1',
        title: '第 1 卷',
        objectId: 'volume-outline-1',
        exists: true,
        emptyTitle: '第 1 卷尚未生成',
        emptyDescription: '卷纲缺失。',
        emptyAction: { label: '生成第 1 卷', prompt: '请生成第 1 卷。' },
      },
    ]
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'volume-outline-1',
      kind: 'volume-outline',
      title: '卷大纲',
      level: 1,
      parentId: 'volume-1',
      volumeNumber: 1,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'volume-outline-1',
      objectKind: 'volume-outline',
      title: '卷大纲',
      artifacts: [
        {
          id: 'volume-outline-1',
          kind: 'markdown',
          title: '卷大纲',
          exists: true,
          content: '# 第一卷\n',
          path: '/novels/stars/outline/vol-01/vol-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '创作蓝图',
      projectPath: '/novels/stars',
      tabs,
      activeTab: tabs[1],
      activeTabId: 'volume-outline-1',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
      volumeChapters: [
        {
          id: 'chapter-1',
          kind: 'chapter',
          title: '第 001 章 · 初醒',
          level: 1,
          parentId: 'volume-1',
          chapterNumber: 1,
          volumeNumber: 1,
          status: 'planned',
        },
        {
          id: 'chapter-2',
          kind: 'chapter',
          title: '第 002 章 · 远行',
          level: 1,
          parentId: 'volume-1',
          chapterNumber: 2,
          volumeNumber: 1,
          status: 'missing-outline',
        },
      ],
    })

    expect(html).not.toContain('data-volume-chapter-list="true"')
    expect(html).not.toContain('本卷章节')
    expect(html).not.toContain('第 001 章 · 初醒')
    expect(html).not.toContain('第 002 章 · 远行')
    expect(html).not.toContain('project=%2Fnovels%2Fstars&amp;object=chapter-1')
    expect(html).not.toContain('project=%2Fnovels%2Fstars&amp;object=chapter-2')
  })

  test('renders an empty guide from the active tab when a non-chapter has no artifact', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: false,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      onChapterViewChange: () => {},
      emptyGuideAction: generateFoundationAction,
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('创作根基尚未生成')
    expect(html).toContain('创作根基缺失。')
    expect(html).toContain('data-brand-illustration="setup-needed"')
    expect(html).toContain('data-workbench-empty-guide-action="generate-empty-foundation"')
    expect(html).toContain('生成创作根基')
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).not.toContain('文件尚未生成')
    expect(html).not.toContain('当前对象没有可显示的文件')
  })

  test('renders an empty guide when a non-chapter artifact exists but has blank content', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'foundation',
      objectKind: 'foundation',
      title: '创作根基',
      artifacts: [
        {
          id: 'foundation',
          kind: 'markdown',
          title: '创作根基',
          exists: true,
          content: ' \n\t ',
          path: '/novels/stars/bible/premise.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
      emptyGuideAction: generateFoundationAction,
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('创作根基尚未生成')
    expect(html).toContain('生成创作根基')
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).not.toContain('NarraCat 文件')
  })

  test('renders a read-only loading state before non-chapter artifacts are loaded', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      loading: true,
      onChapterViewChange: () => {},
      emptyGuideAction: generateFoundationAction,
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('正在读取文档')
    expect(html).toContain('正在加载当前板块内容。')
    expect(html).not.toContain('生成创作根基')
    expect(html.match(/<button/g)).toBeNull()
  })

  test('does not show the generation guide before artifacts load for an existing non-chapter item', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: true,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      loading: false,
      onChapterViewChange: () => {},
      emptyGuideAction: generateFoundationAction,
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('正在读取文档')
    expect(html).not.toContain('生成创作根基')
    expect(html.match(/<button/g)).toBeNull()
  })

  test('renders the active empty guide with a disabled action and its reason instead of a loading state', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'bible-scenes',
      kind: 'bible-document',
      title: '场景设定',
      level: 1,
      exists: false,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[1],
      activeTabId: 'bible-scenes',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      onChapterViewChange: () => {},
      emptyGuideAction: {
        id: 'generate-empty-bible-scenes',
        kind: 'agent',
        label: '生成场景设定',
        description: '场景设定缺失。',
        enabled: false,
        disabledReason: 'Agent 正在运行，请等待当前任务完成。',
        command: 'world',
      },
      onEmptyGuideAction: () => {},
    })

    expect(html).toContain('场景设定尚未生成')
    expect(html).not.toContain('生成中...')
    expect(html.match(/<button/g)?.length).toBe(1)
    expect(html).toContain('disabled=""')
    expect(html).toContain('Agent 正在运行，请等待当前任务完成。')
  })

  test('renders a target-matched generation state instead of the empty guide for missing content', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'foundation',
      kind: 'foundation',
      title: '创作根基',
      level: 0,
      exists: false,
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'settings',
      sectionTitle: '小说设定',
      projectPath: '/novels/stars',
      tabs: settingsTabs,
      activeTab: settingsTabs[0],
      activeTabId: 'foundation',
      selectedItem,
      artifacts: null,
      chapterView: 'text',
      onChapterViewChange: () => {},
      emptyGuideAction: generateFoundationAction,
      onEmptyGuideAction: () => {},
      generationState: {
        label: '创作根基',
        statusText: '正在生成创作根基',
      },
    } as Parameters<typeof WorkbenchObjectView>[0])

    expect(html).toContain('data-workbench-generation-empty="true"')
    expect(html).toContain('正在生成创作根基')
    expect(html).toContain('完成后会自动刷新当前页面。')
    expect(html).not.toContain('data-workbench-empty-guide-action="generate-empty-foundation"')
    expect(html.match(/<button/g)).toBeNull()
  })

  test('routes chapter outline to structured cards view when artifact has data and selectedItem has chapterNumber', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-3',
      kind: 'chapter',
      title: '第 003 章 · 宗门',
      level: 1,
      chapterNumber: 3,
      status: 'planned',
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-3',
      selectedItem,
      artifacts: {
        projectPath: '/novels/stars',
        objectId: 'chapter-3',
        objectKind: 'chapter',
        title: '第 003 章 · 宗门',
        artifacts: [
          {
            id: 'chapter-outline',
            kind: 'chapter-outline',
            title: '章节大纲',
            exists: true,
            data: { chapter: 3, title: '初入宗门', value_shift: '怀疑 → 信任', emotional_stakes: '失去引路人', dramatic_focus: '被当众羞辱' },
          },
        ],
      },
      chapterView: 'outline',
      onChapterViewChange: () => {},
    })

    expect(html).toContain('data-chapter-outline-view="true"')
    expect(html).not.toContain('data-markdown-viewer="true"')
  })

  test('falls back to markdown outline view when artifact has no data object', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-3',
      kind: 'chapter',
      title: '第 003 章 · 宗门',
      level: 1,
      chapterNumber: 3,
      status: 'planned',
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-3',
      selectedItem,
      artifacts: {
        projectPath: '/novels/stars',
        objectId: 'chapter-3',
        objectKind: 'chapter',
        title: '第 003 章 · 宗门',
        artifacts: [
          {
            id: 'chapter-outline',
            kind: 'chapter-outline',
            title: '章节大纲',
            exists: true,
            content: '## 章纲\n\n大纲内容',
          },
        ],
      },
      chapterView: 'outline',
      onChapterViewChange: () => {},
    })

    expect(html).not.toContain('data-chapter-outline-view="true"')
    expect(html).toContain('data-markdown-viewer="true"')
  })

  test('routes master outline to structured cards view when artifact has data', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [
        {
          id: 'master-outline',
          kind: 'markdown',
          title: '全书大纲',
          exists: true,
          content: '# 全书大纲\n\n- 主线',
          data: { central_dramatic_question: '主角能否夺回家族？' },
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '创作蓝图',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
      onEvaluatePremiseImpact: () => {},
    })

    expect(html).toContain('data-master-outline-edit=')
    expect(html).not.toContain('data-markdown-viewer="true"')
  })

  test('falls back to markdown outline view when master outline artifact has no data object', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [
        {
          id: 'master-outline',
          kind: 'markdown',
          title: '全书大纲',
          exists: true,
          content: '# 全书大纲\n\n- 主线',
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '创作蓝图',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).not.toContain('data-master-outline-edit=')
    expect(html).toContain('data-markdown-viewer="true"')
  })

  test('keeps existing content readable while showing a target-matched generation status', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [
        {
          id: 'master-outline',
          kind: 'markdown',
          title: '全书大纲',
          exists: true,
          content: '# 旧版全书大纲\n\n旧内容仍可阅读。',
          path: '/novels/stars/outline/master-outline.md',
        },
      ],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: blueprintTabs[0],
      activeTabId: 'master-outline',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
      generationState: {
        label: '全局大纲',
        statusText: '正在生成全局大纲',
      },
    })

    expect(html).toContain('data-workbench-titlebar-generation="true"')
    expect(html).toContain('正在生成全局大纲')
    expect(html).toContain('旧版全书大纲')
    expect(html).toContain('旧内容仍可阅读。')
    expect(html).toContain('data-reading-canvas="true"')
  })

  test('shows the titlebar generation indicator with short copy instead of a body status bar', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-4',
      kind: 'chapter',
      title: '第 004 章 · 戴手套的女孩',
      level: 1,
      chapterNumber: 4,
      volumeNumber: 1,
      status: 'planned',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-4',
      objectKind: 'chapter',
      title: '第 004 章 · 戴手套的女孩',
      artifacts: [{ id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' }],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-4',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
      generationState: {
        label: '第 004 章 · 戴手套的女孩',
        statusText: '正在生成第 004 章 · 戴手套的女孩',
      },
    })

    expect(html).toContain('data-workbench-titlebar-generation="true"')
    expect(html).toContain('data-icon-tooltip="正在生成第 004 章 · 戴手套的女孩"')
    // titlebar 内联指示只留短文案「正在生成」，长句挪进 hover tooltip，不再是内容区那条灰色横条。
    expect(html).toContain('>正在生成<')
    expect(html).not.toContain('data-workbench-generation-status')
    expect(html).not.toContain('完成后自动刷新')
  })

  test('does not render a titlebar generation indicator when nothing is generating', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-4',
      kind: 'chapter',
      title: '第 004 章 · 戴手套的女孩',
      level: 1,
      chapterNumber: 4,
      volumeNumber: 1,
      status: 'planned',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: '/novels/stars',
      objectId: 'chapter-4',
      objectKind: 'chapter',
      title: '第 004 章 · 戴手套的女孩',
      artifacts: [{ id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' }],
    }

    const html = renderWorkbenchObjectView({
      sectionId: 'blueprint',
      sectionTitle: '小说大纲',
      projectPath: '/novels/stars',
      tabs: blueprintTabs,
      activeTab: null,
      activeTabId: 'chapter-4',
      selectedItem,
      artifacts,
      chapterView: 'text',
      onChapterViewChange: () => {},
    })

    expect(html).not.toContain('data-workbench-titlebar-generation')
  })
})

describe('角色页设定/状态 tab', () => {
  const characterArtifact = {
    id: 'character-张三',
    title: '张三',
    path: 'bible/characters/张三.md',
    exists: true,
    content: '## 基本信息\n山村孤儿',
    characterUid: 'uid-1',
    characterName: '张三',
  } as NovelWorkbenchArtifacts['artifacts'][number]

  function renderDoc(tab: 'profile' | 'state', artifact = characterArtifact) {
    return renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <ObjectArtifactDocument
            artifact={artifact}
            characterTab={tab}
            onCharacterTabChange={() => {}}
            projectPath="/tmp/novel"
          />
        </MemoryRouter>
      </TooltipProvider>,
    )
  }

  test('设定 tab：tab 栏 + markdown 画像正文 + 文件信息', () => {
    const html = renderDoc('profile')
    expect(html).toContain('data-character-doc-tabbar="true"')
    expect(html).toContain('山村孤儿')
    expect(html).toContain('data-reading-metadata')
  })

  test('状态 tab：不渲染画像正文与文件信息', () => {
    const html = renderDoc('state')
    expect(html).toContain('data-character-doc-tabbar="true"')
    expect(html).not.toContain('山村孤儿')
    expect(html).not.toContain('data-reading-metadata')
  })

  test('完善度徽标渲染在 tab 栏行内，不再独占一行', () => {
    const html = renderDoc('profile', { ...characterArtifact, characterProfileStage: 'sketch' })
    const tabbarStart = html.indexOf('data-character-doc-tabbar')
    const badgeIndex = html.indexOf('data-character-profile-stage')
    expect(badgeIndex).toBeGreaterThan(tabbarStart)
    // 徽标在 tab 栏 nav 闭合之前（同一行内）
    expect(badgeIndex).toBeLessThan(html.indexOf('</nav>'))
  })

  test('候选角色不渲染 tab 栏', () => {
    const html = renderDoc('profile', { ...characterArtifact, isCandidateCharacter: true })
    expect(html).not.toContain('data-character-doc-tabbar')
  })

  test('非角色文档不渲染 tab 栏', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <MemoryRouter>
          <ObjectArtifactDocument
            artifact={{ id: 'foundation', title: '创作根基', path: 'x.md', exists: true, content: '正文' } as NovelWorkbenchArtifacts['artifacts'][number]}
            characterTab="profile"
            onCharacterTabChange={() => {}}
            projectPath="/tmp/novel"
          />
        </MemoryRouter>
      </TooltipProvider>,
    )
    expect(html).not.toContain('data-character-doc-tabbar')
  })
})
