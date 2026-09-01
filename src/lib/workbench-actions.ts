import type { AgentComposerAdjustSpec, AgentQuickAction, AgentRunTarget } from '@/types/agent'
import type { NovelProjectDetail, NovelWorkbenchArtifacts, NovelWorkbenchTreeItem } from '@shared/types/novel'
import type { WorkbenchChapterView } from '@shared/types/workbench'
import { workbenchObjectIdForChapter } from './workbench-selection'
import type { WorkbenchPrimarySectionId, WorkbenchTabItem } from './workbench-navigation'

export type WorkbenchActionKind = 'client' | 'agent' | 'composer-handoff'
export type WorkbenchActionPlacement = 'primary' | 'secondary' | 'utility' | 'copy' | 'refresh' | 'more'

export interface WorkbenchActionTarget extends AgentRunTarget {
  sectionId: WorkbenchPrimarySectionId
}

export interface WorkbenchAction {
  id: string
  kind: WorkbenchActionKind
  label: string
  description: string
  enabled: boolean
  disabledReason?: string
  command?: AgentQuickAction
  prompt?: string
  adjust?: AgentComposerAdjustSpec
  target?: WorkbenchActionTarget
  omitSelectedChapter?: boolean
  placement?: WorkbenchActionPlacement
  selectedChapter?: number
  danger?: boolean
  disableWhileAgentBusy?: boolean
  resetReferenceGuidanceBeforeRun?: boolean
}

const SETUP_TAB_IDS = new Set(['foundation', 'bible-premise'])

function hasArtifact(artifacts: NovelWorkbenchArtifacts | null, id: string): boolean {
  return Boolean(artifacts?.artifacts.some((artifact) => artifact.id === id && artifact.exists))
}

/**
 * 正文「就绪」只认正式正文；写作中断留下的 staging 草稿只读预览（刀 3 §4.6），不算就绪——
 * 编辑/版本历史/调整正文/同步记忆/重新审修等动作面板据此隐藏，避免把草稿当正式正文操作。
 */
function hasReadyManuscript(artifacts: NovelWorkbenchArtifacts | null): boolean {
  return Boolean(
    artifacts?.artifacts.some((artifact) => artifact.id === 'manuscript' && artifact.exists && !artifact.isDraft),
  )
}

function hasDisplayableWorkbenchArtifact(artifacts: NovelWorkbenchArtifacts | null): boolean {
  return Boolean(
    artifacts?.artifacts.some((artifact) => {
      if (!artifact.exists) return false
      if (typeof artifact.content === 'string') return artifact.content.trim().length > 0
      return artifact.data !== undefined
    }),
  )
}

function formatVolumeArgument(volumeNumber: number | undefined): string {
  return `vol-${String(volumeNumber ?? 1).padStart(2, '0')}`
}

function createRefreshAction(): WorkbenchAction {
  return {
    id: 'refresh-project',
    kind: 'client',
    label: '刷新',
    description: '重新读取项目文件',
    enabled: true,
    placement: 'refresh',
  }
}

export function shouldShowEmptyTabGuide({
  activeTab,
  artifacts,
  loading,
  selectedItem,
}: {
  activeTab: WorkbenchTabItem | null
  artifacts: NovelWorkbenchArtifacts | null
  loading: boolean
  selectedItem: NovelWorkbenchTreeItem | null
}): boolean {
  if (!activeTab || !selectedItem || selectedItem.kind === 'chapter') return false
  if (activeTab.objectId !== selectedItem.id) return false
  if (hasDisplayableWorkbenchArtifact(artifacts)) return false
  if (!artifacts && (loading || selectedItem.exists !== false)) return false
  return true
}

export function buildWorkbenchActionRegions({
  agentBusy = false,
  actions,
  activeTab,
  artifacts,
  loading,
  sectionId,
  selectedItem,
}: {
  actions: WorkbenchAction[]
  activeTab: WorkbenchTabItem | null
  artifacts: NovelWorkbenchArtifacts | null
  loading: boolean
  sectionId: WorkbenchPrimarySectionId
  selectedItem: NovelWorkbenchTreeItem | null
  agentBusy?: boolean
}): { titlebarActions: WorkbenchAction[]; emptyGuideAction: WorkbenchAction | null } {
  const emptyGuideAction =
    shouldShowEmptyTabGuide({ activeTab, artifacts, loading, selectedItem }) && activeTab
      ? disableAgentActionsWhileBusy([createEmptyTabAction(activeTab, sectionId)], agentBusy)[0]
      : null
  const titlebarActions = disableAgentActionsWhileBusy(
    actions.filter((action) => {
      if (action.kind === 'client') return true
      if (emptyGuideAction) return false
      return action.enabled
    }),
    agentBusy ?? false,
  )

  return { titlebarActions, emptyGuideAction }
}

export function disableAgentActionsWhileBusy(actions: WorkbenchAction[], busy: boolean): WorkbenchAction[] {
  if (!busy) return actions

  return actions.map((action) => {
    if ((action.kind === 'client' && !action.disableWhileAgentBusy) || !action.enabled) return action

    return {
      ...action,
      enabled: false,
      disabledReason: 'Agent 正在运行，请等待当前任务完成。',
    }
  })
}

function emptyTabCommand(tab: WorkbenchTabItem, sectionId: WorkbenchPrimarySectionId): AgentQuickAction {
  if (sectionId === 'blueprint') return 'plan'
  return isSetupTab(tab) ? 'setup' : 'world'
}

function isSetupTab(tab: WorkbenchTabItem): boolean {
  return SETUP_TAB_IDS.has(tab.objectId) || SETUP_TAB_IDS.has(tab.id)
}

function createTargetedPrompt(tab: WorkbenchTabItem, target: WorkbenchActionTarget): string {
  return [
    tab.emptyAction.prompt,
    '',
    `目标：${tab.title}（sectionId: ${target.sectionId}，tabId: ${target.tabId}，objectId: ${target.objectId}）。`,
  ].join('\n')
}

function settingsTabTarget(tabId: string): WorkbenchActionTarget {
  return { sectionId: 'settings', tabId, objectId: tabId }
}

function settingsTargetFor(item: NovelWorkbenchTreeItem): WorkbenchActionTarget {
  return settingsTabTarget(item.id)
}

function chapterTargetFor(item: NovelWorkbenchTreeItem): WorkbenchActionTarget {
  return {
    sectionId: 'blueprint',
    tabId: item.id,
    objectId: item.id,
  }
}

function blueprintTargetForObject(objectId: string): WorkbenchActionTarget {
  return {
    sectionId: 'blueprint',
    tabId: objectId,
    objectId,
  }
}

function volumeOutlineTargetFor(project: NovelProjectDetail, item: NovelWorkbenchTreeItem): WorkbenchActionTarget {
  const outlineItem =
    item.kind === 'volume-outline'
      ? item
      : project.treeItems.find(
          (candidate) => candidate.kind === 'volume-outline' && candidate.volumeNumber === item.volumeNumber,
        )
  return blueprintTargetForObject(outlineItem?.id ?? item.id)
}

function volumeHasCompletedChapters(project: NovelProjectDetail, volumeNumber: number | undefined): boolean {
  return project.tocItems.some(
    (item) => item.kind === 'chapter' && item.volumeNumber === volumeNumber && item.status === 'completed',
  )
}

function createComposerHandoffAction({
  command,
  description,
  id,
  label = '调整内容',
  placement = 'primary',
  target,
  targetLabel,
  verb = '调整',
  selectedChapter,
  danger,
}: {
  command: AgentQuickAction
  description: string
  id: string
  label?: string
  placement?: WorkbenchActionPlacement
  target: WorkbenchActionTarget
  targetLabel: string
  verb?: string
  selectedChapter?: number
  danger?: boolean
}): WorkbenchAction {
  return {
    id,
    kind: 'composer-handoff',
    label,
    description,
    enabled: true,
    command,
    prompt: '',
    adjust: { targetLabel, verb },
    target,
    placement,
    selectedChapter,
    danger,
  }
}

function settingsHandoffCommand(item: NovelWorkbenchTreeItem): AgentQuickAction | null {
  if (item.kind === 'reference-list' || item.parentId === 'references' || item.id.startsWith('reference-')) return null
  // 已存在的立项卡：内容修改走定点修订（级联保护）；创作根基父节点仍走全量立项
  if (item.id === 'bible-premise') return 'revise-premise'
  if (SETUP_TAB_IDS.has(item.id)) return 'setup'
  return 'world'
}

function settingsHandoffTargetLabel(item: NovelWorkbenchTreeItem): string {
  if (item.kind === 'character') return `角色设定《${item.title}》`
  if (item.kind === 'world') return `世界观设定《${item.title}》`
  if (item.kind === 'character-list') return '角色设定'
  if (item.kind === 'world-list') return '世界观设定'
  return item.title
}

function isSettingsAdjustmentItem(item: NovelWorkbenchTreeItem): boolean {
  return (
    item.kind === 'foundation' ||
    item.kind === 'bible-document' ||
    item.kind === 'bible-group' ||
    item.kind === 'character-list' ||
    item.kind === 'character' ||
    item.kind === 'world-list' ||
    item.kind === 'world' ||
    item.kind === 'reference-list'
  )
}

function createExistingSettingsActions({
  artifacts,
  selectedItem,
}: {
  artifacts: NovelWorkbenchArtifacts | null
  selectedItem: NovelWorkbenchTreeItem
}): WorkbenchAction[] | null {
  if (!isSettingsAdjustmentItem(selectedItem)) return null

  const command = settingsHandoffCommand(selectedItem)
  if (!command) return [createRefreshAction()]
  if (!hasDisplayableWorkbenchArtifact(artifacts)) return null

  return [
    createRefreshAction(),
    createComposerHandoffAction({
      id: `adjust-${selectedItem.id}`,
      command,
      description: `将${settingsHandoffTargetLabel(selectedItem)}的调整要求交给右侧 Agent。`,
      target: settingsTargetFor(selectedItem),
      targetLabel: settingsHandoffTargetLabel(selectedItem),
    }),
  ]
}

function createExistingOutlineActions({
  id,
  target,
  targetLabel,
}: {
  id: string
  target: WorkbenchActionTarget
  targetLabel: string
}): WorkbenchAction[] {
  return [
    createRefreshAction(),
    createComposerHandoffAction({
      id,
      command: 'plan',
      description: `将${targetLabel}的调整要求交给右侧 Agent。`,
      target,
      targetLabel,
    }),
  ]
}

export function createEmptyTabAction(tab: WorkbenchTabItem, sectionId: WorkbenchPrimarySectionId): WorkbenchAction {
  const target: WorkbenchActionTarget = {
    sectionId,
    tabId: tab.id,
    objectId: tab.objectId,
  }

  return {
    id: `generate-empty-${tab.id}`,
    kind: 'agent',
    label: tab.emptyAction.label,
    description: tab.emptyDescription,
    enabled: true,
    command: emptyTabCommand(tab, sectionId),
    prompt: createTargetedPrompt(tab, target),
    target,
  }
}

export function createSequentialOutlineAction(target?: WorkbenchActionTarget): WorkbenchAction {
  return {
    id: 'plan-next-missing-outline',
    kind: 'agent',
    label: '按序补充大纲',
    description: '按章节顺序从最前面缺少大纲的章节开始补齐。',
    enabled: true,
    command: 'plan',
    prompt: '按顺序补充缺失的章节大纲',
    omitSelectedChapter: true,
    target,
  }
}

export function createWriteCurrentChapterAction(target?: WorkbenchActionTarget, chapterNumber?: number): WorkbenchAction {
  return {
    id: 'write-current-chapter',
    kind: 'agent',
    label: chapterNumber && chapterNumber > 0 ? `写第 ${chapterNumber} 章` : '写本章',
    description: '按当前写作阶段推进本章正文。',
    enabled: true,
    command: 'write-next',
    prompt: '写本章',
    target,
  }
}

/**
 * 「去写第 N 章」：用户点开的不是当前应写章节时，空态给一条回到当前章的路。
 *
 * 在这之前该空态只有一句「轮到本章时，这里会提供写作入口」、没有任何按钮——遥测显示 25 台设备
 * 建完立项卡后在各模块间逛了几小时却一次都没写，写作入口需要「点进正好是当前章的那一章」才出现，
 * 是这条死胡同的一部分。这里只做导航（kind: 'client'），真正的写作动作仍由当前章空态的
 * createWriteCurrentChapterAction 提供，两者职责不混。
 */
export function createGoToCurrentChapterAction(currentChapterId: string, chapterNumber?: number | null): WorkbenchAction {
  return {
    id: 'go-to-current-chapter',
    kind: 'client',
    label: chapterNumber && chapterNumber > 0 ? `去写第 ${chapterNumber} 章` : '去当前章',
    description: '跳到当前应该写的章节。',
    enabled: true,
    target: { sectionId: 'blueprint', tabId: currentChapterId, objectId: currentChapterId },
  }
}

export function createRecoverCurrentChapterAction(target?: WorkbenchActionTarget): WorkbenchAction {
  return {
    id: 'recover-current-chapter',
    kind: 'agent',
    label: '继续完成本章',
    description: '从上次中断的进度继续完成本章。',
    enabled: true,
    command: 'recover-write',
    prompt: '继续完成本章',
    target,
  }
}

function createReferenceWorksActions(artifacts: NovelWorkbenchArtifacts | null): WorkbenchAction[] {
  const target: WorkbenchActionTarget = {
    sectionId: 'reference-works',
    tabId: 'references',
    objectId: 'references',
  }
  const summary = artifacts?.referenceWorksSummary
  const hasSources = Boolean(summary?.status.sourceCount)
  const hasGuidance = Boolean(summary?.status.guidanceExists)
  const needsAnalysis = Boolean(summary?.status.needsAnalysis)

  return [
    createRefreshAction(),
    ...(hasSources && (needsAnalysis || !hasGuidance)
      ? [
          {
            id: 'analyze-reference-works',
            kind: 'agent' as const,
            label: hasGuidance ? '重新分析' : '分析参考作品',
            description: '分析已添加的参考作品，并生成项目级参考指导。',
            enabled: true,
            command: 'reference' as const,
            prompt: '分析参考作品',
            target,
            resetReferenceGuidanceBeforeRun: hasGuidance,
          },
        ]
      : []),
    ...(hasSources && hasGuidance && !needsAnalysis
      ? [
          {
            id: 'analyze-reference-works',
            kind: 'agent' as const,
            label: '重新分析',
            description: '重新分析已添加的参考作品，并替换当前参考指导。',
            enabled: true,
            command: 'reference' as const,
            prompt: '分析参考作品',
            target,
            placement: 'more' as const,
            resetReferenceGuidanceBeforeRun: true,
          },
          {
            id: 'reset-reference-works',
            kind: 'client' as const,
            label: '重置参考作品',
            description: '清空参考来源和参考指导。',
            enabled: true,
            placement: 'more' as const,
            danger: true,
            disableWhileAgentBusy: true,
          },
        ]
      : []),
  ]
}

/**
 * 状态页「下一步」：跟创作生命周期阶段走，而不是永远吐章号（#状态页重构）。
 * - 'action' 携带可直接派发的 WorkbenchAction（导航到对应版块 + 跑对应流程命令，
 *   语义与该流程空页引导按钮一致：setup / plan / write-next / recover-write）。
 * - 'done' 表示全书已完成（终态，无下一步动作）。
 * - null 表示项目无效 / 不可用。
 *
 * 阶段判定取自引擎的 project.status（needs-setup / needs-outline / ready / in-progress /
 * invalid，见 novel-project.ts）并以 tocItems 的逐章状态定位下一章动作——客户端实时算，
 * 永远准，不依赖可能过期的状态快照。
 */
export type StatusNextStep = { kind: 'action'; action: WorkbenchAction } | { kind: 'done' } | null

function statusChapterTarget(chapter: number): WorkbenchActionTarget {
  const objectId = workbenchObjectIdForChapter(chapter)
  return { sectionId: 'blueprint', tabId: objectId, objectId }
}

/**
 * 状态页生命周期 stepper 的当前阶段下标（0 立项 / 1 设定 / 2 大纲 / 3 连载 / 4 完结）。
 * 项目无效 / 缺失时返回 null（不渲染 stepper）。
 */
/**
 * 创作链里「立项卡之后、大纲之前」那一格：有了立项卡但一个角色档案都还没有。
 *
 * stepper 的阶段下标与当前任务指针**共用这一处判定**——两边各写一遍 status + hasCharacters
 * 的话，改一处漏一处就会出现「指针让去建角色、stepper 显示已经在大纲」这类自相矛盾
 * （本轮外审正是抓到这个漂移风险）。判据本身与引擎 plan.md 的前置检查对齐。
 */
function needsCharacterSettings(project: NovelProjectDetail): boolean {
  return project.status === 'needs-outline' && !project.hasCharacters
}

/**
 * 这一步是「只建议、可跳过」的吗。指针据此显示「可跳过」标记——ADR-0040 说可跳过要体现在
 * 文案上，但那句话原先只写在 action.description 里，而指针从不渲染 description，
 * 作者看到的只有命令式的 label。
 */
const OPTIONAL_NEXT_STEP_IDS: ReadonlySet<string> = new Set(['status-next-world'])

export function isOptionalNextStep(action: WorkbenchAction): boolean {
  return OPTIONAL_NEXT_STEP_IDS.has(action.id)
}

export function resolveStatusLifecycleIndex(project: NovelProjectDetail | null, nextStep: StatusNextStep): number | null {
  if (!project || project.status === 'invalid') return null
  if (project.status === 'needs-setup') return 0
  // 「设定」（世界观与角色）独立成格。跳过它的作者不会卡住——直接做大纲会让 status 进 ready，
  // stepper 顺势推到「连载」，之前的格子一律显示为已走过（stepper 表达的是「当前在哪一阶段」，
  // 不是逐项打卡）。
  if (project.status === 'needs-outline') return needsCharacterSettings(project) ? 1 : 2
  if (nextStep?.kind === 'done') return 4
  return 3
}

export function resolveStatusNextStep(project: NovelProjectDetail | null): StatusNextStep {
  if (!project || project.status === 'invalid') return null

  if (project.status === 'needs-setup') {
    return {
      kind: 'action',
      action: {
        id: 'status-next-setup',
        kind: 'agent',
        label: '建立创作根基',
        description: '引导核心前提，建立小说创作根基。',
        enabled: true,
        command: 'setup',
        prompt: '开始设定引导',
        // 落到设定集「核心前提」tab：bible-premise 是真实可解析的 settings tab；
        // foundation 是聚合对象、不在 settings tabs 中，会 fallback 成裸 object 链接落回 blueprint。
        target: settingsTabTarget('bible-premise'),
      },
    }
  }

  // 创作链缺「世界观与角色」这一格时先建议补上（ADR-0040）。引擎 plan.md 的前置检查会问同一句
  // （无角色文件 → 「先去 world 创建主要角色 / 继续规划」），指针不先说，就会出现「指针推一下、
  // 引擎拦一下」的自相矛盾。判据与 plan.md 逐字对齐：只看 bible/characters 下有没有 .md。
  //
  // 只建议、不阻塞：用户想跳过就直接去点大纲（本来就点得到），大纲一做完 status 变 ready，
  // 这一格自然不再出现——所以「已跳过」不需要记录任何状态。
  if (needsCharacterSettings(project)) {
    return {
      kind: 'action',
      action: {
        id: 'status-next-world',
        kind: 'agent',
        label: '创建主要角色',
        description: '建议先创建主要角色，规划大纲时会用到；也可以跳过，直接规划大纲。',
        enabled: true,
        command: 'world',
        prompt: '创建主要角色',
        target: settingsTabTarget('characters'),
      },
    }
  }

  if (project.status === 'needs-outline') {
    return {
      kind: 'action',
      action: {
        id: 'status-next-plan',
        kind: 'agent',
        label: '规划全书大纲',
        description: '委托 Agent 规划全书、卷和章节大纲。',
        enabled: true,
        command: 'plan',
        prompt: '规划全书大纲和章节大纲',
        target: blueprintTargetForObject('master-outline'),
      },
    }
  }

  // ready / in-progress：按 tocItems 逐章状态定位下一章该做的事。
  const chapters = project.tocItems.filter((item) => item.kind === 'chapter')

  const recoverable = chapters.find((item) => item.status === 'recoverable')
  if (recoverable?.chapterNumber) {
    return {
      kind: 'action',
      action: {
        ...createRecoverCurrentChapterAction(statusChapterTarget(recoverable.chapterNumber)),
        id: 'status-next-recover',
        label: `继续完成第 ${recoverable.chapterNumber} 章`,
      },
    }
  }

  const pending = chapters.find((item) => item.status !== 'completed')
  if (!pending?.chapterNumber) {
    // 结构数据损坏时 novel-project 会给 ready/in-progress 项目带上 problem，此时空或全完成的
    // tocItems 并不代表真完结——返回 null 避免状态页误显「全书已完成」掩盖损坏（problem 由左侧栏呈现）。
    return project.problem ? null : { kind: 'done' }
  }

  const chapter = pending.chapterNumber
  if (pending.status === 'missing-outline') {
    return {
      kind: 'action',
      action: {
        ...createSequentialOutlineAction(statusChapterTarget(chapter)),
        id: 'status-next-plan-chapter',
        label: `补第 ${chapter} 章大纲`,
      },
    }
  }

  return {
    kind: 'action',
    action: {
      ...createWriteCurrentChapterAction(statusChapterTarget(chapter)),
      id: 'status-next-write',
      // interrupted-draft（写作中断留有 staging 草稿）与 in-progress 同属「已经动过手」，文案对齐。
      label:
        pending.status === 'in-progress' || pending.status === 'interrupted-draft'
          ? `继续写第 ${chapter} 章`
          : `写第 ${chapter} 章`,
    },
  }
}

export function getWorkbenchActions({
  artifacts,
  chapterView,
  project,
  selectedItem,
}: {
  artifacts: NovelWorkbenchArtifacts | null
  chapterView?: WorkbenchChapterView
  project: NovelProjectDetail | null
  selectedItem: NovelWorkbenchTreeItem | null
}): WorkbenchAction[] {
  if (!project || !selectedItem) return []

  if (selectedItem.kind === 'reference-list') {
    return createReferenceWorksActions(artifacts)
  }

  if (selectedItem.kind === 'master-outline') {
    if (hasDisplayableWorkbenchArtifact(artifacts)) {
      return createExistingOutlineActions({
        id: 'adjust-master-outline',
        target: blueprintTargetForObject('master-outline'),
        targetLabel: '全局大纲',
      })
    }

    return [
      createRefreshAction(),
      {
        id: 'plan-master-outline',
        kind: 'agent',
        label: '规划全书大纲',
        description: '委托 Agent 规划全书、卷和章节大纲',
        enabled: true,
        command: 'plan',
        prompt: '规划全书大纲和章节大纲',
        target: blueprintTargetForObject('master-outline'),
      },
    ]
  }

  if (selectedItem.kind === 'narrator-voice') {
    if (hasDisplayableWorkbenchArtifact(artifacts)) {
      return createExistingOutlineActions({
        id: 'adjust-narrator-voice',
        target: blueprintTargetForObject('master-outline'),
        targetLabel: '叙事声音',
      })
    }

    return [createRefreshAction()]
  }

  if (selectedItem.kind === 'foundation' || selectedItem.kind === 'bible-document') {
    const existingSettingsActions = createExistingSettingsActions({ artifacts, selectedItem })
    if (existingSettingsActions) return existingSettingsActions

    // foundation 是聚合父节点、自身不是可解析的 settings tab（getSettingsTabs 不含 foundation kind），
    // 直接 settingsTargetFor 会得到 settings/foundation 而 fallback 回 blueprint。聚合节点下把两个动作
    // 分别落到真实子 tab：立项引导→核心前提，补齐角色/世界观→角色列表；bible-document 节点保持自身定位。
    const isFoundationRoot = selectedItem.kind === 'foundation'
    const setupTarget = isFoundationRoot ? settingsTabTarget('bible-premise') : settingsTargetFor(selectedItem)
    const worldTarget = isFoundationRoot ? settingsTabTarget('characters') : settingsTargetFor(selectedItem)
    return [
      createRefreshAction(),
      {
        id: 'setup-foundation',
        kind: 'agent',
        label: '建立创作根基',
        description: '引导核心前提',
        enabled: true,
        command: 'setup',
        prompt: '开始设定引导',
        target: setupTarget,
      },
      {
        id: 'world-foundation',
        kind: 'agent',
        label: '补齐角色/世界观',
        description: '创建或调整角色与世界观设定',
        enabled: true,
        command: 'world',
        prompt: '创建或调整角色与世界观',
        target: worldTarget,
      },
    ]
  }

  if (
    selectedItem.kind === 'bible-group' ||
    selectedItem.kind === 'character-list' ||
    selectedItem.kind === 'character' ||
    selectedItem.kind === 'world-list' ||
    selectedItem.kind === 'world'
  ) {
    return createExistingSettingsActions({ artifacts, selectedItem }) ?? [createRefreshAction()]
  }

  if (selectedItem.kind === 'volume' || selectedItem.kind === 'volume-outline') {
    const target = volumeOutlineTargetFor(project, selectedItem)
    if (hasDisplayableWorkbenchArtifact(artifacts)) {
      return [
        ...createExistingOutlineActions({
          id: 'adjust-volume-outline',
          target,
          targetLabel: `第 ${selectedItem.volumeNumber ?? 1} 卷大纲`,
        }),
        ...(volumeHasCompletedChapters(project, selectedItem.volumeNumber)
          ? [
              createComposerHandoffAction({
                id: 'review-volume',
                command: 'review',
                label: '审修本卷',
                description: '对本卷已完成章节做整卷审修',
                target,
                targetLabel: `第 ${selectedItem.volumeNumber ?? 1} 卷`,
                verb: '审修',
                placement: 'more',
              }),
            ]
          : []),
      ]
    }

    return [
      createRefreshAction(),
      {
        id: 'plan-volume',
        kind: 'agent',
        label: '规划本卷',
        description: '围绕当前卷调整卷大纲和章节安排',
        enabled: true,
        command: 'plan',
        prompt: `规划第 ${selectedItem.volumeNumber ?? 1} 卷`,
        target,
      },
      {
        id: 'review-volume',
        kind: 'agent',
        label: '审修本卷',
        description: '对本卷已完成章节做整卷审修',
        enabled: true,
        command: 'review',
        prompt: formatVolumeArgument(selectedItem.volumeNumber),
        target,
      },
    ]
  }

  if (selectedItem.kind === 'chapter') {
    const outlineReady = hasArtifact(artifacts, 'chapter-outline')
    const manuscriptReady = hasReadyManuscript(artifacts)
    const reviewReady = hasArtifact(artifacts, 'review')
    const target = chapterTargetFor(selectedItem)
    const chapterNumber = selectedItem.chapterNumber ?? 1
    const chapterLabel = `第 ${chapterNumber} 章`
    const recoverable = selectedItem.status === 'recoverable'

    if (chapterView === 'text') {
      const editManuscriptAction: WorkbenchAction = {
        id: 'edit-manuscript',
        kind: 'client',
        label: '编辑正文',
        description: '编辑当前章节正文内容。',
        enabled: true,
        placement: 'primary',
        disableWhileAgentBusy: true,
      }
      const manuscriptHistoryAction: WorkbenchAction = {
        id: 'manuscript-history',
        kind: 'client',
        label: '版本历史',
        description: '查看、比较和恢复当前章节的已保存版本。',
        enabled: true,
        placement: 'utility',
      }
      const syncChapterMemoryAction: WorkbenchAction = {
        id: 'sync-chapter-memory-entry',
        kind: 'client',
        label: '同步本章记忆',
        description: '对照当前正文重新核对并同步本章记忆。',
        enabled: true,
        placement: 'more',
        disableWhileAgentBusy: true,
      }

      const existingTextActions = manuscriptReady
        ? [
            editManuscriptAction,
            manuscriptHistoryAction,
            {
              ...createComposerHandoffAction({
                id: 'adjust-chapter-manuscript',
                command: 'rewrite',
                description: '将当前章节正文的调整要求交给右侧 Agent。',
                target,
                targetLabel: `${chapterLabel}正文`,
                selectedChapter: chapterNumber,
              }),
              placement: 'more' as const,
            },
            syncChapterMemoryAction,
            reviewReady
              ? createComposerHandoffAction({
                  id: 'review-chapter-again',
                  command: 'review',
                  label: '重新审修',
                  description: '将重新审修当前章节的要求交给右侧 Agent。',
                  placement: 'more',
                  target,
                  targetLabel: chapterLabel,
                  verb: '重新审修',
                  selectedChapter: chapterNumber,
                })
              : {
                  id: 'review-chapter',
                  kind: 'agent' as const,
                  label: '审修当前章',
                  description: '读取正文并生成审修报告',
                  enabled: true,
                  command: 'review' as const,
                  prompt: String(chapterNumber),
                  target,
                  selectedChapter: chapterNumber,
                  placement: 'more' as const,
                },
            ...(reviewReady
              ? [
                  createComposerHandoffAction({
                    id: 'rewrite-chapter-from-review',
                    command: 'rewrite',
                    label: '根据审修重写',
                    description: '将根据审修报告重写当前章节的要求交给右侧 Agent。',
                    placement: 'more',
                    target,
                    targetLabel: `${chapterLabel}正文`,
                    verb: '根据审修重写',
                    selectedChapter: chapterNumber,
                    danger: true,
                  }),
                ]
              : []),
          ]
        : []

      return [
        createRefreshAction(),
        ...(recoverable && manuscriptReady ? [createRecoverCurrentChapterAction(target)] : []),
        ...(recoverable ? existingTextActions.map((action) => ({ ...action, placement: 'more' as const })) : existingTextActions),
      ]
    }

    if (chapterView === 'outline') {
      return outlineReady
        ? createExistingOutlineActions({
            id: 'adjust-chapter-outline',
            target,
            targetLabel: `${chapterLabel}章节大纲`,
          })
        : [createRefreshAction()]
    }

    if (chapterView === 'review') {
      if (!manuscriptReady) return [createRefreshAction()]

      return [
        createRefreshAction(),
        reviewReady
          ? createComposerHandoffAction({
              id: 'review-chapter-again',
              command: 'review',
              label: '重新审修',
              description: '将重新审修当前章节的要求交给右侧 Agent。',
              target,
              targetLabel: chapterLabel,
              verb: '重新审修',
              selectedChapter: chapterNumber,
            })
          : {
              id: 'review-chapter',
              kind: 'agent',
              label: '审修当前章',
              description: '读取正文并生成审修报告',
              enabled: true,
              command: 'review',
              prompt: String(chapterNumber),
              target,
              selectedChapter: chapterNumber,
              placement: 'primary',
            },
        ...(reviewReady
          ? [
              createComposerHandoffAction({
                id: 'rewrite-chapter-from-review',
                command: 'rewrite',
                label: '根据审修重写',
                description: '将根据审修报告重写当前章节的要求交给右侧 Agent。',
                placement: 'more',
                target,
                targetLabel: `${chapterLabel}正文`,
                verb: '根据审修重写',
                selectedChapter: chapterNumber,
                danger: true,
              }),
            ]
          : []),
      ]
    }

    const sequentialOutlineAction = createSequentialOutlineAction(target)

    return [
      createRefreshAction(),
      {
        ...sequentialOutlineAction,
        id: 'plan-chapter',
        description: '按章节顺序补齐缺失的章节大纲',
      },
      ...(recoverable ? [createRecoverCurrentChapterAction(target)] : []),
      {
        id: 'write-chapter',
        kind: 'agent',
        label: '写本章',
        description: '执行写前预检、正文生成、审修和记忆更新',
        enabled: outlineReady && !recoverable,
        disabledReason: recoverable
          ? '本章写作中断，需先继续完成本章。'
          : outlineReady
            ? undefined
            : '缺少章节大纲，需先按序补充大纲。',
        command: 'write-next',
        prompt: '写本章',
        target,
      },
      {
        id: 'review-chapter',
        kind: 'agent',
        label: '审修当前章',
        description: '读取正文并生成审修报告',
        enabled: manuscriptReady,
        disabledReason: manuscriptReady ? undefined : '正文尚未生成，需先写当前章。',
        command: 'review',
        prompt: String(selectedItem.chapterNumber ?? ''),
        target,
      },
      {
        id: 'rewrite-chapter',
        kind: 'agent',
        label: '根据审修重写',
        description: '根据审修报告修订当前章节',
        enabled: manuscriptReady && reviewReady,
        disabledReason: manuscriptReady && reviewReady ? undefined : '需要正文和审修报告都存在。',
        command: 'rewrite',
        prompt: String(selectedItem.chapterNumber ?? ''),
        target,
        danger: true,
      },
    ]
  }

  return [
    createRefreshAction(),
  ]
}
