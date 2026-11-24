/**
 * 专业版推荐：文案、下载地址与「看过没有」的版本号。
 *
 * 开源版此后以维护为主，新功能做在专业版（NarraCat Pro，免费下载）。这里的每一句都对着专业版
 * 已发布的版本说明写，不写还没上线的东西；专业版导入规则（复制一份、原书不改、Key 要重填）
 * 以专业版的「从开源版导入」为准，那边改了这里要跟着改。
 */

/** 强提醒的版本号：文案大改、需要老用户再看一次时 +1。与 config.proNoticeVersion 比较。 */
export const CURRENT_PRO_NOTICE_VERSION = 1

export const PRO_SITE_URL = 'https://narracat.com/'

const PRO_DOWNLOAD_BASE = 'https://pro-update.narracat.com'

/** 下载入口来源：拼进下载地址，只用于按入口数下载次数，不带任何用户信息。 */
export type ProReferralSource = 'oss-notice' | 'oss-titlebar' | 'oss-settings'

/**
 * 按平台给专业版安装包直链；专业版只出 macOS（Apple 芯片）与 Windows x64 两种包，
 * 与开源版相同。其他平台给官网。
 */
export function proDownloadUrl(platform: string | undefined, source: ProReferralSource): string {
  const file =
    platform === 'darwin' ? 'mac-arm64/latest.dmg' : platform === 'win32' ? 'win-x64/latest.exe' : null
  return file ? `${PRO_DOWNLOAD_BASE}/${file}?src=${source}` : `${PRO_SITE_URL}?src=${source}`
}

/** main.tsx 把主进程平台写在 <html data-platform> 上；测试与浏览器环境里没有就给官网。 */
export function currentPlatform(): string | undefined {
  return typeof document === 'undefined' ? undefined : document.documentElement.dataset.platform
}

export interface ProEditionPoint {
  title: string
  detail: string
}

export const PRO_EDITION_HEADLINE = '新功能都在 NarraCat 专业版'

export const PRO_EDITION_SUMMARY = '开源版之后以维护为主，新功能都做在专业版里。专业版免费下载，书可以一键带过去。'

export const PRO_EDITION_ADVANTAGES: readonly ProEditionPoint[] = [
  { title: '一键接通模型', detail: '浏览器里登录授权就能写，不用复制 Key，热门模型 7.5 折起' },
  { title: '记忆更懂前因后果', detail: '改了前面一章，只重新核对真正改了剧情的几章；地点、物件、势力也记近况' },
  { title: '长任务更稳', detail: '断网、限流、服务出错时自动重试，已经保存的不受影响' },
  { title: '技能市场', detail: '上百个写作技能，按需一步装上' },
]

export const PRO_EDITION_MIGRATION: readonly ProEditionPoint[] = [
  { title: '书一本不丢', detail: '第一次打开专业版，勾选要带过去的书，复制一份过去；这里的原书一个字都不改' },
  { title: '两个可以同时装', detail: '各用各的数据，开源版照常能用，随时可以回来' },
  { title: '模型设置一起带走', detail: 'API Key 要在专业版里重填一次，也可以用 TokenDance 一键接通，不用 Key' },
]

/** 如实说没带过去的东西：少一句，用户搬过去才发现缺了，比不搬更伤信任。 */
export const PRO_EDITION_NOT_CARRIED = '能力包和参考作品分析暂时没有带过去，写法偏好可以写进专业版的自定义指令。'

/** 点了下载之后的下一步：把「装上 → 导入」这条路说清楚，用户不用自己摸。 */
export const PRO_EDITION_NEXT_STEPS: readonly string[] = [
  '下载好后安装并打开专业版',
  '先关掉开源版，再在专业版里勾选要带过去的书',
  '接通模型后，在专业版里接着写',
]
