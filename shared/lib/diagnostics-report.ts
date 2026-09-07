/**
 * 「报告问题」的纯函数层（双进程共用）：日志脱敏、Issue 正文渲染、GitHub 新建 Issue 链接。
 *
 * 设计取舍：第一步走**预填 Issue 链接**而不是服务端代发——零后端、用户看得见自己发出去什么、
 * 开源仓天然合适。代价是需要 GitHub 账号且要能访问 GitHub；给没有账号的用户留了「复制诊断信息」
 * 这条路。服务端代发（Worker 代理）留作第二步，要先处理垃圾投递与隐私托管。
 */
import type { DiagnosticsReport } from '@shared/types/diagnostics-report'

export const NARRACAT_GITHUB_REPO = 'yannikzz/narracat-novel-agent'

/**
 * GitHub 对 GET 请求 URL 的实际上限约 8KB；正文经 encodeURIComponent 后中文每字 9 字节，
 * 所以正文按**编码后字节**限长，超出的日志行从最旧的那头砍。
 */
const MAX_ENCODED_BODY_BYTES = 6_500
/** 描述在正文里的预算（编码后字节，约 200 个中文字）：超出的部分只留在剪贴板；不限它一段长描述就能把链接撑到 414。 */
const MAX_ENCODED_DESCRIPTION_BYTES = 1_800
const DESCRIPTION_TRUNCATED_NOTE = '…（描述过长已截断，完整内容已复制到剪贴板）'
/** 整条链接的硬上限（GitHub 对 GET 约 8KB 就 414），拼完再兜一次底。 */
export const MAX_ISSUE_URL_LENGTH = 7_600

/** 脱敏：家目录 → `~`；常见 API Key / Bearer 形态整段抹掉。日志文件本体不脱敏（本机取证要保真）。 */
export function sanitizeLogText(text: string, options: { homeDir?: string } = {}): string {
  let result = text
  const home = options.homeDir?.trim()
  if (home) {
    // Windows 路径在日志里可能是正斜杠也可能是反斜杠，两种写法都要抹。
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')])
    for (const variant of variants) {
      if (!variant) continue
      result = result.split(variant).join('~')
    }
  }
  result = result
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/(x-api-key['"]?\s*[:=]\s*['"]?)[A-Za-z0-9._-]{8,}/gi, '$1***')
  return result
}

/** 日志末尾按行取最后 maxLines 行（空行不计），供诊断包与 Issue 正文用。 */
export function takeLogTail(text: string, maxLines: number): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.slice(Math.max(0, lines.length - maxLines))
}

function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform
}

export function renderEnvironmentTable(report: DiagnosticsReport): string {
  const rows: Array<[string, string]> = [
    ['NarraCat', report.appVersion],
    ['Agent Core', report.agentCoreVersion ?? '未检测'],
    ['系统', `${platformLabel(report.platform)} ${report.osVersion} (${report.arch})`],
    ['Electron', report.electronVersion],
    ['语言', report.locale],
  ]
  return ['| 项 | 值 |', '|---|---|', ...rows.map(([key, value]) => `| ${key} | ${value} |`)].join('\n')
}

export interface IssueDraft {
  title: string
  body: string
}

/** 按编码后字节截断（中文每字 9 字节），末尾附说明；不超预算原样返回。 */
function truncateToEncodedBytes(text: string, budget: number, note: string): string {
  if (encodedBytes(text) <= budget) return text
  const noteBytes = encodedBytes(note)
  let end = 0
  let used = 0
  for (const char of text) {
    const cost = encodedBytes(char)
    if (used + cost > budget - noteBytes) break
    used += cost
    end += char.length
  }
  return `${text.slice(0, end)}${note}`
}

/**
 * Issue 正文：环境表 + 用户描述 + 已脱敏日志尾。描述与日志段都按编码后字节预算裁剪（日志从最旧行砍），
 * 保证最终 URL 不超 GitHub 上限；完整描述与日志由渲染端另行复制到剪贴板（descriptionBudget=Infinity）。
 */
export function renderIssueDraft(
  report: DiagnosticsReport,
  description: string,
  options: { descriptionBudget?: number } = {},
): IssueDraft {
  const trimmed = description.trim()
  const firstLine = trimmed.split('\n')[0]?.trim() ?? ''
  const title = `[${platformLabel(report.platform)}] ${firstLine || '问题反馈'}`.slice(0, 60)
  const bodyDescription = truncateToEncodedBytes(
    trimmed,
    options.descriptionBudget ?? MAX_ENCODED_DESCRIPTION_BYTES,
    DESCRIPTION_TRUNCATED_NOTE,
  )

  const head = [
    '## 问题描述',
    '',
    bodyDescription || '（请在这里写下发生了什么、你做了什么操作、期望看到什么）',
    '',
    '## 环境',
    '',
    renderEnvironmentTable(report),
    '',
    '## 最近日志（已脱敏）',
    '',
  ].join('\n')
  const foot = ['', '', `<sub>由 NarraCat 「报告问题」生成于 ${report.generatedAt}</sub>`].join('\n')

  const budget = MAX_ENCODED_BODY_BYTES - encodedBytes(head) - encodedBytes(foot) - encodedBytes('```\n```')
  const kept: string[] = []
  let used = 0
  for (let index = report.logTail.length - 1; index >= 0; index -= 1) {
    const line = report.logTail[index]!
    const cost = encodedBytes(`${line}\n`)
    if (used + cost > budget) break
    kept.unshift(line)
    used += cost
  }
  const logBlock = kept.length > 0 ? ['```', ...kept, '```'].join('\n') : '（没有日志）'
  return { title, body: `${head}${logBlock}${foot}` }
}

function encodedBytes(text: string): number {
  return encodeURIComponent(text).length
}

export function buildGitHubIssueUrl(draft: IssueDraft, repo = NARRACAT_GITHUB_REPO): string {
  const build = (body: string) =>
    `https://github.com/${repo}/issues/new?${new URLSearchParams({ title: draft.title, body, labels: 'bug' }).toString()}`
  let url = build(draft.body)
  // 兜底：预算是按段估的，拼完仍超长就从日志块尾部逐行砍（最旧行在前，砍前面的）。
  let body = draft.body
  while (url.length > MAX_ISSUE_URL_LENGTH) {
    const fenceStart = body.indexOf('```\n')
    const fenceEnd = body.lastIndexOf('\n```')
    if (fenceStart < 0 || fenceEnd <= fenceStart) break
    const inner = body.slice(fenceStart + 4, fenceEnd)
    const lines = inner.split('\n')
    if (lines.length <= 1) break
    body = `${body.slice(0, fenceStart + 4)}${lines.slice(1).join('\n')}${body.slice(fenceEnd)}`
    url = build(body)
  }
  return url
}

/** 剪贴板用的完整版：不裁日志（Issue 正文里放不下的部分让用户贴进评论）。 */
export function renderClipboardReport(report: DiagnosticsReport, description: string): string {
  return [
    renderIssueDraft({ ...report, logTail: [] }, description, { descriptionBudget: Number.POSITIVE_INFINITY }).body.replace(
      '（没有日志）',
      '',
    ),
    '```',
    ...report.logTail,
    '```',
  ].join('\n')
}
