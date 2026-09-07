import { useState, type FormEventHandler, type ReactNode } from 'react'
import { ClipboardPaste, FileText, RefreshCcw, Trash2, Upload } from 'lucide-react'
import { BrandIllustration } from '@/components/brand'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DESTRUCTIVE_INLINE_CLASS, DIALOG_CONTENT_FORM_CLASS, EMPTY_PRIMARY_BODY_CLASS, EMPTY_PRIMARY_TITLE_CLASS, GROUP_CLASS, WORKBENCH_GUIDE_ACTION_CLASS } from '@/design-system'
import { importReferenceSourceFiles, pasteReferenceSource, removeReferenceSource, resetReferenceWorks } from '@/lib/ipc'
import {
  REMOVE_REFERENCE_SOURCE_CONFIRM,
  RESET_REFERENCE_WORKS_CONFIRM,
} from '@/lib/reference-works-confirm'
import type { WorkbenchAction } from '@/lib/workbench-actions'
import type { ReferenceSourceItem, ReferenceWorksSummary } from '@shared/types/novel'
import { ArtifactDocumentBody, ArtifactDocumentShell } from './artifacts/ArtifactDocumentShell'

const referenceWorksTarget = { sectionId: 'reference-works', tabId: 'references', objectId: 'references' } as const

function createReferenceWorksAgentAction(summary: ReferenceWorksSummary): WorkbenchAction {
  return {
    id: 'analyze-reference-works',
    kind: 'agent',
    label: summary.status.guidanceExists ? '重新分析' : '分析参考作品',
    description: '让 Agent 分析已添加的参考作品，并生成项目级参考指导。',
    enabled: true,
    command: 'reference',
    prompt: '分析参考作品',
    target: referenceWorksTarget,
    resetReferenceGuidanceBeforeRun: summary.status.guidanceExists,
  }
}

function formatFileSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${size} B`
}

function PasteField({
  children,
  label,
}: {
  children: ReactNode
  label: string
}) {
  return (
    <label className="grid gap-2 p-4 text-xs font-medium text-muted-foreground">
      <span className="leading-none">{label}</span>
      {children}
    </label>
  )
}

export function ReferenceWorksPasteDialogPanel({
  busy,
  content,
  error,
  onContentChange,
  onSubmit,
  onTitleChange,
  title,
}: {
  busy: boolean
  content: string
  error: string | null
  title: string
  onContentChange: (value: string) => void
  onSubmit: FormEventHandler<HTMLFormElement>
  onTitleChange: (value: string) => void
}) {
  return (
    <form onSubmit={onSubmit} data-reference-works-paste-panel="true" className="grid">
      <DialogHeader className="border-b border-border px-6 pb-5 pt-6 text-left">
        <DialogTitle className="text-lg leading-tight">粘贴一个片段</DialogTitle>
        <DialogDescription className="sr-only">输入片段标题和正文，保存为当前项目的一个参考作品来源。</DialogDescription>
      </DialogHeader>

      <div className="grid gap-4 px-6 py-5">
        <div data-reference-works-paste-group="true" className={GROUP_CLASS}>
          <PasteField label="片段标题">
            <Input
              className="h-9 rounded-row bg-workspace px-3 text-base"
              value={title}
              placeholder="喜欢的开场片段"
              onChange={(event) => onTitleChange(event.target.value)}
            />
          </PasteField>

          <PasteField label="片段正文">
            <Textarea
              value={content}
              className="min-h-56 rounded-row bg-workspace px-3 py-3 text-sm leading-6"
              placeholder="粘贴小说片段"
              onChange={(event) => onContentChange(event.target.value)}
            />
          </PasteField>
        </div>

        {error ? <div className={`${DESTRUCTIVE_INLINE_CLASS} text-xs`}>{error}</div> : null}
      </div>

      <DialogFooter className="border-t border-border bg-active/40 px-6 py-4">
        <Button type="submit" disabled={busy}>
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}

function SourceSummary({
  busy,
  item,
  onRemove,
}: {
  busy: boolean
  item: ReferenceSourceItem
  onRemove: (fileName: string) => void
}) {
  return (
    <div
      className="flex min-h-16 w-full items-center gap-3 rounded-panel border border-border bg-surface px-4 py-3 text-left"
      data-reference-source-row={item.fileName}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-row bg-active text-hint-foreground">
        <FileText className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{item.title}</div>
        <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{item.wordCount} 字</span>
          <span>{formatFileSize(item.size)}</span>
          <span className="min-w-0 break-all font-mono">{item.relativePath}</span>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={`删除 ${item.title}`}
        disabled={busy}
        data-reference-source-remove={item.fileName}
        onClick={() => onRemove(item.fileName)}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function SourceList({
  busy,
  onRemove,
  sources,
}: {
  busy: boolean
  sources: ReferenceSourceItem[]
  onRemove: (fileName: string) => void
}) {
  if (sources.length === 0) return null

  return (
    <div className="grid w-full gap-2" data-reference-source-list="true">
      {sources.map((item) => (
        <SourceSummary key={item.fileName} item={item} busy={busy} onRemove={onRemove} />
      ))}
    </div>
  )
}

export function ReferenceWorksView({
  disabled = false,
  onAction,
  onChanged,
  projectPath,
  summary,
}: {
  projectPath: string
  summary: ReferenceWorksSummary
  disabled?: boolean
  onAction?: (action: WorkbenchAction) => void
  onChanged?: () => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const busy = disabled || submitting
  const guidanceContent = summary.guidance?.content?.trim()
  const hasSources = summary.sources.length > 0
  const canAnalyze = hasSources && !busy

  async function handlePaste() {
    setSubmitting(true)
    setError(null)

    try {
      await pasteReferenceSource({ projectPath, title, content })
      setTitle('')
      setContent('')
      setDialogOpen(false)
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasteSubmit: FormEventHandler<HTMLFormElement> = (event) => {
    event.preventDefault()
    void handlePaste()
  }

  async function handleImport() {
    setSubmitting(true)
    setError(null)

    try {
      await importReferenceSourceFiles(projectPath)
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRemove(fileName: string) {
    if (!(await confirm(REMOVE_REFERENCE_SOURCE_CONFIRM))) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await removeReferenceSource({ projectPath, fileName })
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleReset() {
    if (!(await confirm(RESET_REFERENCE_WORKS_CONFIRM))) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await resetReferenceWorks(projectPath)
      onChanged?.()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  const pasteDialog = (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="lg" className={WORKBENCH_GUIDE_ACTION_CLASS} disabled={busy}>
          <ClipboardPaste className="size-4" />
          粘贴一个片段
        </Button>
      </DialogTrigger>
      <DialogContent className={DIALOG_CONTENT_FORM_CLASS}>
        <ReferenceWorksPasteDialogPanel
          busy={busy}
          content={content}
          error={error}
          title={title}
          onContentChange={setContent}
          onSubmit={handlePasteSubmit}
          onTitleChange={setTitle}
        />
      </DialogContent>
    </Dialog>
  )

  const importButton = (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className={WORKBENCH_GUIDE_ACTION_CLASS}
      disabled={busy}
      onClick={handleImport}
    >
      <Upload className="size-4" />
      导入文本
    </Button>
  )

  const analyzeButton = (
    <Button
      type="button"
      size="lg"
      className={WORKBENCH_GUIDE_ACTION_CLASS}
      disabled={!canAnalyze}
      onClick={() => onAction?.(createReferenceWorksAgentAction(summary))}
    >
      <RefreshCcw className="size-4" />
      {summary.status.guidanceExists ? '重新分析' : '分析参考作品'}
    </Button>
  )

  if (!hasSources && !guidanceContent) {
    return (
      <div
        className="mx-auto flex min-h-[min(640px,calc(100vh-13rem))] w-full max-w-4xl items-center justify-center py-10"
        data-reference-works-view="true"
      >
        <section className="flex w-full max-w-2xl flex-col items-center text-center" data-reference-works-empty-hero="true">
          <BrandIllustration purpose="reference-works-needed" size="xl" className="mb-2" decorative />
          <h2 className={`mt-2 ${EMPTY_PRIMARY_TITLE_CLASS}`}>还没有参考作品</h2>
          <p className={`mt-3 max-w-xl ${EMPTY_PRIMARY_BODY_CLASS}`}>
            粘贴片段或导入 .md / .txt 文本，作为 Agent 分析参考指导的素材。
          </p>
          <p className={`mt-3 max-w-xl ${EMPTY_PRIMARY_BODY_CLASS}`}>
            参考作品给这一本书定调，分析结果隐形融入创作。想把写法炼成跨书可用的能力卡？去 设置→能力包→我的创作→从书学写法。
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {pasteDialog}
            {importButton}
          </div>
          {error && !dialogOpen ? <div className="mt-4 text-xs text-destructive">{error}</div> : null}
        </section>
      </div>
    )
  }

  if (!guidanceContent) {
    return (
      <div
        className="mx-auto flex min-h-[min(600px,calc(100vh-13rem))] w-full max-w-3xl items-center justify-center py-10"
        data-reference-works-view="true"
      >
        <section className="flex w-full flex-col items-center text-center" data-reference-works-status="needs-analysis">
          <BrandIllustration purpose="reference-works-ready" size="xl" className="mb-2" decorative />
          <h2 className={`mt-5 ${EMPTY_PRIMARY_TITLE_CLASS}`}>参考作品待分析</h2>
          <p className={`mt-3 max-w-xl ${EMPTY_PRIMARY_BODY_CLASS}`}>
            当前项目已有 {summary.sources.length} 个参考来源。点击分析后，Agent 会读取这些素材并生成项目级参考指导。
          </p>
          <div className="mt-6 w-full max-w-2xl text-left">
            <SourceList sources={summary.sources} busy={busy} onRemove={handleRemove} />
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3" data-reference-works-actions="pending">
            {pasteDialog}
            {importButton}
            {analyzeButton}
          </div>
          {error ? <div className="mt-4 text-xs text-destructive">{error}</div> : null}
        </section>
        {confirmDialog}
      </div>
    )
  }

  return (
    <div
      className="grid h-full min-h-0 w-full grid-cols-1 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]"
      data-reference-works-view="true"
    >
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-active/20 p-4" data-reference-works-sidebar="true">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-muted-foreground">参考来源</div>
            <div className="mt-1 text-sm font-semibold text-foreground">{summary.sources.length} 个来源</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="重置参考作品"
            disabled={busy}
            data-reference-works-reset="true"
            onClick={handleReset}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <SourceList sources={summary.sources} busy={busy} onRemove={handleRemove} />
        <div className="mt-4 grid gap-2">
          {pasteDialog}
          {importButton}
          {analyzeButton}
        </div>
        {error ? <div className="mt-4 text-xs text-destructive">{error}</div> : null}
      </aside>
      <div className="min-h-0">
        {summary.status.stale ? (
          <div
            className="border-b border-warning/30 bg-warning/10 px-6 py-3 text-xs leading-5 text-warning"
            data-reference-guidance-stale="true"
          >
            参考来源已变更，当前参考指导可能已过期。重新分析会替换现有参考指导。
          </div>
        ) : null}
        <ArtifactDocumentShell
          artifact={{
            kind: 'outline',
            title: '参考指导',
            path: summary.guidance?.path ?? '',
            exists: true,
            content: guidanceContent,
          }}
          title="参考指导"
        >
          <ArtifactDocumentBody>{guidanceContent}</ArtifactDocumentBody>
        </ArtifactDocumentShell>
      </div>
      {confirmDialog}
    </div>
  )
}
