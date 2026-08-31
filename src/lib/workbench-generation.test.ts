import { describe, expect, test } from 'bun:test'
import { resolveWorkbenchGenerationState, resolveWorkbenchSidebarGenerationTarget } from './workbench-generation'
import type { AgentRun } from '@shared/types/agent'
import type { WorkbenchTabItem } from './workbench-navigation'
import type { NovelProjectDetail, NovelWorkbenchTreeItem } from '@shared/types/novel'

const runningPlan: AgentRun = {
  id: 'run-1',
  threadId: 'thread-1',
  command: 'plan',
  prompt: '规划全书大纲',
  status: 'running',
  startedAt: '2026-05-19T00:00:00.000Z',
  projectPath: '/novels/stars',
  target: {
    sectionId: 'blueprint',
    tabId: 'master-outline',
    objectId: 'master-outline',
  },
}

const masterOutlineTab: WorkbenchTabItem = {
  id: 'master-outline',
  title: '全局大纲',
  objectId: 'master-outline',
  exists: false,
  emptyTitle: '全局大纲尚未生成',
  emptyDescription: '全局大纲缺失。',
  emptyAction: { label: '生成全局大纲', prompt: '请生成全局大纲。' },
}

const masterOutlineItem: NovelWorkbenchTreeItem = {
  id: 'master-outline',
  kind: 'master-outline',
  title: '全书大纲',
  level: 0,
  exists: false,
}

const project: NovelProjectDetail = {
  id: 'novel-1',
  title: '星辰大海',
  path: '/novels/stars',
  status: 'ready',
  chapterProgress: '1 / 4 章',
  wordCountLabel: '2100 字',
  tocItems: [
    { id: 'volume-1', kind: 'volume', title: '第 1 卷', volumeNumber: 1 },
    {
      id: 'chapter-1',
      kind: 'chapter',
      title: '第 001 章 · 初醒',
      chapterNumber: 1,
      volumeNumber: 1,
      status: 'completed',
    },
    {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'planned',
    },
  ],
  treeItems: [
    { id: 'master-outline', kind: 'master-outline', title: '全书大纲', level: 0, exists: false },
    { id: 'volume-1', kind: 'volume', title: '第 1 卷', level: 0, volumeNumber: 1 },
    {
      id: 'volume-outline-1',
      kind: 'volume-outline',
      title: '卷大纲',
      level: 1,
      parentId: 'volume-1',
      volumeNumber: 1,
      exists: false,
    },
    {
      id: 'chapter-2',
      kind: 'chapter',
      title: '第 002 章 · 远行',
      level: 1,
      parentId: 'volume-1',
      chapterNumber: 2,
      volumeNumber: 1,
      status: 'planned',
    },
    {
      id: 'bible-premise',
      kind: 'bible-document',
      title: '核心前提',
      level: 1,
      parentId: 'foundation',
      exists: false,
    },
    { id: 'references', kind: 'reference-list', title: '参考作品', level: 0, exists: false },
  ],
}

describe('workbench generation state', () => {
  test('matches a running Agent target to the active workbench tab', () => {
    expect(
      resolveWorkbenchGenerationState({
        activeRun: runningPlan,
        activeTab: masterOutlineTab,
        selectedItem: masterOutlineItem,
        selectedSectionId: 'blueprint',
      }),
    ).toEqual({
      phase: 'running',
      label: '全局大纲',
      statusText: '正在生成全局大纲',
    })
  })

  // 回归钉：Agent 一发问 run 就转 waiting-user，原判定只认 running 会让内容区退回空态，
  // 作者看到的是「点了按钮又变回原样」，而 Agent 正在右侧干等。
  test('keeps holding the content area while the Agent waits for the author', () => {
    expect(
      resolveWorkbenchGenerationState({
        activeRun: { ...runningPlan, status: 'waiting-user' },
        activeTab: masterOutlineTab,
        pendingQuestion: { questionRequestId: 'question-1', prompt: '这本书的叙述人称用第几人称？' },
        selectedItem: masterOutlineItem,
        selectedSectionId: 'blueprint',
      }),
    ).toEqual({
      phase: 'waiting-user',
      label: '全局大纲',
      statusText: 'NarraCat 在等你回答',
      pendingQuestion: { questionRequestId: 'question-1', prompt: '这本书的叙述人称用第几人称？' },
    })
  })

  test('still holds the content area when the pending question pointer is missing', () => {
    expect(
      resolveWorkbenchGenerationState({
        activeRun: { ...runningPlan, status: 'waiting-user' },
        activeTab: masterOutlineTab,
        selectedItem: masterOutlineItem,
        selectedSectionId: 'blueprint',
      }),
    ).toEqual({
      phase: 'waiting-user',
      label: '全局大纲',
      statusText: 'NarraCat 在等你回答',
    })
  })

  test('keeps the sidebar marker while waiting, flagged as waiting rather than generating', () => {
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: { ...runningPlan, status: 'waiting-user' },
        project,
      }),
    ).toEqual({ phase: 'waiting-user', kind: 'primary', id: 'blueprint' })
  })

  test('ignores running Agent targets for a different workbench page', () => {
    expect(
      resolveWorkbenchGenerationState({
        activeRun: runningPlan,
        activeTab: {
          ...masterOutlineTab,
          id: 'volume-outline-1',
          title: '第一卷',
          objectId: 'volume-outline-1',
        },
        selectedItem: {
          ...masterOutlineItem,
          id: 'volume-outline-1',
          kind: 'volume-outline',
          title: '卷大纲',
        },
        selectedSectionId: 'blueprint',
      }),
    ).toBeNull()
  })

  test('maps a running chapter target to the matching sidebar chapter row', () => {
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: {
          ...runningPlan,
          target: {
            sectionId: 'blueprint',
            tabId: 'chapter-2',
            objectId: 'chapter-2',
          },
        },
        project,
      }),
    ).toEqual({ phase: 'running', kind: 'chapter', id: 'chapter-2' })
  })

  test('maps a running volume outline target to the parent sidebar volume row', () => {
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: {
          ...runningPlan,
          target: {
            sectionId: 'blueprint',
            tabId: 'volume-outline-1',
            objectId: 'volume-outline-1',
          },
        },
        project,
      }),
    ).toEqual({ phase: 'running', kind: 'volume', id: 'volume-1' })
  })

  test('maps non-directory targets to their primary sidebar section', () => {
    expect(resolveWorkbenchSidebarGenerationTarget({ activeRun: runningPlan, project })).toEqual({
      phase: 'running',
      kind: 'primary',
      id: 'blueprint',
    })
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: {
          ...runningPlan,
          command: 'setup',
          target: {
            sectionId: 'settings',
            tabId: 'bible-premise',
            objectId: 'bible-premise',
          },
        },
        project,
      }),
    ).toEqual({ phase: 'running', kind: 'primary', id: 'settings' })
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: {
          ...runningPlan,
          command: 'reference',
          target: {
            sectionId: 'reference-works',
            tabId: 'references',
            objectId: 'references',
          },
        },
        project,
      }),
    ).toEqual({ phase: 'running', kind: 'primary', id: 'reference-works' })
  })

  test('ignores completed runs and runs for a different project in the sidebar', () => {
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: { ...runningPlan, status: 'complete', finishedAt: '2026-05-19T00:01:00.000Z' },
        project,
      }),
    ).toBeNull()
    expect(
      resolveWorkbenchSidebarGenerationTarget({
        activeRun: { ...runningPlan, projectPath: '/novels/other' },
        project,
      }),
    ).toBeNull()
  })
})
