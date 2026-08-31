import { useState, type ReactElement } from 'react'
import { Link } from 'react-router'
import { Ellipsis, MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { cn } from '@/lib/cn'
import type { WorkbenchAction } from '@/lib/workbench-actions'
import { buildWorkbenchTabHref } from '@/lib/workbench-navigation'
import type { WorkbenchPrimarySectionId, WorkbenchTabItem } from '@/lib/workbench-navigation'
import type { WorkbenchGenerationState } from '@/lib/workbench-generation'
import type { WorkbenchChapterView } from '@shared/types/workbench'
import { getWorkbenchActionIcon } from './workbench-action-icons'
import { WorkbenchGenerationAnimation } from './WorkbenchGenerationAnimation'

function TitlebarGenerationIndicator({ generationState }: { generationState: WorkbenchGenerationState }) {
  // waiting-user 时机器没在跑：不能继续转动画、也不能承诺「完成后自动刷新」，等的是作者。
  const waiting = generationState.phase === 'waiting-user'

  return (
    <IconTooltip
      label={generationState.statusText}
      description={waiting ? '在右侧对话里回答后继续' : '完成后自动刷新'}
      side="bottom"
      align="start"
    >
      <span
        className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground [-webkit-app-region:no-drag]"
        data-workbench-titlebar-generation="true"
        data-workbench-titlebar-generation-phase={generationState.phase}
      >
        {waiting ? (
          <MessageCircleQuestion aria-hidden="true" className="size-3.5" />
        ) : (
          <WorkbenchGenerationAnimation size="mini" />
        )}
        <span>{waiting ? '等你回答' : '正在生成'}</span>
      </span>
    </IconTooltip>
  )
}

interface WorkbenchChapterTabItem {
  value: WorkbenchChapterView
  label: string
  exists: boolean
}

function resolveTitlebarActionSlots(actions: WorkbenchAction[]) {
  const copyAction = actions.find((action) => action.placement === 'copy' || action.id === 'copy-visible-document')
  const refreshAction = actions.find((action) => action.placement === 'refresh' || action.id === 'refresh-project')
  const utilityActions = actions.filter((action) => action.placement === 'utility')
  const secondaryAction = actions.find((action) => action.placement === 'secondary')
  const primaryAction =
    actions.find((action) => action !== copyAction && action.placement === 'primary') ??
    actions.find(
      (action) =>
        action !== copyAction &&
        action !== refreshAction &&
        action.placement !== 'more' &&
        action.placement !== 'secondary',
    )
  const moreActions = actions.filter(
    (action) =>
      action !== copyAction &&
      action !== refreshAction &&
      action !== primaryAction &&
      action !== secondaryAction &&
      !utilityActions.includes(action),
  )

  return { copyAction, primaryAction, refreshAction, secondaryAction, utilityActions, moreActions }
}

// Button 基类带 `disabled:pointer-events-none`：一旦禁用就接不到 hover/focus，
// 而 IconTooltip 用 asChild 把这个元素本身作为 Radix trigger 直接克隆 props，
// 所以 tooltip 也就永远弹不出来。禁用态下换成外层可命中的 span 承接 hover/focus
// （Radix 会把 trigger 的事件/属性合并到这个 span 上），Button 本身仍保持 disabled。
// 注意：这里必须是返回元素的普通函数而非 React 组件——用组件包一层会吞掉 Radix
// Slot 合并进来的 props（data-slot、onPointerEnter 等），导致 tooltip 结构性失效。
function wrapTitlebarActionTrigger(enabled: boolean, button: ReactElement): ReactElement {
  if (enabled) return button

  return (
    <span className="inline-flex" tabIndex={0}>
      {button}
    </span>
  )
}

// primary（secondary='secondary' variant，深色底）与 manuscript-cancel 这类 secondary（ghost，无底色）
// 共用同一套「图标+文案」Button 结构，只是 variant 和挂载的 data 标记不同。
function TitlebarLabeledAction({
  action,
  dataAttribute,
  variant,
  onTitlebarAction,
}: {
  action: WorkbenchAction
  dataAttribute: Record<string, string>
  variant: 'secondary' | 'ghost'
  onTitlebarAction?: (action: WorkbenchAction) => void
}) {
  const { Icon } = getWorkbenchActionIcon(action)

  return (
    <IconTooltip
      label={action.label}
      description={action.enabled ? action.description : action.disabledReason ?? action.description}
      side="bottom"
      align="end"
    >
      {wrapTitlebarActionTrigger(
        action.enabled,
        <Button
          type="button"
          variant={variant}
          size="sm"
          className="[-webkit-app-region:no-drag]"
          aria-label={action.label}
          data-action-icon={getWorkbenchActionIcon(action).key}
          data-workbench-titlebar-action={action.id}
          {...dataAttribute}
          disabled={!action.enabled}
          onClick={() => onTitlebarAction?.(action)}
        >
          <Icon className="size-3.5" />
          <span>{action.label}</span>
        </Button>,
      )}
    </IconTooltip>
  )
}

function TitlebarIconAction({
  action,
  dataAttribute,
  onTitlebarAction,
}: {
  action: WorkbenchAction
  dataAttribute?: Record<string, string>
  onTitlebarAction?: (action: WorkbenchAction) => void
}) {
  const { Icon, key } = getWorkbenchActionIcon(action)

  return (
    <IconTooltip
      label={action.label}
      description={action.enabled ? action.description : action.disabledReason ?? action.description}
      side="bottom"
      align="end"
    >
      {wrapTitlebarActionTrigger(
        action.enabled,
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="[-webkit-app-region:no-drag]"
          aria-label={action.label}
          data-action-icon={key}
          data-workbench-titlebar-action={action.id}
          disabled={!action.enabled}
          onClick={() => onTitlebarAction?.(action)}
          {...dataAttribute}
        >
          <Icon className="size-4" />
        </Button>,
      )}
    </IconTooltip>
  )
}

function TitlebarMoreActionMenu({
  actions,
  onTitlebarAction,
}: {
  actions: WorkbenchAction[]
  onTitlebarAction?: (action: WorkbenchAction) => void
}) {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [moreTooltipOpen, setMoreTooltipOpen] = useState(false)
  const [suppressMoreTooltip, setSuppressMoreTooltip] = useState(false)

  function handleMoreMenuOpenChange(open: boolean) {
    setMoreMenuOpen(open)
    setMoreTooltipOpen(false)

    if (!open) {
      setSuppressMoreTooltip(true)
    }
  }

  function handleMoreTooltipOpenChange(open: boolean) {
    if (open && (moreMenuOpen || suppressMoreTooltip)) {
      return
    }

    setMoreTooltipOpen(open)
  }

  function handleMoreTriggerPointerEnter() {
    setSuppressMoreTooltip(false)

    if (!moreMenuOpen) {
      setMoreTooltipOpen(true)
    }
  }

  function handleMoreTriggerPointerLeave() {
    setMoreTooltipOpen(false)
  }

  function handleMoreTriggerPointerDown() {
    setMoreTooltipOpen(false)
  }

  function handleMoreTriggerBlur() {
    setSuppressMoreTooltip(false)
    setMoreTooltipOpen(false)
  }

  return (
    <DropdownMenu open={moreMenuOpen} onOpenChange={handleMoreMenuOpenChange}>
      <IconTooltip
        label="更多操作"
        side="bottom"
        align="end"
        open={moreTooltipOpen}
        onOpenChange={handleMoreTooltipOpenChange}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="[-webkit-app-region:no-drag]"
            aria-label="更多操作"
            data-workbench-titlebar-more-trigger="true"
            onPointerEnter={handleMoreTriggerPointerEnter}
            onPointerLeave={handleMoreTriggerPointerLeave}
            onPointerDown={handleMoreTriggerPointerDown}
            onBlur={handleMoreTriggerBlur}
          >
            <Ellipsis className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </IconTooltip>
      <DropdownMenuContent align="end" sideOffset={6}>
        {actions.map((action) => {
          const { Icon } = getWorkbenchActionIcon(action)
          // 禁用项接不到 hover（data-[disabled]:pointer-events-none），tooltip 弹不出来，
          // 原因说明直接排在标签下方（与 WorkbenchEmptyGuide 的 disabledReason 模式同款）。
          const disabledReason = !action.enabled ? action.disabledReason : undefined

          return (
            <DropdownMenuItem
              key={action.id}
              disabled={!action.enabled}
              variant={action.danger ? 'destructive' : 'default'}
              data-workbench-titlebar-menu-action={action.id}
              onSelect={() => onTitlebarAction?.(action)}
            >
              <Icon className="size-4" />
              <span className="flex min-w-0 flex-col">
                <span>{action.label}</span>
                {disabledReason && (
                  <span
                    className="text-xs text-hint-foreground"
                    data-workbench-titlebar-menu-disabled-reason="true"
                  >
                    {disabledReason}
                  </span>
                )}
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function WorkbenchObjectHeader({
  activeTabId,
  chapterTabs,
  chapterView,
  generationState,
  onChapterViewChange,
  projectPath,
  sectionId,
  sectionTitle,
  tabs,
  titlebarActions = [],
  onTitlebarAction,
}: {
  activeTabId: string | null
  chapterTabs?: WorkbenchChapterTabItem[]
  chapterView?: WorkbenchChapterView
  generationState?: WorkbenchGenerationState | null
  projectPath: string
  sectionId: WorkbenchPrimarySectionId
  sectionTitle: string
  tabs: WorkbenchTabItem[]
  titlebarActions?: WorkbenchAction[]
  onChapterViewChange?: (value: WorkbenchChapterView) => void
  onTitlebarAction?: (action: WorkbenchAction) => void
}) {
  const rendersChapterTabs = chapterTabs !== undefined
  const rendersDocumentTabs = !rendersChapterTabs && sectionId !== 'reference-works'
  const { copyAction, primaryAction, refreshAction, secondaryAction, utilityActions, moreActions } =
    resolveTitlebarActionSlots(titlebarActions)

  return (
    <>
      <header
        className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-workspace px-5 [-webkit-app-region:drag]"
        data-workbench-titlebar="true"
      >
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-sm font-semibold text-foreground">{sectionTitle}</h1>
          {generationState && <TitlebarGenerationIndicator generationState={generationState} />}
        </div>
        {titlebarActions.length > 0 && (
          <div
            className="flex shrink-0 items-center justify-end gap-1.5 [-webkit-app-region:no-drag]"
            data-workbench-titlebar-actions="true"
          >
            {primaryAction && (
              <TitlebarLabeledAction
                action={primaryAction}
                variant="secondary"
                dataAttribute={{ 'data-workbench-titlebar-primary-action': primaryAction.id }}
                onTitlebarAction={onTitlebarAction}
              />
            )}
            {secondaryAction && (
              <TitlebarLabeledAction
                action={secondaryAction}
                variant="ghost"
                dataAttribute={{ 'data-workbench-titlebar-secondary-action': secondaryAction.id }}
                onTitlebarAction={onTitlebarAction}
              />
            )}
            {utilityActions.map((action) => (
              <TitlebarIconAction
                key={action.id}
                action={action}
                dataAttribute={{ 'data-workbench-titlebar-utility-action': action.id }}
                onTitlebarAction={onTitlebarAction}
              />
            ))}
            {copyAction && (
              <TitlebarIconAction
                action={copyAction}
                dataAttribute={{ 'data-workbench-titlebar-copy-action': copyAction.id }}
                onTitlebarAction={onTitlebarAction}
              />
            )}
            {refreshAction && (
              <TitlebarIconAction
                action={refreshAction}
                dataAttribute={{ 'data-workbench-titlebar-refresh-action': refreshAction.id }}
                onTitlebarAction={onTitlebarAction}
              />
            )}
            {moreActions.length > 0 && (
              <TitlebarMoreActionMenu actions={moreActions} onTitlebarAction={onTitlebarAction} />
            )}
          </div>
        )}
      </header>

      {rendersChapterTabs || rendersDocumentTabs ? (
        <div
          className="flex h-10 shrink-0 items-center overflow-hidden border-b border-border bg-workspace px-3"
          data-workbench-tabbar="true"
        >
          <nav aria-label={`${sectionTitle}文档`} className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {rendersChapterTabs ? (
            chapterTabs.map((tab) => {
              const active = tab.value === chapterView

              return (
                <button
                  key={tab.value}
                  type="button"
                  aria-label={tab.exists ? tab.label : `${tab.label}，未生成`}
                  aria-current={active ? 'page' : undefined}
                  data-active={active}
                  data-workbench-chapter-tab={tab.value}
                  className={cn(
                    `
                      flex h-7 shrink-0 items-center gap-1.5 rounded-row px-2.5 text-xs
                      transition-colors duration-150
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      focus-visible:ring-offset-2 focus-visible:ring-offset-canvas
                    `,
                    active
                      ? 'bg-active font-semibold text-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                  )}
                  onClick={() => onChapterViewChange?.(tab.value)}
                >
                  <span className="truncate">{tab.label}</span>
                  {!tab.exists && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />}
                </button>
              )
            })
            ) : (
            tabs.map((tab) => {
              const active = tab.id === activeTabId

              return (
                <Link
                  key={tab.id}
                  to={buildWorkbenchTabHref({ projectPath, sectionId, tabId: tab.id })}
                  aria-label={tab.exists ? tab.title : `${tab.title}，未生成`}
                  aria-current={active ? 'page' : undefined}
                  data-active={active}
                  className={cn(
                    `
                      flex h-7 shrink-0 items-center gap-1.5 rounded-row px-2.5 text-xs
                      transition-colors duration-150
                      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      focus-visible:ring-offset-2 focus-visible:ring-offset-canvas
                    `,
                    active
                      ? 'bg-active font-semibold text-foreground'
                      : 'text-muted-foreground hover:bg-hover hover:text-foreground',
                  )}
                >
                  <span className="truncate">{tab.title}</span>
                  {!tab.exists && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />}
                </Link>
              )
            })
            )}
          </nav>
        </div>
      ) : null}
    </>
  )
}
