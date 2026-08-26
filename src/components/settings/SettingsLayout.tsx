import { Fragment, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { GROUP_CLASS, SIDEBAR_ROW_CLASS, WARNING_PILL_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'

export type SettingsSectionItem = {
  id: string
  title: string
  /** 可选状态徽标（如内测阶段的「测试」），显示在导航项标题右侧 */
  badge?: string
}

type SettingsNavLinkProps = {
  active?: boolean
  label: string
  to: string
  badge?: string
}

export function SettingsNavLink({
  active = false,
  label,
  to,
  badge,
}: SettingsNavLinkProps) {
  return (
    <Link
      to={to}
      replace
      aria-current={active ? 'page' : undefined}
      data-active={active}
      className={cn(
        SIDEBAR_ROW_CLASS,
        active
          ? 'bg-active font-semibold text-foreground hover:bg-active'
          : 'text-muted-foreground hover:bg-hover hover:text-foreground'
      )}
    >
      <span className="flex-1 truncate">{label}</span>
      {badge ? <span className={cn(WARNING_PILL_CLASS, 'shrink-0')}>{badge}</span> : null}
    </Link>
  )
}

export function SettingsPrimarySidebar({
  activeSectionId,
  sections,
  returnTo,
}: {
  activeSectionId: string
  sections: readonly SettingsSectionItem[]
  /** 退出设置的目标路径（进入设置时捕获或从耐久落点恢复）；null 时等待解析并禁用返回。
   *  不用 navigate(-1)——设置页内部子视图导航会 push 历史，历史后退只会退回子视图上一级而非离开设置。 */
  returnTo: string | null
}) {
  const navigate = useNavigate()

  const handleBack = () => {
    if (returnTo) navigate(returnTo)
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-canvas" data-settings-sidebar="true">
      <div
        className="flex h-14 shrink-0 items-center justify-end gap-2 pl-[var(--titlebar-inset-left)] pr-3 [-webkit-app-region:drag]"
        data-settings-sidebar-headbar="true"
      >
        <IconTooltip label="返回">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="[-webkit-app-region:no-drag]"
            aria-label="返回"
            disabled={!returnTo}
            onClick={handleBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
        </IconTooltip>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pb-4">
          <div className="mb-5 px-2">
            <div className="truncate text-base font-semibold leading-tight text-foreground">设置</div>
            <div className="mt-1 truncate text-xs leading-none text-muted-foreground">应用与 Agent 配置</div>
          </div>

          <nav aria-label="设置菜单" className="space-y-1">
            {sections.map((section) => (
              <SettingsNavLink
                key={section.id}
                active={section.id === activeSectionId}
                to={`/settings?section=${section.id}`}
                label={section.title}
                badge={section.badge}
              />
            ))}
          </nav>
        </div>
      </ScrollArea>
    </aside>
  )
}

export type SettingsBreadcrumbItem = {
  label: string
  /** 提供则该级可点（导航回上级）；末级恒为当前页，不响应点击 */
  onNavigate?: () => void
}

/**
 * 设置页内容区 titlebar 面包屑（导航规范，docs/design.md §9.8）：二级视图不在内容区放返回按钮，
 * 由 titlebar 面包屑展示层级并承担返回——一级可点回上级，末级为当前页（与 titlebar h1 同字级）。
 */
export function SettingsBreadcrumb({ trail }: { trail: readonly SettingsBreadcrumbItem[] }) {
  return (
    <nav aria-label="当前位置" className="flex min-w-0 items-center gap-1.5" data-settings-breadcrumb="true">
      {trail.map((item, index) => {
        const isLast = index === trail.length - 1
        return (
          <Fragment key={`${item.label}-${index}`}>
            {index > 0 ? <ChevronRight className="size-3.5 shrink-0 text-hint-foreground" aria-hidden="true" /> : null}
            {item.onNavigate && !isLast ? (
              <button
                type="button"
                className="truncate text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
                onClick={item.onNavigate}
              >
                {item.label}
              </button>
            ) : (
              <span aria-current={isLast ? 'page' : undefined} className="truncate text-sm font-semibold text-foreground">
                {item.label}
              </span>
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

export function SettingsSection({
  children,
  id,
  title,
}: {
  children: ReactNode
  id: string
  title: string
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <h2 className="text-sm font-semibold leading-tight text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className={GROUP_CLASS}>
      {children}
    </div>
  )
}

export function SettingsRow({
  align = 'center',
  children,
  description,
  title,
}: {
  align?: 'center' | 'start'
  children?: ReactNode
  description?: ReactNode
  title: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex min-h-[60px] flex-col gap-3 px-3 py-3 sm:flex-row sm:justify-between sm:gap-6',
        align === 'start' ? 'sm:items-start' : 'sm:items-center'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium leading-tight text-foreground">
          {title}
        </div>
        {description ? (
          <div className="mt-1 text-xs leading-snug text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? <div className="w-full shrink-0 sm:w-[320px]">{children}</div> : null}
    </div>
  )
}

export function SettingsActionRow({
  children,
  status,
}: {
  children: ReactNode
  status?: ReactNode
}) {
  return (
    <div className="flex min-h-[56px] flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-xs leading-snug text-muted-foreground">
        {status}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function SettingsFieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-xs font-medium uppercase leading-none text-hint-foreground">
      {children}
    </div>
  )
}
