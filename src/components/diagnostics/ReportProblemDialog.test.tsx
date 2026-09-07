/**
 * 「报告问题」面板的 SSR 结构断言：三种状态（加载中 / 读取失败 / 就绪）各自渲染什么、按钮禁用态、
 * 预览里必须是脱敏后的内容。事件接线（点了调哪个回调）不在 SSR 覆盖范围，靠 review 走查。
 */
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dialog } from '@/components/ui/dialog'
import type { DiagnosticsReport } from '@shared/types/diagnostics-report'
import { ReportProblemDialogPanel } from './ReportProblemDialog'

const REPORT: DiagnosticsReport = {
  appVersion: '0.3.2',
  agentCoreVersion: '4.0.188',
  platform: 'win32',
  arch: 'x64',
  osVersion: '10.0.26100',
  electronVersion: '41.2.1',
  locale: 'zh-CN',
  logPath: 'C:\\Users\\alice\\AppData\\Roaming\\NarraCat\\logs\\main.log',
  logTail: ['2026-09-07T10:00:00.000Z WARN  [narracat] 事件落盘 question.answered 耗时 4200ms'],
  generatedAt: '2026-09-07T10:01:00.000Z',
}

function render(overrides: Partial<Parameters<typeof ReportProblemDialogPanel>[0]> = {}): string {
  // DialogTitle/Description 只能在 Dialog 上下文里渲染（与 confirm-dialog.test 同法）。
  return renderToStaticMarkup(
    <Dialog open>
      <ReportProblemDialogPanel
        report={REPORT}
        loadError={null}
        description=""
        onDescriptionChange={() => {}}
        onCopy={() => {}}
        onRevealLog={() => {}}
        onSubmit={() => {}}
        {...overrides}
      />
    </Dialog>,
  )
}

describe('ReportProblemDialogPanel', () => {
  test('就绪态：预览含环境表与日志尾，提交/复制可点，日志路径（含用户名）不进预览', () => {
    const html = render()
    expect(html).toContain('data-report-problem-preview="true"')
    expect(html).toContain('| NarraCat | 0.3.2 |')
    expect(html).toContain('事件落盘 question.answered 耗时 4200ms')
    expect(html).not.toContain('alice')
    expect(html).toMatch(/data-report-problem-submit="true"[^>]*>/)
    expect(html).not.toMatch(/disabled=""[^>]*data-report-problem-submit/)
    expect(html).not.toMatch(/data-report-problem-submit="true"[^>]*disabled/)
  })

  test('加载中：显示收集提示，提交与复制禁用，「打开日志文件夹」仍可点', () => {
    const html = render({ report: null })
    expect(html).toContain('正在收集诊断信息')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-report-problem-submit="true"|data-report-problem-submit="true"[^>]*disabled=""/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-report-problem-copy="true"|data-report-problem-copy="true"[^>]*disabled=""/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*data-report-problem-reveal-log="true"|data-report-problem-reveal-log="true"[^>]*disabled=""/)
  })

  test('读取失败：显示错误原因，不渲染预览', () => {
    const html = render({ report: null, loadError: 'IPC 挂了' })
    expect(html).toContain('诊断信息读取失败：IPC 挂了')
    expect(html).not.toContain('data-report-problem-preview')
  })

  test('没有日志时预览写明「还没有日志」', () => {
    const html = render({ report: { ...REPORT, logTail: [] } })
    expect(html).toContain('（还没有日志）')
  })

  test('描述回显在输入框里（失败卡片入口会预填失败原因）', () => {
    const html = render({ description: '运行失败：模型服务 502' })
    expect(html).toContain('运行失败：模型服务 502')
  })
})
