import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useLocation, useNavigate } from 'react-router'
import { Bell, CheckCheck, Circle, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LoadRecoveryNotice } from '@/components/LoadRecoveryNotice'
import { EMPTY_PRIMARY_BODY_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import {
  EMPTY_LOAD_STATE,
  beginLoad,
  completeLoad,
  createLoadIssue,
  failLoad,
  runWithFiniteRetry,
  type LoadState,
} from '@/lib/load-state'
import {
  listResultNotifications,
  markAllResultNotificationsRead,
  onResultNotificationsChanged,
} from '@/lib/ipc'
import { openResultNotification } from '@/lib/result-notification-navigation'
import {
  readResultNotificationProjection,
  rememberResultNotificationProjection,
} from '@/lib/result-notification-projection'
import type { ResultNotification, ResultNotificationList } from '@shared/types/notifications'
import {
  getNotificationDropdownPlacement,
  getNotificationPanelMotion,
  NOTIFICATION_PANEL_TRANSITION,
  type NotificationBellPlacement,
} from './notification-panel-placement'

const EMPTY_NOTIFICATION_LIST: ResultNotificationList = {
  notifications: [],
  totalCount: 0,
  unreadCount: 0,
}

function hasResultNotificationApi(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.electron?.listResultNotifications) &&
    Boolean(window.electron?.onResultNotificationsChanged)
  )
}

function formatNotificationTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''

  const diffMs = Date.now() - timestamp
  const minute = 60_000
  const hour = 60 * minute
  if (diffMs < minute) return '刚刚'
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))} 分钟前`

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

export function ResultNotificationPanel({
  notifications,
  unreadCount,
  onMarkAllRead,
  onNotificationClick,
  loadState = completeLoad(),
  onRetry,
  retrying = false,
  returnTo = '/',
}: {
  notifications: ResultNotification[]
  unreadCount: number
  onMarkAllRead: () => void
  onNotificationClick: (notification: ResultNotification) => void
  loadState?: LoadState
  onRetry?: () => void
  retrying?: boolean
  returnTo?: string
}) {
  const visibleNotifications = notifications.slice(0, 20)
  const unreadLabel = `${unreadCount} 条未读`

  return (
    <section
      aria-label="通知面板"
      className="w-[360px] overflow-hidden rounded-panel border border-border bg-popover text-foreground shadow-[var(--shadow-floating)]"
      data-result-notification-panel="true"
    >
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">通知</div>
          <div className="mt-1 text-xs leading-none text-muted-foreground">{unreadLabel}</div>
        </div>
        {unreadCount > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={onMarkAllRead}>
            <CheckCheck className="size-3.5" />
            全部标为已读
          </Button>
        ) : null}
      </header>

      {loadState.issue ? (
        <LoadRecoveryNotice
          className="m-2"
          compact
          from={returnTo}
          issue={loadState.issue}
          onRetry={onRetry ?? (() => {})}
          retrying={retrying}
          stale={loadState.status === 'stale'}
        />
      ) : null}

      {loadState.status === 'error' && !loadState.hasData ? null : visibleNotifications.length === 0 ? (
        <div className={`px-4 py-8 text-center ${EMPTY_PRIMARY_BODY_CLASS}`}>暂无通知</div>
      ) : (
        <div className="max-h-[420px] space-y-1 overflow-auto p-2">
          {visibleNotifications.map((notification) => {
            const unread = !notification.readAt
            return (
              <button
                key={notification.id}
                type="button"
                className={cn(
                  'grid w-full grid-cols-[8px_1fr] gap-2 rounded-row px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
                  unread && 'bg-active',
                )}
                data-result-notification-row="true"
                data-unread={unread}
                onClick={() => onNotificationClick(notification)}
              >
                <span className="pt-1.5">
                  {unread ? (
                    <Circle className="size-1.5 fill-foreground text-foreground" aria-hidden="true" />
                  ) : (
                    <span className="block size-1.5" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold leading-snug text-foreground">
                    {notification.title}
                  </span>
                  <span className="mt-1 block truncate text-xs leading-none text-muted-foreground">
                    {notification.projectName} · {formatNotificationTime(notification.updatedAt)}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function GlobalNotificationBell({
  className,
  placement = 'topbar',
}: {
  className?: string
  placement?: NotificationBellPlacement
}) {
  const [open, setOpen] = useState(false)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [suppressTooltip, setSuppressTooltip] = useState(false)
  const [loading, setLoading] = useState(true)
  const initialProjectionRef = useRef(readResultNotificationProjection())
  const [payload, setPayload] = useState<ResultNotificationList>(
    initialProjectionRef.current ?? EMPTY_NOTIFICATION_LIST,
  )
  const [loadState, setLoadState] = useState<LoadState>(
    initialProjectionRef.current ? completeLoad() : EMPTY_LOAD_STATE,
  )
  const loadStateRef = useRef(loadState)
  const mountedRef = useRef(false)
  const requestSequenceRef = useRef(0)
  const navigate = useNavigate()
  const location = useLocation()
  const dropdownPlacement = getNotificationDropdownPlacement(placement)
  const panelMotion = getNotificationPanelMotion(placement)

  function updateLoadState(next: LoadState) {
    loadStateRef.current = next
    setLoadState(next)
  }

  function updatePayload(next: ResultNotificationList) {
    rememberResultNotificationProjection(next)
    setPayload(next)
  }

  async function loadNotifications() {
    const requestSequence = ++requestSequenceRef.current
    const previous = loadStateRef.current
    updateLoadState(beginLoad(previous))
    setLoading(true)

    try {
      const next = await runWithFiniteRetry(() => listResultNotifications())
      if (!mountedRef.current || requestSequence !== requestSequenceRef.current) return

      updatePayload(next)
      updateLoadState(completeLoad())
    } catch (error) {
      if (!mountedRef.current || requestSequence !== requestSequenceRef.current) return

      updateLoadState(failLoad(previous, createLoadIssue('notifications', error)))
    } finally {
      if (mountedRef.current && requestSequence === requestSequenceRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    mountedRef.current = true

    if (!hasResultNotificationApi()) {
      setLoading(false)
      return () => {
        mountedRef.current = false
      }
    }

    // 每次挂载都发一次首载，不用「只发一次」的 ref 守卫：卸载时 requestSequence 已经 +1，上一次挂载的
    // 请求回来会被当成过期丢掉、且不复位 loading——React StrictMode（dev）会把 effect 挂载→卸载→再挂载，
    // 守卫让第二次挂载不再发请求，于是铃铛永远转圈、列表永远空（2026-09-07 dev 撞到）。
    // 陈旧请求由 requestSequence 兜底，重复首载最多多读一次本地 JSON，无害。
    void loadNotifications()
    const unsubscribe = onResultNotificationsChanged((next) => {
      requestSequenceRef.current += 1
      updatePayload(next)
      updateLoadState(completeLoad())
      setLoading(false)
    })

    return () => {
      mountedRef.current = false
      requestSequenceRef.current += 1
      unsubscribe()
    }
  }, [])

  async function handleMarkAllRead() {
    try {
      updatePayload(await markAllResultNotificationsRead())
    } catch (error) {
      console.error(error)
    }
  }

  async function handleNotificationClick(notification: ResultNotification) {
    try {
      const nextPayload = await openResultNotification({
        notification,
        navigate,
        notify: (message) => toast.info(message),
      })
      if (nextPayload) updatePayload(nextPayload)
    } catch (error) {
      console.error(error)
    }
    setOpen(false)
  }

  function handleDropdownOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    setTooltipOpen(false)
    setSuppressTooltip(true)
  }

  function handleTooltipOpenChange(nextOpen: boolean) {
    if (nextOpen && (open || suppressTooltip)) return

    setTooltipOpen(nextOpen)
  }

  function handleTriggerPointerDown() {
    setTooltipOpen(false)
    setSuppressTooltip(true)
  }

  function handleTriggerPointerLeave() {
    setSuppressTooltip(false)
    setTooltipOpen(false)
  }

  function handleTriggerBlur() {
    setSuppressTooltip(false)
    setTooltipOpen(false)
  }

  return (
    <TooltipProvider>
      <DropdownMenu open={open} onOpenChange={handleDropdownOpenChange}>
        <IconTooltip label="通知" open={open || suppressTooltip ? false : tooltipOpen} onOpenChange={handleTooltipOpenChange}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn('relative', className)}
              aria-label="通知"
              data-global-notification-bell="true"
              onBlur={handleTriggerBlur}
              onPointerDown={handleTriggerPointerDown}
              onPointerLeave={handleTriggerPointerLeave}
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <Bell className="size-4" />}
              {payload.unreadCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 size-2 rounded-full bg-destructive ring-2 ring-canvas"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </IconTooltip>
        <DropdownMenuContent
          align={dropdownPlacement.align}
          side={dropdownPlacement.side}
          sideOffset={dropdownPlacement.sideOffset}
          collisionPadding={dropdownPlacement.collisionPadding}
          className="overflow-visible border-0 bg-transparent p-0 shadow-none"
        >
          <motion.div
            animate={open ? panelMotion.animate : panelMotion.exit}
            data-notification-panel-placement={placement}
            data-result-notification-motion="true"
            exit={panelMotion.exit}
            initial={panelMotion.initial}
            style={{ transformOrigin: panelMotion.transformOrigin }}
            transition={NOTIFICATION_PANEL_TRANSITION}
          >
            <ResultNotificationPanel
              loadState={loadState}
              notifications={payload.notifications}
              unreadCount={payload.unreadCount}
              onMarkAllRead={handleMarkAllRead}
              onNotificationClick={handleNotificationClick}
              onRetry={() => void loadNotifications()}
              retrying={loading}
              returnTo={`${location.pathname}${location.search}`}
            />
          </motion.div>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  )
}
