import type { ReactNode } from 'react'
import { APP_CANVAS_CLASS, APP_HEADER_CLASS } from '@/design-system'

type AppShellProps = {
  /** 顶部导航的左侧内容（标题 / 返回按钮 etc） */
  navStart?: ReactNode
  /** 顶部导航的居中内容（主视图切换 etc） */
  navCenter?: ReactNode
  /** 顶部导航的右侧内容（设置图标 / 操作按钮 etc） */
  navEnd?: ReactNode
  /** 主内容 */
  children: ReactNode
}

export function AppShell({ navStart, navCenter, navEnd, children }: AppShellProps) {
  return (
    <div className={`${APP_CANVAS_CLASS} flex h-full flex-col`}>
      {/* 顶部 nav：只承担拖拽和轻量导航，不再作为一块有边框的独立 surface。
          左右 padding 平台感知：mac 给左上角红绿灯让位（--titlebar-inset-left），
          Windows 给右上角系统 caption 按钮让位（--titlebar-inset-right），
          再加呼吸位——caption 与 navEnd 图标只隔让位线会读成一团（视觉混排）。
          左侧同样 +1rem 呼吸位：原实现是 header px-4 与内层 pl-[112px] 两层叠加（合计 128px），
          收进变量时必须保留两层语义，与右侧 +0.75rem 写法对称。 */}
      <header
        className={`
          ${APP_HEADER_CLASS}
          relative flex items-center justify-between
          h-14 shrink-0
          pl-[max(1rem,calc(var(--titlebar-inset-left)+1rem))]
          pr-[max(1rem,calc(var(--titlebar-inset-right)+0.75rem))]
          [-webkit-app-region:drag]
        `}
      >
        <div className="flex h-full min-w-0 items-center gap-2.5 leading-none [-webkit-app-region:no-drag] [&_a]:leading-none [&_button]:leading-none [&_span]:leading-none [&_svg]:shrink-0">
          {navStart}
        </div>
        {navCenter ? (
          <div className="absolute left-1/2 top-0 flex h-full -translate-x-1/2 select-none items-center leading-none [-webkit-app-region:drag] [&_a]:[-webkit-app-region:no-drag] [&_button]:[-webkit-app-region:no-drag] [&_button]:leading-none [&_span]:leading-none">
            {navCenter}
          </div>
        ) : null}
        <div className="flex h-full items-center gap-1.5 leading-none [-webkit-app-region:no-drag] [&_a]:leading-none [&_button]:leading-none [&_span]:leading-none [&_svg]:shrink-0">
          {navEnd}
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-auto">
        {children}
      </main>
    </div>
  )
}
