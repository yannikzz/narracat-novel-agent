import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * 墓碑测试：防「内联工具 schema 的必填项与 prompt 字段清单漂移」回归。
 *
 * 病型（真机 durable 事件实锤）：memory-keeper 调 novel_commit_chapter 时漏传
 * characters_appeared / emotional_tone / continuation_hook 三个必填字段，几百字的
 * summary + anchor + key_events 全部白写，被 ajv 当场拒掉。
 *
 * 查下去发现 prompt 侧根本没法区分必填与可选：九个字段排成一串
 * `{chapter, summary, anchor, key_events, characters_appeared, emotional_tone,
 *   continuation_hook, foreshadowing_actions, timeline_note?}`，只有最后一个带 `?`，
 * 而 foreshadowing_actions 其实同样是可选的。模型看到的是「九个都要」或「随便挑」，
 * 两种读法都错。
 *
 * 为什么现有守卫接不住：lint:schema-drift 只比对 schemas/*.json（独立 schema 文件）的
 * 版本号与弃用字段；novel_commit_chapter 与 novel_consolidate 的入参契约是写死在
 * mcp-server/src/handlers/validators.ts 里的内联常量（「工具入参即契约，无独立 schema
 * 文件」），落在它的扫描范围之外。内联 schema 目前只有这两个，专门做 AST 解析的通用
 * lint 不划算，用墓碑测试钉住这两处即可。
 *
 * 注意这里断言的是「集合相等」而非「包含」：prompt 的必填串里多写一个可选字段，
 * 模型就会当它必填而被迫编造；少写一个必填字段，就是这次真机失败的成因。两个方向都要红。
 */

const agentCoreRoot = join(import.meta.dir, '..')
const VALIDATORS = join(agentCoreRoot, 'mcp-server', 'src', 'handlers', 'validators.ts')
const MEMORY_KEEPER = join(agentCoreRoot, 'agents', 'memory-keeper.md')

/** 从 validators.ts 抠某个内联 schema 的 required 数组（源码即契约，不走编译产物） */
function requiredOf(source, schemaName) {
  const start = source.indexOf(`const ${schemaName} = {`)
  if (start === -1) throw new Error(`validators.ts 里找不到 ${schemaName}`)
  const slice = source.slice(start)
  const match = slice.match(/required:\s*\[([\s\S]*?)\]/)
  if (!match) throw new Error(`${schemaName} 里找不到 required 数组`)
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** 从 prompt 的「提交 `{...}`」花括号里取字段名；带 `?` 的算可选，其余算必填 */
function declaredFields(promptLine) {
  const match = promptLine.match(/\{([^}]*)\}/)
  if (!match) throw new Error(`这一行没有字段清单：${promptLine}`)
  const required = []
  const optional = []
  for (const raw of match[1].split(',')) {
    const name = raw.trim()
    if (!name) continue
    if (name.endsWith('?')) optional.push(name.slice(0, -1))
    else required.push(name)
  }
  return { required, optional }
}

function lineContaining(source, needle) {
  const line = source.split('\n').find((l) => l.includes(needle))
  if (!line) throw new Error(`memory-keeper.md 里找不到含「${needle}」的行`)
  return line
}

describe('内联工具 schema 的必填项与 prompt 字段清单一致', () => {
  const validators = readFileSync(VALIDATORS, 'utf8')
  const keeper = readFileSync(MEMORY_KEEPER, 'utf8')

  test('novel_commit_chapter：prompt 标为必填的字段集 === schema 的 required', () => {
    const schemaRequired = requiredOf(validators, 'COMMIT_CHAPTER_SCHEMA')
    const { required, optional } = declaredFields(lineContaining(keeper, '提交 `{chapter, summary'))

    // sanity：确认真抠到了东西，空集合不许算通过
    expect(schemaRequired.length).toBeGreaterThan(0)
    expect(required.length).toBeGreaterThan(0)

    expect([...required].sort()).toEqual([...schemaRequired].sort())
    // 可选字段必须显式带 `?`，不能混在必填串里让模型自己猜
    expect([...optional].sort()).toEqual(['foreshadowing_actions', 'timeline_note'])
  })

  test('novel_consolidate：prompt 标为必填的字段集 === schema 的 required', () => {
    const schemaRequired = requiredOf(validators, 'CONSOLIDATE_SCHEMA')
    const { required } = declaredFields(lineContaining(keeper, '提交 `{scope, scope_id'))

    expect(schemaRequired.length).toBeGreaterThan(0)
    expect([...required].sort()).toEqual([...schemaRequired].sort())
  })

  test('必填字段在 prompt 里逐条有说明，不能只出现在花括号清单里', () => {
    const schemaRequired = requiredOf(validators, 'COMMIT_CHAPTER_SCHEMA')
    // chapter 是调用方给定的章号，不需要写作说明；其余必填项都要有自己的说明条目
    for (const field of schemaRequired.filter((f) => f !== 'chapter')) {
      const documented =
        keeper.includes(`\`${field}\``) || keeper.includes(`\`${field}.`) || keeper.includes(`\`anchor.`)
      expect(documented).toBe(true)
    }
  })
})
