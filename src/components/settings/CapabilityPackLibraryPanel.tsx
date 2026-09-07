import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { BadgeCheck, BookOpen, Copy, Download, FolderPlus, Loader2, Package, PenTool, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/ui/disclosure'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { Textarea } from '@/components/ui/textarea'
import { DESTRUCTIVE_INLINE_CLASS, DIALOG_CONTENT_FORM_CLASS, DIALOG_SCROLL_SHELL_CLASS, MUTED_PILL_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import {
  PACK_DETAIL_DIALOG_BODY_CLASS,
  PACK_DETAIL_DIALOG_CONTENT_CLASS,
  PACK_DETAIL_DIALOG_HEADER_CLASS,
  PackDetailContent,
} from '@/components/packs/PackDetailContent'
import { DraftEditorView } from '@/components/packs/DraftEditorView'
import { LearnFromBookView } from '@/components/packs/LearnFromBookView'
import { PackGuideView } from '@/components/packs/PackGuideView'
import { summarizeCardTypeCounts } from '@/components/packs/pack-card-labels'
import { WizardView } from '@/components/packs/WizardView'
import { WorkshopListView } from '@/components/packs/WorkshopListView'
import { PACK_LICENSE_LABELS } from '@shared/types/capability-pack'
import type {
  CapabilityPackDetail,
  CapabilityPackSummary,
  LocalPackContent,
  PackLicense,
  PreviewImportPackResult,
} from '@shared/types/capability-pack'

// 方型圆角图标容器：官方包统一品牌图标 / 用户包统一默认图标
const PACK_ICON_TILE_CLASS = 'flex size-10 shrink-0 items-center justify-center rounded-row'

/** 已确认预览的待导入包（previewCapabilityPackImport 成功态），携带 token 供确认/取消。 */
type PendingImport = Extract<PreviewImportPackResult, { status: 'ok' }>

/**
 * 设置页二级/三级视图 URL 参数（`?section=packs&sub=…`）：`guide`=制作指南；`pack:<id>@<version>`=单包详情；
 * `creations`=我的创作（本地草稿列表）；`draft:<draftId>`=编辑器、`wizard`=作家向导（均为我的创作
 * 下钻的三级视图）。子视图路由化 + titlebar 面包屑是设置页的导航规范（docs/design.md §9.8），
 * 返回入口在面包屑各级，内容区不再放返回按钮。
 */
export type PacksSubView =
  | { kind: 'detail'; id: string; version: string }
  | { kind: 'guide' }
  | { kind: 'creations' }
  | { kind: 'draft'; draftId: string }
  | { kind: 'learn' }
  | { kind: 'wizard' }

export function parsePacksSubParam(raw: string | null): PacksSubView | null {
  if (!raw) return null
  if (raw === 'guide') return { kind: 'guide' }
  if (raw === 'creations') return { kind: 'creations' }
  if (raw === 'learn') return { kind: 'learn' }
  if (raw === 'wizard') return { kind: 'wizard' }
  if (raw.startsWith('draft:')) {
    const draftId = raw.slice('draft:'.length)
    return draftId ? { kind: 'draft', draftId } : null
  }
  if (raw.startsWith('pack:')) {
    const at = raw.lastIndexOf('@')
    if (at > 'pack:'.length) return { kind: 'detail', id: raw.slice('pack:'.length, at), version: raw.slice(at + 1) }
  }
  return null
}

/** 面包屑二级/三级文案：详情用固定「包详情」（包名已在内容区首行，避免重复取数）。 */
export function packsSubTitle(sub: PacksSubView): string {
  switch (sub.kind) {
    case 'guide':
      return '制作能力包'
    case 'creations':
      return '我的创作'
    case 'draft':
      return '编辑能力包'
    case 'learn':
      return '从书学写法'
    case 'wizard':
      return '作家向导'
    default:
      return '包详情'
  }
}

/**
 * 二级/三级视图「应用内进入」标记（history state）：面包屑返回/回上级对内部来源执行 navigate(-N)
 * 弹出真实历史条目；若无标记（深链/刷新进入，历史里没有上级页），才 replace 清/改 sub 参数。
 * 否则 push 进入 + replace 返回会留下重复历史，浏览器后退一次界面无变化。
 *
 * `packsSubDepth` 记录本次 push 相对「非 sub 基准页」的层数（列表→我的创作=1，我的创作→编辑器=2）。
 * 不能假设三级视图恒有 2 层真实历史：刷新/深链落在「我的创作」后再下钻编辑器，push 前并无列表历史，
 * 此时 depth 只应记 1——面包屑按 depth 而非硬编码层级选步数，越界时才落回 replace。
 */
type PacksSubHistoryState = { packsSubInternal: true; packsSubDepth: number }

function packsSubHistoryDepth(state: unknown): number {
  const parsed = state as Partial<PacksSubHistoryState> | null
  if (!parsed?.packsSubInternal) return 0
  return typeof parsed.packsSubDepth === 'number' && parsed.packsSubDepth > 0 ? parsed.packsSubDepth : 1
}

export function hasInternalPacksSubOrigin(state: unknown): boolean {
  return packsSubHistoryDepth(state) > 0
}

/** 当前 history state 的应用内 push 深度（0=非内部来源）；titlebar 面包屑据此选 navigate(-N) 步数。 */
export function readPacksSubHistoryDepth(state: unknown): number {
  return packsSubHistoryDepth(state)
}

/**
 * 进料器（learn/wizard）完成后进草稿的导航参数（T6 评审 Minor-2）：replace 而非 push——进料器
 * 会话此刻已清空/收尾，返回键不该再落回幽灵页；replace 继承当前深度（我的创作→进料器=2），
 * draft 三级面包屑 navigate(-1)/(-2) 恰好落回我的创作/列表，标签与去向归正。
 */
export function feederDraftNavigation(draftId: string): [sub: string, options: { replace: true }] {
  return [`draft:${draftId}`, { replace: true }]
}

/**
 * 设置页「能力包」包库面板（B2 刀1，ADR-0034 v1.1；刀2 扩三视图 + 两阶段导入；刀3「造包中心」加我的创作/编辑器）。
 *
 * 列表：顶部「我的创作 / 制作能力包 / 导入能力包」+ 包列表——官方内置包恒在（无导出/卸载，锁定语义），
 * 用户导入包按 id+version 各占一行（双轨版本制轨道二，同 id 多版本并存）、行尾导出/卸载 icon 按钮。
 * 点击行进详情子视图（PackDetailContent，展示边界：不读卡正文）；「制作能力包」进指南子视图；
 * 「我的创作」进本地草稿列表子视图（WorkshopListView），打开草稿再下钻进编辑器子视图（Task 12 实做）。
 * 导入两阶段：先 preview 展示 README + 卡清单摘要，确认后才 confirm 安装。
 */
export function CapabilityPackLibraryPanel() {
  const [packs, setPacks] = useState<CapabilityPackSummary[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const view = parsePacksSubParam(searchParams.get('sub'))
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null)
  // 导入确认弹窗专属 busy：防双击「确认安装」用同一 token 并发发两次 confirm（第二次必返回「导入会话已失效」）
  const [importConfirmBusy, setImportConfirmBusy] = useState(false)
  // 导出确认弹窗目标（Task 13）：readmeDraft 预填导出弹窗的说明 textarea——详情页入口带 detail.readme，
  // 列表行入口无已加载详情，留空（spec 明确允许「预填或空」两种入口态）。
  const [exportTarget, setExportTarget] = useState<{ id: string; version: string; readmeDraft: string } | null>(null)

  // 二级/三级视图导航统一走 URL（?sub=…）：面包屑各级/浏览器返回天然可用，视图状态可刷新恢复。
  // 进入/停留子视图时带内部来源标记 + push 深度（history state），返回路径据此选 navigate(-N) 或 replace。
  const setSub = useCallback(
    (sub: string | null, opts?: { replace?: boolean }) => {
      const replace = opts?.replace ?? false
      // push 进入子视图=应用内来源，深度在当前 state 基础上 +1（我的创作→编辑器是第 2 层）；
      // replace（版本切换等）继承现有 state——深链进入后切版本不得凭空获得内部标记/深度，
      // 否则面包屑会 navigate(-N) 弹出应用外的历史条目
      const state: PacksSubHistoryState | undefined = sub
        ? replace
          ? (location.state as PacksSubHistoryState | undefined)
          : { packsSubInternal: true, packsSubDepth: packsSubHistoryDepth(location.state) + 1 }
        : undefined
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (sub) next.set('sub', sub)
          else next.delete('sub')
          return next
        },
        { replace, ...(state !== undefined && state !== null ? { state } : {}) },
      )
    },
    [setSearchParams, location.state],
  )

  // 回列表：内部进入弹历史（保持后退键语义），深链/刷新进入才 replace 清参数
  const backToList = useCallback(() => {
    if (hasInternalPacksSubOrigin(location.state)) navigate(-1)
    else setSub(null, { replace: true })
  }, [location.state, navigate, setSub])

  const refresh = useCallback(async () => {
    setPacks(await window.electron.listCapabilityPacks())
  }, [])

  useEffect(() => {
    refresh().catch(() => setMessage('加载能力包列表失败，请重试。'))
  }, [refresh])

  const handleImport = useCallback(async () => {
    if (busyKey) return
    setBusyKey('import')
    try {
      const result = await window.electron.previewCapabilityPackImport()
      if (result.status === 'ok') {
        setMessage(null)
        setPendingImport(result)
      } else if (result.status !== 'canceled') {
        setMessage(result.message)
      }
    } finally {
      setBusyKey(null)
    }
  }, [busyKey])

  const handleConfirmImport = useCallback(async () => {
    if (!pendingImport || importConfirmBusy) return
    setImportConfirmBusy(true)
    try {
      const result = await window.electron.confirmCapabilityPackImport({ token: pendingImport.token })
      setPendingImport(null)
      if (result.status === 'ok') {
        setMessage(null)
        setPacks(result.packs)
      } else {
        setMessage(result.message)
      }
    } catch {
      setPendingImport(null)
      setMessage('导入失败，请重试。')
    } finally {
      setImportConfirmBusy(false)
    }
  }, [pendingImport, importConfirmBusy])

  const handleCancelImport = useCallback(async () => {
    if (!pendingImport || importConfirmBusy) return
    setImportConfirmBusy(true)
    try {
      // 取消失败无碍：主进程侧 token 会自然过期，UI 关闭弹窗即达成用户意图
      await window.electron.cancelCapabilityPackImport({ token: pendingImport.token })
    } catch {
      /* noop */
    } finally {
      setPendingImport(null)
      setImportConfirmBusy(false)
    }
  }, [pendingImport, importConfirmBusy])

  // 打开导出确认弹窗（同步，不发 IPC）：真实导出/权利确认在 ExportPackConfirmDialog 内完成。
  const openExportDialog = useCallback((id: string, version: string, readmeDraft = '') => {
    setExportTarget({ id, version, readmeDraft })
  }, [])

  const handleUninstall = useCallback(async (id: string, version: string) => {
    const key = `uninstall:${id}@${version}`
    if (busyKey) return
    setBusyKey(key)
    try {
      setPacks(await window.electron.uninstallCapabilityPack({ id, version }))
      setMessage(null)
    } catch {
      setMessage('卸载失败，请重试。')
    } finally {
      setBusyKey(null)
    }
  }, [busyKey])

  // 详情视图卸载：成功后回列表（该版本已消失，停留详情无意义）；沿用 handleUninstall 的 setPacks/错误处理
  const handleUninstallFromDetail = useCallback(
    async (id: string, version: string) => {
      await handleUninstall(id, version)
      backToList()
    },
    [handleUninstall, backToList],
  )

  // 详情拉取 not-found（版本已被卸载/外部删除）：回列表并刷新，让列表反映真实状态
  const handleDetailNotFound = useCallback(() => {
    backToList()
    refresh().catch(() => setMessage('加载能力包列表失败，请重试。'))
  }, [refresh, backToList])

  // 复制为新草稿（created/learned-own 本机产物专属，详情操作区）：成功后直接跳进编辑器子视图，
  // 让用户立即接着改；草稿列表本身在下次进「我的创作」时自然反映新增项，这里不必额外 refresh。
  const [copyToDraftBusy, setCopyToDraftBusy] = useState(false)
  const handleCopyToDraft = useCallback(
    async (id: string, version: string) => {
      if (copyToDraftBusy) return
      setCopyToDraftBusy(true)
      try {
        const meta = await window.electron.copyPackToDraft({ id, version })
        if (meta) setSub(`draft:${meta.draftId}`)
        else setMessage('复制为草稿失败，请重试。')
      } catch {
        setMessage('复制为草稿失败，请重试。')
      } finally {
        setCopyToDraftBusy(false)
      }
    },
    [copyToDraftBusy, setSub],
  )

  const hasUserPacks = packs.some((pack) => pack.origin === 'user')

  return (
    <section
      // 作家向导钉底布局的全高链路（settings 页容器 wizard 态转 h-full → 这里续上 → WizardSessionView
      // 内部消息区自滚）；其余子视图维持 space-y-3 自然流
      className={view?.kind === 'wizard' ? 'flex h-full min-h-0 flex-col' : 'space-y-3'}
      data-capability-pack-library-panel="true"
    >
      {view?.kind === 'guide' ? (
        <PackGuideView onOpenCreations={() => setSub('creations')} />
      ) : view?.kind === 'detail' ? (
        <PackDetailView
          key={`${view.id}@${view.version}`}
          id={view.id}
          version={view.version}
          onSelectVersion={(version) => setSub(`pack:${view.id}@${version}`, { replace: true })}
          onRequestExport={openExportDialog}
          onCopyToDraft={handleCopyToDraft}
          copyToDraftBusy={copyToDraftBusy}
          onUninstall={handleUninstallFromDetail}
          onNotFound={handleDetailNotFound}
        />
      ) : view?.kind === 'creations' ? (
        <WorkshopListView
          onOpenDraft={(draftId) => setSub(`draft:${draftId}`)}
          onOpenLearn={() => setSub('learn')}
          onOpenWizard={() => setSub('wizard')}
        />
      ) : view?.kind === 'learn' ? (
        <LearnFromBookView onOpenDraft={(draftId) => setSub(...feederDraftNavigation(draftId))} />
      ) : view?.kind === 'wizard' ? (
        <WizardView onOpenDraft={(draftId) => setSub(...feederDraftNavigation(draftId))} />
      ) : view?.kind === 'draft' ? (
        <DraftEditorView
          key={view.draftId}
          draftId={view.draftId}
          onPublished={refresh}
          onOpenGuide={() => setSub('guide')}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-muted-foreground">
              安装的能力包为写作提供文风、手法与结构支持，随书启用。
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-capability-pack-creations-trigger="true"
                onClick={() => setSub('creations')}
              >
                <PenTool className="size-4" />
                我的创作
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-capability-pack-guide-trigger="true"
                onClick={() => setSub('guide')}
              >
                <BookOpen className="size-4" />
                制作能力包
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busyKey === 'import'}
                data-capability-pack-import-trigger="true"
                onClick={() => void handleImport()}
              >
                <FolderPlus className="size-4" />
                导入能力包
              </Button>
            </div>
          </div>

          {message ? (
            <p className="text-xs leading-5 text-destructive" data-capability-pack-library-error="true">
              {message}
            </p>
          ) : null}

          <div className="space-y-2">
            {packs.map((pack) => (
              <CapabilityPackRow
                key={`${pack.id}@${pack.version}`}
                pack={pack}
                busy={busyKey === `uninstall:${pack.id}@${pack.version}`}
                onOpenDetail={() => setSub(`pack:${pack.id}@${pack.version}`)}
                onExport={() => openExportDialog(pack.id, pack.version)}
                onUninstall={() => void handleUninstall(pack.id, pack.version)}
              />
            ))}

            {!hasUserPacks ? (
              <div
                className="flex min-h-[56px] items-center rounded-row border border-dashed border-border px-3 py-3 text-sm leading-6 text-muted-foreground"
                data-capability-pack-library-empty="true"
              >
                暂无导入的用户能力包，点击上方「导入能力包」添加。
              </div>
            ) : null}
          </div>
        </>
      )}

      {pendingImport ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !importConfirmBusy) void handleCancelImport()
          }}
        >
          <DialogContent className={PACK_DETAIL_DIALOG_CONTENT_CLASS}>
            <DialogHeader className={PACK_DETAIL_DIALOG_HEADER_CLASS}>
              <DialogTitle className="text-lg leading-tight">确认安装能力包</DialogTitle>
              <DialogDescription className="sr-only">核对包摘要与说明后确认安装。</DialogDescription>
            </DialogHeader>
            <div className={PACK_DETAIL_DIALOG_BODY_CLASS}>
              {pendingImport.lintWarnings.length > 0 ? (
                <ImportLintWarningNotice lintWarnings={pendingImport.lintWarnings} />
              ) : null}
              <PackDetailContent
                detail={{
                  manifest: pendingImport.manifest,
                  origin: 'user',
                  installedVersions: [pendingImport.manifest.version],
                  ...(pendingImport.readme ? { readme: pendingImport.readme } : {}),
                  ...(pendingImport.readmeTruncated ? { readmeTruncated: true } : {}),
                }}
                selectedVersion={pendingImport.manifest.version}
                onSelectVersion={() => {}}
              />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={importConfirmBusy}
                onClick={() => void handleCancelImport()}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={importConfirmBusy}
                data-capability-pack-import-confirm="true"
                onClick={() => void handleConfirmImport()}
              >
                确认安装
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {exportTarget ? (
        <ExportPackConfirmDialog
          key={`${exportTarget.id}@${exportTarget.version}`}
          target={exportTarget}
          onClose={() => setExportTarget(null)}
        />
      ) : null}
    </section>
  )
}

/** severity → 分级标记文案（不改变「不阻断」语义，只做最小视觉区分，帮用户判断哪些更值得看一眼）。 */
const LINT_SEVERITY_LABEL: Record<PendingImport['lintWarnings'][number]['severity'], string> = {
  block: '高',
  warn: '注意',
}

/**
 * 导入确认弹窗内的 lint 警示区（B2 刀3 Task 9/13）：staging 阶段逐卡扫描出的「像是在给 AI
 * 下指令的语句」，只警示不阻断确认按钮——折叠展开，默认收起以免吓退正常导入。
 */
function ImportLintWarningNotice({
  lintWarnings,
}: {
  lintWarnings: PendingImport['lintWarnings']
}) {
  const totalFindings = lintWarnings.reduce((sum, entry) => sum + entry.findings.length, 0)
  if (totalFindings === 0) return null

  return (
    <Disclosure
      className="mb-4 rounded-row border border-warning/30 bg-warning/10 px-3 py-2"
      data-capability-pack-import-lint-warning="true"
      summary={
        <span className="cursor-pointer text-xs font-medium leading-5 text-warning">
          这个包的卡片里有 {totalFindings} 处像是在给 AI 下指令的语句
        </span>
      }
    >
      <div className="mt-2 space-y-1.5">
        {lintWarnings.flatMap((entry) =>
          entry.findings.map((finding, index) => (
            <p
              key={`${entry.file}-${finding.line}-${index}`}
              className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground"
              data-capability-pack-import-lint-finding={entry.file}
              data-capability-pack-import-lint-severity={entry.severity}
            >
              <span
                className={cn(
                  'mt-1 inline-block size-1.5 shrink-0 rounded-full',
                  entry.severity === 'block' ? 'bg-destructive' : 'bg-warning',
                )}
                aria-hidden="true"
              />
              <span>
                <span className={cn('font-medium', entry.severity === 'block' ? 'text-destructive' : 'text-warning')}>
                  {LINT_SEVERITY_LABEL[entry.severity]}
                </span>
                {' · '}
                <span className="font-medium text-foreground">{entry.file}</span>：{finding.excerpt}
              </span>
            </p>
          )),
        )}
      </div>
    </Disclosure>
  )
}

/**
 * 导出确认弹窗（B2 刀3 Task 13，§9.7 三段式 560px，对齐 CreateNovelDialog 骨架）：license 三选一
 * （默认 share-no-derivatives）+ 说明 textarea（预填详情页 README 或空）+「我确认有权分享此内容」
 * 勾选门（未勾选禁用发布）。`forbidden`（learned-external 场景）替换整个表单为说明文案——同一份
 * 内容无论怎么改授权都会被拒，不给用户徒劳重试的假象。
 */
function ExportPackConfirmDialog({
  target,
  onClose,
}: {
  target: { id: string; version: string; readmeDraft: string }
  onClose: () => void
}) {
  const [license, setLicense] = useState<PackLicense>('share-no-derivatives')
  const [description, setDescription] = useState(target.readmeDraft)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState<string | null>(null)

  const submit = useCallback(async () => {
    if (busy || !confirmed) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.electron.exportCapabilityPack({
        id: target.id,
        version: target.version,
        license,
        rightsConfirmed: confirmed,
        ...(description.trim() ? { readme: description } : {}),
      })
      if (result.status === 'ok') {
        toast.success(`已导出能力包：${result.filePath}`)
        onClose()
      } else if (result.status === 'forbidden') {
        setForbidden(result.message)
      } else if (result.status !== 'canceled') {
        setError(result.message)
      }
    } catch {
      setError('导出失败，请重试。')
    } finally {
      setBusy(false)
    }
  }, [busy, confirmed, description, license, target.id, target.version, onClose])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        className={`${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_FORM_CLASS}`}
        data-capability-pack-export-dialog="true"
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 pb-5 pt-6 text-left">
          <DialogTitle className="text-lg leading-tight">导出能力包</DialogTitle>
          <DialogDescription className="sr-only">选择授权类型并确认分享权利后导出。</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {forbidden ? (
            <p className="text-sm leading-6 text-muted-foreground" data-capability-pack-export-forbidden="true">
              {forbidden}
            </p>
          ) : (
            <div className="space-y-4">
              <div
                className="space-y-1.5"
                role="radiogroup"
                aria-label="授权类型"
                data-capability-pack-export-license-group="true"
              >
                {(Object.keys(PACK_LICENSE_LABELS) as PackLicense[]).map((value) => (
                  <label
                    key={value}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-row border border-border bg-surface px-3 py-2 text-sm text-foreground transition-colors',
                      license === value && 'border-brand-border bg-brand-soft',
                    )}
                  >
                    <input
                      type="radio"
                      name="pack-export-license"
                      className="size-4 accent-brand"
                      checked={license === value}
                      disabled={busy}
                      data-capability-pack-export-license-option={value}
                      onChange={() => setLicense(value)}
                    />
                    {PACK_LICENSE_LABELS[value]}
                  </label>
                ))}
              </div>

              <div className="space-y-1.5">
                <p className="text-xs font-medium leading-5 text-muted-foreground">说明（可选）</p>
                <Textarea
                  rows={4}
                  value={description}
                  disabled={busy}
                  data-capability-pack-export-readme="true"
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="写给别人看的包说明，帮助他人了解这个包能做什么"
                />
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-sm leading-6 text-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-brand"
                  checked={confirmed}
                  disabled={busy}
                  data-capability-pack-export-rights-confirm="true"
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我确认有权分享此内容
              </label>

              {error ? (
                <p className={DESTRUCTIVE_INLINE_CLASS} data-capability-pack-export-error="true">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border bg-active/40 px-6 py-4">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            {forbidden ? '关闭' : '取消'}
          </Button>
          {forbidden ? null : (
            <Button
              type="button"
              size="sm"
              disabled={busy || !confirmed}
              data-capability-pack-export-confirm="true"
              onClick={() => void submit()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              确认导出
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 单包详情子视图：拉取 getCapabilityPackDetail 并渲染 PackDetailContent。
 * 用户包提供导出/卸载 actions；官方包无 actions（锁定语义，随引擎更新）。
 * 数据拉取以 id+version 为键（宿主用 key 强制重挂载，effect 内不残留旧态）。
 * 返回入口在设置页 titlebar 面包屑（导航规范 §9.8），本视图不放返回按钮。
 */
function PackDetailView({
  id,
  version,
  onSelectVersion,
  onRequestExport,
  onCopyToDraft,
  copyToDraftBusy,
  onUninstall,
  onNotFound,
}: {
  id: string
  version: string
  onSelectVersion: (version: string) => void
  onRequestExport: (id: string, version: string, readmeDraft?: string) => void
  onCopyToDraft: (id: string, version: string) => Promise<void>
  copyToDraftBusy: boolean
  onUninstall: (id: string, version: string) => Promise<void>
  onNotFound: () => void
}) {
  const [detail, setDetail] = useState<CapabilityPackDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  // 本机产物正文（Task 13）：只在 origin='user' 时拉取，null（imported/官方）不传给 PackDetailContent
  // ——维持展示降维边界（导入包不露卡正文）。
  const [localContent, setLocalContent] = useState<LocalPackContent | null>(null)

  useEffect(() => {
    let alive = true
    setDetail(null)
    setError(null)
    window.electron
      .getCapabilityPackDetail({ id, version })
      .then((result) => {
        if (!alive) return
        if (result.status === 'ok') setDetail(result.detail)
        else onNotFound()
      })
      .catch(() => {
        if (alive) setError('加载能力包详情失败，请重试。')
      })
    return () => {
      alive = false
    }
  }, [id, version, onNotFound])

  useEffect(() => {
    if (!detail || detail.origin !== 'user') {
      setLocalContent(null)
      return
    }
    let alive = true
    window.electron
      .getLocalPackContent({ id: detail.manifest.id, version: detail.manifest.version })
      .then((result) => {
        if (alive) setLocalContent(result)
      })
      .catch(() => {
        if (alive) setLocalContent(null)
      })
    return () => {
      alive = false
    }
  }, [detail])

  const runUninstall = useCallback(async () => {
    if (actionBusy) return
    setActionBusy(true)
    try {
      await onUninstall(id, version)
    } finally {
      setActionBusy(false)
    }
  }, [actionBusy, onUninstall, id, version])

  if (error) {
    return (
      <section className="space-y-4" data-capability-pack-detail-view="true">
        <p className="text-xs leading-5 text-destructive">{error}</p>
      </section>
    )
  }

  if (!detail) {
    return (
      <section className="space-y-4" data-capability-pack-detail-view="true">
        <p className="text-xs leading-5 text-muted-foreground">加载中…</p>
      </section>
    )
  }

  const isOfficial = detail.origin === 'official'
  const canCopyToDraft = !isOfficial && (detail.localSource === 'created' || detail.localSource === 'learned-own')

  return (
    <section className="space-y-4" data-capability-pack-detail-view="true">
      <PackDetailContent
        detail={detail}
        selectedVersion={version}
        onSelectVersion={onSelectVersion}
        localCards={localContent?.cards}
        localSource={detail.localSource}
        actions={
          isOfficial ? undefined : (
            <>
              {canCopyToDraft ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={copyToDraftBusy}
                  data-capability-pack-detail-copy-to-draft="true"
                  onClick={() => void onCopyToDraft(id, version)}
                >
                  <Copy className="size-4" />
                  复制为新草稿
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-capability-pack-detail-export="true"
                onClick={() => onRequestExport(id, version, detail.readme)}
              >
                <Download className="size-4" />
                导出
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={actionBusy}
                data-capability-pack-detail-uninstall="true"
                onClick={() => void runUninstall()}
              >
                <Trash2 className="size-4" />
                卸载
              </Button>
            </>
          )
        }
      />
    </section>
  )
}

/**
 * 单条能力包行：图标 + 包名 + 署名/版本副行 + 来源徽标 + 卡数（结果语言汇总）。
 * 官方包恒在、无操作按钮（锁定语义）；用户包按 id+version 定位，行尾导出/卸载。
 * 包名/副行区域为可点热区，点击进详情子视图；行尾操作按钮不参与热区。
 */
function CapabilityPackRow({
  pack,
  busy,
  onOpenDetail,
  onExport,
  onUninstall,
}: {
  pack: CapabilityPackSummary
  /** 该行导出/卸载调用进行中：禁用行内按钮，避免并发操作同一行 */
  busy: boolean
  onOpenDetail: () => void
  onExport: () => void
  onUninstall: () => void
}) {
  const isOfficial = pack.origin === 'official'

  return (
    <div
      className="flex items-center gap-3 rounded-row border border-border bg-surface px-3 py-2.5"
      data-capability-pack-row={`${pack.id}@${pack.version}`}
      data-capability-pack-origin={pack.origin}
    >
      <div
        className={cn(
          PACK_ICON_TILE_CLASS,
          isOfficial ? 'border border-brand-border bg-brand-soft text-brand' : 'border border-border bg-active text-muted-foreground',
        )}
        aria-hidden="true"
      >
        {isOfficial ? <BadgeCheck className="size-5" /> : <Package className="size-5" />}
      </div>

      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        data-capability-pack-open-detail={`${pack.id}@${pack.version}`}
        onClick={onOpenDetail}
      >
        <div className="truncate text-sm font-medium leading-tight text-foreground">{pack.name}</div>
        <div className="mt-0.5 truncate text-xs leading-5 text-muted-foreground">
          {pack.author} · v{pack.version}
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className={MUTED_PILL_CLASS}>{isOfficial ? '官方' : '用户'}</span>
        <span className={MUTED_PILL_CLASS}>{summarizeCardTypeCounts(pack.cardTypeCounts)}</span>
      </div>

      {isOfficial ? null : (
        <div className="flex shrink-0 items-center gap-1">
          <IconTooltip label="导出">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label="导出"
              data-capability-pack-export={`${pack.id}@${pack.version}`}
              onClick={onExport}
            >
              <Download className="size-4" />
            </Button>
          </IconTooltip>
          <IconTooltip label="卸载">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label="卸载"
              data-capability-pack-uninstall={`${pack.id}@${pack.version}`}
              onClick={onUninstall}
            >
              <Trash2 className="size-4" />
            </Button>
          </IconTooltip>
        </div>
      )}
    </div>
  )
}
