/**
 * 工具名归一的**运行时**护栏（issue #100）。
 *
 * 为什么单测不够：`pi-toolcall-name-normalizer.test.ts` 直接调 `handlers.get('message_end')[0]`，
 * `index.test.ts` 则手写循环复刻链式语义——两者都绕开了真实运行时的两道关卡：
 *
 * 1. `ExtensionRunner.emitMessageEnd` 的 role 一致性校验（返回的 message 字段不全会被**整条丢弃**）；
 * 2. `AgentSession._handleAgentEvent` 只把处理排进 `_agentEventQueue` 就返回，**agent loop 不等
 *    扩展跑完**——归一是异步追赶工具查找的，靠的是队列在查找前排空这份余量，不是上游契约。
 *
 * 这两种失效都是静默的（症状退回 `Tool Read not found`，与没修一样），且上面那两个测试文件全绿
 * 也照样漏。所以这里走真实 `createAgentSession` + 真 `runPiSession`，只把 `agent.streamFn` 换成
 * 假流（因此不打网络），断言工具**真的被执行了**。
 *
 * **pi 升级后必须重跑本文件。** 它红了意味着时序余量没了或替换通道变了，那时要改的是归一的落点，
 * 不是把断言改松。
 *
 * 刻意**不经过 `runPiSession`**：`index.test.ts` 的 `mock.module('./pi-session.ts')` 是进程级的，
 * 会泄漏到同批次的其它测试文件（本仓旧坑，那边注释里「按测试文件隔离」的说法并不成立），
 * 一旦泄漏 runPiSession 就成了空生成器、本文件会静默变成零断言。这里自己装配最小真会话，
 * 只依赖 pi 自身——会话装配那一层另有 `pi-session.test.ts` 覆盖，不是本文件要验的东西。
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic'
import type { Model } from '@mariozechner/pi-ai'
import type { AppConfig } from '@shared/types/config'
import { POOL_DEFAULT_FIELDS } from '@shared/types/config'
import { createPiModel } from './pi-model.ts'
import { createPiEagerToolArgsRestorer } from './pi-eager-toolcall-args.ts'
import { createPiToolCallNameNormalizer } from './pi-toolcall-name-normalizer.ts'

const config: AppConfig = {
  ...POOL_DEFAULT_FIELDS,
  apiKeyMetadata: {},
  novelRootDir: '/tmp/novels',
  recentNovelPaths: [],
  systemNotificationsEnabled: true,
  introVersion: 0,
}

const PROBE_CONTENT = '归一成功才读得到这一行'

type SseEvent = { type: string } & Record<string, unknown>

function toSse(events: SseEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const MODEL: Model<'anthropic-messages'> = {
  id: 'fake-anthropic-compatible',
  name: 'fake-anthropic-compatible',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
}

/**
 * 走**真** `streamAnthropic`（只把 HTTP client 换成喂构造 SSE 的替身），不手写 EventStream 替身。
 *
 * 这一点是本文件的成败所在：手写替身是纯同步产出的，微任务余量远小于真实流（真实流要 await
 * `asResponse()` 再逐块读 ReadableStream），扩展链一多就会假阴性——实测手写替身下「eager + 归一」
 * 会红，而同样的链走真 streamAnthropic 则正常归一，与生产一致。测试的时序必须与生产同构，
 * 否则它红的是自己，不是生产。
 */
function streamFromSse(events: SseEvent[]) {
  const client = {
    messages: {
      create: () => ({
        asResponse: async () =>
          new Response(toSse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      }),
    },
  }
  return streamAnthropic(
    MODEL,
    // biome-ignore lint/suspicious/noExplicitAny: 测试替身，只需满足 streamAnthropic 的运行时形状
    { messages: [{ role: 'user', content: '读一下 probe.txt' }], tools: [] } as any,
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    { client: client as any, apiKey: 'test' },
  )
}

/**
 * 第一轮：模型发起一次工具调用（`Read` 是引擎 prompt 里的写法，pi 真名是 `read`）。
 *
 * `eagerInput` 选的是两种服务端形态，区别只在参数怎么传，与工具名无关：
 * - `false`（默认）＝官方 Anthropic 的标准增量：参数走 `input_json_delta`，上游解析本就正确；
 * - `true` ＝部分兼容端点的 eager 形态：参数塞在 `content_block_start.input`、之后无增量，
 *   上游会在收尾把它抹成 `{}`（issue #16），必须挂 `createPiEagerToolArgsRestorer` 才救得回来。
 *
 * 默认用标准增量，好让「归一有没有生效」的判定不被参数丢失这件无关的事干扰。
 */
function toolCallStream(toolName: string, args: Record<string, unknown>, eagerInput = false) {
  const argsJson = JSON.stringify(args)
  return streamFromSse([
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: eagerInput ? args : {} },
    },
    ...(eagerInput
      ? []
      : [{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argsJson } }]),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ])
}

/** 第二轮：纯文本收尾，让 agent loop 正常结束。 */
function textStream() {
  return streamFromSse([
    { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '读完了' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])
}

/**
 * 最小真会话：真 `createAgentSession` + 真扩展链 + 真 agent-loop，只有 streamFn 是假的。
 * 装配项照 `pi-session.ts` 的同名调用，但刻意不复用它（见文件头注释的 mock 泄漏说明）。
 */
async function runWithToolCall(
  calledToolName: string,
  extensions: Extension[],
  tools: string[] = ['read'],
  args?: Record<string, unknown>,
  eagerInput = false,
): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'narracat-normalizer-it-'))
  writeFileSync(join(cwd, 'probe.txt'), `${PROBE_CONTENT}\n`, 'utf-8')
  const agentDir = join(cwd, 'agent')
  mkdirSync(agentDir, { recursive: true })

  try {
    const authStorage = AuthStorage.inMemory()
    authStorage.setRuntimeApiKey('deepseek', 'test-key')

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: createPiModel(config),
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
      // biome-ignore lint/suspicious/noExplicitAny: resourceLoader 只需满足运行时形状，同 pi-session.ts 的做法
    } as any)

    // 只换 streamFn 的 HTTP 出口即可完全离线：会话、扩展链、agent-loop、上游流解析一个没动。
    let turn = 0
    session.agent.streamFn = (() => {
      turn += 1
      return turn === 1 ? toolCallStream(calledToolName, args ?? { path: 'probe.txt' }, eagerInput) : textStream()
      // biome-ignore lint/suspicious/noExplicitAny: 测试替身，只需满足 agent-loop 的运行时形状
    }) as any

    const seen: string[] = []
    const unsubscribe = session.subscribe((event: unknown) => {
      seen.push(JSON.stringify(event))
    })
    await session.prompt('读一下 probe.txt')
    unsubscribe()
    return seen.join('\n')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe('工具名归一在真实运行时生效（issue #100）', () => {
  test('对照组：不挂归一扩展时，大写 Read 在真实运行时确实 not found', async () => {
    const output = await runWithToolCall('Read', [])
    // 先钉住根因本身——这条断言失败说明上游开始自己翻译工具名了，本扩展可考虑摘除。
    expect(output).toContain('not found')
    expect(output).not.toContain(PROBE_CONTENT)
  }, 20_000)

  test('挂上归一扩展后，大写 Read 真的读到了文件（归一赶在工具查找之前生效）', async () => {
    const output = await runWithToolCall('Read', [
      createPiToolCallNameNormalizer({ knownToolNames: () => ['read'] }),
    ])
    // 工具真的跑起来了才读得到探针内容；若归一迟到或被 runner 丢弃，这里会是 not found。
    expect(output).toContain(PROBE_CONTENT)
    expect(output).not.toContain('not found')
  }, 20_000)

  test('Glob 这类改名映射同样在真实运行时生效（不是只有大小写差异的才管用）', async () => {
    // 断言必须是**正向**的：`not.toContain('Tool Glob not found')` 在 run 整个没产出时也会平凡通过，
    // 归一迟到反而看不出来。这里要求真的出现 find 的执行事件并命中探针文件。
    // 参数给 `pattern` 而非 `path`——find 的 schema 是 {pattern, path?, limit?}，给错会卡在参数校验，
    // 「工具执行了」就无从谈起（这正是上一版这条用例的毛病）。
    const output = await runWithToolCall(
      'Glob',
      [createPiToolCallNameNormalizer({ knownToolNames: () => ['read', 'find'] })],
      ['read', 'find'],
      { pattern: 'probe.txt' },
    )
    expect(output).toContain('"toolName":"find"')
    expect(output).toContain('probe.txt')
    expect(output).not.toContain('not found')
  }, 20_000)

  test('与生产同构的扩展链（eager 在前）下两个扩展共存且都生效', async () => {
    // 注释里立了「禁止在 message_* handler 里做异步 I/O」，并点名这条纪律对 eager 同样成立——
    // 只挂归一器一个扩展是守不住它的：eager 排在归一之前、共用同一条队列余量。这条把生产链复刻
    // 进来，纪律才真的有人看守。
    //
    // 同时用 eager 形态的服务端流：参数只在 content_block_start 出现、会被上游抹空，于是这条同时
    // 要求两件事都成立——eager 把参数救回来（否则参数校验失败），归一把名字改对（否则 not found）。
    const output = await runWithToolCall(
      'Read',
      [createPiEagerToolArgsRestorer(), createPiToolCallNameNormalizer({ knownToolNames: () => ['read'] })],
      ['read'],
      { path: 'probe.txt' },
      true,
    )
    expect(output).toContain(PROBE_CONTENT)
    expect(output).not.toContain('Tool Read not found')
  }, 20_000)
})
