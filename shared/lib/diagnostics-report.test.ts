/**
 * 「报告问题」纯函数层测试：脱敏不漏（家目录两种斜杠、API Key、Bearer）、Issue 正文按编码字节限长
 * 且从最旧行砍、链接落在正确仓库。
 */
import { describe, expect, test } from 'bun:test'
import type { DiagnosticsReport } from '@shared/types/diagnostics-report'
import {
  buildGitHubIssueUrl,
  NARRACAT_GITHUB_REPO,
  renderClipboardReport,
  renderIssueDraft,
  sanitizeLogText,
  takeLogTail,
} from './diagnostics-report'

function report(overrides: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    appVersion: '0.3.2',
    agentCoreVersion: '4.0.188',
    platform: 'win32',
    arch: 'x64',
    osVersion: '10.0.26100',
    electronVersion: '41.2.1',
    locale: 'zh-CN',
    logPath: 'C:\\Users\\alice\\AppData\\Roaming\\NarraCat\\logs\\main.log',
    logTail: ['2026-09-07T10:00:00.000Z WARN  [narracat] 回答的问题不在等待中：requestId=abc pending=0'],
    generatedAt: '2026-09-07T10:01:00.000Z',
    ...overrides,
  }
}

describe('sanitizeLogText', () => {
  test('家目录两种斜杠写法都抹成 ~（Windows 日志里两种都会出现）', () => {
    const text = 'read C:\\Users\\alice\\Documents\\book.md and C:/Users/alice/x'
    expect(sanitizeLogText(text, { homeDir: 'C:\\Users\\alice' })).toBe('read ~\\Documents\\book.md and ~/x')
  })

  test('API Key / Bearer / x-api-key 整段抹掉', () => {
    const text = 'key=sk-abcdefghijklmnop Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x x-api-key: abcdefgh12345'
    const out = sanitizeLogText(text)
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).not.toContain('eyJhbGci')
    expect(out).not.toContain('abcdefgh12345')
    expect(out).toContain('sk-***')
    expect(out).toContain('Bearer ***')
  })

  test('homeDir 为空不动文本', () => {
    expect(sanitizeLogText('/Users/x/y', { homeDir: '' })).toBe('/Users/x/y')
  })
})

describe('takeLogTail', () => {
  test('取最后 N 个非空行', () => {
    expect(takeLogTail('a\n\nb\r\nc\n', 2)).toEqual(['b', 'c'])
  })
})

describe('renderIssueDraft', () => {
  test('标题带平台前缀 + 描述首行；正文含环境表、描述、脱敏日志', () => {
    const draft = renderIssueDraft(report(), '提交按钮点不了\n第二行')
    expect(draft.title).toBe('[Windows] 提交按钮点不了')
    expect(draft.body).toContain('| NarraCat | 0.3.2 |')
    expect(draft.body).toContain('Windows 10.0.26100 (x64)')
    expect(draft.body).toContain('提交按钮点不了\n第二行')
    expect(draft.body).toContain('回答的问题不在等待中')
    // 日志路径不进正文（它含用户名）
    expect(draft.body).not.toContain('alice')
  })

  test('没写描述：标题回落「问题反馈」，正文留占位提示', () => {
    const draft = renderIssueDraft(report(), '   ')
    expect(draft.title).toBe('[Windows] 问题反馈')
    expect(draft.body).toContain('请在这里写下发生了什么')
  })

  test('日志按编码后字节限长，从最旧行砍、最新行保留', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `${index} 这是一条比较长的中文日志用来撑爆预算`)
    const draft = renderIssueDraft(report({ logTail: lines }), 'x')
    expect(draft.body).toContain('399 这是一条')
    expect(draft.body).not.toContain('\n0 这是一条')
    expect(encodeURIComponent(draft.body).length).toBeLessThanOrEqual(6_500)
  })

  test('没有日志时正文写明「没有日志」而不是空代码块', () => {
    expect(renderIssueDraft(report({ logTail: [] }), 'x').body).toContain('（没有日志）')
  })
})

describe('buildGitHubIssueUrl', () => {
  test('落在本仓 issues/new，title/body/labels 走 query', () => {
    const url = buildGitHubIssueUrl({ title: 't', body: 'b' })
    expect(url.startsWith(`https://github.com/${NARRACAT_GITHUB_REPO}/issues/new?`)).toBe(true)
    const params = new URL(url).searchParams
    expect(params.get('title')).toBe('t')
    expect(params.get('body')).toBe('b')
    expect(params.get('labels')).toBe('bug')
  })
})

describe('renderClipboardReport', () => {
  test('剪贴板版不裁日志，全部行都在', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `${index} 这是一条比较长的中文日志用来撑爆预算`)
    const text = renderClipboardReport(report({ logTail: lines }), '描述')
    expect(text).toContain('\n0 这是一条')
    expect(text).toContain('399 这是一条')
    expect(text).not.toContain('（没有日志）')
  })
})
