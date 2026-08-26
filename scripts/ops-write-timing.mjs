#!/usr/bin/env node
/**
 * 单章写作耗时瀑布（issue #28）：读 pi 已经在写的会话记录，把一次 run 的墙钟拆成
 * 「子 agent 派发 / 主会话模型调用 / 本地工具」三类，回答「这一章的时间到底花在哪」。
 *
 * 为什么是只读脚本而不是生产埋点：pi 的 `sessions/*.jsonl` 每条 message 本就带 timestamp、
 * model、usage，Task 的 subagent_type 也在调用参数里——重建瀑布不需要再往**用户磁盘**写一份
 * 仪表产物。issue #29 的诊断就是这么做出来的（PR #32 据此关闭，分支
 * feat/28-write-timing-instrumentation 保留，里面有 JSONL 给不了的 prefill/decode 拆分）。
 *
 * 口径三点须知（都是真机数据上撞出来的，别想当然）：
 * - 并发派发（write.md 步骤 6 一次 4 个 memory-keeper）按**区间并集**算挂钟，不是逐个相加，
 *   否则 4 路各 81s 会记成 324s。
 * - 一条 assistant 消息的 timestamp 是它**写完**的时刻，所以「模型调用耗时」取它与上一条消息
 *   的间隔（含连线、排队、prefill、解码）。
 * - **同一条 assistant 消息里发出的工具是一批，整批的 toolResult 共用一个写入时刻**，于是批内
 *   每个工具的「耗时」都等于批次挂钟。模型常在派发 Task 的同时调 TaskUpdate，若照单全收，
 *   4 个 TaskUpdate 会各自背上 273s，把「本地工具」算成 709s——实测真值是 4.8s。因此混批
 *   （含 Task）里的本地工具一律不计入本地工具耗时，只计数并在报告里标注。
 *
 * 只读：不写、不删任何文件。
 *
 * 用法：
 *   node scripts/ops-write-timing.mjs                  最近一次会话
 *   node scripts/ops-write-timing.mjs --list           列出可选会话
 *   node scripts/ops-write-timing.mjs <file.jsonl>     指定会话文件
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TASK_TOOL_NAME = 'Task'
const NAMESPACE_PREFIX = /^narracat:/

/** pi 会话目录：Electron `app.getPath('userData')` 在脚本里跑不到，按平台惯例推。 */
export function piSessionsDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
    return join(appData, 'NarraCat', 'pi-agent', 'sessions')
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'NarraCat', 'pi-agent', 'sessions')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'NarraCat', 'pi-agent', 'sessions')
}

/** 坏行跳过而不是整份放弃：会话文件可能被中断写坏最后一行。 */
export function parseSessionLines(text) {
  const records = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // 忽略半行
    }
  }
  return records
}

/** 区间并集总长：并发派发的重叠部分只算一次。 */
export function mergeIntervalsMs(intervals) {
  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  let total = 0
  let cursor = -Infinity
  for (const { start, end } of sorted) {
    const from = Math.max(start, cursor)
    if (end > from) total += end - from
    cursor = Math.max(cursor, end)
  }
  return total
}

function readToolCalls(message) {
  if (!Array.isArray(message?.content)) return []
  return message.content.filter((block) => block?.type === 'toolCall' && typeof block.id === 'string')
}

export function summarizeSession(records) {
  const messages = records.filter((record) => record?.type === 'message' && record.message)
  const pending = new Map()
  const spans = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const models = new Set()
  let modelCalls = 0
  let modelMs = 0
  let previousMs

  for (const record of messages) {
    const at = Date.parse(record.timestamp)
    const message = record.message
    if (!Number.isFinite(at)) continue

    if (message.role === 'assistant') {
      modelCalls += 1
      if (previousMs !== undefined) modelMs += Math.max(0, at - previousMs)
      if (typeof message.model === 'string') models.add(message.model)
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        if (typeof message.usage?.[key] === 'number') usage[key] += message.usage[key]
      }
      const batch = readToolCalls(message)
      // 批内混了 Task 时，本地工具的结束时刻会被最慢的 Task 拖长（整批共用写入时刻）。
      const batchHasTask = batch.some((call) => call.name === TASK_TOOL_NAME)
      for (const call of batch) {
        const isTask = call.name === TASK_TOOL_NAME
        pending.set(call.id, {
          startMs: at,
          isTask,
          durationTrusted: isTask || !batchHasTask,
          label: isTask
            ? String(call.arguments?.subagent_type ?? 'unknown').replace(NAMESPACE_PREFIX, '')
            : String(call.name ?? 'unknown'),
        })
      }
    }

    if (message.role === 'toolResult') {
      const started = pending.get(message.toolCallId)
      if (started) {
        pending.delete(message.toolCallId)
        spans.push({ ...started, endMs: at, isError: message.isError === true })
      }
    }

    previousMs = at
  }

  const startedAtMs = messages.length ? Date.parse(messages[0].timestamp) : undefined
  const finishedAtMs = messages.length ? Date.parse(messages[messages.length - 1].timestamp) : undefined
  const toIntervals = (list) => list.map((span) => ({ start: span.startMs, end: span.endMs }))
  const subagentSpans = spans.filter((span) => span.isTask)
  const localSpans = spans.filter((span) => !span.isTask && span.durationTrusted)
  const localSpansShadowed = spans.filter((span) => !span.isTask && !span.durationTrusted)

  const byAgent = new Map()
  for (const span of subagentSpans) {
    const entry = byAgent.get(span.label) ?? { agentId: span.label, calls: 0, totalMs: 0, errors: 0 }
    entry.calls += 1
    entry.totalMs += span.endMs - span.startMs
    if (span.isError) entry.errors += 1
    byAgent.set(span.label, entry)
  }

  return {
    sessionId: records.find((record) => record?.type === 'session')?.id,
    startedAtMs,
    finishedAtMs,
    wallMs: startedAtMs !== undefined && finishedAtMs !== undefined ? finishedAtMs - startedAtMs : 0,
    models: [...models],
    modelCalls,
    modelMs,
    usage,
    subagentWallMs: mergeIntervalsMs(toIntervals(subagentSpans)),
    subagentSumMs: subagentSpans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0),
    localToolWallMs: mergeIntervalsMs(toIntervals(localSpans)),
    localToolCalls: localSpans.length,
    /** 与 Task 同批、耗时被拖长而不可信的本地工具（只计数，不计时）。 */
    localToolShadowed: localSpansShadowed.length,
    unfinished: pending.size,
    subagents: subagentSpans.map((span, index) => ({
      order: index + 1,
      agentId: span.label,
      ms: span.endMs - span.startMs,
      isError: span.isError,
    })),
    byAgent: [...byAgent.values()].sort((a, b) => b.totalMs - a.totalMs),
  }
}

const seconds = (ms) => `${(ms / 1000).toFixed(0)}s`
const share = (ms, total) => (total > 0 ? `${((ms / total) * 100).toFixed(1)}%` : '—')

export function formatReport(summary) {
  const lines = []
  const total = summary.wallMs
  lines.push(`会话 ${summary.sessionId ?? '(未知)'}`)
  lines.push(`总墙钟 ${seconds(total)}（${(total / 60000).toFixed(1)} 分钟）  模型 ${summary.models.join(', ') || '—'}`)
  lines.push('')
  lines.push('归因（子 agent 与本地工具按区间并集算挂钟，并发不重复计）：')
  lines.push(`  子 agent 派发    ${seconds(summary.subagentWallMs).padStart(6)}  ${share(summary.subagentWallMs, total).padStart(6)}`)
  lines.push(`  主会话模型调用   ${seconds(summary.modelMs).padStart(6)}  ${share(summary.modelMs, total).padStart(6)}  （${summary.modelCalls} 次，含派发等待）`)
  const shadowed = summary.localToolShadowed > 0 ? `，另有 ${summary.localToolShadowed} 次与派发同批、耗时不可分辨` : ''
  lines.push(`  本地工具 / MCP   ${seconds(summary.localToolWallMs).padStart(6)}  ${share(summary.localToolWallMs, total).padStart(6)}  （${summary.localToolCalls} 次${shadowed}）`)
  lines.push('')
  lines.push('子 agent 明细（按派发顺序）：')
  for (const span of summary.subagents) {
    lines.push(`  ${String(span.order).padStart(2)}. ${span.agentId.padEnd(20)} ${seconds(span.ms).padStart(6)}${span.isError ? '  ⚠️ 失败' : ''}`)
  }
  lines.push('')
  lines.push('按 agent 汇总（totalMs 是逐次相加，并发时会大于挂钟）：')
  for (const entry of summary.byAgent) {
    lines.push(`  ${entry.agentId.padEnd(20)} ${String(entry.calls).padStart(2)} 次  ${seconds(entry.totalMs).padStart(6)}${entry.errors ? `  ⚠️ ${entry.errors} 次失败` : ''}`)
  }
  lines.push('')
  const { input, output, cacheRead, cacheWrite } = summary.usage
  lines.push(`token：入 ${input} / 出 ${output} / 缓存读 ${cacheRead} / 缓存写 ${cacheWrite}`)
  if (summary.unfinished > 0) {
    lines.push(`⚠️ 有 ${summary.unfinished} 个工具调用没等到结果（run 被中止或会话被截断），其耗时未计入。`)
  }
  return lines.join('\n')
}

export function listSessionFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const path = join(dir, name)
      return { path, name, mtimeMs: statSync(path).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function main(argv) {
  const args = argv.slice(2)
  const dir = piSessionsDir()
  const explicit = args.find((arg) => !arg.startsWith('--'))

  if (args.includes('--list')) {
    const files = listSessionFiles(dir)
    if (files.length === 0) {
      console.log(`没有找到会话记录：${dir}`)
      return
    }
    for (const file of files) console.log(`${new Date(file.mtimeMs).toISOString()}  ${file.name}`)
    return
  }

  const target = explicit ?? listSessionFiles(dir)[0]?.path
  if (!target || !existsSync(target)) {
    console.error(`没有找到会话记录。目录：${dir}`)
    console.error('先在 App 里跑一次写作，或用 --list 查看可选会话。')
    process.exitCode = 1
    return
  }

  const summary = summarizeSession(parseSessionLines(readFileSync(target, 'utf8')))
  if (summary.modelCalls === 0) {
    console.log(`这份会话没有模型调用记录：${target}`)
    return
  }
  console.log(formatReport(summary))
}

// 裸 `file://${argv[1]}` 拼接在路径含空格或软链时会静默失效，照 audit-*.mjs 用 pathToFileURL。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
}
