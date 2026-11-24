import { useState } from 'react'
import { Check, ShieldCheck, Sparkles } from 'lucide-react'
import { BrandIllustration } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import {
  APP_CANVAS_CLASS,
  DIALOG_BODY_CLASS,
  DIALOG_CONTENT_DOCUMENT_CLASS,
  DIALOG_HEADER_SECTIONED_CLASS,
  DIALOG_SCROLL_SHELL_CLASS,
} from '@/design-system'
import {
  PRO_EDITION_ADVANTAGES,
  PRO_EDITION_HEADLINE,
  PRO_EDITION_MIGRATION,
  PRO_EDITION_NEXT_STEPS,
  PRO_EDITION_NOT_CARRIED,
  PRO_EDITION_SUMMARY,
  PRO_SITE_URL,
  currentPlatform,
  proDownloadUrl,
  type ProReferralSource,
} from '@/lib/pro-edition'

/**
 * 专业版推荐的正文：好在哪 → 搬过去会怎样 → 下载。强提醒全屏页与常驻入口的弹窗共用这一份，
 * 两处说法不会走样。
 *
 * 信息顺序按「用户为什么不搬」排：先给理由（好在哪），再把最大的顾虑（书会不会丢、要不要重配）
 * 放进视觉最重的一块，最后如实写没带过去的东西。点了下载就换成「下一步」，把装上 → 导入这条路说完。
 */
export function ProEditionPanel({
  source,
  dismissLabel,
  onDismiss,
  onDownload,
}: {
  source: ProReferralSource
  /** 不搬时的按钮字；下载之后变成「知道了」。 */
  dismissLabel: string
  onDismiss: () => void
  onDownload?: () => void
}) {
  const [downloaded, setDownloaded] = useState(false)

  function download(): void {
    // 外链统一交给主进程的 setWindowOpenHandler 用系统浏览器打开（只放行安全地址）。
    window.open(proDownloadUrl(currentPlatform(), source), '_blank', 'noopener')
    setDownloaded(true)
    onDownload?.()
  }

  return (
    <div className="flex w-full flex-col gap-5 text-left" data-pro-edition-panel={source}>
      <ul className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
        {PRO_EDITION_ADVANTAGES.map((point) => (
          <li key={point.title} className="flex items-start gap-2.5">
            <Sparkles className="mt-1 size-3.5 shrink-0 text-brand" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium leading-6 text-foreground">{point.title}</p>
              <p className="text-xs leading-5 text-muted-foreground">{point.detail}</p>
            </div>
          </li>
        ))}
      </ul>

      {/* 视觉最重的一块：用户最怕的是书丢、要重配。与告知屏「不会离开这台电脑」同一色族。 */}
      <div className="rounded-panel border border-success/25 bg-success/5 px-5 py-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-success" aria-hidden />
          <p className="text-sm font-medium text-foreground">搬过去会怎样</p>
        </div>
        <ul className="mt-3 flex flex-col gap-2.5">
          {PRO_EDITION_MIGRATION.map((point) => (
            <li key={point.title} className="flex items-start gap-2.5">
              <Check className="mt-1 size-3.5 shrink-0 text-success" aria-hidden />
              <p className="text-xs leading-5 text-muted-foreground">
                <span className="font-medium text-foreground">{point.title}</span>：{point.detail}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{PRO_EDITION_NOT_CARRIED}</p>
      </div>

      {downloaded ? (
        <div className="flex flex-col gap-3" data-pro-edition-next-steps="true">
          <p className="text-sm font-medium text-foreground">下载已在浏览器里开始，接下来：</p>
          <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-xs leading-5 text-muted-foreground">
            {PRO_EDITION_NEXT_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="flex items-center justify-end gap-2.5 pt-1">
            <Button type="button" variant="ghost" onClick={download}>
              重新下载
            </Button>
            <Button type="button" onClick={onDismiss}>
              知道了
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 pt-1">
          <a
            href={`${PRO_SITE_URL}?src=${source}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            去官网看看
          </a>
          {/* 主按钮在右：与告知屏、macOS 原生对话框的确认位一致。 */}
          <div className="flex items-center gap-2.5">
            <Button type="button" variant="ghost" onClick={onDismiss}>
              {dismissLabel}
            </Button>
            <Button type="button" onClick={download}>
              下载专业版
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 升级到这一版（或新装）后首屏弹一次的强提醒；不搬也只弹这一次，之后靠常驻入口。 */
export function ProEditionNotice({ onDownload, onDone }: { onDownload: () => void; onDone: () => void }) {
  return (
    <div className={`${APP_CANVAS_CLASS} fixed inset-0 z-50 flex flex-col overflow-auto`}>
      {/* 顶部留出与主窗口一致的拖拽区，否则这一屏没法拖动窗口。 */}
      <div className="h-14 shrink-0 [-webkit-app-region:drag]" />
      <div className="flex flex-1 items-center justify-center px-8 pb-16">
        <div className="flex w-full max-w-xl flex-col items-center gap-6">
          <BrandIllustration purpose="about" size="lg" />
          <div className="flex flex-col gap-2.5 text-center">
            <h1 className="text-2xl font-semibold text-foreground">{PRO_EDITION_HEADLINE}</h1>
            <p className="text-base leading-7 text-muted-foreground">{PRO_EDITION_SUMMARY}</p>
          </div>
          <ProEditionPanel
            source="oss-notice"
            dismissLabel="暂不，继续用开源版"
            onDismiss={onDone}
            onDownload={onDownload}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * 常驻入口：强提醒被关掉后，书架顶栏与设置「关于」里都留一个，点开是同一份内容。
 * `titlebar` 是顶栏的小字按钮，`row` 是设置行里的普通按钮。
 */
export function ProEditionEntry({ variant }: { variant: 'titlebar' | 'row' }) {
  const [open, setOpen] = useState(false)
  const source: ProReferralSource = variant === 'titlebar' ? 'oss-titlebar' : 'oss-settings'

  const trigger =
    variant === 'titlebar' ? (
      <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-brand" data-pro-edition-entry={variant}>
        <Sparkles className="size-3.5" aria-hidden />
        专业版
      </Button>
    ) : (
      <Button type="button" variant="outline" size="sm" data-pro-edition-entry={variant}>
        了解专业版
      </Button>
    )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {variant === 'titlebar' ? (
        <IconTooltip label="新功能都在专业版，免费下载">
          <DialogTrigger asChild>{trigger}</DialogTrigger>
        </IconTooltip>
      ) : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent className={`${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_DOCUMENT_CLASS}`}>
        <div className={`${DIALOG_HEADER_SECTIONED_CLASS} flex flex-col gap-2`}>
          <DialogTitle className="text-lg leading-tight">{PRO_EDITION_HEADLINE}</DialogTitle>
          <DialogDescription className="text-sm leading-6">{PRO_EDITION_SUMMARY}</DialogDescription>
        </div>
        <div className={DIALOG_BODY_CLASS}>
          <ProEditionPanel source={source} dismissLabel="暂不" onDismiss={() => setOpen(false)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
