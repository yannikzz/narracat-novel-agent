import { describe, expect, test } from 'bun:test'
import {
  buildWorkbenchActionRegions,
  createEmptyTabAction,
  createSequentialOutlineAction,
  createWriteCurrentChapterAction,
  disableAgentActionsWhileBusy,
  getWorkbenchActions,
  resolveStatusLifecycleIndex,
  resolveStatusNextStep,
} from './workbench-actions'
import type { WorkbenchTabItem } from './workbench-navigation'
import type {
  NovelChapterStatus,
  NovelProjectDetail,
  NovelProjectStatus,
  NovelTocItem,
  NovelWorkbenchArtifacts,
  NovelWorkbenchTreeItem,
} from '@shared/types/novel'

const project: NovelProjectDetail = {
  id: 'novel-1',
  title: '星辰大海',
  path: '/novels/stars',
  status: 'ready',
  chapterProgress: '0 / 1 章',
  wordCountLabel: '0 字',
  tocItems: [],
  treeItems: [
    { id: 'volume-2', kind: 'volume', title: '第二卷', level: 0, volumeNumber: 2 },
    {
      id: 'volume-outline-2',
      kind: 'volume-outline',
      title: '第二卷大纲',
      level: 1,
      parentId: 'volume-2',
      volumeNumber: 2,
      exists: true,
    },
  ],
}

describe('workbench actions', () => {
  test('moves refresh to the titlebar and uses a targeted empty-tab guide action in the content body', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: false,
    }
    const activeTab: WorkbenchTabItem = {
      id: 'master-outline',
      title: '全局大纲',
      objectId: 'master-outline',
      exists: false,
      emptyTitle: '全局大纲尚未生成',
      emptyDescription: '全局大纲缺失。',
      emptyAction: { label: '生成全局大纲', prompt: '请生成全局大纲。' },
    }
    const actions = getWorkbenchActions({ project, selectedItem, artifacts: null })

    const regions = buildWorkbenchActionRegions({
      actions,
      activeTab,
      artifacts: null,
      loading: false,
      sectionId: 'blueprint',
      selectedItem,
    })

    expect(regions.titlebarActions).toEqual([expect.objectContaining({ id: 'refresh-project' })])
    expect(regions.emptyGuideAction).toEqual(
      expect.objectContaining({
        id: 'generate-empty-master-outline',
        label: '生成全局大纲',
        command: 'plan',
      }),
    )
    expect(regions.titlebarActions).not.toContainEqual(expect.objectContaining({ id: 'plan-master-outline' }))
  })

  test('moves generated content agent actions into titlebar icons without footer actions', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const activeTab: WorkbenchTabItem = {
      id: 'master-outline',
      title: '全局大纲',
      objectId: 'master-outline',
      exists: true,
      emptyTitle: '全局大纲尚未生成',
      emptyDescription: '全局大纲缺失。',
      emptyAction: { label: '生成全局大纲', prompt: '请生成全局大纲。' },
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [{ id: 'master-outline', kind: 'markdown', title: '全书大纲', exists: true, content: '已生成' }],
    }
    const actions = getWorkbenchActions({ project, selectedItem, artifacts })

    const regions = buildWorkbenchActionRegions({
      actions,
      activeTab,
      artifacts,
      loading: false,
      sectionId: 'blueprint',
      selectedItem,
    })

    expect(regions.emptyGuideAction).toBeNull()
    expect(regions.titlebarActions).toContainEqual(expect.objectContaining({ id: 'refresh-project' }))
    expect(regions.titlebarActions).toContainEqual(
      expect.objectContaining({
        id: 'adjust-master-outline',
        kind: 'composer-handoff',
        label: '调整内容',
        command: 'plan',
        prompt: '',
        adjust: { targetLabel: '全局大纲', verb: '调整' },
        target: {
          sectionId: 'blueprint',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
      }),
    )
    expect(regions.titlebarActions).not.toContainEqual(expect.objectContaining({ id: 'plan-master-outline' }))
  })

  test('creates a targeted planning action for an empty blueprint tab', () => {
    const tab: WorkbenchTabItem = {
      id: 'master-outline',
      title: '全局大纲',
      objectId: 'master-outline',
      exists: false,
      emptyTitle: '全局大纲尚未生成',
      emptyDescription: '全局大纲缺失。',
      emptyAction: { label: '生成全局大纲', prompt: '请生成全局大纲。' },
    }

    expect(createEmptyTabAction(tab, 'blueprint')).toEqual(
      expect.objectContaining({
        id: 'generate-empty-master-outline',
        kind: 'agent',
        label: '生成全局大纲',
        command: 'plan',
        enabled: true,
        target: {
          sectionId: 'blueprint',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
      }),
    )
    expect(createEmptyTabAction(tab, 'blueprint').prompt).toContain('objectId: master-outline')
  })

  test('maps empty premise setup tabs to setup and other settings to world', () => {
    const premiseTab: WorkbenchTabItem = {
      id: 'bible-premise',
      title: '核心前提',
      objectId: 'bible-premise',
      exists: false,
      emptyTitle: '核心前提尚未生成',
      emptyDescription: '核心前提缺失。',
      emptyAction: { label: '生成核心前提', prompt: '请生成核心前提。' },
    }
    const characterTab: WorkbenchTabItem = {
      id: 'characters',
      title: '小说角色',
      objectId: 'characters',
      exists: false,
      emptyTitle: '小说角色尚未生成',
      emptyDescription: '小说角色缺失。',
      emptyAction: { label: '生成小说角色', prompt: '请生成小说角色。' },
    }

    expect(createEmptyTabAction(premiseTab, 'settings')).toEqual(expect.objectContaining({ command: 'setup' }))
    expect(createEmptyTabAction(characterTab, 'settings')).toEqual(expect.objectContaining({ command: 'world' }))
  })

  test('foundation 聚合节点的动作落到真实子 tab（setup→核心前提 / world→角色），不指向不可解析的 foundation', () => {
    const actions = getWorkbenchActions({
      project,
      selectedItem: {
        id: 'foundation',
        kind: 'foundation',
        title: '创作根基',
        level: 0,
      },
      artifacts: null,
    })

    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'setup-foundation',
        command: 'setup',
        description: '引导核心前提',
        // foundation 不是可解析 settings tab，会 fallback 回 blueprint；改落核心前提（bible-premise）。
        target: { sectionId: 'settings', tabId: 'bible-premise', objectId: 'bible-premise' },
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'world-foundation',
        command: 'world',
        target: { sectionId: 'settings', tabId: 'characters', objectId: 'characters' },
      }),
    )
  })

  test('routes narrator voice adjustments back to the master outline', () => {
    const regions = buildWorkbenchActionRegions({
      actions: getWorkbenchActions({
        project,
        selectedItem: {
          id: 'narrator-voice',
          kind: 'narrator-voice',
          title: '叙事声音',
          level: 1,
          parentId: 'foundation',
          exists: true,
        },
        artifacts: {
          projectPath: '/novels/stars',
          objectId: 'narrator-voice',
          objectKind: 'narrator-voice',
          title: '叙事声音',
          artifacts: [{ id: 'narrator-voice', kind: 'markdown', title: '叙事声音', exists: true, content: '已生成' }],
        },
      }),
      activeTab: null,
      artifacts: null,
      loading: false,
      sectionId: 'settings',
      selectedItem: null,
    })

    expect(regions.titlebarActions).toContainEqual(
      expect.objectContaining({
        id: 'adjust-narrator-voice',
        command: 'plan',
        target: { sectionId: 'blueprint', tabId: 'master-outline', objectId: 'master-outline' },
      }),
    )
  })

  test('hands existing premise to the composer via the targeted revise-premise command', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'bible-premise',
      kind: 'bible-document',
      title: '核心前提',
      level: 1,
      parentId: 'foundation',
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'bible-premise',
      objectKind: 'bible-document',
      title: '核心前提',
      artifacts: [
        {
          id: 'bible-premise',
          kind: 'markdown',
          title: '核心前提',
          exists: true,
          content: '已有核心前提',
        },
      ],
    }

    const actions = getWorkbenchActions({ project, selectedItem, artifacts })

    expect(actions).toContainEqual(expect.objectContaining({ id: 'refresh-project', kind: 'client' }))
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'adjust-bible-premise',
        kind: 'composer-handoff',
        label: '调整内容',
        command: 'revise-premise',
        prompt: '',
        adjust: { targetLabel: '核心前提', verb: '调整' },
        target: {
          sectionId: 'settings',
          tabId: 'bible-premise',
          objectId: 'bible-premise',
        },
      }),
    )
  })

  test('hands existing world settings groups to the composer and leaves references out of adjustment', () => {
    const worldItem: NovelWorkbenchTreeItem = {
      id: 'world',
      kind: 'world-list',
      title: '世界观',
      level: 1,
      parentId: 'foundation',
      exists: true,
    }
    const worldArtifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'world',
      objectKind: 'world-list',
      title: '世界观',
      artifacts: [
        {
          id: 'world-修真体系',
          kind: 'markdown',
          title: '修真体系',
          exists: true,
          content: '已有世界观设定',
        },
      ],
    }

    const worldActions = getWorkbenchActions({ project, selectedItem: worldItem, artifacts: worldArtifacts })

    expect(worldActions).toContainEqual(
      expect.objectContaining({
        id: 'adjust-world',
        kind: 'composer-handoff',
        label: '调整内容',
        command: 'world',
        prompt: '',
        adjust: { targetLabel: '世界观设定', verb: '调整' },
      }),
    )

    const referenceActions = getWorkbenchActions({
      project,
      selectedItem: {
        id: 'references',
        kind: 'reference-list',
        title: '参考作品',
        level: 1,
        parentId: 'foundation',
        exists: true,
      },
      artifacts: {
        projectPath: project.path,
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
    })

    expect(referenceActions).toContainEqual(expect.objectContaining({ id: 'refresh-project', kind: 'client' }))
    expect(referenceActions).not.toContainEqual(expect.objectContaining({ label: '调整内容' }))
    expect(referenceActions).not.toContainEqual(expect.objectContaining({ id: 'setup-from-reference-works' }))
  })

  test('offers reference works analysis for populated reference lists', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'references',
      kind: 'reference-list',
      title: '参考作品',
      level: 1,
      parentId: 'foundation',
      exists: true,
    }
    const actions = getWorkbenchActions({
      project,
      selectedItem,
      artifacts: {
        projectPath: project.path,
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
    })

    expect(actions).toContainEqual(expect.objectContaining({ id: 'refresh-project', kind: 'client' }))
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'analyze-reference-works',
        kind: 'agent',
        label: '分析参考作品',
        command: 'reference',
        prompt: '分析参考作品',
        target: { sectionId: 'reference-works', tabId: 'references', objectId: 'references' },
      }),
    )
  })

  test('moves completed reference works actions into the titlebar more menu', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'references',
      kind: 'reference-list',
      title: '参考作品',
      level: 1,
      parentId: 'foundation',
      exists: true,
    }
    const actions = getWorkbenchActions({
      project,
      selectedItem,
      artifacts: {
        projectPath: project.path,
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
          guidance: {
            exists: true,
            relativePath: 'bible/reference-guidance/index.md',
            path: '/novels/stars/bible/reference-guidance/index.md',
            updatedAt: '2026-05-21T00:00:00.000Z',
            content: '# 参考指导',
          },
          status: {
            guidanceState: 'current',
            sourceCount: 1,
            needsAnalysis: false,
            stale: false,
            guidanceExists: true,
          },
        },
      },
    })

    expect(actions).toContainEqual(expect.objectContaining({ id: 'refresh-project', kind: 'client' }))
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'analyze-reference-works',
        kind: 'agent',
        label: '重新分析',
        command: 'reference',
        placement: 'more',
        resetReferenceGuidanceBeforeRun: true,
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'reset-reference-works',
        kind: 'client',
        label: '重置参考作品',
        placement: 'more',
        danger: true,
        disableWhileAgentBusy: true,
      }),
    )
  })

  test('recommends sequential planning and blocks writing when a chapter outline is missing', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-1',
      kind: 'chapter',
      title: '第 001 章',
      level: 1,
      chapterNumber: 1,
      volumeNumber: 1,
      status: 'missing-outline',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-1',
      objectKind: 'chapter',
      title: '第 001 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: false },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
      ],
    }

    const actions = getWorkbenchActions({ project, selectedItem, artifacts })

    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'plan-chapter',
        kind: 'agent',
        label: '按序补充大纲',
        enabled: true,
        command: 'plan',
        prompt: '按顺序补充缺失的章节大纲',
        omitSelectedChapter: true,
      }),
    )
    expect(actions.find((action) => action.id === 'plan-chapter')?.prompt).not.toContain('第 1 章')
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'write-chapter',
        kind: 'agent',
        label: '写本章',
        enabled: false,
        disabledReason: '缺少章节大纲，需先按序补充大纲。',
      }),
    )
  })

  test('offers explicit recovery and blocks new writing for recoverable chapters', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'recoverable',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true },
      ],
    }

    const actions = getWorkbenchActions({ project, selectedItem, artifacts, chapterView: 'text' })

    expect(actions[1]).toEqual(expect.objectContaining({ id: 'recover-current-chapter' }))
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'recover-current-chapter',
        kind: 'agent',
        label: '继续完成本章',
        enabled: true,
        command: 'recover-write',
        prompt: '继续完成本章',
        target: {
          sectionId: 'blueprint',
          tabId: 'chapter-2',
          objectId: 'chapter-2',
        },
      }),
    )
    expect(actions).not.toContainEqual(expect.objectContaining({ id: 'write-chapter', enabled: true }))
  })

  test('creates a reusable sequential outline guide action without chapter targeting', () => {
    expect(createSequentialOutlineAction()).toEqual(
      expect.objectContaining({
        id: 'plan-next-missing-outline',
        kind: 'agent',
        label: '按序补充大纲',
        enabled: true,
        command: 'plan',
        prompt: '按顺序补充缺失的章节大纲',
        omitSelectedChapter: true,
      }),
    )
    expect(createSequentialOutlineAction().target).toBeUndefined()
  })

  test('写本章动作带章号时按钮文案具体化为「写第 N 章」', () => {
    expect(createWriteCurrentChapterAction(undefined, 12).label).toBe('写第 12 章')
    expect(createWriteCurrentChapterAction(undefined).label).toBe('写本章')
  })

  test('offers master outline planning for the full-book object', () => {
    const actions = getWorkbenchActions({
      project,
      selectedItem: { id: 'master-outline', kind: 'master-outline', title: '全书大纲', level: 0, exists: false },
      artifacts: null,
    })

    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'plan-master-outline',
        kind: 'agent',
        label: '规划全书大纲',
        command: 'plan',
        enabled: true,
        target: {
          sectionId: 'blueprint',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
      }),
    )
  })

  test('targets volume and chapter generation actions to their workbench pages', () => {
    const volumeActions = getWorkbenchActions({
      project,
      selectedItem: { id: 'volume-2', kind: 'volume', title: '第二卷', level: 0, volumeNumber: 2 },
      artifacts: null,
    })

    expect(volumeActions).toContainEqual(
      expect.objectContaining({
        id: 'plan-volume',
        target: {
          sectionId: 'blueprint',
          tabId: 'volume-outline-2',
          objectId: 'volume-outline-2',
        },
      }),
    )

    const chapterActions = getWorkbenchActions({
      project,
      selectedItem: {
        id: 'chapter-3',
        kind: 'chapter',
        title: '第 003 章',
        level: 1,
        chapterNumber: 3,
        volumeNumber: 2,
        status: 'planned',
      },
      artifacts: {
        projectPath: project.path,
        objectId: 'chapter-3',
        objectKind: 'chapter',
        title: '第 003 章',
        artifacts: [
          { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true },
          { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: false },
        ],
      },
    })

    expect(chapterActions).toContainEqual(
      expect.objectContaining({
        id: 'write-chapter',
        target: {
          sectionId: 'blueprint',
          tabId: 'chapter-3',
          objectId: 'chapter-3',
        },
      }),
    )
  })

  test('uses command-friendly chapter arguments for review and rewrite', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-1',
      kind: 'chapter',
      title: '第 001 章',
      level: 1,
      chapterNumber: 1,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-1',
      objectKind: 'chapter',
      title: '第 001 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true },
        { id: 'review', kind: 'review', title: '审修报告', exists: true },
      ],
    }

    const actions = getWorkbenchActions({ project, selectedItem, artifacts })

    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'review-chapter',
        command: 'review',
        enabled: true,
        prompt: '1',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'rewrite-chapter',
        command: 'rewrite',
        enabled: true,
        prompt: '1',
      }),
    )
  })

  test('hands existing chapter manuscript adjustments to the composer and keeps review actions in more', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: true, content: '审修' },
      ],
    }

    const actions = getWorkbenchActions({ project, selectedItem, artifacts, chapterView: 'text' })

    // 「润色正文」占 titlebar primary 槽（正文页最常做的是读与润），「编辑正文」退成纯 icon，
    // 「调整内容」让位收进「更多」。
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'polish-manuscript',
        kind: 'client',
        label: '润色正文',
        placement: 'primary',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'edit-manuscript',
        kind: 'client',
        label: '编辑正文',
        placement: 'utility',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'manuscript-history',
        kind: 'client',
        label: '版本历史',
        placement: 'utility',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'adjust-chapter-manuscript',
        kind: 'composer-handoff',
        label: '调整内容',
        command: 'rewrite',
        prompt: '',
        adjust: { targetLabel: '第 2 章正文', verb: '调整' },
        placement: 'more',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'sync-chapter-memory-entry',
        kind: 'client',
        label: '同步本章记忆',
        placement: 'more',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'review-chapter-again',
        kind: 'composer-handoff',
        label: '重新审修',
        command: 'review',
        placement: 'more',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'rewrite-chapter-from-review',
        kind: 'composer-handoff',
        label: '根据审修重写',
        command: 'rewrite',
        placement: 'more',
      }),
    )
  })

  test('hides edit/history/agent manuscript actions for a staging draft (interrupted-draft, read-only preview)', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'interrupted-draft',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '中断前热写的草稿', isDraft: true },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
      ],
    }

    const actions = getWorkbenchActions({ project, selectedItem, artifacts, chapterView: 'text' })

    expect(actions.some((action) => action.id === 'edit-manuscript')).toBe(false)
    expect(actions.some((action) => action.id === 'manuscript-history')).toBe(false)
    expect(actions.some((action) => action.id === 'adjust-chapter-manuscript')).toBe(false)
    expect(actions.some((action) => action.id === 'sync-chapter-memory-entry')).toBe(false)
    expect(actions.some((action) => action.id === 'review-chapter-again')).toBe(false)
    expect(actions.some((action) => action.id === 'review-chapter')).toBe(false)
  })

  test('uses direct review only when the visible chapter review is missing', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
        { id: 'review', kind: 'review', title: '审修报告', exists: false },
      ],
    }

    expect(getWorkbenchActions({ project, selectedItem, artifacts, chapterView: 'review' })).toContainEqual(
      expect.objectContaining({
        id: 'review-chapter',
        kind: 'agent',
        label: '审修当前章',
        command: 'review',
        placement: 'primary',
        prompt: '2',
      }),
    )

    const reviewedArtifacts: NovelWorkbenchArtifacts = {
      ...artifacts,
      artifacts: artifacts.artifacts.map((artifact) =>
        artifact.id === 'review' ? { ...artifact, exists: true, content: '审修报告' } : artifact,
      ),
    }

    expect(getWorkbenchActions({ project, selectedItem, artifacts: reviewedArtifacts, chapterView: 'review' })).toContainEqual(
      expect.objectContaining({
        id: 'review-chapter-again',
        kind: 'composer-handoff',
        label: '重新审修',
        command: 'review',
        placement: 'primary',
        prompt: '',
        adjust: { targetLabel: '第 2 章', verb: '重新审修' },
      }),
    )
  })

  test('shows volume review handoff only when the volume has completed chapters', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'volume-outline-2',
      kind: 'volume-outline',
      title: '第二卷大纲',
      level: 1,
      parentId: 'volume-2',
      volumeNumber: 2,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'volume-outline-2',
      objectKind: 'volume-outline',
      title: '第二卷大纲',
      artifacts: [{ id: 'volume-outline-2', kind: 'markdown', title: '第二卷大纲', exists: true, content: '卷纲' }],
    }
    const projectWithCompletedChapter: NovelProjectDetail = {
      ...project,
      tocItems: [
        { id: 'volume-2', kind: 'volume', title: '第二卷', volumeNumber: 2 },
        {
          id: 'chapter-9',
          kind: 'chapter',
          title: '第 009 章',
          chapterNumber: 9,
          volumeNumber: 2,
          status: 'completed',
        },
      ],
    }

    expect(getWorkbenchActions({ project, selectedItem, artifacts })).not.toContainEqual(
      expect.objectContaining({ id: 'review-volume' }),
    )
    expect(getWorkbenchActions({ project: projectWithCompletedChapter, selectedItem, artifacts })).toContainEqual(
      expect.objectContaining({
        id: 'review-volume',
        kind: 'composer-handoff',
        placement: 'more',
      }),
    )
  })

  test('uses volume ids as review command arguments', () => {
    const actions = getWorkbenchActions({
      project,
      selectedItem: { id: 'volume-2', kind: 'volume', title: '第二卷', level: 0, volumeNumber: 2 },
      artifacts: null,
    })

    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'review-volume',
        command: 'review',
        prompt: 'vol-02',
      }),
    )
  })

  test('disables otherwise-enabled agent actions while preserving prerequisite disabled reasons', () => {
    const actions = disableAgentActionsWhileBusy(
      [
        {
          id: 'refresh-project',
          kind: 'client',
          label: '刷新',
          description: '重新读取项目文件',
          enabled: true,
        },
        {
          id: 'plan-chapter',
          kind: 'composer-handoff',
          label: '按序补充大纲',
          description: '补齐或调整当前章节大纲',
          enabled: true,
          command: 'plan',
          omitSelectedChapter: true,
        },
        {
          id: 'write-chapter',
          kind: 'agent',
          label: '写本章',
          description: '执行正文生成',
          enabled: false,
          disabledReason: '缺少章节大纲，需先按序补充大纲。',
          command: 'write-next',
        },
      ],
      true,
    )

    expect(actions).toContainEqual(expect.objectContaining({ id: 'refresh-project', enabled: true }))
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'plan-chapter',
        enabled: false,
        disabledReason: 'Agent 正在运行，请等待当前任务完成。',
      }),
    )
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'write-chapter',
        enabled: false,
        disabledReason: '缺少章节大纲，需先按序补充大纲。',
      }),
    )
  })

  test('Agent 忙时 titlebar 动作置灰并携带禁用原因（而非仅空页动作）', () => {
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'master-outline',
      kind: 'master-outline',
      title: '全书大纲',
      level: 0,
      exists: true,
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'master-outline',
      objectKind: 'master-outline',
      title: '全书大纲',
      artifacts: [{ id: 'master-outline', kind: 'markdown', title: '全书大纲', exists: true, content: '已生成' }],
    }
    const actions = getWorkbenchActions({ project, selectedItem, artifacts })

    const regions = buildWorkbenchActionRegions({
      actions,
      activeTab: null,
      artifacts,
      loading: false,
      sectionId: 'blueprint',
      selectedItem,
      agentBusy: true,
    })

    const handoffAction = regions.titlebarActions.find((action) => action.kind === 'composer-handoff')
    expect(handoffAction?.enabled).toBe(false)
    expect(handoffAction?.disabledReason).toContain('Agent 正在运行')
  })

  test('真实 WorkbenchStage 调用形状：忙时章节正文调整动作仍留在 titlebar 且置灰（而非被过滤消失，终审C1回归）', () => {
    // 复刻 WorkbenchStage 的真实调用形状：getWorkbenchActions 的原始（未预置灰）结果直接交给
    // buildWorkbenchActionRegions，由它内部的 agentBusy 统一置灰。修复前 WorkbenchStage 会先用
    // disableAgentActionsWhileBusy 把动作预置灰，导致 buildWorkbenchActionRegions 的
    // `actions.filter((action) => action.enabled)` 把已置灰的 composer-handoff 动作整个过滤掉，
    // 忙时 titlebar 上「调整内容」按钮直接消失而不是置灰。
    const selectedItem: NovelWorkbenchTreeItem = {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章',
      level: 1,
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'completed',
    }
    const artifacts: NovelWorkbenchArtifacts = {
      projectPath: project.path,
      objectId: 'chapter-2',
      objectKind: 'chapter',
      title: '第 002 章',
      artifacts: [
        { id: 'chapter-outline', kind: 'chapter-outline', title: '章节大纲', exists: true, content: '大纲' },
        { id: 'manuscript', kind: 'manuscript', title: '章节正文', exists: true, content: '正文' },
      ],
    }
    const rawActions = getWorkbenchActions({ project, selectedItem, artifacts, chapterView: 'text' })

    const regions = buildWorkbenchActionRegions({
      actions: rawActions,
      activeTab: null,
      artifacts,
      loading: false,
      sectionId: 'blueprint',
      selectedItem,
      agentBusy: true,
    })

    expect(regions.titlebarActions).toContainEqual(
      expect.objectContaining({
        id: 'adjust-chapter-manuscript',
        kind: 'composer-handoff',
        enabled: false,
        disabledReason: 'Agent 正在运行，请等待当前任务完成。',
      }),
    )
    // 「编辑正文」是 client 动作，须显式 disableWhileAgentBusy 才会跟着置灰。
    expect(regions.titlebarActions).toContainEqual(
      expect.objectContaining({
        id: 'edit-manuscript',
        kind: 'client',
        enabled: false,
        disabledReason: 'Agent 正在运行，请等待当前任务完成。',
      }),
    )
  })
})

describe('resolveStatusNextStep', () => {
  function projectWith(
    status: NovelProjectStatus,
    chapters: Array<{ n: number; status: NovelChapterStatus }> = [],
    // 默认「已有角色」：绝大多数用例测的是 world 之后的环节，不该被创作链那一格截胡。
    hasCharacters = true,
  ): NovelProjectDetail {
    const tocItems: NovelTocItem[] = chapters.map(({ n, status: chapterStatus }) => ({
      id: `chapter-${n}`,
      kind: 'chapter',
      title: `第 ${n} 章`,
      chapterNumber: n,
      status: chapterStatus,
    }))
    return {
      id: 'novel-1',
      title: '星辰大海',
      path: '/novels/stars',
      status,
      chapterProgress: '0 / 0 章',
      wordCountLabel: '0 字',
      tocItems,
      treeItems: [],
      hasCharacters,
    }
  }

  test('未立项 → 建立创作根基（setup，导航设定集核心前提 tab）', () => {
    const step = resolveStatusNextStep(projectWith('needs-setup'))
    expect(step).toEqual({
      kind: 'action',
      action: expect.objectContaining({
        command: 'setup',
        label: '建立创作根基',
        kind: 'agent',
        // bible-premise 是真实可解析的 settings tab；foundation 会 fallback 落回 blueprint。
        target: { sectionId: 'settings', tabId: 'bible-premise', objectId: 'bible-premise' },
      }),
    })
  })

  test('有设定缺大纲、且还没有角色 → 先建议创建主要角色（world）', () => {
    const step = resolveStatusNextStep(projectWith('needs-outline', [], false))
    expect(step?.kind).toBe('action')
    if (step?.kind === 'action') {
      expect(step.action.command).toBe('world')
      expect(step.action.label).toBe('创建主要角色')
      expect(step.action.target).toEqual({ sectionId: 'settings', tabId: 'characters', objectId: 'characters' })
      // 只建议不阻塞：文案必须说得出「可以跳过」，否则读起来像硬门槛。
      expect(step.action.description).toContain('跳过')
    }
  })

  test('有设定缺大纲（已有角色）→ 规划全书大纲（plan，导航全局大纲）', () => {
    const step = resolveStatusNextStep(projectWith('needs-outline'))
    expect(step?.kind).toBe('action')
    if (step?.kind === 'action') {
      expect(step.action.command).toBe('plan')
      expect(step.action.label).toBe('规划全书大纲')
      expect(step.action.target?.objectId).toBe('master-outline')
    }
  })

  test('写作中且有可恢复断点 → 继续完成该章（recover-write）优先', () => {
    const step = resolveStatusNextStep(
      projectWith('in-progress', [
        { n: 1, status: 'completed' },
        { n: 2, status: 'recoverable' },
        { n: 3, status: 'planned' },
      ]),
    )
    expect(step?.kind).toBe('action')
    if (step?.kind === 'action') {
      expect(step.action.command).toBe('recover-write')
      expect(step.action.label).toBe('继续完成第 2 章')
      expect(step.action.target?.objectId).toBe('chapter-2')
    }
  })

  test('有大纲、下一章待写 → 写该章（write-next）', () => {
    const step = resolveStatusNextStep(
      projectWith('ready', [
        { n: 1, status: 'completed' },
        { n: 2, status: 'planned' },
      ]),
    )
    expect(step?.kind).toBe('action')
    if (step?.kind === 'action') {
      expect(step.action.command).toBe('write-next')
      expect(step.action.label).toBe('写第 2 章')
      expect(step.action.target?.objectId).toBe('chapter-2')
    }
  })

  test('下一章是写作中断的草稿（interrupted-draft）→ 文案对齐 in-progress 的「继续写第 N 章」', () => {
    const step = resolveStatusNextStep(
      projectWith('ready', [
        { n: 1, status: 'completed' },
        { n: 2, status: 'interrupted-draft' },
      ]),
    )
    expect(step?.kind).toBe('action')
    if (step?.kind === 'action') {
      expect(step.action.command).toBe('write-next')
      expect(step.action.label).toBe('继续写第 2 章')
      expect(step.action.target?.objectId).toBe('chapter-2')
    }
  })

  test('下一章缺章节大纲 → 先补该章大纲（plan）', () => {
    const step = resolveStatusNextStep(
      projectWith('in-progress', [{ n: 1, status: 'missing-outline' }]),
    )
    expect(step?.kind).toBe('action')
    if (step?.kind === 'action') {
      expect(step.action.command).toBe('plan')
      expect(step.action.label).toBe('补第 1 章大纲')
    }
  })

  test('全部写完 → 终态 done', () => {
    const step = resolveStatusNextStep(
      projectWith('in-progress', [
        { n: 1, status: 'completed' },
        { n: 2, status: 'completed' },
      ]),
    )
    expect(step).toEqual({ kind: 'done' })
  })

  test('结构损坏（带 problem）→ 不判 done，返回 null 不掩盖损坏', () => {
    // novel-project 会给结构损坏的 ready/in-progress 项目带上 problem，此时 tocItems 可能为空或全完成，
    // 但不代表真完结；resolveStatusNextStep 不应返回 done（那会让状态页误显「全书已完成」）。
    const corruptedEmpty = { ...projectWith('ready'), problem: '全书结构数据损坏' }
    expect(resolveStatusNextStep(corruptedEmpty)).toBeNull()

    const corruptedCompleted = {
      ...projectWith('in-progress', [{ n: 1, status: 'completed' as const }]),
      problem: '全书结构数据损坏',
    }
    expect(resolveStatusNextStep(corruptedCompleted)).toBeNull()
  })

  test('项目无效 / 缺失 → null', () => {
    expect(resolveStatusNextStep(projectWith('invalid'))).toBeNull()
    expect(resolveStatusNextStep(null)).toBeNull()
  })
})

describe('resolveStatusLifecycleIndex', () => {
  function projectWith(
    status: NovelProjectStatus,
    chapters: Array<{ n: number; status: NovelChapterStatus }> = [],
    // 默认「已有角色」：绝大多数用例测的是 world 之后的环节，不该被创作链那一格截胡。
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

  test('立项(0) / 设定(1) / 大纲(2) / 连载(3) / 完结(4)', () => {
    expect(resolveStatusLifecycleIndex(projectWith('needs-setup'), resolveStatusNextStep(projectWith('needs-setup')))).toBe(0)
    // 有立项卡但还没有角色档案 → 停在「设定」这一格。
    const noCharacters = projectWith('needs-outline', [], false)
    expect(resolveStatusLifecycleIndex(noCharacters, resolveStatusNextStep(noCharacters))).toBe(1)
    expect(resolveStatusLifecycleIndex(projectWith('needs-outline'), resolveStatusNextStep(projectWith('needs-outline')))).toBe(2)
    const writing = projectWith('in-progress', [{ n: 1, status: 'planned' }])
    expect(resolveStatusLifecycleIndex(writing, resolveStatusNextStep(writing))).toBe(3)
    const done = projectWith('in-progress', [{ n: 1, status: 'completed' }])
    expect(resolveStatusLifecycleIndex(done, resolveStatusNextStep(done))).toBe(4)
  })

  test('跳过设定直接做大纲不会卡住：status 进 ready 后 stepper 顺势推到连载', () => {
    // 没有角色档案，但大纲已经做完（planned > 0 → ready）——「设定」那一格算走过了，不倒退。
    const skipped = projectWith('ready', [{ n: 1, status: 'planned' }], false)
    expect(resolveStatusLifecycleIndex(skipped, resolveStatusNextStep(skipped))).toBe(3)
  })

  test('项目无效 / 缺失 → null（不渲染 stepper）', () => {
    expect(resolveStatusLifecycleIndex(projectWith('invalid'), null)).toBeNull()
    expect(resolveStatusLifecycleIndex(null, null)).toBeNull()
  })
})
