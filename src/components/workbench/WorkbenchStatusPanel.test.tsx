import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  CurrentArcBlock,
  ForeshadowingBlock,
  ReferencesBlock,
  ReviewFailuresBlock,
  WorkbenchStatusPanelView,
} from './WorkbenchStatusPanel'
import type { StatusNextStep } from '@/lib/workbench-actions'
import type { WorkbenchStatusPhase } from '@/lib/workbench-status-store'
import type { NovelStatusForeshadowing, NovelStatusSnapshot } from '@shared/types/novel'

function snapshotFixture(overrides: Partial<NovelStatusSnapshot> = {}): NovelStatusSnapshot {
  return {
    generatedAt: '2026-06-15T08:00:00.000Z',
    book: { title: '星辰大海', genre: '科幻' },
    progress: {
      completedChapters: 1,
      totalChaptersPlanned: 2,
      percentage: 50,
      inProgressChapter: null,
      wordCountTotal: 2100,
      avgWordsPerChapter: 2100,
    },
    checkpoint: { lastCommand: 'write 5', lastStep: 3, timestamp: '2026-06-14T10:00:00.000Z' },
    nextAction: { chapter: 2 },
    ...overrides,
  }
}

function render({
  phase,
  snapshot,
  error = null,
  lifecycleIndex,
  nextStep,
}: {
  phase: WorkbenchStatusPhase
  snapshot: NovelStatusSnapshot | null
  error?: string | null
  lifecycleIndex?: number | null
  nextStep?: StatusNextStep
}): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
      <WorkbenchStatusPanelView
        phase={phase}
        snapshot={snapshot}
        error={error}
        lifecycleIndex={lifecycleIndex}
        nextStep={nextStep}
        onRefresh={() => {}}
      />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('WorkbenchStatusPanelView', () => {
  test('empty phase shows the restrained guide with a trigger button', () => {
    const html = render({ phase: 'empty', snapshot: null })

    expect(html).toContain('data-status-phase="empty"')
    expect(html).toContain('还没有状态快照')
    expect(html).toContain('data-workbench-status-empty-action="true"')
    expect(html).toContain('查看状态')
  })

  test('loaded phase renders progress, word count and a refresh action', () => {
    const html = render({ phase: 'loaded', snapshot: snapshotFixture() })

    expect(html).toContain('data-status-phase="loaded"')
    expect(html).toContain('data-workbench-status-snapshot="true"')
    // 内容顶部书头：小说封面 + 大标题
    expect(html).toContain('data-status-book-header="true"')
    expect(html).toContain('星辰大海')
    expect(html).toContain('章节完成度')
    expect(html).toContain('2100 字')
    // 「下一步」不再由快照章号驱动（改阶段感知，需 project）；裸快照不再泄露「第 2 章」。
    expect(html).not.toContain('data-status-metric="下一步"')
    expect(html).not.toContain('第 2 章')
    expect(html).toContain('更新于')
    expect(html).toContain('data-workbench-status-refresh="true"')
    // 完成态刷新按钮可点击（无 disabled 属性）。
    expect(html).not.toContain('disabled=""')
  })

  test('中断进度卡用作者大白话，不出现「断点」开发黑话（#407）', () => {
    const withCheckpoint = render({ phase: 'loaded', snapshot: snapshotFixture() })

    expect(withCheckpoint).toContain('data-status-section="checkpoint"')
    expect(withCheckpoint).toContain('上次中断的进度')
    expect(withCheckpoint).not.toContain('断点')
    // 引擎落盘格式「write 5」须翻成人读任务名，不裸露英文命令
    expect(withCheckpoint).toContain('写下一章（第 5 章）')
    expect(withCheckpoint).not.toContain('write 5')

    const emptyState = render({ phase: 'empty', snapshot: null })

    expect(emptyState).not.toContain('断点')
  })

  test('lifecycle card renders the stepper and the stage-aware next-step action', () => {
    const html = render({
      phase: 'loaded',
      snapshot: snapshotFixture(),
      lifecycleIndex: 2,
      nextStep: {
        kind: 'action',
        action: {
          id: 'status-next-write',
          kind: 'agent',
          label: '写第 2 章',
          description: '按当前写作阶段推进本章正文。',
          enabled: true,
          command: 'write-next',
          prompt: '写本章',
          target: { sectionId: 'blueprint', tabId: 'chapter-2', objectId: 'chapter-2' },
        },
      },
    })

    // 生命周期 stepper（立项 → 大纲 → 连载 → 完结）+ 当前阶段下标
    expect(html).toContain('data-status-lifecycle="2"')
    expect(html).toContain('立项')
    expect(html).toContain('连载')
    expect(html).toContain('完结')
    // 阶段感知「下一步」CTA
    expect(html).toContain('下一步')
    expect(html).toContain('写第 2 章')
    expect(html).toContain('按当前写作阶段推进本章正文。')
    expect(html).toContain('data-status-next-step-action="status-next-write"')
  })

  test('lifecycle card shows the finished state when the whole book is done', () => {
    const html = render({ phase: 'loaded', snapshot: snapshotFixture(), lifecycleIndex: 3, nextStep: { kind: 'done' } })

    expect(html).toContain('data-status-lifecycle="3"')
    expect(html).toContain('data-status-next-step="done"')
    expect(html).toContain('全书已完成')
    expect(html).not.toContain('data-status-next-step-action')
  })

  test('enriched blocks are organized under a shadcn Tabs control (下 4 进 Tab)', () => {
    const html = render({
      phase: 'loaded',
      snapshot: snapshotFixture({
        currentArc: null,
        foreshadowing: [],
        reviewFailures: [],
        references: { sourceCount: 0, guidanceGenerated: false },
      }),
    })

    // 用 shadcn Tabs（含框分段控件），非贯穿式 tabbar
    expect(html).toContain('data-status-tabs="true"')
    expect(html).toContain('data-slot="tabs-list"')
    expect(html).toContain('data-slot="tabs-trigger"')
    expect(html).toContain('data-status-tab="current-arc"')
    expect(html).toContain('data-status-tab="foreshadowing"')
    expect(html).toContain('data-status-tab="review-failures"')
    expect(html).toContain('data-status-tab="references"')
  })

  test('refreshing phase dims content in place (no layout-shifting loading bar) and disables refresh', () => {
    const html = render({ phase: 'refreshing', snapshot: snapshotFixture() })

    expect(html).toContain('data-status-phase="refreshing"')
    // 内容原地渐隐，不插入撑高布局的长条 loading（避免页面上下跳动）。
    expect(html).toContain('data-status-refreshing="true"')
    expect(html).not.toContain('data-workbench-generation-status="true"')
    // 更新进行中禁止重复触发（按钮禁用）。
    expect(html).toContain('data-workbench-status-refresh="true"')
    expect(html).toContain('disabled=""')
  })

  test('failed phase keeps the last snapshot and offers a retry', () => {
    const html = render({ phase: 'failed', snapshot: snapshotFixture(), error: '聚合失败' })

    expect(html).toContain('data-status-phase="failed"')
    expect(html).toContain('data-workbench-status-failure="true"')
    expect(html).toContain('状态更新失败')
    expect(html).toContain('聚合失败')
    expect(html).toContain('data-workbench-status-retry="true"')
    // 不抹掉上一次成功的快照展示。
    expect(html).toContain('章节完成度')
  })

  test('failed phase with no prior snapshot falls back to the empty guide plus failure banner', () => {
    const html = render({ phase: 'failed', snapshot: null, error: '读取失败' })

    expect(html).toContain('data-workbench-status-failure="true"')
    expect(html).toContain('还没有状态快照')
  })


  test('broken project shows plain-language guidance and a way back instead of retry', () => {
    // 对损坏项目重试一万次都是同一个错。作者需要的是「这本书的文件不完整」+ 一条出路，
    // 而不是一个永远点不出结果的重试按钮，更不是 IPC 实现细节。
    const html = render({
      phase: 'failed',
      snapshot: null,
      error: '缺少 .narracat/config.yaml 或 .narracat/state.yaml',
    })

    expect(html).toContain('data-workbench-status-failure="true"')
    expect(html).toContain('data-workbench-status-back-to-library="true"')
    expect(html).not.toContain('data-workbench-status-retry="true"')
    expect(html).not.toContain('.narracat/config.yaml')
  })

  test('enriched snapshot shows the default 当前剧情 tab plus triggers for the other groups', () => {
    const snapshot = snapshotFixture({
      currentArc: {
        arcId: 'arc-2',
        volumeNo: 2,
        title: '远征篇',
        chapterStart: 11,
        chapterEnd: 25,
        coreQuestion: '盟友是否可信？',
        irreversibleChange: '旧身份暴露',
      },
      foreshadowing: [],
      reviewFailures: [],
      references: { sourceCount: 0, guidanceGenerated: false },
    })
    const html = render({ phase: 'loaded', snapshot })

    // 默认激活 tab = 当前剧情：大气卡片展示篇章标题 + 核心悬念。
    expect(html).toContain('data-status-section="current-arc"')
    expect(html).toContain('远征篇')
    expect(html).toContain('盟友是否可信？')
    // 其余 3 组作为 tab 触发器（标签可见，内容点了才渲染）。
    expect(html).toContain('当前剧情')
    expect(html).toContain('伏笔')
    expect(html).toContain('未过审')
  })

  test('omits enriched blocks entirely for a state.yaml-only snapshot', () => {
    // #238 形状快照（无 memory.db 丰富字段）→ 不渲染丰富区块。
    const html = render({ phase: 'loaded', snapshot: snapshotFixture() })

    expect(html).not.toContain('data-status-tabs="true"')
    expect(html).not.toContain('data-status-section="current-arc"')
  })
})

const foreshadowingFixture: NovelStatusForeshadowing = {
  id: 'F-001',
  type: 'major',
  description: '神秘信物',
  state: 'developing',
  plantedChapter: 2,
  targetReveal: '8',
  overdue: true,
}

describe('status enriched blocks (tab 内容)', () => {
  test('ForeshadowingBlock：卡片网格 + 类型/状态分色标签 + 临期标注', () => {
    const html = renderToStaticMarkup(<ForeshadowingBlock items={[foreshadowingFixture]} />)
    // 网格容器 + 单卡
    expect(html).toContain('data-status-foreshadowing-list="true"')
    expect(html).toContain('grid-cols-3')
    expect(html).toContain('data-status-foreshadowing="F-001"')
    // 机器字段映射成人话（major→大 / developing→推进中）+ 分色标签 + 临期
    expect(html).toContain('大伏笔')
    expect(html).toContain('推进中')
    expect(html).toContain('text-warning')
    expect(html).toContain('data-status-foreshadowing-overdue="true"')
    expect(html).toContain('临期未兑现')
    expect(html).toContain('目标第 8 章揭示')
  })

  test('ForeshadowingBlock：空 → 中性文案', () => {
    expect(renderToStaticMarkup(<ForeshadowingBlock items={[]} />)).toContain('暂无追踪中的伏笔')
  })

  test('ReviewFailuresBlock：未过审计数 + 章号；空 → 全部通过', () => {
    const html = renderToStaticMarkup(<ReviewFailuresBlock chapters={[4, 7]} />)
    expect(html).toContain('共 2 章未通过审校')
    expect(html).toContain('data-status-review-fail-chapter="4"')
    expect(renderToStaticMarkup(<ReviewFailuresBlock chapters={[]} />)).toContain('全部通过')
  })

  test('ReferencesBlock：篇数与参考指导状态', () => {
    const withRefs = snapshotFixture({ references: { sourceCount: 3, guidanceGenerated: true } })
    expect(renderToStaticMarkup(<ReferencesBlock snapshot={withRefs} />)).toContain('3 篇原文')
    expect(renderToStaticMarkup(<ReferencesBlock snapshot={withRefs} />)).toContain('参考指导已生成')
    // 无参考原文 → 品牌插图空态（与设定集空页一致）
    const noRefs = snapshotFixture({ references: { sourceCount: 0, guidanceGenerated: false } })
    expect(renderToStaticMarkup(<ReferencesBlock snapshot={noRefs} />)).toContain('暂无参考作品')
  })

  test('CurrentArcBlock：缺剧情 → 中性占位', () => {
    expect(renderToStaticMarkup(<CurrentArcBlock arc={null} />)).toContain('暂无当前剧情线')
  })
})
