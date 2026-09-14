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
import type { AppConfig } from '@shared/types/config'
import { POOL_DEFAULT_FIELDS } from '@shared/types/config'
import { createPiModel } from './pi-model.ts'
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

/** 模型发起的那次工具调用（`Read` 是引擎 prompt 里的写法，pi 真名是 `read`）。 */
function assistantToolCallMessage(toolName: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'toolCall' as const, id: 'toolu_1', name: toolName, arguments: { path: 'probe.txt' } }],
    stopReason: 'toolUse',
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    provider: 'deepseek',
    model: 'test',
    api: 'anthropic-messages',
  }
}

/** 工具跑完后的收尾回合：纯文本 + stop，让 agent loop 正常结束。 */
function assistantTextMessage() {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: '读完了' }],
    stopReason: 'stop',
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    provider: 'deepseek',
    model: 'test',
    api: 'anthropic-messages',
  }
}

/**
 * EventStream 替身：既能 for-await，又有 agent-loop 在 done 分支要调的 `result()`。
 * 刻意用真的 async generator——agent-loop 在 done 分支是从 `for await` 里 `return` 的，
 * 由此触发的迭代器 cleanup 正是归一赖以生效的那点微任务余量，数组迭代复刻不出来。
 */
function fakeEventStream(finalMessage: ReturnType<typeof assistantToolCallMessage> | ReturnType<typeof assistantTextMessage>) {
  const partial = { ...finalMessage, content: [] as unknown[] }
  async function* events() {
    yield { type: 'start', partial }
    for (const [index, block] of finalMessage.content.entries()) {
      yield { type: block.type === 'toolCall' ? 'toolcall_start' : 'text_start', contentIndex: index, partial: finalMessage }
    }
    yield { type: 'done', reason: 'stop', message: finalMessage, partial: finalMessage }
  }
  const iterator = events()
  return {
    [Symbol.asyncIterator]: () => iterator,
    result: async () => finalMessage,
  }
}

/**
 * 最小真会话：真 `createAgentSession` + 真扩展链 + 真 agent-loop，只有 streamFn 是假的。
 * 装配项照 `pi-session.ts` 的同名调用，但刻意不复用它（见文件头注释的 mock 泄漏说明）。
 */
async function runWithToolCall(
  calledToolName: string,
  extensions: Extension[],
  tools: string[] = ['read'],
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

    // 换掉 streamFn 即可完全离线：会话、扩展链、agent-loop 一个没动。
    let turn = 0
    session.agent.streamFn = (() => {
      turn += 1
      return fakeEventStream(turn === 1 ? assistantToolCallMessage(calledToolName) : assistantTextMessage())
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
    // find 是 pi 对 Glob 的真名。这里只验「归一确实把 Glob 送到了 find」——find 没在 tools 白名单里
    // 时结果仍是 not found，故把 find 一并开进工具面。
    const output = await runWithToolCall(
      'Glob',
      [createPiToolCallNameNormalizer({ knownToolNames: () => ['read', 'find'] })],
      ['read', 'find'],
    )
    expect(output).not.toContain('Tool Glob not found')
  }, 20_000)
})
