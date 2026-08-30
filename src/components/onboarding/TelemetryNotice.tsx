import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { APP_CANVAS_CLASS } from '@/design-system'

/**
 * 匿名使用统计告知屏（ADR-0039 决定二/决定八）。
 *
 * 存在的唯一理由：**没告知就不许发**。新用户看完首启介绍后、存量用户升级后各看一次，
 * 确认之前主进程一个事件都不会发出去（闸门在 telemetry.ts 的 isTelemetryAllowed）。
 *
 * 文案里的两栏"会传/永远不传"不是宣传语，是逐条对得上 shared/types/telemetry.ts 的清单。
 * **改了那边就要改这边，并且 bump CURRENT_TELEMETRY_NOTICE_VERSION**，否则已确认过的
 * 用户永远看不到新口径——那就等于没告知。
 */

const COLLECTED = [
  'App 版本、操作系统',
  '哪个功能被打开过（只记模块名，不记你做了什么）',
  '写章节的成败与耗时区间',
  '在用哪个模型渠道',
  '写到第几章的区间（如「6-20 章」）',
]

const NEVER_COLLECTED = [
  '小说正文、章节标题、大纲、人物设定',
  '任何你输入的文字',
  'API Key',
  '本机文件路径、小说名',
]

export function TelemetryNotice({
  onAccept,
  onDecline,
}: {
  onAccept: () => void
  onDecline: () => void
}) {
  const [busy, setBusy] = useState(false)

  function choose(action: () => void): void {
    if (busy) return
    setBusy(true)
    action()
  }

  return (
    <div className={`${APP_CANVAS_CLASS} fixed inset-0 z-50 flex flex-col overflow-auto`}>
      {/* 顶部留出与主窗口一致的拖拽区，否则这一屏没法拖动窗口。 */}
      <div className="h-14 shrink-0 [-webkit-app-region:drag]" />
      <div className="flex flex-1 items-center justify-center px-8 pb-12">
        <div className="flex w-full max-w-2xl flex-col gap-7">
          <div className="flex flex-col gap-2.5">
            <h1 className="text-2xl font-semibold text-foreground">关于匿名使用统计</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              NarraCat 会收集一点匿名的使用数据，用来判断哪些功能真的有人用、哪些该改。
              我们做这件事的前提是先把它讲清楚。
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <section className="flex flex-col gap-2.5">
              <h2 className="text-sm font-medium text-foreground">会传这些</h2>
              <ul className="flex flex-col gap-1.5">
                {COLLECTED.map((item) => (
                  <li key={item} className="text-sm leading-6 text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
            <section className="flex flex-col gap-2.5">
              <h2 className="text-sm font-medium text-foreground">永远不传</h2>
              <ul className="flex flex-col gap-1.5">
                {NEVER_COLLECTED.map((item) => (
                  <li key={item} className="text-sm leading-6 text-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <p className="text-xs leading-6 text-muted-foreground">
            数据只关联一个本机随机生成的 ID，与你的账号、设备指纹都无关，我们无法反查到具体某个人。
            这些代码在公开仓库里可以逐行核对，你也可以随时在「设置 → 安全与项目」里关掉。
          </p>

          <div className="flex items-center gap-2.5">
            <Button type="button" size="sm" disabled={busy} onClick={() => choose(onAccept)}>
              知道了
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => choose(onDecline)}
            >
              不参与
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
