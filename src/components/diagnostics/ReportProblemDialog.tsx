import { useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import { Copy, ExternalLink, FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  DIALOG_BODY_CLASS,
  DIALOG_CONTENT_FORM_CLASS,
  DIALOG_FOOTER_SECTIONED_CLASS,
  DIALOG_HEADER_SECTIONED_CLASS,
  DIALOG_SCROLL_SHELL_CLASS,
} from '@/design-system'
import { getDiagnosticsReport, revealLogFile } from '@/lib/ipc'
import {
  buildGitHubIssueUrl,
  renderClipboardReport,
  renderEnvironmentTable,
  renderIssueDraft,
} from '@shared/lib/diagnostics-report'
import type { DiagnosticsReport } from '@shared/types/diagnostics-report'

/**
 * 「报告问题」：生成脱敏诊断（版本 / 系统 / 最近日志）→ 用户预览、补一句描述 → 打开预填好的
 * GitHub 新建 Issue 页，同时把完整版复制到剪贴板（Issue 链接放不下全部日志）。
 *
 * 隐私边界在这一层兑现：用户在弹窗里看得到将要发出去的全部内容，没有「后台悄悄上传」。
 * 入口有两个：设置 → 关于；Agent 运行失败卡片。两处共用 ReportProblemButton。
 */
export function ReportProblemButton({
  initialDescription = '',
  children = '报告问题',
  ...buttonProps
}: Omit<ComponentProps<typeof Button>, 'onClick' | 'children'> & { initialDescription?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" data-report-problem-trigger="true" {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <ReportProblemDialog open={open} onOpenChange={setOpen} initialDescription={initialDescription} />
    </>
  )
}

export function ReportProblemDialog({
  open,
  onOpenChange,
  initialDescription = '',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialDescription?: string
}) {
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [description, setDescription] = useState(initialDescription)

  // 每次打开都重新取：日志尾在变，用户可能在两次报告之间又撞了一次。
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setReport(null)
    setLoadError(null)
    setDescription(initialDescription)
    getDiagnosticsReport()
      .then((next) => {
        if (!cancelled) setReport(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [open, initialDescription])

  async function copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  async function handleCopy() {
    if (!report) return
    const ok = await copyToClipboard(renderClipboardReport(report, description))
    if (ok) toast.success('诊断信息已复制，可以贴到任何地方')
    else toast.error('复制失败，请用「打开日志文件夹」手动取日志')
  }

  async function handleSubmit() {
    if (!report) return
    const draft = renderIssueDraft(report, description)
    const copied = await copyToClipboard(renderClipboardReport(report, description))
    // 渲染端 window.open 会被主进程 setWindowOpenHandler 拦下并交给系统浏览器（同 <a target=_blank>）。
    window.open(buildGitHubIssueUrl(draft), '_blank', 'noopener')
    toast.success(copied ? '已打开 GitHub；完整日志已复制到剪贴板，可贴进 Issue 评论' : '已打开 GitHub')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_FORM_CLASS}`} data-report-problem-dialog="true">
        <ReportProblemDialogPanel
          report={report}
          loadError={loadError}
          description={description}
          onDescriptionChange={setDescription}
          onCopy={() => void handleCopy()}
          onRevealLog={() => void revealLogFile()}
          onSubmit={() => void handleSubmit()}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * 弹窗内容面板；单独导出便于 SSR 测试。
 * 形态 = 内容型三段式（§9.7）：有输入框 + 可滚动预览，不是轻确认框——第一版照着 ConfirmDialogPanel 抄成了
 * 裸容器，就是把两种形态抄混的典型（治理见 dialog-governance.test）。
 */
export function ReportProblemDialogPanel({
  report,
  loadError,
  description,
  onDescriptionChange,
  onCopy,
  onRevealLog,
  onSubmit,
}: {
  report: DiagnosticsReport | null
  loadError: string | null
  description: string
  onDescriptionChange: (value: string) => void
  onCopy: () => void
  onRevealLog: () => void
  onSubmit: () => void
}) {
  const ready = report !== null
  return (
    <>
      <DialogHeader className={DIALOG_HEADER_SECTIONED_CLASS}>
        <DialogTitle className="text-lg leading-tight">报告问题</DialogTitle>
        <DialogDescription className="sr-only">生成脱敏诊断信息并提交到 GitHub Issue</DialogDescription>
      </DialogHeader>

      <div className={`${DIALOG_BODY_CLASS} grid gap-4`} data-report-problem-panel="true">
        <p className="text-sm leading-relaxed text-muted-foreground">
          下面是将要一起提交的内容：版本、系统和最近的日志（已抹掉本机路径与密钥）。确认后会打开 GitHub 的新建 Issue 页面，需要一个 GitHub 账号。
        </p>

        <label className="grid gap-1.5">
          <span className="text-sm font-medium text-foreground">发生了什么</span>
          <Textarea
            value={description}
            rows={3}
            placeholder="做了什么操作、看到了什么、期望是什么"
            className="text-sm"
            data-report-problem-description="true"
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </label>

        {loadError ? (
          <p className="text-xs text-destructive">诊断信息读取失败：{loadError}</p>
        ) : !ready ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            正在收集诊断信息…
          </p>
        ) : (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium text-foreground">将要提交的诊断信息</span>
            <pre
              className="max-h-56 overflow-auto rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
              data-report-problem-preview="true"
            >
              {renderEnvironmentTable(report)}
              {'\n\n'}
              {report.logTail.length > 0 ? report.logTail.join('\n') : '（还没有日志）'}
            </pre>
          </div>
        )}
      </div>

      <DialogFooter className={DIALOG_FOOTER_SECTIONED_CLASS}>
        {/* 次要动作靠左用 sm:mr-auto：DialogFooter 窄屏会 flex-col-reverse，两端式布局在窄屏下顺序会乱（§9.7） */}
        <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onRevealLog} data-report-problem-reveal-log="true">
          <FolderOpen className="size-4" />
          打开日志文件夹
        </Button>
        <Button type="button" variant="secondary" disabled={!ready} onClick={onCopy} data-report-problem-copy="true">
          <Copy className="size-4" />
          复制诊断信息
        </Button>
        <Button type="button" disabled={!ready} onClick={onSubmit} data-report-problem-submit="true">
          <ExternalLink className="size-4" />
          在 GitHub 提交
        </Button>
      </DialogFooter>
    </>
  )
}
