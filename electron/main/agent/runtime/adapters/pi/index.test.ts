/**
 * pi adapter 组装测试：createRunOptions 的字段映射（含切片②新增 maxTurns）与 fail-loud 面、
 * startRun 纯转发 runSession（DI）、mapMessage 委托 pi-event-mapper（切片②已实装）、
 * 会话持久化与 readSessionId（切片⑦：sessionStore 装配 + narracat_pi_session 侧信道）。
 * 切片⑥后 createRunOptions/createSandboxedRunOptions 改 async（NovelMemory 工具异步装载），
 * 全文件测试相应补 await。
 */
import { describe, expect, mock, test } from 'bun:test'
import { createExtensionRuntime, ExtensionRunner } from '@mariozechner/pi-coding-agent'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '@shared/types/config'
import { DEFAULT_PROVIDER_SETTINGS, POOL_DEFAULT_FIELDS } from '@shared/types/config'
import type { PiRunOptions, RunPiSessionArgs } from './pi-session.ts'
import type { PiMemoryBridge } from './pi-memory-tools.ts'
import { MEMORY_TOOL_PREFIX } from './pi-memory-tools.ts'

// 子会话 Task 派发（pi-subagent.ts）内部固定 import 真实 runPiSession，真派发会尝试起真会话打
// 网络——mock 掉整个 pi-session.ts 模块，子会话记忆工具测试用它捕获 buildChildRunOptions 的产出；
// 其余测试要么不触发 Task 派发的 runSession 调用，要么走 createPiAdapter({ runSession }) 的 DI
// 覆盖 startRun 本身，不受影响（bun mock.module 按测试文件隔离，不会漏到 pi-session.test.ts/
// pi-subagent.test.ts）。必须在 import index.ts 之前装好（bun mock.module 对同一 specifier 的
// 后续 import 生效）。
let capturedChildSessionCalls: RunPiSessionArgs[] = []
mock.module('./pi-session.ts', () => ({
  runPiSession: (args: RunPiSessionArgs) => {
    capturedChildSessionCalls.push(args)
    return (async function* () {})() as AsyncGenerator<unknown>
  },
}))

const { computeBaselineAllowedRoots, createPiAdapter } = await import('./index.ts')

const config: AppConfig = {
  ...POOL_DEFAULT_FIELDS,
  apiKeyMetadata: {},
  novelRootDir: '/tmp/novels',
  recentNovelPaths: [],
  systemNotificationsEnabled: true,
  introVersion: 0,
}

function makeRunConfig(overrides: Record<string, unknown> = {}) {
  return {
    config,
    apiKey: 'test-key',
    abortController: new AbortController(),
    appRoot: '/tmp/app-root',
    userDataPath: '/tmp/user-data',
    projectPath: '/tmp/novel-project',
    ...overrides,
  }
}

const fakeMemoryBridge: PiMemoryBridge = {
  loadDefinitions: async () => [
    { name: 'novel_query', description: 'd', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'novel_commit_chapter', description: 'd', inputSchema: { type: 'object', properties: {} } },
  ],
  createChannel: () => async () => ({ text: '{}', isError: false }),
}

describe('createPiAdapter', () => {
  test('id 恒为 pi', () => {
    expect(createPiAdapter().id).toBe('pi')
  })

  test('createRunOptions：Provider 装配 + cwd/agentDir/tools/systemPrompt 映射', async () => {
    const options = (await createPiAdapter().createRunOptions(makeRunConfig({ systemPrompt: '底色' }))) as PiRunOptions
    expect(options.model.id).toBe('deepseek-v4-pro')
    expect(options.provider).toBe('deepseek')
    expect(options.apiKey).toBe('test-key')
    expect(options.cwd).toBe('/tmp/novel-project')
    expect(options.agentDir).toBe(join('/tmp/user-data', 'pi-agent'))
    expect(options.tools).toEqual(['read', 'grep', 'find', 'bash'])
    expect(options.systemPrompt).toBe('底色')
    expect(options.maxTurns).toBe(12)
  })

  test('projectPath 缺席回退 appRoot；userDataPath 缺席回退 appRoot 下私有目录；非字符串 systemPrompt 丢弃', async () => {
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({ projectPath: undefined, userDataPath: undefined, systemPrompt: { preset: 'x' } }),
    )) as PiRunOptions
    expect(options.cwd).toBe('/tmp/app-root')
    expect(options.agentDir).toBe(join('/tmp/app-root', 'pi-agent'))
    expect(options.systemPrompt).toBeUndefined()
  })

  test('会话持久化（切片⑦）：主会话恒带 sessionStore（dir 落 agentDir/sessions），resume 翻成 resumeSessionId', async () => {
    const fresh = (await createPiAdapter().createRunOptions(makeRunConfig())) as PiRunOptions
    expect(fresh.sessionStore).toEqual({ dir: join('/tmp/user-data', 'pi-agent', 'sessions') })
    const resumed = (await createPiAdapter().createRunOptions(makeRunConfig({ resume: 'session-1' }))) as PiRunOptions
    expect(resumed.sessionStore).toEqual({
      dir: join('/tmp/user-data', 'pi-agent', 'sessions'),
      resumeSessionId: 'session-1',
    })
  })

  test('startRun 纯转发 runSession（DI）', async () => {
    let captured: RunPiSessionArgs | undefined
    const fakeIterable = (async function* () { yield { type: 'agent_start' } })()
    const adapter = createPiAdapter({
      runSession: (args) => {
        captured = args
        return fakeIterable as AsyncGenerator<unknown>
      },
    })
    const options = await adapter.createRunOptions(makeRunConfig())
    const result = adapter.startRun({ prompt: 'hi', options })
    expect(result).toBe(fakeIterable)
    expect(captured?.prompt).toBe('hi')
    expect(captured?.options).toBe(options)
  })

  test('mapMessage 委托 pi-event-mapper（text_delta → message.delta）；readSessionId 只认 narracat_pi_session（切片⑦）', () => {
    const adapter = createPiAdapter()
    const ctx = { runId: 'r1', messageId: 'm1', createdAt: '2026-07-31T00:00:00.000Z' }
    expect(
      adapter.mapMessage(
        { type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '喵', partial: {} } },
        ctx,
      ),
    ).toEqual([{ type: 'message.delta', runId: 'r1', messageId: 'm1', text: '喵', createdAt: ctx.createdAt }])
    expect(adapter.mapMessage({ type: 'agent_start' }, ctx)).toEqual([])
    expect(adapter.readSessionId({ type: 'agent_start' })).toBeUndefined()
    expect(adapter.readSessionId({ type: 'narracat_pi_session', sessionId: 'session-9' })).toBe('session-9')
    expect(adapter.readSessionId({ type: 'narracat_pi_session', sessionId: '' })).toBeUndefined()
    // 合成会话消息对事件流零产出（id 只走 readSessionId 侧信道）
    expect(adapter.mapMessage({ type: 'narracat_pi_session', sessionId: 'session-9' }, ctx)).toEqual([])
  })

  test('maxTurns 透传（narracat-command 各命令 48-72 档）', async () => {
    const options = (await createPiAdapter().createRunOptions(makeRunConfig({ maxTurns: 48 }))) as PiRunOptions
    expect(options.maxTurns).toBe(48)
  })
})

describe('切片③ 权限门禁接线', () => {
  test('默认工具面 = DEFAULT_ALLOWED_TOOLS 映射（Read/Grep/Glob/Bash→read/grep/find/bash，Skill 丢弃）', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(makeRunConfig())) as PiRunOptions
    expect(options.tools).toEqual(['read', 'grep', 'find', 'bash'])
    // 只有 find/grep（不依赖 fd/ripgrep 的替代实现，工具面含它们时自动注入）——此处要钉的是
    // 「不注册其它自定义工具」，故精确列举而非只判空。
    expect(options.customTools.map((tool) => tool.name)).toEqual(['find', 'grep'])
  })

  test('allowedTools 含 AskUserQuestion 时注册自定义工具且 tools 列表含其名', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(
      makeRunConfig({ allowedTools: ['Read', 'Write', 'AskUserQuestion'], canUseTool: async () => ({ behavior: 'allow' }) }),
    )) as PiRunOptions
    expect(options.tools).toEqual(['read', 'write', 'AskUserQuestion'])
    expect(options.customTools.map((tool) => tool.name)).toEqual(['AskUserQuestion'])
  })

  test('无 canUseTool 时不注册 AskUserQuestion（问答桥缺失宁可缺工具，不给模型能调用但必失败的面）', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(makeRunConfig({ allowedTools: ['Read', 'AskUserQuestion'] }))) as PiRunOptions
    expect(options.tools).toEqual(['read'])
    expect(options.customTools).toHaveLength(0)
  })

  test('guard 扩展始终注入且允许根含 novelRootDir/projectPath/cwd', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(makeRunConfig())) as PiRunOptions
    // guard + eager 参数救回 + 工具名归一 + 输出上限兑现（测试配置的主力槽是白名单内的 deepseek-v4-pro）。
    expect(options.extensions).toHaveLength(4)
    expect(options.extensions.some((extension) => extension.handlers.has('tool_call'))).toBe(true)
  })

  test('computeBaselineAllowedRoots：四根去重去空——projectPath 与 cwd 不同时各留一条', () => {
    expect(
      computeBaselineAllowedRoots({
        agentCorePath: '/tmp/app-root/agent-core/narracat',
        novelRootDir: '/tmp/novels',
        projectPath: '/tmp/novel-project',
        cwd: '/tmp/other-cwd',
      }),
    ).toEqual(['/tmp/app-root/agent-core/narracat', '/tmp/novels', '/tmp/novel-project', '/tmp/other-cwd'])
  })

  test('computeBaselineAllowedRoots：projectPath===cwd 去重只留一条', () => {
    expect(
      computeBaselineAllowedRoots({
        agentCorePath: '/tmp/app-root/agent-core/narracat',
        novelRootDir: '/tmp/novels',
        projectPath: '/tmp/novel-project',
        cwd: '/tmp/novel-project',
      }),
    ).toEqual(['/tmp/app-root/agent-core/narracat', '/tmp/novels', '/tmp/novel-project'])
  })

  test('computeBaselineAllowedRoots：novelRootDir 空串/projectPath 缺席时去空不进列表', () => {
    expect(
      computeBaselineAllowedRoots({
        agentCorePath: '/tmp/app-root/agent-core/narracat',
        novelRootDir: '',
        projectPath: undefined,
        cwd: '/tmp/app-root',
      }),
    ).toEqual(['/tmp/app-root/agent-core/narracat', '/tmp/app-root'])
  })

  test('createSandboxedRunOptions 实装：tools 沙盒收窄、根只剩 workspaceDir、cwd=workspaceDir', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createSandboxedRunOptions({
      ...makeRunConfig(),
      sandbox: { tools: ['Read', 'Write', 'Glob'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    expect(options.tools).toEqual(['read', 'write', 'find'])
    expect(options.cwd).toBe('/tmp/sandbox-ws')
    // 只有 find（不依赖 fd 的替代实现，工具面含 find 时自动注入）——此处要钉的是
    // 「不注册其它自定义工具」，故精确列举而非只判空。
    expect(options.customTools.map((tool) => tool.name)).toEqual(['find'])
    // guard + eager 参数救回 + 工具名归一 + 输出上限兑现。
    expect(options.extensions).toHaveLength(4)
  })

  test('createSandboxedRunOptions 沙盒路径同规持久化：resume 翻成 sessionStore.resumeSessionId（对齐 SDK persistSession 默认，向导轮次续接同构）', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createSandboxedRunOptions({
      ...makeRunConfig({ resume: 'session-1' }),
      sandbox: { tools: ['Read'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    expect(options.sessionStore).toEqual({
      dir: join('/tmp/user-data', 'pi-agent', 'sessions'),
      resumeSessionId: 'session-1',
    })
  })
})

describe('切片④ 引擎钩子接线', () => {
  test('loadNarraCatRuntime=true → extensions 含 guard + engine-hooks 两个扩展', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(makeRunConfig({ loadNarraCatRuntime: true }))) as PiRunOptions
    // 上面四个 + engine-hooks。
    expect(options.extensions).toHaveLength(5)
    expect(options.extensions.some((extension) => extension.handlers.has('tool_call'))).toBe(true)
    expect(options.extensions.some((extension) => extension.handlers.has('tool_result'))).toBe(true)
  })

  test('loadNarraCatRuntime 缺省/false → 只有 guard，不挂引擎钩子', async () => {
    const adapter = createPiAdapter()
    const withoutFlag = (await adapter.createRunOptions(makeRunConfig())) as PiRunOptions
    expect(withoutFlag.extensions.some((extension) => extension.handlers.has('tool_result'))).toBe(false)
    expect(withoutFlag.extensions).toHaveLength(4)
    const withFalse = (await adapter.createRunOptions(makeRunConfig({ loadNarraCatRuntime: false }))) as PiRunOptions
    expect(withFalse.extensions.some((extension) => extension.handlers.has('tool_result'))).toBe(false)
    expect(withFalse.extensions).toHaveLength(4)
  })

  test('输出上限兑现扩展按模型装配：白名单内挂，白名单外零装配（不赌 provider 的上限）', async () => {
    const adapter = createPiAdapter()
    const hasPatch = (options: PiRunOptions) =>
      options.extensions.some((extension) => extension.handlers.has('before_provider_request'))
    const whitelisted = (await adapter.createRunOptions(makeRunConfig())) as PiRunOptions
    expect(hasPatch(whitelisted)).toBe(true)
    const unknownModel = (await adapter.createRunOptions(
      makeRunConfig({
        // 换成没收进白名单的模型 id（老 deepseek-chat 输出上限低得多，抬上去就是硬 400）。
        config: {
          ...config,
          modelPool: [{ provider: 'deepseek', modelId: 'deepseek-chat', verification: null }],
          primaryModelKey: 'deepseek/deepseek-chat',
        },
      } as never),
    )) as PiRunOptions
    expect(hasPatch(unknownModel)).toBe(false)
  })
})

/**
 * issue #16 接线锁：eager 工具参数救回修的是 pi 传输层，与引擎契约无关，必须在**所有**会话形态上
 * 挂载。这条测试的意义是防止将来有人顺手把它并进 loadNarraCatRuntime 门控里——真那样，学习/
 * 向导沙盒与 direct-chat 会在 eager 端点上重新开始丢参数，而且是静默丢。
 */
describe('eager 工具参数救回接线（issue #16）', () => {
  const hasEagerRestorer = (extensions: PiRunOptions['extensions']) =>
    extensions.some((extension) => extension.handlers.has('message_update') && extension.handlers.has('message_end'))

  test('主会话三种门控形态下都挂载', async () => {
    const adapter = createPiAdapter()
    for (const config of [
      makeRunConfig(),
      makeRunConfig({ loadNarraCatRuntime: false }),
      makeRunConfig({ loadNarraCatRuntime: true }),
    ]) {
      const options = (await adapter.createRunOptions(config)) as PiRunOptions
      expect(hasEagerRestorer(options.extensions)).toBe(true)
    }
  })

  test('沙盒会话（学习/向导）同样挂载', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createSandboxedRunOptions({
      ...makeRunConfig(),
      sandbox: { tools: ['Read'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    expect(hasEagerRestorer(options.extensions)).toBe(true)
  })
})

describe('工具名大小写归一接线（issue #100）', () => {
  /**
   * 判据是**行为**不是「挂了几个扩展」：把一条含大写工具名的 assistant 消息喂给装配好的扩展链，
   * 看它实际被归一成什么。这同时锁住了装配处传进去的工具名集合是否与 `options.tools` 同源——
   * 只断言「某个扩展存在」的话，集合传错（比如漏掉 customTools）照样全绿。
   *
   * 用**真** `ExtensionRunner.emitMessageEnd` 跑链，不手写 for 循环复刻：上游那段还带 role 一致性
   * 校验与 try/catch，手写版复刻不全，会漏掉「返回的 message 字段不全被整条丢弃」这类失效。
   */
  async function normalizeThrough(options: PiRunOptions, calledName: string): Promise<string> {
    const message = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'toolu_0', name: calledName, arguments: { path: 'x.md' } }],
    }
    const runner = new ExtensionRunner(
      options.extensions,
      createExtensionRuntime(),
      '/tmp/normalize-through',
      undefined as never,
      undefined as never,
    )
    const replacement = (await runner.emitMessageEnd({ type: 'message_end', message } as never)) as
      | { content?: unknown[] }
      | undefined
    const content = (replacement ?? message).content ?? []
    return (content[0] as { name?: string }).name ?? ''
  }

  /** 子会话的 pi 内置工具面（不含 customTools）——用来证明断言选的名字确实只能从 customTools 进集合。 */
  function childFaceToolNames(options: PiRunOptions): string[] {
    const customNames = new Set(options.customTools.map((tool) => tool.name))
    return options.tools.filter((name) => !customNames.has(name))
  }

  test('主会话：模型抄引擎 prompt 的大写名 → 归一成 pi 真名', async () => {
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({ allowedTools: ['Read', 'Write'] }),
    )) as PiRunOptions
    expect(await normalizeThrough(options, 'Read')).toBe('read')
    expect(await normalizeThrough(options, 'Write')).toBe('write')
  })

  test('自定义工具名也在判定集合内：大小写抄错的 AskUserQuestion 同样归一', async () => {
    // 这条专钉「knownToolNames 必须含 customTools」——只传 face.tools 的话它会红。
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({ allowedTools: ['Read', 'AskUserQuestion'], canUseTool: async () => ({ behavior: 'allow' }) }),
    )) as PiRunOptions
    expect(options.tools).toContain('AskUserQuestion')
    expect(await normalizeThrough(options, 'askuserquestion')).toBe('AskUserQuestion')
  })

  test('工具面里真没有的名字：原样放行，不凭空改成别的工具', async () => {
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({ allowedTools: ['Read'] }),
    )) as PiRunOptions
    // 默认面不含 write：模型调 Write 必须原样报 not found，归一不能成为绕过工具白名单的通道。
    expect(options.tools).not.toContain('write')
    expect(await normalizeThrough(options, 'Write')).toBe('Write')
    expect(await normalizeThrough(options, 'WebSearch')).toBe('WebSearch')
  })

  test('子会话同样归一：写手/审校跑在这里，漏了它们照样调不动 Read/Write', async () => {
    capturedChildSessionCalls = []
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({
        loadNarraCatRuntime: true,
        allowedTools: ['Read', 'Write', 'Agent'],
        agents: { 'chapter-writer': { description: '写手', prompt: '写手系统词', tools: ['Read', 'Write'] } },
      }),
    )) as PiRunOptions
    const task = options.customTools.find((tool) => tool.name === 'Task')!
    await task.execute('tc-1', { subagent_type: 'chapter-writer', prompt: '写第一章' } as never, undefined, undefined, {} as never)

    expect(capturedChildSessionCalls).toHaveLength(1)
    const childOptions = capturedChildSessionCalls[0]!.options as PiRunOptions
    expect(await normalizeThrough(childOptions, 'Write')).toBe('write')
    expect(await normalizeThrough(childOptions, 'Read')).toBe('read')
  })

  test('子会话的判定集合同样含 childCustomTools（漏传时这条会红）', async () => {
    capturedChildSessionCalls = []
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    const options = (await adapter.createRunOptions(
      makeRunConfig({
        loadNarraCatRuntime: true,
        allowedTools: ['Read', 'Glob', 'Agent', `${MEMORY_TOOL_PREFIX}novel_query`],
        agents: {
          'chapter-writer': {
            description: '写手',
            prompt: '写手系统词',
            tools: ['Read', 'Glob', `${MEMORY_TOOL_PREFIX}novel_query`],
          },
        },
      }),
    )) as PiRunOptions
    const task = options.customTools.find((tool) => tool.name === 'Task')!
    await task.execute('tc-1', { subagent_type: 'chapter-writer', prompt: '写第一章' } as never, undefined, undefined, {} as never)

    const childOptions = capturedChildSessionCalls[0]!.options as PiRunOptions
    // 断言必须用**只存在于 childCustomTools** 的名字。portable find/grep 不行——它们的注入条件
    // 本身就是 childFace.tools.includes('find')，对并集零贡献，漏传照样过（实测如此）。
    // 记忆工具是唯一独有的那一类：它不在 childFace.tools 里，只从 childCustomTools 进集合。
    expect(childFaceToolNames(childOptions)).not.toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
    expect(childOptions.customTools.map((tool) => tool.name)).toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
    expect(await normalizeThrough(childOptions, `${MEMORY_TOOL_PREFIX}novel_query`.toUpperCase())).toBe(
      `${MEMORY_TOOL_PREFIX}novel_query`,
    )
  })

  test('归一排在 eager 参数救回之后——装配注释声称顺序有意义，就得钉住', async () => {
    // 两者共用 message_end 链且都返回替换 message。eager 在前，归一看到的才是参数已补全的那份。
    const options = (await createPiAdapter().createRunOptions(makeRunConfig())) as PiRunOptions
    const messageEndOwners = options.extensions
      .filter((extension) => extension.handlers.has('message_end'))
      .map((extension) => extension.path)
    expect(messageEndOwners).toEqual(['<narracat:pi-eager-toolcall-args>', '<narracat:pi-toolcall-name-normalizer>'])
  })

  test('沙盒会话（学习/向导）同样挂载', async () => {
    const options = (await createPiAdapter().createSandboxedRunOptions({
      ...makeRunConfig(),
      sandbox: { tools: ['Read'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    expect(await normalizeThrough(options, 'Read')).toBe('read')
  })
})

describe('小说 AGENTS.md 精准注入（loadNarraCatRuntime 门控，F1 回归锁定）', () => {
  // resolveNovelAgentsGuide 自身的读取/回退/截断语义已在 novel-agents-guide.test.ts 锁定；本组
  // 只锁 adapter 这一关节——loadNarraCatRuntime 决定 AGENTS.md 是否被读取并接进
  // options.systemPromptAppendix，防止将来重构掉这段门控代码而无测试报警（模板已向用户承诺
  // 创作会话自动读取本文件）。
  test('loadNarraCatRuntime:true + 项目根有 AGENTS.md → systemPromptAppendix 带文件内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'narracat-pi-adapter-agents-guide-'))
    await writeFile(join(dir, 'AGENTS.md'), '# 本书写作说明\n只在深夜写反派内心戏。')
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({ loadNarraCatRuntime: true, projectPath: dir }),
    )) as PiRunOptions
    expect(options.systemPromptAppendix).toContain('只在深夜写反派内心戏')
  })

  test('createSandboxedRunOptions（学习/向导沙盒，loadNarraCatRuntime:false）→ systemPromptAppendix 为 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'narracat-pi-adapter-agents-guide-'))
    await writeFile(join(dir, 'AGENTS.md'), '# 本书写作说明\n只在深夜写反派内心戏。')
    const options = (await createPiAdapter().createSandboxedRunOptions({
      ...makeRunConfig({ loadNarraCatRuntime: false, projectPath: dir }),
      sandbox: { tools: ['Read'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    expect(options.systemPromptAppendix).toBeUndefined()
  })
})

describe('切片⑤ 子 agent 派发与任务卡接线', () => {
  const commandRunConfig = {
    loadNarraCatRuntime: true,
    allowedTools: ['Read', 'Write', 'Agent', 'TaskCreate', 'TaskUpdate'],
  }

  test('命令路径：customTools 含 Task/TaskCreate/TaskUpdate，且三者同步进 tools 白名单（pi isAllowedTool 会过滤）', async () => {
    const options = (await createPiAdapter().createRunOptions(makeRunConfig(commandRunConfig))) as PiRunOptions
    expect(options.customTools.map((tool) => tool.name)).toEqual(['Task', 'TaskCreate', 'TaskUpdate'])
    expect(options.tools).toEqual(['read', 'write', 'Task', 'TaskCreate', 'TaskUpdate'])
    expect(options.subagentChannel).toBeDefined()
  })

  test('无 loadNarraCatRuntime：不注册 Task 派发工具（沙盒/自由对话无子 agent 面），任务卡随白名单独立生效', async () => {
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({ allowedTools: ['Read', 'Agent', 'TaskCreate'] }),
    )) as PiRunOptions
    expect(options.customTools.map((tool) => tool.name)).toEqual(['TaskCreate', 'TaskUpdate'])
    expect(options.subagentChannel).toBeUndefined()
  })

  test('沙盒路径（学习/向导）工具面不含 Task/任务卡', async () => {
    const options = (await createPiAdapter().createSandboxedRunOptions({
      ...makeRunConfig({ loadNarraCatRuntime: true }),
      sandbox: { tools: ['Read', 'Write', 'Glob'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    // 只有 find（不依赖 fd 的替代实现，工具面含 find 时自动注入）——此处要钉的是
    // 「不注册其它自定义工具」，故精确列举而非只判空。
    expect(options.customTools.map((tool) => tool.name)).toEqual(['find'])
    expect(options.tools).toEqual(['read', 'write', 'find'])
  })

  test('I-1 收口：args.agents overrides 进注册表（未知名报错文案里能读到被覆盖的 agent 名）', async () => {
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({
        ...commandRunConfig,
        agents: { 'chapter-writer': { description: '用户挂载后的写手', prompt: '写手系统词 + 用户 Skill 正文', tools: ['Read', 'Write'] } },
      }),
    )) as PiRunOptions
    const task = options.customTools.find((tool) => tool.name === 'Task')!
    await expect(
      task.execute('tc-1', { subagent_type: 'ghost-writer', prompt: 'x' } as never, undefined, undefined, {} as never),
    ).rejects.toThrow('chapter-writer')
  })

  test('AskUserQuestion 与 Task/任务卡共存时 tools 白名单三类齐全', async () => {
    const options = (await createPiAdapter().createRunOptions(
      makeRunConfig({
        ...commandRunConfig,
        allowedTools: [...commandRunConfig.allowedTools, 'AskUserQuestion'],
        canUseTool: async () => ({ behavior: 'allow' }),
      }),
    )) as PiRunOptions
    expect(options.tools).toEqual(['read', 'write', 'AskUserQuestion', 'Task', 'TaskCreate', 'TaskUpdate'])
  })
})

describe('切片⑥ NovelMemory 工具接线', () => {
  test('allowedTools 含记忆名 + loadNarraCatRuntime + projectPath → customTools 含该名，tools 白名单同步含', async () => {
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    const options = (await adapter.createRunOptions(
      makeRunConfig({ loadNarraCatRuntime: true, allowedTools: ['Read', `${MEMORY_TOOL_PREFIX}novel_query`] }),
    )) as PiRunOptions
    expect(options.customTools.map((tool) => tool.name)).toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
    expect(options.tools).toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
  })

  test('loadNarraCatRuntime 缺省(false) → 零装载，即便 allowedTools 含记忆名（沙盒/自由对话无引擎契约）', async () => {
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    const options = (await adapter.createRunOptions(
      makeRunConfig({ allowedTools: ['Read', `${MEMORY_TOOL_PREFIX}novel_query`] }),
    )) as PiRunOptions
    expect(options.customTools.map((tool) => tool.name)).not.toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
  })

  test('无 projectPath → 零装载（与 SDK createNovelMemoryMcpServers 同门条件）', async () => {
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    const options = (await adapter.createRunOptions(
      makeRunConfig({ projectPath: undefined, loadNarraCatRuntime: true, allowedTools: ['Read', `${MEMORY_TOOL_PREFIX}novel_query`] }),
    )) as PiRunOptions
    expect(options.customTools.map((tool) => tool.name)).not.toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
  })

  test('createSandboxedRunOptions：sandbox.tools 不含记忆名 → 零装载', async () => {
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    const options = (await adapter.createSandboxedRunOptions({
      ...makeRunConfig({ loadNarraCatRuntime: true }),
      sandbox: { tools: ['Read', 'Write', 'Glob'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    // 只有 find（不依赖 fd 的替代实现，工具面含 find 时自动注入）——此处要钉的是
    // 「不注册其它自定义工具」，故精确列举而非只判空。
    expect(options.customTools.map((tool) => tool.name)).toEqual(['find'])
  })

  test('子会话按自己声明的面过滤：只含 novel_query，不含父面也开了的 novel_commit_chapter', async () => {
    capturedChildSessionCalls = []
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    // 模型池化：主力槽 model-sonnet + 同 provider 已验证轻量槽 model-haiku，供下方 haiku 别名映射断言用。
    const poolConfig = {
      ...config,
      modelPool: [
        { provider: 'deepseek' as const, modelId: 'model-sonnet', verification: null },
        {
          provider: 'deepseek' as const,
          modelId: 'model-haiku',
          verification: {
            verifiedAt: '2026-08-02T00:00:00.000Z',
            apiKeyUpdatedAt: '2026-08-01T00:00:00.000Z',
            baseUrl: DEFAULT_PROVIDER_SETTINGS.deepseek.baseUrl,
            wire: 'anthropic',
          },
        },
      ],
      primaryModelKey: 'deepseek/model-sonnet',
      lightModelKey: 'deepseek/model-haiku',
      apiKeyMetadata: { deepseek: { updatedAt: '2026-08-01T00:00:00.000Z' } },
    }
    const options = (await adapter.createRunOptions(
      makeRunConfig({
        config: poolConfig,
        loadNarraCatRuntime: true,
        allowedTools: ['Read', 'Agent', `${MEMORY_TOOL_PREFIX}novel_query`, `${MEMORY_TOOL_PREFIX}novel_commit_chapter`],
        agents: {
          'chapter-writer': {
            description: '写手',
            prompt: '写手系统词',
            tools: ['Read', `${MEMORY_TOOL_PREFIX}novel_query`],
            model: 'haiku',
          },
        },
      }),
    )) as PiRunOptions
    const task = options.customTools.find((tool) => tool.name === 'Task')!
    await task.execute('tc-1', { subagent_type: 'chapter-writer', prompt: '写第一章' } as never, undefined, undefined, {} as never)

    expect(capturedChildSessionCalls).toHaveLength(1)
    const childOptions = capturedChildSessionCalls[0]!.options as PiRunOptions
    expect(childOptions.customTools.map((tool) => tool.name)).toEqual([`${MEMORY_TOOL_PREFIX}novel_query`])
    expect(childOptions.tools).toContain(`${MEMORY_TOOL_PREFIX}novel_query`)
    expect(childOptions.tools).not.toContain(`${MEMORY_TOOL_PREFIX}novel_commit_chapter`)
    // 子会话不带 sessionStore（切片⑦）：一次性派发无 resume 消费者，保持 in-memory
    expect(childOptions.sessionStore).toBeUndefined()
    // model 别名映射（模型池化）：frontmatter model:'haiku' → 同 provider 已验证轻量槽；父 run 用主力槽
    expect(childOptions.model.id).toBe('model-haiku')
    expect(options.model.id).toBe('model-sonnet')
  })
})

describe('find 工具可移植化（不依赖 fd 二进制）', () => {
  // pi 内置 find 走 fd：查系统 PATH，找不到就下载。macOS 从 Finder 启动的 App 继承 launchd
  // 窄 PATH（不含 Homebrew），作者机器上也不会装 fd，GitHub 下载对国内用户基本不可达——
  // 真机打包版实测 find 一半调用直接报「fd is not available」。同名 customTool 覆盖内置。
  test('工具面含 find 时注入同名替代实现', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(makeRunConfig())) as PiRunOptions
    expect(options.tools).toContain('find')
    expect(options.customTools.map((tool) => tool.name)).toContain('find')
  })

  test('工具面不含 find 时不注入——不给会话凭空多一个工具面', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createRunOptions(makeRunConfig({ allowedTools: ['Read', 'Write'] }))) as PiRunOptions
    expect(options.tools).not.toContain('find')
    expect(options.customTools.map((tool) => tool.name)).not.toContain('find')
  })

  test('子会话同样拿到替代实现——写手/审校跑在子会话里，漏了这条它们的 find 照样是坏的', async () => {
    capturedChildSessionCalls = []
    const adapter = createPiAdapter({ memoryBridge: fakeMemoryBridge })
    const options = (await adapter.createRunOptions(
      makeRunConfig({
        loadNarraCatRuntime: true,
        allowedTools: ['Read', 'Glob', 'Agent'],
        agents: {
          'chapter-writer': { description: '写手', prompt: '写手系统词', tools: ['Read', 'Glob'] },
        },
      }),
    )) as PiRunOptions
    const task = options.customTools.find((tool) => tool.name === 'Task')!
    await task.execute('tc-1', { subagent_type: 'chapter-writer', prompt: '写第一章' } as never, undefined, undefined, {} as never)

    const childOptions = capturedChildSessionCalls[0]!.options as PiRunOptions
    expect(childOptions.tools).toContain('find')
    expect(childOptions.customTools.map((tool) => tool.name)).toContain('find')
  })

  test('沙盒会话（学习/向导）同样注入——它们一样跑在打包版里', async () => {
    const adapter = createPiAdapter()
    const options = (await adapter.createSandboxedRunOptions({
      ...makeRunConfig(),
      sandbox: { tools: ['Read', 'Glob'], workspaceDir: '/tmp/sandbox-ws' },
    } as never)) as PiRunOptions
    expect(options.customTools.map((tool) => tool.name)).toContain('find')
  })
})
