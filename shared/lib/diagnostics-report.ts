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

/**
 * Issue 正文：环境表 + 用户描述 + 已脱敏日志尾。日志段按编码后字节预算裁剪（从最旧行砍），
 * 保证最终 URL 不超 GitHub 上限；完整日志由渲染端另行复制到剪贴板。
 */
export function renderIssueDraft(report: DiagnosticsReport, description: string): IssueDraft {
  const trimmed = description.trim()
  const firstLine = trimmed.split('\n')[0]?.trim() ?? ''
  const title = `[${platformLabel(report.platform)}] ${firstLine || '问题反馈'}`.slice(0, 120)

  const head = [
    '## 问题描述',
    '',
    trimmed || '（请在这里写下发生了什么、你做了什么操作、期望看到什么）',
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
  const params = new URLSearchParams({ title: draft.title, body: draft.body, labels: 'bug' })
  return `https://github.com/${repo}/issues/new?${params.toString()}`
}

/** 剪贴板用的完整版：不裁日志（Issue 正文里放不下的部分让用户贴进评论）。 */
export function renderClipboardReport(report: DiagnosticsReport, description: string): string {
  return [
    renderIssueDraft({ ...report, logTail: [] }, description).body.replace('（没有日志）', ''),
    '```',
    ...report.logTail,
    '```',
  ].join('\n')
}
