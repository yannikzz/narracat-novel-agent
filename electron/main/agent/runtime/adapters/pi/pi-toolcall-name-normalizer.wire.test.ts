/**
 * 工具名归一在**真实 wire 流形状**下的护栏（issue #136）。
 *
 * `pi-toolcall-name-normalizer.integration.test.ts` 只覆盖「无正文 + 单个调用」这一种形状，而
 * `message_end` 扩展靠队列余量追赶工具查找：余量在下面两类形状里不够，`tool_execution_start`
 * 拿到的仍是 `Read`，直接 `Tool Read not found`。
 *
 * - openai-completions：reasoning_content → 正文 → 1 个 tool_call；或 ≥3 个并行 tool_call。
 *   上游在流结束后**同步**推出全部 `*_end` 事件，最容易掉队。
 * - anthropic-messages：正文 + 3 个并行 tool_use。
 *
 * 每种形状两条用例：对照组只挂 `message_end` 扩展（钉住它确实掉队——这条若变绿，说明上游时序变了，
 * 可以考虑摘掉同步包装），实验组再按生产方式包一层 streamFn（`pi-session.ts` 的装配），断言工具
 * **真的执行了**（读到探针内容），而不只是没报错。
 *
 * 用本机 node:http 起假端点、走真 pi-ai provider：手写 EventStream 替身是纯同步的，时序与生产不
 * 同构（见 integration 测试文件里的说明）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import type { Extension } from '@mariozechner/pi-coding-agent'
import { createPiEagerToolArgsRestorer } from './pi-eager-toolcall-args.ts'
import { createPiToolCallNameNormalizer, wrapStreamFnWithToolCallNameNormalizer } from './pi-toolcall-name-normalizer.ts'

const PROBE_CONTENT = '同步归一成功才读得到这一行'

type Wire = 'openai' | 'anthropic'
interface Shape {
  wire: Wire
  withText: boolean
  calls: number
}

function openaiSse(turn: number, toolName: string, args: object, shape: Shape): string {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  if (turn > 1) return `${chunk({ role: 'assistant', content: '完成' })}${chunk({}, 'stop')}data: [DONE]\n\n`
  let body = shape.withText ? chunk({ role: 'assistant', reasoning_content: '想一想' }) + chunk({ content: '我先看看。' }) : ''
  for (let i = 0; i < shape.calls; i++) {
    body += chunk({ tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: toolName, arguments: '' } }] })
    body += chunk({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(args) } }] })
  }
  return `${body}${chunk({}, 'tool_calls')}data: [DONE]\n\n`
}

function anthropicSse(turn: number, toolName: string, args: object, shape: Shape): string {
  const events: Array<Record<string, unknown>> = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 1, output_tokens: 0 } } },
  ]
  let index = 0
  const text = (value: string) => {
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } },
      { type: 'content_block_stop', index },
    )
    index += 1
  }
  if (turn > 1) {
    text('完成')
    events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' })
  } else {
    if (shape.withText) text('我先看看')
    for (let i = 0; i < shape.calls; i++, index++) {
      events.push(
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${i}`, name: toolName, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
        { type: 'content_block_stop', index },
      )
    }
    events.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' })
  }
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

// 每次运行由测试设置当前要回放的形状；服务器按请求序号区分第一轮（工具调用）与第二轮（收尾）。
let current: { shape: Shape; toolName: string; args: object; turn: number } | undefined
let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((_req, res) => {
    if (!current) {
      res.writeHead(500).end()
      return
    }
    current.turn += 1
    const { shape, toolName, args, turn } = current
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(shape.wire === 'anthropic' ? anthropicSse(turn, toolName, args, shape) : openaiSse(turn, toolName, args, shape))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

async function run(shape: Shape, { syncWrap }: { syncWrap: boolean }): Promise<string> {
  const toolName = 'Read'
  const tools = ['read']
  current = { shape, toolName, args: { path: 'probe.txt' }, turn: 0 }

  const cwd = mkdtempSync(join(tmpdir(), 'narracat-normalizer-wire-'))
  writeFileSync(join(cwd, 'probe.txt'), `${PROBE_CONTENT}\n`, 'utf-8')
  const agentDir = join(cwd, 'agent')
  mkdirSync(agentDir, { recursive: true })

  try {
    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey('custom', 'test-key')
    const model = {
      id: 'fake-model',
      name: 'fake-model',
      api: shape.wire === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      provider: 'custom',
      baseUrl: shape.wire === 'anthropic' ? baseUrl : `${baseUrl}/v1`,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8000,
    }
    // 与生产同构的扩展链：eager 在前，归一在后。
    const extensions: Extension[] = [
      createPiEagerToolArgsRestorer(),
      createPiToolCallNameNormalizer({ knownToolNames: () => tools }),
    ]
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: 'off',
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      resourceLoader: {
        getExtensions: () => ({ extensions, errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => '测试系统提示词',
        getAppendSystemPrompt: () => [],
        extendResources: () => {},
        reload: async () => {},
      },
      tools,
      customTools: [],
      sessionManager: SessionManager.create(cwd, join(agentDir, 'sessions')),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      // biome-ignore lint/suspicious/noExplicitAny: model / resourceLoader 只需满足运行时形状
    } as any)

    if (syncWrap) {
      // 与 pi-session.ts 的装配一致。
      session.agent.streamFn = wrapStreamFnWithToolCallNameNormalizer(session.agent.streamFn, () => tools)
    }

    const seen: string[] = []
    const unsubscribe = session.subscribe((event: unknown) => {
      seen.push(JSON.stringify(event))
    })
    await session.prompt('读一下 probe.txt')
    unsubscribe()
    return seen.join('\n')
  } finally {
    current = undefined
    rmSync(cwd, { recursive: true, force: true })
  }
}

const SHAPES: Array<{ label: string; shape: Shape }> = [
  { label: 'openai：reasoning + 正文 + 1 个调用', shape: { wire: 'openai', withText: true, calls: 1 } },
  { label: 'openai：3 个并行调用', shape: { wire: 'openai', withText: false, calls: 3 } },
  { label: 'anthropic：正文 + 3 个并行调用', shape: { wire: 'anthropic', withText: true, calls: 3 } },
]

describe('工具名归一在真实 wire 流形状下生效（issue #136）', () => {
  for (const { label, shape } of SHAPES) {
    test(`对照组（仅 message_end 扩展）在「${label}」下掉队`, async () => {
      const output = await run(shape, { syncWrap: false })
      expect(output).toContain('Tool Read not found')
    }, 20_000)

    test(`同步包装 streamFn 后「${label}」真的执行了工具`, async () => {
      const output = await run(shape, { syncWrap: true })
      expect(output).toContain(PROBE_CONTENT)
      expect(output).not.toContain('not found')
      expect(output).toContain('"toolName":"read"')
    }, 20_000)
  }
})
