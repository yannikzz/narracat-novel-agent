import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { BrandIllustration } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { APP_CANVAS_CLASS } from '@/design-system'

/**
 * 匿名使用统计告知屏（ADR-0039 决定二/决定八）。
 *
 * 存在的唯一理由：**没告知就不许发**。新用户看完首启介绍后、存量用户升级后各看一次，
 * 确认之前主进程一个事件都不会发出去（闸门在 telemetry.ts 的 isTelemetryAllowed）。
 *
 * **信息架构**：这一屏只有一件事决定用户按哪个键——「我的稿子会不会被看到」。
 * 所以"永远不传"是全屏视觉最重的一块，"会传什么"压成一句代表性描述，逐条全清单外链到 FAQ
 * （ADR 承诺的"可逐条核对"由那份清单兑现，不必占掉这一屏）。初版把两边平铺成对称两栏，
 * 结果是 9 条清单一样重、读起来像法务通知，反而没人真读——那等于没告知。
 *
 * **文案规矩**（照 Apple 那套隐私征询屏，二版改过一次）：
 *   ①标题就是这件事本身、且说清谁受益——不是「关于匿名使用统计」这种名词化行话，
 *     也不是「想请你搭把手」这种没说清搭什么手的招呼；
 *   ②第一句一句话说完"做什么 + 为什么"，主谓句，不用「为此」「以便」这类书面连接词；
 *     并且**用用户脑子里已经有的品类词**（「使用数据」「分析」），不自造机制描述——
 *     写成「把你用到了哪些功能发给我们」反而更吓人，读着像在盯着你个人看，
 *     而「匿名的使用数据」是人人见过、一眼归类的东西（Apple 中文版用的是「诊断与使用数据」）；
 *   ③承诺句逐个点名具体东西（正文、大纲、书名、Key），不写「任何个人信息」这种空话；
 *   ③b **面向用户一律用第一人称单数「我」，不用「我们」**——NarraCat 对外只有一个开发者，
 *     写「我们」是端着，且在一个讲信任的页面上尤其别扭：这里请求的是用户对一个具体的人的信任；
 *   ④**按钮是成对的动词，读得出两个键的区别**——「同意 / 不同意」，而不是最初那版
 *     「知道了 / 不参与」：后者两个键不对称，读不出按下去分别会发生什么，用户只好靠猜。
 *     主按钮排在右边，跟 macOS 原生对话框的确认位一致。
 *
 * 采集口径与 shared/types/telemetry.ts 一致。**改口径（尤其新增采集项）时必须同时改这里的
 * 文案并 bump CURRENT_TELEMETRY_NOTICE_VERSION**，否则已确认过的用户永远看不到新口径。
 */

/**
 * 永远不传什么：卡片里只点最要命的四样，完整逐条清单在 FAQ（下方"看完整清单"）。
 *
 * 试过把七项排成标签墙，不好看也不对——**pill 是"可点"的视觉语言**（筛选器、标签选择），
 * 这七个不能点，形状在许诺一个给不出的交互；再叠上圆徽、圆卡，一张小卡里三层圆角，
 * 噪声比信息多。排成清单又会被当成免责声明整块扫过去。
 * 最后选了最克制的一档：承诺句 + 一行代表性点名，逐条核对交给 FAQ。
 */
const NEVER_COLLECTED_SUMMARY = '正文、大纲、人物设定与 API Key 都在内'

const FAQ_URL = 'https://github.com/yannikzz/narracat-novel-agent/blob/main/docs/faq.md'

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
      <div className="flex flex-1 items-center justify-center px-8 pb-16">
        <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
          <BrandIllustration purpose="telemetry-notice" size="lg" />

          <div className="flex flex-col gap-2.5">
            <h1 className="text-2xl font-semibold text-foreground">帮 NarraCat 变得更好用</h1>
            <p className="text-base leading-7 text-muted-foreground">
              自动发送匿名的使用数据，帮我分析哪些功能真的好用、哪些该改。
            </p>
          </div>

          {/* 全屏最重的一块：用户真正要的答案。用 success 色系轻染，与插画那颗绿心同一色族。 */}
          <div className="w-full rounded-panel border border-success/25 bg-success/5 px-5 py-4 text-left">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                <ShieldCheck className="size-4" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-medium leading-6 text-foreground">
                  你写的每一个字都不会离开这台电脑
                </p>
                <p className="text-xs leading-5 text-muted-foreground">{NEVER_COLLECTED_SUMMARY}</p>
              </div>
            </div>
          </div>

          <p className="text-xs leading-6 text-muted-foreground">
            发出去的只有用过哪些功能（新建项目、立项卡对话、规划大纲、正文润色这些步骤也在内）、成败和耗时区间，
            连着一个本机随机 ID，我无法反查到人。随时可在设置里关掉。
            <a
              href={FAQ_URL}
              target="_blank"
              rel="noreferrer"
              className="ml-1 text-foreground underline underline-offset-2"
            >
              看完整清单
            </a>
          </p>

          {/* 主按钮在右：与 macOS 原生对话框的确认位一致，用户的肌肉记忆落在那儿。 */}
          <div className="flex items-center gap-2.5 pt-1">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => choose(onDecline)}>
              不同意
            </Button>
            <Button type="button" disabled={busy} onClick={() => choose(onAccept)}>
              同意
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
