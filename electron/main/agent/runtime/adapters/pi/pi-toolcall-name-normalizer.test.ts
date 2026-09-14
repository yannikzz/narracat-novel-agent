/**
 * 工具名大小写归一扩展单测（issue #100）。
 *
 * 纪律同 `pi-eager-toolcall-args.test.ts`：assistant 消息**不手写**，而是驱动真实的
 * `streamAnthropic`（注入假 client 喂构造 SSE）拿到上游真正推送的那份消息，再照
 * `agent-session.js` `_emitExtensionEvent` 的桥接形状交给扩展。手写消息只能验证「代码符合我对
 * 消息形状的假设」，假设一错测试照样绿。
 *
 * 第一条测试同时钉住根因前提：非 OAuth 路径下 pi-ai 把模型发来的 `Read` **原样**透传（它自己的
 * `fromClaudeCodeName` 只在 OAuth 路径启用）。哪天上游默认翻译了，那条断言会红，提示本扩展可摘除。
 */
import { describe, expect, test } from 'bun:test'
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic'
import type { Model } from '@mariozechner/pi-ai'
import { createPiToolCallNameNormalizer, resolveToolCallName } from './pi-toolcall-name-normalizer.ts'

/** 本次会话真实注册的工具面：pi 内置真名（小写）+ 自定义工具（原样大小写）。 */
const KNOWN_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'AskUserQuestion']

type SseEvent = { type: string } & Record<string, unknown>

function toSse(events: SseEvent[]): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

/** 一条 assistant 消息，内含按 `names` 顺序发起的若干工具调用。 */
function toolCallMessage(names: string[]): SseEvent[] {
  return [
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 0 } } },
    ...names.flatMap((name, index) => [
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `toolu_${index}`, name, input: { path: 'bible/premise.md' } },
      },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' },
  ]
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

function fakeClient(events: SseEvent[]) {
  return {
    messages: {
      create: () => ({
        asResponse: async () =>
          new Response(toSse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      }),
    },
  }
}

/** 跑真实上游解析拿到 assistant 消息，交给扩展，返回归一前后两份的工具名序列。 */
async function runThroughExtension(
  calledNames: string[],
  knownToolNames: readonly string[] = KNOWN_TOOLS,
): Promise<{ before: string[]; after: string[] }> {
  const extension = createPiToolCallNameNormalizer({ knownToolNames: () => knownToolNames })
  const onEnd = extension.handlers.get('message_end')?.[0]
  if (!onEnd) throw new Error('扩展未注册 message_end 处理器')

  const stream = streamAnthropic(MODEL, {
    messages: [{ role: 'user', content: '读立项卡' }],
    // 工具清单按 pi 真名申报（小写）——模型却按引擎 prompt 抄了大写名，这正是 #100 的现场。
    tools: knownToolNames.map((name) => ({
      name,
      description: `${name} tool`,
      parameters: { type: 'object', properties: {} },
    })),
    // biome-ignore lint/suspicious/noExplicitAny: 测试替身，只需满足 streamAnthropic 的运行时形状
  } as any, { client: fakeClient(toolCallMessage(calledNames)) as any, apiKey: 'test' })

  let finalMessage: unknown
  for await (const streamEvent of stream) {
    if (streamEvent.type === 'done' || streamEvent.type === 'error') {
      finalMessage = streamEvent.partial ?? streamEvent.message
    }
  }

  const before = toolCallNames(finalMessage)
  const result = (await onEnd({ message: finalMessage })) as { message?: unknown } | undefined
  return { before, after: toolCallNames(result?.message ?? finalMessage) }
}

function toolCallNames(message: unknown): string[] {
  const content = (message as { content?: unknown[] })?.content ?? []
  return content
    .filter((entry) => (entry as { type?: string })?.type === 'toolCall')
    .map((entry) => (entry as { name?: string }).name ?? '')
}

describe('createPiToolCallNameNormalizer', () => {
  test('模型按引擎 prompt 抄大写名：上游原样透传，扩展归一成 pi 真名', async () => {
    const { before, after } = await runThroughExtension(['Read'])
    // 钉住根因前提：非 OAuth 路径下上游不做任何翻译，`Read` 原样到达工具查找，于是 not found。
    expect(before).toEqual(['Read'])
    expect(after).toEqual(['read'])
  })

  test('Write/Edit/Grep 同样按大小写归一', async () => {
    const { after } = await runThroughExtension(['Write', 'Edit', 'Grep'])
    expect(after).toEqual(['write', 'edit', 'grep'])
  })

  test('Glob 经别名表归一成 find——改名映射，大小写规则够不着它', async () => {
    // #100 的第二半：SDK_TO_PI_TOOL_NAME 里只有 Glob→find 是改名而非变大小写。
    const { before, after } = await runThroughExtension(['Glob'], [...KNOWN_TOOLS, 'find'])
    expect(before).toEqual(['Glob'])
    expect(after).toEqual(['find'])
  })

  test('别名表查找不分大小写：glob / GLOB 一样归一成 find', async () => {
    const { after } = await runThroughExtension(['glob', 'GLOB'], [...KNOWN_TOOLS, 'find'])
    expect(after).toEqual(['find', 'find'])
  })

  test('别名目标不在本会话工具面时不改——归一不能把调用引到没开的工具上', async () => {
    // 工具面没有 find：Glob 必须原样报 not found，而不是被归一成一个本会话没有的工具。
    const { after } = await runThroughExtension(['Glob'], ['read', 'write'])
    expect(after).toEqual(['Glob'])
  })

  test('归一只换名字：id 与 arguments 逐字保留', async () => {
    // 改名的全部意义就是让这次调用能被执行，而执行靠的正是 id 与 arguments。
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => KNOWN_TOOLS })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    const block = { type: 'toolCall', id: 'toolu_7', name: 'Read', arguments: { path: 'bible/premise.md', limit: 20 } }
    const result = (await onEnd({ message: { role: 'assistant', content: [block] } })) as { message?: unknown } | undefined
    const after = ((result?.message as { content?: unknown[] })?.content ?? [])[0]
    expect(after).toEqual({ ...block, name: 'read' })
  })

  test('归一保留 message 的其余字段——丢了 role 会被上游整条丢弃', async () => {
    // runner.js 的 emitMessageEnd 校验 role 与原消息一致，不一致就丢弃整个替换、归一静默失效。
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => KNOWN_TOOLS })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    const message = {
      role: 'assistant',
      stopReason: 'toolUse',
      usage: { input: 1, output: 2 },
      provider: 'deepseek',
      content: [{ type: 'toolCall', id: 'toolu_1', name: 'Read', arguments: {} }],
    }
    const result = (await onEnd({ message })) as { message?: Record<string, unknown> } | undefined
    expect({ ...result?.message, content: undefined }).toEqual({ ...message, content: undefined })
  })

  test('非 assistant 消息不介入', async () => {
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => KNOWN_TOOLS })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    const content = [{ type: 'toolCall', id: 'toolu_1', name: 'Read', arguments: {} }]
    expect(await onEnd({ message: { role: 'user', content } })).toBeUndefined()
  })

  test('content 不是数组 / 工具名字段缺失时安全跳过，不抛异常', async () => {
    // handler 抛异常会被 runner catch 成 emitError → 归一静默不生效，症状退回 not found。
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => KNOWN_TOOLS })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    expect(await onEnd({ message: { role: 'assistant', content: '不是数组' } })).toBeUndefined()
    // 空串那半是 defensive：走完三档同样返回 undefined，与有守卫时行为一致，故此处只作不抛异常的保证。
    expect(
      await onEnd({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'x', name: '', arguments: {} }] } }),
    ).toBeUndefined()
    expect(
      await onEnd({ message: { role: 'assistant', content: [{ type: 'toolCall', id: 'x', arguments: {} }] } }),
    ).toBeUndefined()
  })

  test('工具名本就精确命中：一个字节都不改', async () => {
    const { before, after } = await runThroughExtension(['read', 'AskUserQuestion'])
    expect(before).toEqual(['read', 'AskUserQuestion'])
    expect(after).toEqual(['read', 'AskUserQuestion'])
  })

  test('本会话真没有这个工具：原样放行，让它照常报 not found', async () => {
    // 模型幻觉出的 WebSearch：大小写不敏感也匹配不到，不能凭空改成别的工具。
    const { after } = await runThroughExtension(['WebSearch'])
    expect(after).toEqual(['WebSearch'])
  })

  test('一条消息里混合命中与未命中：只改该改的那个', async () => {
    const { after } = await runThroughExtension(['Read', 'WebSearch', 'write'])
    expect(after).toEqual(['read', 'WebSearch', 'write'])
  })

  test('工具面收窄后大写名不再有对应真名：不改，不越权放行', async () => {
    // 子 agent 只拿到只读面（无 write）。模型抄大写 `Write` 时必须原样报错——
    // 若这里被归一成别的工具，等于绕过 agent 自己声明的工具白名单。
    const { after } = await runThroughExtension(['Write'], ['read', 'grep'])
    expect(after).toEqual(['Write'])
  })

  test('无工具调用的纯文本消息：扩展不返回替换', async () => {
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => KNOWN_TOOLS })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    const message = { role: 'assistant', content: [{ type: 'text', text: '好的' }] }
    expect(await onEnd({ message })).toBeUndefined()
  })

  test('全部精确命中时不返回替换：不做无谓的消息重建', async () => {
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => KNOWN_TOOLS })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    const message = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'toolu_0', name: 'read', arguments: {} }],
    }
    expect(await onEnd({ message })).toBeUndefined()
  })

  test('工具名惰性求值：装配期为空、触发时已定型也能正确归一', async () => {
    // 装配处 customTools 是边构造边 push 的，扩展先于它定型——惰性回调必须在 message_end 那一刻取值。
    const tools: string[] = []
    const extension = createPiToolCallNameNormalizer({ knownToolNames: () => tools })
    const onEnd = extension.handlers.get('message_end')?.[0]
    if (!onEnd) throw new Error('扩展未注册处理器')
    tools.push('read')
    const result = (await onEnd({
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'toolu_0', name: 'Read', arguments: {} }] },
    })) as { message?: unknown } | undefined
    expect(toolCallNames(result?.message)).toEqual(['read'])
  })
})

describe('resolveToolCallName', () => {
  test('大小写歧义时不改：两个只差大小写的自定义工具，无从判断模型要哪个', () => {
    // 用别名表外的名字才测得到第 3 档——表内的名字有权威映射可依，不算猜。
    expect(resolveToolCallName('MYTOOL', ['mytool', 'MyTool'])).toBeUndefined()
  })

  test('精确命中优先于一切：别名表与大小写回退都不参与', () => {
    expect(resolveToolCallName('Read', ['read', 'Read'])).toBeUndefined()
    expect(resolveToolCallName('mytool', ['mytool', 'MyTool'])).toBeUndefined()
  })

  test('别名表内的名字遇到大小写并存时按表走（不是猜，有权威映射可依）', () => {
    // 这条钉住第 2、3 档的**顺序**：一旦对调，READ 会落进第 3 档被判歧义而不改，行为静默翻转。
    expect(resolveToolCallName('READ', ['read', 'Read'])).toBe('read')
  })

  test('别名表优先于大小写回退，且只在目标已注册时生效', () => {
    expect(resolveToolCallName('Glob', ['find'])).toBe('find')
    expect(resolveToolCallName('GLOB', ['find'])).toBe('find')
    // 目标未注册 → 不改（不把调用引到本会话没开的工具上）
    expect(resolveToolCallName('Glob', ['read'])).toBeUndefined()
  })

  test('唯一大小写候选才回退', () => {
    expect(resolveToolCallName('Read', ['read'])).toBe('read')
    expect(resolveToolCallName('BASH', ['bash'])).toBe('bash')
    expect(resolveToolCallName('Read', [])).toBeUndefined()
  })
})
