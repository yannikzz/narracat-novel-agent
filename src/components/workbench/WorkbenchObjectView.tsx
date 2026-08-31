import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle, FileText, Loader2, Plus, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { ArtifactDocumentBody, ArtifactDocumentShell } from './artifacts/ArtifactDocumentShell'
import type { MarkdownSelectionHandoff } from './artifacts/ArtifactDocumentShell'
import { BookVoiceAnchors } from './artifacts/BookVoiceAnchors'
import { CharacterStatePanel } from './artifacts/CharacterStatePanel'
import type { CharacterDocTab } from './artifacts/CharacterStatePanel'
import { ChapterCapabilityReceipt } from './ChapterCapabilityReceipt'
import { ChapterManuscriptView } from './artifacts/ChapterManuscriptView'
import { ChapterPreview } from './artifacts/ChapterPreview'
import { NarratorVoiceSummary } from './artifacts/NarratorVoiceSummary'
import { ChapterOutlineCardsView } from './artifacts/ChapterOutlineCardsView'
import { MasterOutlineCardsView } from './artifacts/MasterOutlineCardsView'
import { OutlineView } from './artifacts/OutlineView'
import { PremiseCardsView } from './artifacts/PremiseCardsView'
import { ReviewReportView } from './artifacts/ReviewReportView'
import { ReferenceWorksView } from './ReferenceWorksView'
import { WorkbenchEmptyGuide } from './WorkbenchEmptyGuide'
import { WorkbenchEmptyState } from './WorkbenchEmptyState'
import { WorkbenchGenerationEmptyState } from './WorkbenchGenerationFrame'
import { WorkbenchObjectHeader } from './WorkbenchObjectHeader'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { MUTED_PILL_CLASS, WORKBENCH_READING_CANVAS_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import { useManuscriptEditorGuard } from '@/lib/manuscript-editor-guard'
import { resolveDeferTargets } from '@/lib/workbench-chapter-state'
import {
  resolveVisibleWorkbenchCopyDocument,
  type WorkbenchCopyDocument,
} from '@/lib/workbench-copy-document'
import { removeNarratorVoiceSection } from '@shared/lib/narrator-voice'
import { resolveCharacterProfileStageBadge } from '@/lib/character-profile-stage'
import { createAddCharacterComposerHandoff, createPromoteCandidateComposerHandoff } from '@/lib/agent-commands'
import { submitStyleAnchor } from '@/lib/ipc'
import type { WorkbenchGenerationState } from '@/lib/workbench-generation'
import {
  createWorkbenchSelectionComposerHandoff,
  resolveWorkbenchSelectionHandoff,
  type WorkbenchSelectionHandoffDescriptor,
} from '@/lib/workbench-selection-handoff'
import {
  createRecoverCurrentChapterAction,
  createSequentialOutlineAction,
  createWriteCurrentChapterAction,
  disableAgentActionsWhileBusy,
} from '@/lib/workbench-actions'
import type { WorkbenchAction } from '@/lib/workbench-actions'
import type { WorkbenchPrimarySectionId, WorkbenchTabItem } from '@/lib/workbench-navigation'
import type { AgentComposerHandoff } from '@/types/agent'
import type {
  NovelArtifact,
  NovelTocItem,
  NovelWorkbenchArtifact,
  NovelWorkbenchArtifacts,
  NovelWorkbenchTreeItem,
} from '@shared/types/novel'
import type { WorkbenchChapterView } from '@shared/types/workbench'
import type { BrandIllustrationPurpose } from '@/components/brand'

const CHAPTER_VIEWS: Array<{ value: WorkbenchChapterView; label: string }> = [
  { value: 'text', label: '正文' },
  { value: 'outline', label: '章节大纲' },
  { value: 'review', label: '审修' },
]

const CHAPTER_VIEW_ARTIFACT_IDS: Record<WorkbenchChapterView, NovelWorkbenchArtifact['id']> = {
  text: 'manuscript',
  outline: 'chapter-outline',
  context: 'context-pack',
  review: 'review',
}

const COPY_VISIBLE_DOCUMENT_ACTION: WorkbenchAction = {
  id: 'copy-visible-document',
  kind: 'client',
  label: '复制当前文档',
  description: '复制当前可见文档正文。',
  enabled: true,
  placement: 'copy',
}

function findObjectArtifact(
  artifacts: NovelWorkbenchArtifacts | null,
  id: NovelWorkbenchArtifact['id'],
): NovelWorkbenchArtifact | undefined {
  return artifacts?.artifacts.find((artifact) => artifact.id === id)
}

function resolveVisibleChapterView(chapterView: WorkbenchChapterView): WorkbenchChapterView {
  return chapterView === 'context' ? 'text' : chapterView
}

function toNovelArtifact(artifact: NovelWorkbenchArtifact | undefined): NovelArtifact | undefined {
  if (!artifact) return undefined

  const kind = artifact.id === 'chapter-outline' ? 'outline' : artifact.id
  if (kind !== 'outline' && kind !== 'manuscript' && kind !== 'context-pack' && kind !== 'review') return undefined

  return {
    kind,
    title: artifact.title,
    path: artifact.path ?? '',
    exists: artifact.exists,
    content: artifact.content,
    data: artifact.data,
    error: artifact.error,
    isDraft: artifact.isDraft,
  }
}

function hasDisplayableObjectArtifact(artifact: NovelWorkbenchArtifact): boolean {
  if (!artifact.exists) return false
  if (artifact.data && typeof artifact.data === 'object') return true
  if (typeof artifact.content === 'string') return artifact.content.trim().length > 0
  return false
}

function getDisplayableObjectArtifacts(artifacts: NovelWorkbenchArtifacts | null): NovelWorkbenchArtifact[] {
  return artifacts?.artifacts.filter(hasDisplayableObjectArtifact) ?? []
}

const CHARACTER_DOC_TABS: Array<{ value: CharacterDocTab; label: string }> = [
  { value: 'profile', label: '设定' },
  { value: 'state', label: '状态' },
]

/** 角色详情页「设定/状态」tab 栏（spec 2026-08-03 §4.1）；视觉沿用章节 tab（WorkbenchObjectHeader） */
function CharacterDocTabBar({
  active,
  onChange,
  trailing,
}: {
  active: CharacterDocTab
  onChange: (tab: CharacterDocTab) => void
  trailing?: ReactNode
}) {
  return (
    <nav aria-label="角色文档" className="mb-4 flex items-center gap-1" data-character-doc-tabbar="true">
      {CHARACTER_DOC_TABS.map((tab) => {
        const activeTab = tab.value === active
        return (
          <button
            key={tab.value}
            type="button"
            aria-current={activeTab ? 'page' : undefined}
            data-active={activeTab}
            data-character-doc-tab={tab.value}
            className={cn(
              `
                flex h-7 shrink-0 items-center rounded-row px-2.5 text-xs
                transition-colors duration-150
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                focus-visible:ring-offset-2 focus-visible:ring-offset-canvas
              `,
              activeTab
                ? 'bg-active font-semibold text-foreground'
                : 'text-muted-foreground hover:bg-hover hover:text-foreground',
            )}
            onClick={() => onChange(tab.value)}
          >
            {tab.label}
          </button>
        )
      })}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </nav>
  )
}

function CandidateCharacterGuide({
  artifact,
  onPromote,
}: {
  artifact: NovelWorkbenchArtifact
  onPromote?: () => void
}) {
  const name = artifact.characterName ?? artifact.title
  const proposedChapter =
    typeof artifact.candidateProposedChapter === 'number' ? artifact.candidateProposedChapter : null
  const isKeyCandidate = artifact.candidateImportance === 'major'

  // 走与正式角色档案同一个阅读画布（居中 820 宽 + 文档排版），避免与角色内容区割裂（dogfood 反馈）。
  return (
    <section className={WORKBENCH_READING_CANVAS_CLASS} data-workbench-candidate-guide="true">
      <div className="flex items-center gap-2">
        <span
          className="rounded-full bg-active px-2 py-0.5 text-xs font-medium text-muted-foreground"
          data-workbench-candidate-tag="true"
          data-candidate-importance={isKeyCandidate ? 'major' : 'minor'}
        >
          {isKeyCandidate ? '重要候选角色' : '次要候选角色'}
        </span>
        {proposedChapter !== null && (
          <span className="text-xs text-muted-foreground">第 {proposedChapter} 章首次出现</span>
        )}
      </div>
      <h1 className="mt-3 text-2xl font-semibold leading-tight text-foreground">{name}</h1>
      <p className="mt-4 text-base leading-8 text-body-foreground">
        「{name}」在写作中出现，已记入候选池，但还没有正式的设定档案。
        {artifact.candidateNote ? `备注：${artifact.candidateNote}` : ''}
      </p>
      <p className="mt-2 text-base leading-8 text-body-foreground">
        {isKeyCandidate
          ? '这是会影响剧情的重要角色，建议尽快让世界观 Agent 为 ta 建立设定档案。'
          : '次要角色，需要时再让世界观 Agent 为 ta 建立设定档案即可。'}
      </p>
      <div className="mt-6">
        <Button type="button" onClick={onPromote} disabled={!onPromote} data-workbench-promote-candidate="true">
          完善角色设定
        </Button>
      </div>
    </section>
  )
}

export function ObjectArtifactDocument({
  artifact,
  characterTab,
  children,
  onCharacterTabChange,
  onChanged,
  onEvaluateOutlineImpact,
  onEvaluatePremiseImpact,
  onSelectionHandoff,
  projectPath,
  selectionDescriptor,
  selectionHandoffDisabled,
}: {
  artifact: NovelWorkbenchArtifact
  /** 角色页设定/状态 tab 状态（spec 2026-08-03 §4.1）；非角色文档不使用 */
  characterTab: CharacterDocTab
  children?: ReactNode
  onCharacterTabChange: (tab: CharacterDocTab) => void
  onChanged?: () => void
  onEvaluateOutlineImpact?: (prompt: string) => void
  onEvaluatePremiseImpact?: (prompt: string) => void
  onSelectionHandoff?: (handoff: Omit<AgentComposerHandoff, 'id'>) => void
  projectPath?: string
  selectionDescriptor?: WorkbenchSelectionHandoffDescriptor | null
  selectionHandoffDisabled?: boolean
}) {
  // 候选角色（写作中出现、尚未建档）：不渲染正文，给一页引导，把建档转交世界观 Agent（ADR-0015）。
  if (artifact.isCandidateCharacter) {
    const onPromote =
      onSelectionHandoff && !selectionHandoffDisabled
        ? () => onSelectionHandoff(createPromoteCandidateComposerHandoff(artifact.characterName ?? artifact.title))
        : undefined
    return <CandidateCharacterGuide artifact={artifact} onPromote={onPromote} />
  }

  // 立项卡分组列表 + 就地写回（标记为已定）+ 重新讨论/讨论确定交 Agent（ADR-0019 step-2A）；
  // 缺契约（data）时回退默认 markdown body（引擎机械渲染的只读 premise.md）。
  if (artifact.id === 'bible-premise' && artifact.data && typeof artifact.data === 'object') {
    const onDiscuss =
      selectionDescriptor && onSelectionHandoff && !selectionHandoffDisabled
        ? (instruction: string) => {
            const handoff = createWorkbenchSelectionComposerHandoff(selectionDescriptor, instruction)
            if (handoff) onSelectionHandoff(handoff)
          }
        : undefined
    const onEvaluateImpact =
      onEvaluatePremiseImpact && !selectionHandoffDisabled ? onEvaluatePremiseImpact : undefined
    return (
      <PremiseCardsView
        artifact={artifact}
        projectPath={projectPath}
        onChanged={onChanged}
        onDiscuss={onDiscuss}
        onEvaluateImpact={onEvaluateImpact}
      />
    )
  }

  // 全书大纲：契约存在时走结构化编辑视图——四个立项卡映射字段第二档走 revise-premise，
  // stakes_progression 第二档独立走 freeform 评估，故事线名/伏笔描述第一档行内直存（spec 2026-07-12 PR1+PR2）；
  // 缺契约时整体回退人读 md（原 outline-structure 渲染路径）。
  if (artifact.id === 'master-outline' && artifact.data && typeof artifact.data === 'object') {
    return (
      <MasterOutlineCardsView
        artifact={{
          kind: 'outline',
          title: artifact.title,
          path: artifact.path ?? '',
          exists: artifact.exists,
          content: artifact.content,
          data: artifact.data,
          error: artifact.error,
        }}
        onChanged={onChanged}
        onEvaluateImpact={
          onEvaluatePremiseImpact && !selectionHandoffDisabled ? onEvaluatePremiseImpact : undefined
        }
        onEvaluateOutlineImpact={
          onEvaluateOutlineImpact && !selectionHandoffDisabled ? onEvaluateOutlineImpact : undefined
        }
        projectPath={projectPath}
      />
    )
  }

  // 叙述者腔调摘要只在「叙事声音」页展示；全局大纲页不再多余展示（dogfood 反馈：割裂、异常）。
  const showsNarratorVoiceSummary = artifact.id === 'narrator-voice'
  const rawBody = artifact.content ?? ''
  // 叙述者腔调已由上方结构化摘要展示，正文剥掉同段避免重复渲染（dogfood 反馈）。
  const body = showsNarratorVoiceSummary ? removeNarratorVoiceSection(rawBody) : rawBody
  // 角色档案完善度徽标（渐进生长 stub→sketch→full）：stub/sketch 提示「待完善/完善中」，full 不展示。
  const profileBadge = artifact.id.startsWith('character-')
    ? resolveCharacterProfileStageBadge(artifact.characterProfileStage)
    : null
  const isCharacterDoc = artifact.id.startsWith('character-') && Boolean(artifact.characterUid) && Boolean(projectPath)
  const showsProfileContent = !isCharacterDoc || characterTab === 'profile'

  return (
    <ArtifactDocumentShell
      artifact={{ kind: 'outline', title: artifact.title, path: artifact.path ?? '', exists: true, content: body }}
      title={artifact.title}
      fileInfoHidden={isCharacterDoc && characterTab === 'state'}
    >
      {isCharacterDoc && (
        <CharacterDocTabBar
          active={characterTab}
          onChange={onCharacterTabChange}
          trailing={
            profileBadge?.needsAttention ? (
              <span className={MUTED_PILL_CLASS} data-character-profile-stage="true" title={profileBadge.hint}>
                {profileBadge.label}
              </span>
            ) : undefined
          }
        />
      )}
      {isCharacterDoc && artifact.characterUid && projectPath && (
        <CharacterStatePanel
          mode={characterTab}
          projectPath={projectPath}
          characterUid={artifact.characterUid}
          characterName={artifact.characterName ?? artifact.title}
          // artifacts 每次重载都是新对象：以身份变化作平滑重取信号（F5/agent run 后状态卡跟上 memory.db）
          reloadSignal={artifact}
          onChanged={onChanged}
        />
      )}
      {showsNarratorVoiceSummary && <NarratorVoiceSummary content={artifact.content} />}
      {showsNarratorVoiceSummary && projectPath && (
        <BookVoiceAnchors projectPath={projectPath} reloadSignal={artifact} />
      )}
      {showsProfileContent && (
        <ArtifactDocumentBody
          selectionHandoff={createMarkdownSelectionHandoff({
            disabled: selectionHandoffDisabled,
            onSelectionHandoff,
            selectionDescriptor,
          })}
        >
          {body}
        </ArtifactDocumentBody>
      )}
      {children}
    </ArtifactDocumentShell>
  )
}

function WorkbenchSubcontentDirectory({
  artifacts,
  onAddCharacter,
  onSelectArtifact,
  panelId,
  selectedArtifactId,
}: {
  artifacts: NovelWorkbenchArtifact[]
  onAddCharacter?: () => void
  onSelectArtifact: (artifactId: NovelWorkbenchArtifact['id']) => void
  panelId: string
  selectedArtifactId: NovelWorkbenchArtifact['id']
}) {
  return (
    <aside
      className="
        flex min-h-0 min-w-0 flex-col border-b border-border p-6
        md:border-b-0 md:border-r md:pr-4
      "
      data-workbench-subcontent-directory="true"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-foreground">目录</h2>
        {onAddCharacter && (
          <IconTooltip label="新增角色" side="bottom" align="end">
            <button
              type="button"
              aria-label="新增角色"
              className="
                inline-flex size-5 shrink-0 items-center justify-center rounded-row text-muted-foreground
                transition-colors hover:bg-hover hover:text-foreground
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              "
              data-workbench-add-character="true"
              onClick={onAddCharacter}
            >
              <Plus className="size-3.5" />
            </button>
          </IconTooltip>
        )}
      </div>
      <div aria-label="子内容目录" className="grid min-h-0 gap-1 overflow-y-auto" role="tablist">
        {artifacts.map((artifact) => {
          const selected = artifact.id === selectedArtifactId

          return (
            <button
              key={artifact.id}
              type="button"
              aria-controls={panelId}
              aria-selected={selected}
              className={cn(
                `
                  flex min-h-8 w-full min-w-0 items-center rounded-row px-2.5 text-left text-xs
                  transition-all duration-150
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                  focus-visible:ring-offset-2 focus-visible:ring-offset-canvas
                `,
                selected
                  ? 'bg-active font-semibold text-foreground'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground',
              )}
              data-workbench-subcontent-option={artifact.id}
              role="tab"
              onClick={() => onSelectArtifact(artifact.id)}
            >
              <span className="min-w-0 truncate">{artifact.title}</span>
              {artifact.isCandidateCharacter && (
                <span
                  className="ml-auto shrink-0 rounded-full bg-active px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
                  data-workbench-candidate-tag="true"
                  data-candidate-importance={artifact.candidateImportance === 'major' ? 'major' : 'minor'}
                >
                  {artifact.candidateImportance === 'major' ? '重要候选' : '候选'}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </aside>
  )
}

function WorkbenchSubcontentBrowser({
  artifacts,
  onChanged,
  onEvaluateOutlineImpact,
  onEvaluatePremiseImpact,
  onSelectionHandoff,
  onVisibleArtifactChange,
  projectPath,
  sectionId,
  selectedItem,
  selectionHandoffDisabled,
}: {
  artifacts: NovelWorkbenchArtifact[]
  onChanged?: () => void
  onEvaluateOutlineImpact?: (prompt: string) => void
  onEvaluatePremiseImpact?: (prompt: string) => void
  onSelectionHandoff?: (handoff: Omit<AgentComposerHandoff, 'id'>) => void
  onVisibleArtifactChange?: (artifactId: NovelWorkbenchArtifact['id']) => void
  projectPath: string
  sectionId: WorkbenchPrimarySectionId
  selectedItem: NovelWorkbenchTreeItem
  selectionHandoffDisabled?: boolean
}) {
  const panelId = 'workbench-subcontent-panel'
  const panelRef = useRef<HTMLDivElement>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<NovelWorkbenchArtifact['id']>(artifacts[0]?.id ?? '')
  // 角色页设定/状态 tab 状态：跨角色保持（视图层状态，不随 artifact 切换重置，spec 2026-08-03 §4.1）
  const [characterTab, setCharacterTab] = useState<CharacterDocTab>('profile')

  useEffect(() => {
    if (!artifacts.some((artifact) => artifact.id === selectedArtifactId)) {
      setSelectedArtifactId(artifacts[0]?.id ?? '')
    }
  }, [artifacts, selectedArtifactId])

  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? artifacts[0]
  const selectedArtifactKey = selectedArtifact?.id ?? ''
  // 写作期「+ 角色」入口：仅角色目录展示，dispatch 预填的 world handoff（不依赖重跑全量立项）。
  const onAddCharacter =
    selectedItem.kind === 'character-list' && onSelectionHandoff && !selectionHandoffDisabled
      ? () => onSelectionHandoff(createAddCharacterComposerHandoff())
      : undefined

  useEffect(() => {
    if (selectedArtifactKey) {
      onVisibleArtifactChange?.(selectedArtifactKey)
      panelRef.current?.scrollTo({ top: 0, left: 0 })
    }
  }, [onVisibleArtifactChange, selectedArtifactKey])

  if (!selectedArtifact) return null

  return (
    <div
      className="
        grid h-full min-h-0 w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden
        md:grid-cols-[176px_minmax(0,1fr)] md:grid-rows-none
      "
      data-workbench-subcontent-browser="true"
    >
      <WorkbenchSubcontentDirectory
        artifacts={artifacts}
        onAddCharacter={onAddCharacter}
        panelId={panelId}
        selectedArtifactId={selectedArtifact.id}
        onSelectArtifact={setSelectedArtifactId}
      />
      <div
        ref={panelRef}
        className="min-h-0 min-w-0 overflow-auto"
        data-workbench-subcontent-panel="true"
        id={panelId}
        role="tabpanel"
      >
        <div className="min-h-full p-6" data-workbench-subcontent-panel-inner="true">
          <ObjectArtifactDocument
            artifact={selectedArtifact}
            characterTab={characterTab}
            onCharacterTabChange={setCharacterTab}
            onChanged={onChanged}
            onEvaluateOutlineImpact={onEvaluateOutlineImpact}
            onEvaluatePremiseImpact={onEvaluatePremiseImpact}
            onSelectionHandoff={onSelectionHandoff}
            projectPath={projectPath}
            selectionDescriptor={resolveWorkbenchSelectionHandoff({
              artifact: selectedArtifact,
              chapterView: 'text',
              sectionId,
              selectedItem,
            })}
            selectionHandoffDisabled={selectionHandoffDisabled}
          />
        </div>
      </div>
    </div>
  )
}

function usesSubcontentBrowser(
  selectedItem: NovelWorkbenchTreeItem | null,
  artifacts: NovelWorkbenchArtifacts | null,
): boolean {
  return selectedItem !== null && selectedItem.kind !== 'chapter' && getDisplayableObjectArtifacts(artifacts).length > 1
}

function getObjectEmptyGuidePurpose(sectionId: WorkbenchPrimarySectionId): BrandIllustrationPurpose {
  return sectionId === 'settings' ? 'setup-needed' : 'outline-needed'
}

function RecoverableChapterNotice({
  action,
  onAction,
}: {
  action: WorkbenchAction
  onAction?: (action: WorkbenchAction) => void
}) {
  return (
    <div
      className="mb-5 flex flex-col gap-3 rounded-row border border-warning/30 bg-warning/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      data-workbench-recoverable-notice="true"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <div className="font-semibold text-foreground">写作中断待恢复</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            本章上次写作中断，还有未完成的收尾。请先继续完成本章，避免直接写下一章时进度错位。
          </p>
        </div>
      </div>
      <div className="shrink-0">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0"
          disabled={!action.enabled}
          data-workbench-recoverable-action={action.id}
          onClick={() => onAction?.(action)}
        >
          <RotateCw className="size-3.5" />
          {action.label}
        </Button>
        {!action.enabled && action.disabledReason && (
          <p className="mt-1 text-xs text-hint-foreground">{action.disabledReason}</p>
        )}
      </div>
    </div>
  )
}

/**
 * write 编排 staging 只读预览（刀 3 §4.6）：正式正文缺失但写作中断留有热写/打磨中的草稿时，
 * 顶部横幅说明「只读、继续写作会自动完成验收」——不提供编辑/复制/强制采纳等入口。
 */
function InterruptedDraftNotice() {
  return (
    <div
      className="mb-5 flex items-start gap-2 rounded-row border border-warning/30 bg-warning/10 p-3 text-sm"
      data-workbench-interrupted-draft-notice="true"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="text-xs leading-5 text-muted-foreground">
        <span className="font-semibold text-foreground">写作中断的草稿（只读）</span>
        ——继续写作后会自动完成验收。
      </p>
    </div>
  )
}

function createMarkdownSelectionHandoff({
  disabled = false,
  extraActions,
  onSelectionHandoff,
  selectionDescriptor,
}: {
  disabled?: boolean
  extraActions?: MarkdownSelectionHandoff['extraActions']
  onSelectionHandoff?: (handoff: Omit<AgentComposerHandoff, 'id'>) => void
  selectionDescriptor?: WorkbenchSelectionHandoffDescriptor | null
}) {
  if (!selectionDescriptor || !onSelectionHandoff) return null

  return {
    enabled: !disabled,
    label: '交给 Agent',
    onHandoff: (selectedText: string) => {
      const handoff = createWorkbenchSelectionComposerHandoff(selectionDescriptor, selectedText)
      if (handoff) onSelectionHandoff(handoff)
    },
    extraActions,
  }
}

function buildStyleAnchorActions({
  projectPath,
  chapterNumber,
}: {
  projectPath?: string
  chapterNumber?: number
}): MarkdownSelectionHandoff['extraActions'] {
  if (!projectPath || !chapterNumber) return undefined
  return [
    {
      label: '设为本书样章',
      onAction: (selectedText: string) => {
        void submitStyleAnchor({ projectPath, action: 'add', chapter: chapterNumber, excerpt: selectedText }).then(
          (result) => {
            if (result.ok) toast.success('已设为本书样章')
            else toast.error(result.message ?? '保存失败，请稍后重试。')
          },
        )
      },
    },
  ]
}

function renderObjectBody({
  activeTab,
  artifacts,
  characterTab,
  chapterView,
  currentChapterId,
  emptyGuideAction,
  generationState,
  loading,
  onAnswerPendingQuestion,
  onCharacterTabChange,
  onEmptyGuideAction,
  onEvaluateManuscriptImpact,
  onEvaluateOutlineImpact,
  onEvaluatePremiseImpact,
  onReferenceChanged,
  onSelectionHandoff,
  onVisibleSubcontentArtifactChange,
  projectPath,
  sectionId,
  selectedItem,
  selectionHandoffDisabled,
  tocItems,
}: {
  activeTab: WorkbenchTabItem | null
  artifacts: NovelWorkbenchArtifacts | null
  /** 角色页设定/状态 tab 状态（spec 2026-08-03 §4.1）——本组件非 chapter 分支的单文档 artifact 场景使用 */
  characterTab: CharacterDocTab
  chapterView: WorkbenchChapterView
  currentChapterId?: string | null
  emptyGuideAction?: WorkbenchAction | null
  generationState?: WorkbenchGenerationState | null
  loading: boolean
  /** 内容区等待态的「去回答」：把右侧对话滚到那条待答问题（agent-store 的 focusQuestionRequest）。 */
  onAnswerPendingQuestion?: (questionRequestId: string) => void
  onCharacterTabChange: (tab: CharacterDocTab) => void
  onEmptyGuideAction?: (action: WorkbenchAction) => void
  onEvaluateManuscriptImpact?: (input: { prompt: string; chapter: number }) => void
  onEvaluateOutlineImpact?: (prompt: string) => void
  onEvaluatePremiseImpact?: (prompt: string) => void
  onReferenceChanged?: () => void
  onSelectionHandoff?: (handoff: Omit<AgentComposerHandoff, 'id'>) => void
  onVisibleSubcontentArtifactChange?: (artifactId: NovelWorkbenchArtifact['id']) => void
  projectPath: string
  sectionId: WorkbenchPrimarySectionId
  selectedItem: NovelWorkbenchTreeItem | null
  selectionHandoffDisabled?: boolean
  /** 全书章节目录（未兑现计划「移到后续章」候选章号计算用，Task 7） */
  tocItems: NovelTocItem[]
}) {
  if (!selectedItem) {
    return <WorkbenchEmptyState icon={FileText} title="未选择对象">请选择左侧小说结构中的一个对象。</WorkbenchEmptyState>
  }

  if (selectedItem.kind !== 'chapter') {
    if (selectedItem.kind === 'reference-list') {
      if (!artifacts && loading) {
        return <WorkbenchEmptyState density="compact" icon={Loader2} title="正在读取参考作品">正在加载当前项目的参考素材。</WorkbenchEmptyState>
      }

      const referenceWorksView = (
        <ReferenceWorksView
          projectPath={projectPath}
          summary={
            artifacts?.referenceWorksSummary ?? {
              sources: [],
              status: {
                guidanceState: 'empty',
                sourceCount: 0,
                needsAnalysis: false,
                stale: false,
                guidanceExists: false,
              },
            }
          }
          onAction={onEmptyGuideAction}
          onChanged={onReferenceChanged}
        />
      )

      if (generationState && !artifacts?.referenceWorksSummary?.guidance?.content?.trim()) {
        return <WorkbenchGenerationEmptyState generationState={generationState} onAnswerQuestion={onAnswerPendingQuestion} />
      }

      return referenceWorksView
    }

    const objectArtifacts = getDisplayableObjectArtifacts(artifacts)
    const artifact = objectArtifacts[0]
    if (!artifact?.exists) {
      if (generationState) {
        return <WorkbenchGenerationEmptyState generationState={generationState} onAnswerQuestion={onAnswerPendingQuestion} />
      }

      if (!artifacts && (loading || selectedItem.exists !== false)) {
        return <WorkbenchEmptyState density="compact" icon={Loader2} title="正在读取文档">正在加载当前板块内容。</WorkbenchEmptyState>
      }

      if (activeTab?.objectId === selectedItem.id) {
        return (
          <WorkbenchEmptyGuide
            title={activeTab.emptyTitle}
            description={activeTab.emptyDescription}
            purpose={getObjectEmptyGuidePurpose(sectionId)}
            action={emptyGuideAction}
            onAction={onEmptyGuideAction}
          />
        )
      }

      return <WorkbenchEmptyState icon={FileText} title="文件尚未生成">当前对象没有可显示的文件。</WorkbenchEmptyState>
    }

    if (objectArtifacts.length > 1) {
      return (
        <WorkbenchSubcontentBrowser
          artifacts={objectArtifacts}
          onChanged={onReferenceChanged}
          onEvaluateOutlineImpact={onEvaluateOutlineImpact}
          onEvaluatePremiseImpact={onEvaluatePremiseImpact}
          onSelectionHandoff={onSelectionHandoff}
          onVisibleArtifactChange={onVisibleSubcontentArtifactChange}
          projectPath={projectPath}
          sectionId={sectionId}
          selectedItem={selectedItem}
          selectionHandoffDisabled={selectionHandoffDisabled}
        />
      )
    }

    return (
      <ObjectArtifactDocument
        artifact={artifact}
        characterTab={characterTab}
        onCharacterTabChange={onCharacterTabChange}
        onChanged={onReferenceChanged}
        onEvaluateOutlineImpact={onEvaluateOutlineImpact}
        onEvaluatePremiseImpact={onEvaluatePremiseImpact}
        onSelectionHandoff={onSelectionHandoff}
        projectPath={projectPath}
        selectionDescriptor={resolveWorkbenchSelectionHandoff({
          artifact,
          chapterView: 'text',
          sectionId,
          selectedItem,
        })}
        selectionHandoffDisabled={selectionHandoffDisabled}
      />
    )
  }

  const outlineArtifact = findObjectArtifact(artifacts, 'chapter-outline')
  const manuscriptArtifact = findObjectArtifact(artifacts, 'manuscript')
  const isCurrentChapter = selectedItem.id === currentChapterId
  const isRecoverableChapter = selectedItem.status === 'recoverable'
  const showRecoverablePrompt = isRecoverableChapter && !generationState
  // staging 只读预览（刀 3 §4.6）：recoverable 优先级更高，已被上面的横幅覆盖时不重复提示；
  // 本章正在生成时 titlebar 已有生成指示，「写作中断」横幅与「正在生成」语义打架，同样抑制。
  const showInterruptedDraftNotice = Boolean(manuscriptArtifact?.isDraft) && !showRecoverablePrompt && !generationState
  const chapterTarget = { sectionId: 'blueprint' as const, tabId: selectedItem.id, objectId: selectedItem.id }
  const recoverableAction = disableAgentActionsWhileBusy(
    [createRecoverCurrentChapterAction(chapterTarget)],
    Boolean(selectionHandoffDisabled),
  )[0]
  let hasVisibleChapterArtifact = false

  let chapterBody = <ReviewReportView artifact={toNovelArtifact(findObjectArtifact(artifacts, 'review'))} />
  if (chapterView === 'text') {
    if (!manuscriptArtifact?.exists) {
      if (generationState) {
        chapterBody = <WorkbenchGenerationEmptyState generationState={generationState} onAnswerQuestion={onAnswerPendingQuestion} />
      } else if (showRecoverablePrompt) {
        chapterBody = (
          <WorkbenchEmptyGuide
            title="写作中断待恢复"
            description="本章上次写作中断，留有未完成的进度。Agent 会从中断处继续完成本章。"
            action={recoverableAction}
            onAction={onEmptyGuideAction}
          />
        )
      } else if (isCurrentChapter) {
        chapterBody = (
          <WorkbenchEmptyGuide
            title="正文尚未生成"
            description="当前阶段应该写这一章。Agent 会先做写前预检，再按顺序推进正文生成。"
            purpose="draft-needed"
            action={disableAgentActionsWhileBusy(
              [createWriteCurrentChapterAction(chapterTarget, selectedItem.chapterNumber)],
              Boolean(selectionHandoffDisabled),
            )[0]}
            onAction={onEmptyGuideAction}
          />
        )
      } else {
        chapterBody = (
          <WorkbenchEmptyGuide
            title="正文尚未生成"
            description="请按章节顺序写作。轮到本章时，这里会提供写作入口。"
            purpose="draft-needed"
          />
        )
      }
    } else {
      hasVisibleChapterArtifact = true
      chapterBody =
        typeof selectedItem.chapterNumber === 'number' ? (
          <>
            <ChapterManuscriptView
              key={`manuscript-${projectPath}-${selectedItem.chapterNumber}`}
              artifact={toNovelArtifact(manuscriptArtifact)}
              projectPath={projectPath}
              chapter={selectedItem.chapterNumber}
              agentBusy={Boolean(selectionHandoffDisabled)}
              selectionHandoff={createMarkdownSelectionHandoff({
                disabled: selectionHandoffDisabled,
                extraActions: buildStyleAnchorActions({ projectPath, chapterNumber: selectedItem.chapterNumber }),
                onSelectionHandoff,
                selectionDescriptor: resolveWorkbenchSelectionHandoff({
                  artifact: manuscriptArtifact,
                  chapterView: 'text',
                  sectionId,
                  selectedItem,
                }),
              })}
              leadingContent={
                showRecoverablePrompt ? (
                  <RecoverableChapterNotice action={recoverableAction} onAction={onEmptyGuideAction} />
                ) : showInterruptedDraftNotice ? (
                  <InterruptedDraftNotice />
                ) : undefined
              }
              onChanged={onReferenceChanged}
              onEvaluateManuscriptImpact={onEvaluateManuscriptImpact}
            />
            <ChapterCapabilityReceipt projectPath={projectPath} chapter={selectedItem.chapterNumber} />
          </>
        ) : (
          <ChapterPreview
            artifact={toNovelArtifact(manuscriptArtifact)}
            selectionHandoff={createMarkdownSelectionHandoff({
              disabled: selectionHandoffDisabled,
              onSelectionHandoff,
              selectionDescriptor: resolveWorkbenchSelectionHandoff({
                artifact: manuscriptArtifact,
                chapterView: 'text',
                sectionId,
                selectedItem,
              }),
            })}
            leadingContent={
              showRecoverablePrompt ? (
                <RecoverableChapterNotice action={recoverableAction} onAction={onEmptyGuideAction} />
              ) : showInterruptedDraftNotice ? (
                <InterruptedDraftNotice />
              ) : undefined
            }
          />
        )
    }
  }
  if (chapterView === 'outline') {
    if (!outlineArtifact?.exists) {
      chapterBody = generationState ? (
        <WorkbenchGenerationEmptyState generationState={generationState} onAnswerQuestion={onAnswerPendingQuestion} />
      ) : (
        <WorkbenchEmptyGuide
          title="章节大纲尚未规划"
          description="NarraCat 会按章节顺序从最前面缺少大纲的章节开始补齐。"
          purpose="outline-needed"
          action={
            disableAgentActionsWhileBusy(
              [createSequentialOutlineAction(chapterTarget)],
              Boolean(selectionHandoffDisabled),
            )[0]
          }
          onAction={onEmptyGuideAction}
        />
      )
    } else {
      hasVisibleChapterArtifact = true
      chapterBody =
        outlineArtifact.data &&
        typeof outlineArtifact.data === 'object' &&
        typeof selectedItem.chapterNumber === 'number' ? (
          <ChapterOutlineCardsView
            artifact={toNovelArtifact(outlineArtifact)}
            projectPath={projectPath}
            chapter={selectedItem.chapterNumber}
            chapterWritten={selectedItem.status === 'completed'}
            deferTargets={resolveDeferTargets(tocItems, selectedItem.chapterNumber)}
            onChanged={onReferenceChanged}
          />
        ) : (
          <OutlineView
            artifact={toNovelArtifact(outlineArtifact)}
            selectionHandoff={createMarkdownSelectionHandoff({
              disabled: selectionHandoffDisabled,
              onSelectionHandoff,
              selectionDescriptor: resolveWorkbenchSelectionHandoff({
                artifact: outlineArtifact,
                chapterView: 'outline',
                sectionId,
                selectedItem,
              }),
            })}
          />
        )
    }
  }
  if (chapterView === 'review') {
    const reviewArtifact = findObjectArtifact(artifacts, 'review')
    const deepReviewArtifact = findObjectArtifact(artifacts, 'deep-review')
    const hasLightReview = reviewArtifact?.exists === true
    const hasDeepReview = deepReviewArtifact?.exists === true
    // 轻审报告与深审标注同住 reviews/，审修视图发现并展示两份；任一存在即视图有内容（ADR-0021）。
    hasVisibleChapterArtifact = hasLightReview || hasDeepReview
    chapterBody =
      generationState && !hasVisibleChapterArtifact ? (
        <WorkbenchGenerationEmptyState generationState={generationState} onAnswerQuestion={onAnswerPendingQuestion} />
      ) : !hasVisibleChapterArtifact ? (
        <WorkbenchEmptyGuide
          title="审修报告尚未生成"
          description="审修完成后，质量结论和修改建议会在这里显示。"
          purpose="review-needed"
        />
      ) : (
        <>
          {hasLightReview && (
            <ReviewReportView
              artifact={toNovelArtifact(reviewArtifact)}
              selectionHandoff={createMarkdownSelectionHandoff({
                disabled: selectionHandoffDisabled,
                onSelectionHandoff,
                selectionDescriptor: resolveWorkbenchSelectionHandoff({
                  artifact: reviewArtifact,
                  chapterView: 'review',
                  sectionId,
                  selectedItem,
                }),
              })}
            />
          )}
          {hasDeepReview && (
            <DeepReviewSection
              artifact={deepReviewArtifact}
              selectionHandoff={createMarkdownSelectionHandoff({
                disabled: selectionHandoffDisabled,
                onSelectionHandoff,
                selectionDescriptor: resolveWorkbenchSelectionHandoff({
                  artifact: deepReviewArtifact,
                  chapterView: 'review',
                  sectionId,
                  selectedItem,
                }),
              })}
            />
          )}
        </>
      )
  }

  return <>{chapterBody}</>
}

// 深审标注（/review … deep）是 finding-only 人读 markdown，无 verdict、无 JSON 孪生（ADR-0021）；
// 直接按 markdown 渲染在审修视图轻审报告之下。
function DeepReviewSection({
  artifact,
  selectionHandoff,
}: {
  artifact: NovelWorkbenchArtifact
  selectionHandoff?: MarkdownSelectionHandoff | null
}) {
  const content = artifact.content ?? ''
  return (
    <ArtifactDocumentShell
      artifact={{ kind: 'deep-review', title: artifact.title, path: artifact.path ?? '', exists: true, content }}
      title={artifact.title}
    >
      <ArtifactDocumentBody selectionHandoff={selectionHandoff}>{content}</ArtifactDocumentBody>
    </ArtifactDocumentShell>
  )
}

function getChapterHeaderTabs(artifacts: NovelWorkbenchArtifacts | null) {
  return CHAPTER_VIEWS.map((option) => {
    if (option.value === 'review') {
      // 审修标签：轻审报告或深审标注任一存在即视为有内容。
      const hasReview =
        findObjectArtifact(artifacts, 'review')?.exists === true ||
        findObjectArtifact(artifacts, 'deep-review')?.exists === true
      return { ...option, exists: artifacts ? hasReview : true }
    }

    const artifact = findObjectArtifact(artifacts, CHAPTER_VIEW_ARTIFACT_IDS[option.value])

    return {
      ...option,
      exists: artifacts ? artifact?.exists === true : true,
    }
  })
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable.')
  }

  await navigator.clipboard.writeText(text)
}

async function copyVisibleDocument(copyDocument: WorkbenchCopyDocument | null): Promise<void> {
  if (!copyDocument) {
    toast.error('当前没有可复制的文档')
    return
  }

  try {
    await writeClipboardText(copyDocument.text)
    toast.success('已复制当前文档')
  } catch (error) {
    console.error(error)
    toast.error('复制失败')
  }
}

export function WorkbenchObjectView({
  activeTab,
  activeTabId,
  artifacts,
  chapterView,
  currentChapterId,
  emptyGuideAction,
  generationState,
  loading = false,
  onAnswerPendingQuestion,
  onChapterViewChange,
  onEmptyGuideAction,
  onEvaluateManuscriptImpact,
  onEvaluateOutlineImpact,
  onEvaluatePremiseImpact,
  onReferenceChanged,
  onSelectionHandoff,
  projectPath,
  sectionId,
  sectionTitle,
  selectionHandoffDisabled,
  selectedItem,
  tabs,
  titlebarActions = [],
  onTitlebarAction,
  tocItems = [],
}: {
  activeTab: WorkbenchTabItem | null
  activeTabId: string | null
  artifacts: NovelWorkbenchArtifacts | null
  chapterView: WorkbenchChapterView
  currentChapterId?: string | null
  emptyGuideAction?: WorkbenchAction | null
  generationState?: WorkbenchGenerationState | null
  loading?: boolean
  onAnswerPendingQuestion?: (questionRequestId: string) => void
  onChapterViewChange: (value: WorkbenchChapterView) => void
  onEmptyGuideAction?: (action: WorkbenchAction) => void
  onEvaluateManuscriptImpact?: (input: { prompt: string; chapter: number }) => void
  onEvaluateOutlineImpact?: (prompt: string) => void
  onEvaluatePremiseImpact?: (prompt: string) => void
  onReferenceChanged?: () => void
  onSelectionHandoff?: (handoff: Omit<AgentComposerHandoff, 'id'>) => void
  projectPath: string
  sectionId: WorkbenchPrimarySectionId
  sectionTitle: string
  selectionHandoffDisabled?: boolean
  /** 全书章节目录（未兑现计划「移到后续章」候选章号计算用，Task 7）；缺省视为无候选章 */
  tocItems?: NovelTocItem[]
  selectedItem: NovelWorkbenchTreeItem | null
  tabs: WorkbenchTabItem[]
  titlebarActions?: WorkbenchAction[]
  onTitlebarAction?: (action: WorkbenchAction) => void
}) {
  const scrollFrameRef = useRef<HTMLDivElement>(null)
  const hasSubcontentBrowser = usesSubcontentBrowser(selectedItem, artifacts)
  const rendersChapterObject = selectedItem?.kind === 'chapter'
  const selectedObjectKey = selectedItem?.id ?? ''
  const [visibleSubcontentArtifactId, setVisibleSubcontentArtifactId] = useState<string | null>(null)
  // 角色页设定/状态 tab 状态：跨角色保持（视图层状态，不随 artifact 切换重置，spec 2026-08-03 §4.1）
  const [characterTab, setCharacterTab] = useState<CharacterDocTab>('profile')
  const headerTitle = rendersChapterObject ? selectedItem.title : sectionTitle
  const visibleChapterView = resolveVisibleChapterView(chapterView)
  const chapterTabs = rendersChapterObject ? getChapterHeaderTabs(artifacts) : undefined
  const copyDocument = resolveVisibleWorkbenchCopyDocument({
    artifacts,
    chapterView: visibleChapterView,
    selectedItem,
    selectedSubcontentArtifactId: visibleSubcontentArtifactId,
  })
  // 正文编辑态由 titlebar 整体替换为保存/取消（少解释、不与阅读态动作混排），
  // 「复制当前文档」这个拼接注入点需要一并抑制，否则编辑态 titlebar 会多冒出一个复制按钮。
  const manuscriptEditing = useManuscriptEditorGuard((state) => state.editing)
  const titlebarActionsWithCopy =
    !generationState && copyDocument && !manuscriptEditing ? [COPY_VISIBLE_DOCUMENT_ACTION, ...titlebarActions] : titlebarActions

  useEffect(() => {
    if (!hasSubcontentBrowser) {
      scrollFrameRef.current?.scrollTo({ top: 0, left: 0 })
    }
  }, [chapterView, hasSubcontentBrowser, selectedObjectKey])

  useEffect(() => {
    setVisibleSubcontentArtifactId(null)
  }, [selectedObjectKey])

  function handleTitlebarAction(action: WorkbenchAction) {
    if (action.id === COPY_VISIBLE_DOCUMENT_ACTION.id) {
      void copyVisibleDocument(copyDocument)
      return
    }

    onTitlebarAction?.(action)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <WorkbenchObjectHeader
        sectionId={sectionId}
        sectionTitle={headerTitle}
        generationState={generationState}
        projectPath={projectPath}
        tabs={tabs}
        activeTabId={activeTabId}
        chapterTabs={chapterTabs}
        chapterView={visibleChapterView}
        onChapterViewChange={onChapterViewChange}
        titlebarActions={titlebarActionsWithCopy}
        onTitlebarAction={handleTitlebarAction}
      />
      <div
        ref={scrollFrameRef}
        className={cn('min-h-0 flex-1', hasSubcontentBrowser ? 'overflow-hidden' : 'overflow-auto')}
        data-workbench-object-scroll-frame={hasSubcontentBrowser ? 'subcontent' : 'standard'}
      >
        <div
          className={cn('h-full min-h-0', !hasSubcontentBrowser && 'p-6')}
          data-workbench-object-body-frame={hasSubcontentBrowser ? 'subcontent' : 'standard'}
        >
          {renderObjectBody({
            activeTab,
            artifacts,
            characterTab,
            chapterView: visibleChapterView,
            currentChapterId,
            emptyGuideAction,
            generationState,
            loading,
            onAnswerPendingQuestion,
            onCharacterTabChange: setCharacterTab,
            onEmptyGuideAction,
            onEvaluateManuscriptImpact,
            onEvaluateOutlineImpact,
            onEvaluatePremiseImpact,
            onReferenceChanged,
            onSelectionHandoff,
            onVisibleSubcontentArtifactChange: setVisibleSubcontentArtifactId,
            projectPath,
            sectionId,
            selectedItem,
            selectionHandoffDisabled,
            tocItems,
          })}
        </div>
      </div>
    </div>
  )
}
