export const APP_CANVAS_CLASS = 'min-h-full bg-canvas text-foreground'

export const APP_HEADER_CLASS = 'bg-canvas text-foreground'

export const WORKSPACE_SHELL_CLASS =
  'rounded-workspace border border-border bg-workspace shadow-[var(--shadow-workspace)]'

export const WORKSPACE_STATE_CLASS =
  'rounded-workspace border border-border bg-workspace shadow-[var(--shadow-workspace)]'

export const FLOATING_PANEL_CLASS =
  'rounded-panel border border-border bg-floating shadow-[var(--shadow-floating)] backdrop-blur-2xl'

export const ASIDE_PANEL_CLASS =
  'border-border bg-glass-aside backdrop-blur-2xl'

export const CONTENT_HEADER_CLASS =
  'border-b border-border px-5 py-4 sm:px-6'

export const CARD_CLASS =
  'rounded-card border border-border bg-surface transition-all duration-200 hover:border-border-strong hover:bg-hover'

export const INTERACTIVE_CARD_CLASS =
  'rounded-panel border border-border bg-surface transition-all duration-200 hover:border-border-strong hover:bg-hover active:scale-[0.98]'

export const METRIC_TILE_CLASS =
  'rounded-panel border border-border bg-glass px-3 py-2 backdrop-blur-xl'

export const DOCUMENT_PANEL_CLASS =
  'rounded-panel border border-border bg-surface'

export const WORKBENCH_READING_CANVAS_CLASS =
  'mx-auto flex min-h-full w-full max-w-[820px] flex-col py-2 sm:py-4 [content-visibility:auto] [contain-intrinsic-size:1px_900px]'

export const GROUP_CLASS =
  'overflow-hidden rounded-row border border-border bg-surface divide-y divide-border'

export const SECTION_CLASS = 'border-b border-border pb-5 last:border-b-0'

export const REGION_CLASS = 'bg-transparent'

export const ROW_CLASS =
  'transition-all duration-200 hover:bg-hover active:scale-[0.98] data-[active=true]:bg-active data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:hover:bg-active data-[selected=true]:bg-active data-[selected=true]:font-semibold data-[selected=true]:text-foreground data-[selected=true]:hover:bg-active'

export const SIDEBAR_ROW_CLASS =
  'flex h-8 w-full items-center gap-2 rounded-row px-2 text-left text-sm transition-all duration-200 active:scale-[0.98]'

export const WORKBENCH_GUIDE_ACTION_CLASS = 'min-w-40 rounded-row'

export const WORKBENCH_RESIZE_HANDLE_CLASS =
  'group relative z-10 flex w-1.5 shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center focus-visible:outline-none'

export const WORKBENCH_RESIZE_HANDLE_LINE_CLASS =
  'h-full w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-ring'

export const TOOLBAR_BUTTON_CLASS =
  'text-muted-foreground transition-all duration-200 hover:bg-hover hover:text-foreground active:scale-[0.95] data-[state=open]:bg-active data-[state=open]:text-foreground data-[pressed=true]:bg-active data-[pressed=true]:text-foreground'

export const MUTED_PILL_CLASS =
  'rounded-full bg-active px-1.5 py-0.5 text-xs font-medium text-muted-foreground'

/** 「待确认」类小徽标（extracted 状态值等诚实标注场景）；可作 span 或可点按钮的底座 */
export const PENDING_PILL_CLASS =
  'inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-1.5 py-0 text-[11px] leading-4 text-muted-foreground'

/** 「待确认」琥珀描边小徽标（extracted 待作者确认）；结构与 PENDING_PILL_CLASS 同构、色族用 warning */
export const WARNING_OUTLINE_PILL_CLASS =
  'inline-flex shrink-0 items-center rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0 text-[11px] leading-4 text-warning'

export const SUCCESS_PILL_CLASS =
  'rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success'

export const WARNING_PILL_CLASS =
  'rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning'

export const DESTRUCTIVE_INLINE_CLASS =
  'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive'

// ── 弹窗容器档位（docs/design.md §9.7）────────────────────────────────────────
// 弹窗只有两种形态：内容型三段式（装表单/长文/对比）与轻确认框（一句话后果 + 两个按钮）。
// 宽度档位只能从这里取——DialogContent 原语的默认值（bg-floating p-6 gap-4 sm:max-w-lg）是轻确认框
// 的形态，内容型必须整套覆盖；散在业务文件里各写一遍就是漂移的来源（dialog-governance.test 守着）。

/** 三段式底座：bg-workspace 盖掉浮层色、p-0 由内部分区自管间距、gap-0 去掉段间距、overflow-hidden 让圆角裁内容。 */
export const DIALOG_SECTIONED_BASE_CLASS = 'gap-0 overflow-hidden bg-workspace p-0'
/** 内容可能超高的三段式外壳：容器成 flex 列并限高，正文区配 DIALOG_BODY_CLASS 自滚。 */
export const DIALOG_SCROLL_SHELL_CLASS = 'flex max-h-[calc(100dvh-4rem)] flex-col'
/** 表单档 560：单栏表单、短清单。 */
export const DIALOG_CONTENT_FORM_CLASS = `${DIALOG_SECTIONED_BASE_CLASS} sm:max-w-[560px]`
/** 长文档 680：详情、长文、含预览的清单。 */
export const DIALOG_CONTENT_DOCUMENT_CLASS = `${DIALOG_SECTIONED_BASE_CLASS} sm:max-w-[680px]`
/** 对比档 1320：同屏并排多个同构选项横向比较，且必须窄窗降栏（grid-cols-1 lg:grid-cols-3）。 */
export const DIALOG_CONTENT_COMPARE_CLASS = `${DIALOG_SECTIONED_BASE_CLASS} sm:max-w-[1320px]`
/** 轻确认框 448：一句话后果 + 取消/确认，用原语默认的 bg-floating p-6 裸容器。 */
export const DIALOG_CONTENT_CONFIRM_CLASS = 'sm:max-w-md'

/** 三段式头：可见标题 + 底边线；Description 用 sr-only（内容本身就是说明）。 */
export const DIALOG_HEADER_SECTIONED_CLASS = 'shrink-0 border-b border-border px-6 pb-5 pt-6 text-left'
/** 轻确认框头：只给关闭钮让位；Description 必须可见（后果说明就是这个弹窗的正文）。 */
export const DIALOG_HEADER_CONFIRM_CLASS = 'pr-8 text-left'
/** 三段式正文：自滚。 */
export const DIALOG_BODY_CLASS = 'min-h-0 flex-1 overflow-y-auto px-6 py-5'
/** 三段式按钮条：顶边线，配 DialogFooter 默认右对齐。 */
export const DIALOG_FOOTER_SECTIONED_CLASS = 'shrink-0 border-t border-border px-6 py-4'
