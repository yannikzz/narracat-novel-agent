import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  buildCharacterChatMessages,
  CHARACTER_CHAT_READONLY_NOVEL_MEMORY_TOOLS,
  createCharacterChatRunManager,
  normalizeCharacterChatSendRequest,
} from './character-chat-runner'
import type {
  AnthropicLike,
  AnthropicMessageStreamLike,
  CharacterChatRunManagerDeps,
} from './character-chat-runner'
import type { NovelMemoryReadonlyMcpClient } from '../engine/novel-memory-mcp-client'
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { MemoryDbReader, OpenMemoryDb } from '../novel/memory-db'
import type { AppConfig } from '../config'
import { POOL_DEFAULT_FIELDS } from '@shared/types/config'
import type {
  CharacterChatMessage,
  CharacterChatStreamEvent,
  CharacterChatTranscript,
} from '@shared/types/character-chat'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const UID_LIN = '11111111-1111-4111-8111-111111111111'

function makeBunReader(db: Database): MemoryDbReader {
  return {
    all<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[] {
      return db.query(sql).all(...params) as T[]
    },
    close(): void {
      db.close()
    },
  }
}

function seededDb(): Database {
  const db = new Database(':memory:')
  db.run(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE chapter_summaries (id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, chapter INTEGER NOT NULL,
      summary TEXT NOT NULL, characters TEXT NOT NULL DEFAULT '[]', UNIQUE(novel_id, chapter));
  `)
  db.run("INSERT INTO meta (key, value) VALUES ('novel_id', 'novel-1')")
  db.run(
    `INSERT INTO chapter_summaries (id, novel_id, chapter, summary, characters) VALUES
     ('s1', 'novel-1', 1, '第一章', ?), ('s2', 'novel-1', 2, '第二章', ?)`,
    JSON.stringify([{ character_uid: UID_LIN, name: '林衍' }]),
    JSON.stringify([{ character_uid: UID_LIN, name: '林衍' }]),
  )
  return db
}

async function tempProjectWithCharacter(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'narracat-cc-runner-'))
  tempRoots.push(root)
  const dir = join(root, 'bible', 'characters')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, '林衍.md'),
    `<!-- character_identity: {"character_uid":"${UID_LIN}","name":"林衍"} -->\n# 林衍\n冷峻的剑客。`,
    'utf-8',
  )
  return root
}

/** 打开磁盘上真实 sqlite 文件的只读 reader（默认绑定 buildSituationPack 用例：不注 fake，走真实实现）。 */
function openRealMemoryDb(dbPath: string): MemoryDbReader {
  const db = new Database(dbPath, { readonly: true })
  return {
    all<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): T[] {
      return db.query(sql).all(...params) as T[]
    },
    close(): void {
      db.close()
    },
  }
}

/**
 * 在 tempProjectWithCharacter 基础上补一份真实落盘 memory.db（含 facts/chapter_summaries），
 * 供「默认绑定 buildSituationPack（不注 fake）」用例验证真实实现能拼出处境包。
 * 建库套路照 character-chat-situation.test.ts。
 */
async function tempProjectWithSituationData(): Promise<string> {
  const root = await tempProjectWithCharacter()
  await mkdir(join(root, '.narracat'), { recursive: true })
  const db = new Database(join(root, '.narracat', 'memory.db'), { create: true })
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE facts (
      id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, subject TEXT NOT NULL,
      subject_character_uid TEXT, subject_character_b_uid TEXT,
      predicate TEXT NOT NULL, object TEXT NOT NULL,
      from_chapter INTEGER NOT NULL, event_chapter INTEGER,
      invalidated_at_chapter INTEGER, invalidated_by TEXT,
      source TEXT NOT NULL DEFAULT 'extracted',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      secret_known INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE character_cards (
      novel_id TEXT NOT NULL, character_uid TEXT NOT NULL, character TEXT NOT NULL,
      as_of_chapter INTEGER NOT NULL, card_json TEXT NOT NULL,
      PRIMARY KEY (novel_id, character_uid)
    );
    CREATE TABLE chapter_summaries (
      id TEXT PRIMARY KEY, novel_id TEXT NOT NULL, chapter INTEGER NOT NULL,
      summary TEXT NOT NULL, characters TEXT NOT NULL DEFAULT '[]',
      UNIQUE(novel_id, chapter)
    );
  `)
  db.run("INSERT INTO meta (key, value) VALUES ('novel_id', 'novel-1')")
  db.run(
    `INSERT INTO chapter_summaries (id, novel_id, chapter, summary, characters) VALUES ('s1', 'novel-1', 1, '第一章', ?)`,
    JSON.stringify([{ character_uid: UID_LIN, name: '林衍' }]),
  )
  db.run(
    `INSERT INTO facts (id, novel_id, subject, subject_character_uid, predicate, object, from_chapter, event_chapter)
     VALUES ('e1', 'novel-1', '林衍', ?, 'location', '城南客栈', 1, 1)`,
    UID_LIN,
  )
  db.close()
  return root
}

function verifiedConfig(): AppConfig {
  return {
    ...POOL_DEFAULT_FIELDS,
    // 按条目验证语义（切片①T2）：池条目须携带与 apiKeyMetadata/providers 一致的验证快照，
    // isModelServiceVerified 才判「已验证」。
    modelPool: [
      {
        provider: 'anthropic',
        modelId: 's',
        verification: { verifiedAt: 'now', apiKeyUpdatedAt: 'now', baseUrl: '' },
      },
    ],
    primaryModelKey: 'anthropic/s',
    apiKeyMetadata: { anthropic: { updatedAt: 'now' } },
    novelRootDir: '/novels',
    recentNovelPaths: [],
    systemNotificationsEnabled: false,
  }
}

/** 文本块流（仅 text_delta），finalMessage stop_reason=end_turn。 */
function textStream(texts: string[]): AnthropicMessageStreamLike {
  const iterable = (async function* () {
    for (const text of texts) {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
    }
  })()
  return {
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
    finalMessage: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: texts.join('') }],
    }),
  }
}

/** 工具请求轮：流出一段引导文本，finalMessage stop_reason=tool_use 含一个 tool_use 块。 */
function toolUseStream(args: {
  leading: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}): AnthropicMessageStreamLike {
  const iterable = (async function* () {
    if (args.leading) {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: args.leading } }
    }
  })()
  return {
    [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
    finalMessage: async () => ({
      stop_reason: 'tool_use',
      content: [
        ...(args.leading ? [{ type: 'text', text: args.leading }] : []),
        { type: 'tool_use', id: args.toolUseId, name: args.toolName, input: args.input },
      ],
    }),
  }
}

interface StreamCapture {
  body: {
    model: string
    system: string
    messages: MessageParam[]
    tools?: Tool[]
    max_tokens: number
  }
}

/** 假 Anthropic：按预排的 stream 队列逐轮返回，并记录每轮请求 body。 */
function fakeAnthropic(streams: AnthropicMessageStreamLike[]): {
  client: AnthropicLike
  captures: StreamCapture[]
} {
  const captures: StreamCapture[] = []
  let turn = 0
  const client: AnthropicLike = {
    messages: {
      stream: (body) => {
        captures.push({ body: JSON.parse(JSON.stringify(body)) })
        const stream = streams[turn] ?? textStream([''])
        turn += 1
        return stream
      },
    },
  }
  return { client, captures }
}

const READONLY_TOOLS: Tool[] = CHARACTER_CHAT_READONLY_NOVEL_MEMORY_TOOLS.map((name) => ({
  name,
  description: `${name} (readonly)`,
  input_schema: { type: 'object', properties: { character_uid: { type: 'string' } } },
}))

interface FakeMcpRecord {
  listed: number
  calls: Array<{ name: string; input: Record<string, unknown> }>
  closed: number
}

function fakeMcpClient(record: FakeMcpRecord, callResult = '截至边界：林衍在城南客栈。'): NovelMemoryReadonlyMcpClient {
  return {
    async listReadonlyTools() {
      record.listed += 1
      return READONLY_TOOLS
    },
    async callTool(name, input) {
      record.calls.push({ name, input })
      return callResult
    },
    async close() {
      record.closed += 1
    },
  }
}

function baseDeps(
  overrides: Partial<CharacterChatRunManagerDeps>,
  openMemoryDb: OpenMemoryDb,
  events: CharacterChatStreamEvent[],
): CharacterChatRunManagerDeps {
  return {
    readConfig: async () => verifiedConfig(),
    getApiKey: async () => 'sk-test',
    sendEvent: (event) => events.push(event),
    appRoot: '/app',
    openMemoryDb,
    createAnthropicClient: () => fakeAnthropic([textStream(['你', '好'])]).client,
    // 默认注入假 MCP 客户端：测试绝不 spawn 真实引擎 stdio。
    createMcpClient: () => fakeMcpClient({ listed: 0, calls: [], closed: 0 }),
    ...overrides,
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function completedText(events: CharacterChatStreamEvent[]): string {
  return (events.find((event) => event.type === 'completed') as { text: string }).text
}

function bubbles(events: CharacterChatStreamEvent[]): string[] {
  return events.filter((event) => event.type === 'bubble').map((event) => (event as { text: string }).text)
}

describe('normalizeCharacterChatSendRequest', () => {
  test('校验必填并默认 author 模式', () => {
    const normalized = normalizeCharacterChatSendRequest({
      runId: 'r1',
      projectPath: '/p',
      characterUid: 'uid',
      message: '在吗',
    })
    expect(normalized.userMode).toBe('author')
    expect(normalized.message).toBe('在吗')
  })

  test('缺字段抛错', () => {
    expect(() => normalizeCharacterChatSendRequest({ runId: 'r1', projectPath: '/p', characterUid: 'uid', message: '' })).toThrow()
    expect(() => normalizeCharacterChatSendRequest({ runId: '', projectPath: '/p', characterUid: 'uid', message: 'x' })).toThrow()
  })
})

describe('CHARACTER_CHAT_READONLY_NOVEL_MEMORY_TOOLS', () => {
  test('只含 4 个只读工具，绝无写工具', () => {
    expect(CHARACTER_CHAT_READONLY_NOVEL_MEMORY_TOOLS).toEqual([
      'novel_character_state',
      'novel_relationship',
      'novel_chapter_summary',
      'novel_query',
    ])
    expect(
      CHARACTER_CHAT_READONLY_NOVEL_MEMORY_TOOLS.some(
        (tool) => tool.includes('commit') || tool.includes('submit') || tool.includes('consolidate') || tool.includes('register'),
      ),
    ).toBe(false)
  })
})

describe('buildCharacterChatMessages', () => {
  const message = (
    role: CharacterChatMessage['role'],
    text: string,
    status: CharacterChatMessage['status'] = 'complete',
  ): CharacterChatMessage => ({ id: `${role}-${text}`, role, text, status, createdAt: 'now' })

  test('把终态历史映射为 user/assistant 交替，并 append 本条新 user', () => {
    const messages = buildCharacterChatMessages(
      [message('user', '你是谁'), message('character', '我是林衍'), message('user', '在干嘛'), message('character', '练剑')],
      '吃了吗',
    )
    expect(messages).toEqual([
      { role: 'user', content: '你是谁' },
      { role: 'assistant', content: '我是林衍' },
      { role: 'user', content: '在干嘛' },
      { role: 'assistant', content: '练剑' },
      { role: 'user', content: '吃了吗' },
    ])
  })

  test('丢弃非 complete / 空文本消息（流式、失败气泡不入上下文）', () => {
    const messages = buildCharacterChatMessages(
      [message('user', '在吗'), message('character', '', 'streaming'), message('character', '网络错误', 'failed')],
      '再问一次',
    )
    // 历史里没有可用 assistant，只剩首条 user，合并新 user 到同一轮
    expect(messages).toEqual([{ role: 'user', content: '在吗\n\n再问一次' }])
  })

  test('只取最近 N 轮', () => {
    const history: CharacterChatMessage[] = []
    for (let i = 0; i < 20; i += 1) {
      history.push(message('user', `u${i}`))
      history.push(message('character', `c${i}`))
    }
    const messages = buildCharacterChatMessages(history, '最新')
    // 12 条历史 + 末尾新 user（与末条 assistant 不连缀，独立成轮）
    expect(messages.length).toBe(13)
    expect(messages[0]).toEqual({ role: 'user', content: 'u14' })
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: '最新' })
  })
})

describe('createCharacterChatRunManager', () => {
  test('纯文本回复：started → bubble* → completed，无空行合成一条气泡', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const manager = createCharacterChatRunManager(baseDeps({}, () => makeBunReader(db), events))

    await manager.send({ runId: 'run-1', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    expect(events[0]).toEqual({ type: 'started', runId: 'run-1' })
    expect(bubbles(events)).toEqual(['你好'])
    expect(completedText(events)).toBe('你好')
  })

  test('单轮 tool_use → tool_result → 续答：工具往返不外露，最终文本拼接两段', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const record: FakeMcpRecord = { listed: 0, calls: [], closed: 0 }

    const { client, captures } = fakeAnthropic([
      toolUseStream({ leading: '让我想想……', toolUseId: 'tool-1', toolName: 'novel_character_state', input: { character_uid: UID_LIN } }),
      textStream(['我', '在城南']),
    ])

    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          createAnthropicClient: () => client,
          createMcpClient: () => fakeMcpClient(record),
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-tool', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '你在哪' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    // 工具调用确实经 MCP 客户端转发（白名单只读工具）
    expect(record.calls).toEqual([{ name: 'novel_character_state', input: { character_uid: UID_LIN } }])
    // run 收尾 close 客户端
    expect(record.closed).toBe(1)
    // 两轮请求：第二轮 messages 含 assistant(tool_use) + user(tool_result)
    expect(captures.length).toBe(2)
    const secondTurn = captures[1].body.messages
    expect(secondTurn.some((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === 'tool_use'))).toBe(true)
    expect(secondTurn.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => (b as { type: string }).type === 'tool_result'))).toBe(true)
    // UI 只收到文本增量（引导 + 续答），不含工具细节
    expect(bubbles(events)).toEqual(['让我想想……我在城南'])
    expect(completedText(events)).toBe('让我想想……我在城南')
  })

  test('多轮历史组装：第一轮请求 messages 含已存 transcript 历史 + 新 user', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const { client, captures } = fakeAnthropic([textStream(['嗯'])])

    const transcript: CharacterChatTranscript = {
      projectPath: project,
      characterUid: UID_LIN,
      userMode: 'author',
      messages: [
        { id: 'u1', role: 'user', text: '你好', status: 'complete', createdAt: 'now' },
        { id: 'c1', role: 'character', text: '你好，找我有事？', status: 'complete', createdAt: 'now' },
      ],
      updatedAt: 'now',
    }

    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          createAnthropicClient: () => client,
          readTranscript: async () => transcript,
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-hist', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '随便聊聊' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    const firstTurn = captures[0].body.messages
    expect(firstTurn).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，找我有事？' },
      { role: 'user', content: '随便聊聊' },
    ])
  })

  test('模型服务未验证：failed，且不调用 SDK / 不起 MCP', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    let streamCalls = 0
    let mcpStarts = 0
    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          readConfig: async () => ({
            ...verifiedConfig(),
            modelPool: [{ provider: 'anthropic', modelId: 's', verification: null }],
          }),
          createAnthropicClient: () => ({
            messages: {
              stream: () => {
                streamCalls += 1
                return textStream(['x'])
              },
            },
          }),
          createMcpClient: () => {
            mcpStarts += 1
            return fakeMcpClient({ listed: 0, calls: [], closed: 0 })
          },
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-2', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'failed'))

    expect(streamCalls).toBe(0)
    expect(mcpStarts).toBe(0)
    expect((events.find((event) => event.type === 'failed') as { message: string }).message).toContain('模型服务尚未验证')
  })

  test('无 API Key：failed', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const manager = createCharacterChatRunManager(
      baseDeps({ getApiKey: async () => null }, () => makeBunReader(db), events),
    )

    await manager.send({ runId: 'run-key', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'failed'))
    expect((events.find((event) => event.type === 'failed') as { message: string }).message).toContain('API Key')
  })

  test('SDK 抛错：failed 进入聊天流（可重试）', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          createAnthropicClient: () => ({
            messages: {
              stream: () => {
                throw new Error('网络错误')
              },
            },
          }),
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-3', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'failed'))
    expect((events.find((event) => event.type === 'failed') as { message: string }).message).toContain('网络错误')
  })

  test('未出场角色：failed', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const manager = createCharacterChatRunManager(baseDeps({}, () => makeBunReader(db), events))

    await manager.send({ runId: 'run-4', projectPath: project, characterUid: 'uid-unknown', userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'failed'))
    expect((events.find((event) => event.type === 'failed') as { message: string }).message).toContain('尚未出场或不存在')
  })

  test('工具 schema 按项目缓存：首发预热 spawn 一次拉 schema，纯闲聊续发零 spawn', async () => {
    const project = await tempProjectWithCharacter()
    const events: CharacterChatStreamEvent[] = []
    let mcpConstructs = 0
    let listed = 0

    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          // 每次 send 各排一段纯文本流（不触发 tool_use）。
          createAnthropicClient: () => fakeAnthropic([textStream(['好的'])]).client,
          createMcpClient: () => {
            mcpConstructs += 1
            const record: FakeMcpRecord = { listed: 0, calls: [], closed: 0 }
            const wrapped = fakeMcpClient(record)
            return {
              ...wrapped,
              async listReadonlyTools() {
                listed += 1
                return wrapped.listReadonlyTools()
              },
            }
          },
        },
        // 两次发送各开一次只读 db（reader.close 会关库），每次给新连接。
        () => makeBunReader(seededDb()),
        events,
      ),
    )

    await manager.send({ runId: 'warm-1', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))
    expect(mcpConstructs).toBe(1)
    expect(listed).toBe(1)

    events.length = 0
    await manager.send({ runId: 'warm-2', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '再聊聊' })
    await waitFor(() => events.some((event) => event.type === 'completed'))
    // 第二轮命中缓存：不再构造 MCP 客户端、不再 list（零 spawn）。
    expect(mcpConstructs).toBe(1)
    expect(listed).toBe(1)
    // 但 schema 仍然传给了模型（缓存复用）。
    expect(completedText(events)).toBe('好的')
  })

  test('MCP schema 拉取失败：降级为无工具纯聊天（completed 而非 failed）', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const record: FakeMcpRecord = { listed: 0, calls: [], closed: 0 }
    const { client, captures } = fakeAnthropic([textStream(['你', '好'])])

    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          createAnthropicClient: () => client,
          createMcpClient: () => ({
            ...fakeMcpClient(record),
            // 模拟 NovelMemory MCP 起不来 / 拉 schema 失败
            async listReadonlyTools(): Promise<Tool[]> {
              record.listed += 1
              throw new Error('mcp spawn failed')
            },
          }),
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-degrade', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    // 记忆服务不可用不致整条回复 failed；正常出 completed
    expect(events.some((event) => event.type === 'failed')).toBe(false)
    expect(completedText(events)).toBe('你好')
    // 降级：本轮请求不带 tools（无工具纯聊天）
    expect(captures[0].body.tools).toBeUndefined()
    // 扮演角色说话不是推理任务；thinking 与回复共用 max_tokens（只有 4096），开着会被烧光
    // 而返回空回复——润色那边实测过 thinking_delta × 15994 / text_delta × 0（ADR-0041）。
    expect(captures[0].body.thinking).toEqual({ type: 'disabled' })
    // 即便降级也收尾 close（曾构造过 client）
    expect(record.closed).toBe(1)
  })

  test('cancel 在 stream 前生效：不发 completed，且 MCP 被 close', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const record: FakeMcpRecord = { listed: 0, calls: [], closed: 0 }

    // readConfig 阻塞直到测试 cancel，确保取消发生在进入流式之前。
    let releaseConfig: () => void = () => {}
    const configGate = new Promise<void>((resolve) => {
      releaseConfig = resolve
    })

    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          readConfig: async () => {
            await configGate
            return verifiedConfig()
          },
          createMcpClient: () => fakeMcpClient(record),
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-cancel', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    const cancelled = manager.cancel('run-cancel')
    releaseConfig()
    expect(cancelled).toEqual({ cancelled: true })

    // 给 run 收尾留出时间
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(events.some((event) => event.type === 'started')).toBe(false)
  })

  test('cancel 已结束的 run 返回 false', () => {
    const events: CharacterChatStreamEvent[] = []
    const db = seededDb()
    const manager = createCharacterChatRunManager(baseDeps({}, () => makeBunReader(db), events))
    expect(manager.cancel('nope')).toEqual({ cancelled: false })
  })

  test('回复含空行→切成多条 bubble，括号旁白被清理', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const manager = createCharacterChatRunManager(
      baseDeps(
        { createAnthropicClient: () => fakeAnthropic([textStream(['在。\n\n（笑）你猜']) ]).client },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-1', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    expect(bubbles(events)).toEqual(['在。', '你猜'])
    const bubbleEvents = events.filter((event) => event.type === 'bubble') as Array<{ bubbleIndex: number }>
    expect(bubbleEvents.map((event) => event.bubbleIndex)).toEqual([0, 1])
  })
})

describe('createCharacterChatRunManager 处境包接线（片4）', () => {
  test('注入 buildSituationPack fake：systemPrompt 含处境包文本', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const { client, captures } = fakeAnthropic([textStream(['嗯'])])
    const fixedPack = '【你当前的处境】（截至第 2 章）\n你的状态：境界=筑基'

    const manager = createCharacterChatRunManager(
      baseDeps(
        { createAnthropicClient: () => client, buildSituationPack: async () => fixedPack },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-situation-fake', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    expect(captures[0].body.system).toContain(fixedPack)
  })

  test('buildSituationPack 抛错：降级为无处境包继续聊（completed 而非 failed）', async () => {
    const project = await tempProjectWithCharacter()
    const db = seededDb()
    const events: CharacterChatStreamEvent[] = []
    const { client, captures } = fakeAnthropic([textStream(['嗯'])])

    const manager = createCharacterChatRunManager(
      baseDeps(
        {
          createAnthropicClient: () => client,
          buildSituationPack: async () => {
            throw new Error('处境包组装失败（测试注入）')
          },
        },
        () => makeBunReader(db),
        events,
      ),
    )

    await manager.send({ runId: 'run-situation-error', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    expect(events.some((event) => event.type === 'failed')).toBe(false)
    expect(captures[0].body.system).not.toContain('【你当前的处境】')
  })

  test('默认绑定（不注 fake）：走真实实现，指向含最小 memory.db 的临时项目，systemPrompt 含【你当前的处境】', async () => {
    const project = await tempProjectWithSituationData()
    const events: CharacterChatStreamEvent[] = []
    const { client, captures } = fakeAnthropic([textStream(['嗯'])])

    const manager = createCharacterChatRunManager(
      baseDeps({ createAnthropicClient: () => client }, (dbPath) => openRealMemoryDb(dbPath), events),
    )

    await manager.send({ runId: 'run-situation-default', projectPath: project, characterUid: UID_LIN, userMode: 'author', message: '在吗' })
    await waitFor(() => events.some((event) => event.type === 'completed'))

    expect(captures[0].body.system).toContain('【你当前的处境】')
  })
})

describe('buildCharacterChatMessages 时间跨度标注', () => {
  function msg(role: 'user' | 'character', text: string, createdAt: string): CharacterChatMessage {
    return { id: `${role}-${text}`, role, text, status: 'complete' as const, createdAt }
  }

  test('相邻消息间隔超过阈值时，后一条前插「隔了…」标注', () => {
    const history = [
      msg('user', '在吗', '2026-06-20T10:00:00.000Z'),
      msg('character', '在的', '2026-06-20T10:00:00.000Z'),
      // 隔了 3 天（精确 3 天）
      msg('user', '最近忙啥', '2026-06-23T10:00:00.000Z'),
      msg('character', '老样子', '2026-06-23T10:00:05.000Z'),
    ]
    const messages = buildCharacterChatMessages(history, '今天有空吗')
    const flat = messages.map((m) => m.content as string).join('\n')
    expect(flat).toContain('隔了 3 天')
  })

  test('连续对话（间隔小）不插标注', () => {
    const history = [
      msg('user', '在吗', '2026-06-20T10:00:00.000Z'),
      msg('character', '在的', '2026-06-20T10:00:05.000Z'),
    ]
    const messages = buildCharacterChatMessages(history, '吃了吗')
    const flat = messages.map((m) => m.content as string).join('\n')
    expect(flat).not.toContain('隔了')
  })
})
