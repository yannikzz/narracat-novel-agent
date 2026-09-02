import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * 危险/需确认操作的统一确认弹窗（#400：替换原生 window.confirm）。
 * 文案约定：description 要用大白话讲清「这个操作会发生什么、能不能恢复」。
 * 删书级的 type-to-confirm 不在此覆盖（见 library 的 LibraryProjectDeletePanel）。
 */
export interface ConfirmDialogCopy {
  title: string
  /** 后果说明：会发生什么、能不能恢复。 */
  description: ReactNode
  /** 确认按钮文案，默认「继续」。 */
  confirmLabel?: string
  /** 取消按钮文案，默认「取消」。 */
  cancelLabel?: string
  /** 不可恢复的危险操作置 true：确认钮走 destructive 红色。 */
  danger?: boolean
}

/** 弹窗内容面板；单独导出便于测试（惯例同 CreateNovelDialogPanel / LibraryProjectDeletePanel）。 */
export function ConfirmDialogPanel({
  cancelLabel = '取消',
  confirmLabel = '继续',
  danger = false,
  description,
  onCancel,
  onConfirm,
  title,
}: ConfirmDialogCopy & {
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div data-confirm-dialog-panel="true" className="grid gap-5">
      <DialogHeader className="pr-8 text-left">
        <DialogTitle className="text-lg leading-tight">{title}</DialogTitle>
        <DialogDescription className="whitespace-pre-line">{description}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button type="button" variant="secondary" data-confirm-dialog-cancel="true" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={danger ? 'destructive' : 'default'}
          data-confirm-dialog-confirm="true"
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}

export function ConfirmDialog({
  onCancel,
  onConfirm,
  onDismiss,
  open,
  ...copy
}: ConfirmDialogCopy & {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  /**
   * Esc / 点遮罩 / 右上角关闭。不传则并入 onCancel（既有调用方行为不变）。
   *
   * 分开是因为两者语义不同：点「取消」是一个明确的回答，随手关掉不是。
   * 有的调用方会把「回答过了」记下来不再问，那种场景必须能区分。
   */
  onDismiss?: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) (onDismiss ?? onCancel)()
      }}
    >
      <DialogContent className="sm:max-w-md" data-confirm-dialog="true">
        <ConfirmDialogPanel {...copy} onCancel={onCancel} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  )
}

/**
 * promise 化确认：`await confirm(copy)` 得到 true/false，可直接替换 async 流程里的
 * window.confirm。使用方须把返回的 `confirmDialog` 渲染进组件树。
 */
/** 三种收场。`dismiss` = Esc / 遮罩 / 关闭按钮，不是一个回答。 */
export type ConfirmOutcome = 'confirm' | 'cancel' | 'dismiss'

export function useConfirmDialog(): {
  confirm: (copy: ConfirmDialogCopy) => Promise<boolean>
  /** 需要区分「明确取消」与「随手关掉」时用它——例如「答过就不再问」这类记忆型提示。 */
  confirmWithOutcome: (copy: ConfirmDialogCopy) => Promise<ConfirmOutcome>
  confirmDialog: ReactNode
} {
  const [copy, setCopy] = useState<ConfirmDialogCopy | null>(null)
  const [open, setOpen] = useState(false)
  const resolverRef = useRef<((outcome: ConfirmOutcome) => void) | null>(null)

  const settle = useCallback((outcome: ConfirmOutcome) => {
    resolverRef.current?.(outcome)
    resolverRef.current = null
    // 只收 open，保留 copy 供关闭动画期间继续渲染内容。
    setOpen(false)
  }, [])

  // 卸载时把挂起的确认按「随手关掉」收尾，避免调用方 await 悬死。
  useEffect(
    () => () => {
      resolverRef.current?.('dismiss')
      resolverRef.current = null
    },
    [],
  )

  const confirmWithOutcome = useCallback((next: ConfirmDialogCopy) => {
    return new Promise<ConfirmOutcome>((resolve) => {
      // 同一时刻只允许一个确认在挂：新确认到来时旧的按「随手关掉」收尾。
      resolverRef.current?.('dismiss')
      resolverRef.current = resolve
      setCopy(next)
      setOpen(true)
    })
  }, [])

  const confirm = useCallback(
    (next: ConfirmDialogCopy) => confirmWithOutcome(next).then((outcome) => outcome === 'confirm'),
    [confirmWithOutcome],
  )

  const confirmDialog = copy ? (
    <ConfirmDialog
      {...copy}
      open={open}
      onCancel={() => settle('cancel')}
      onConfirm={() => settle('confirm')}
      onDismiss={() => settle('dismiss')}
    />
  ) : null

  return { confirm, confirmWithOutcome, confirmDialog }
}
