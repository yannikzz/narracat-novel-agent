import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * 墓碑测试：防「任务书路径示例写不全，导致 agent 猜错文件名」回归。
 *
 * 病型（真机 durable 事件实锤，dev 与打包版都复现）：agent 反复 read
 * `<项目>/.narracat/staging/ch-019.md` / `ch-020.md` / `ch-021.md` 全部 ENOENT——真实文件名是
 * `ch-0NN.brief.md`。根因在 write.md 步骤 3a 的括号示例写的是「三位补零，如 ch-004」，那是个
 * 不完整的文件名；正文恰好叫 `ch-004.md`，于是「ch-004」+「.md」被补成了正文的名字。
 *
 * 任务书是写手唯一的剧情输入，读不到它就等于这一章没有任务书——每次白跑一轮工具往返，
 * 而错误信息只说文件不存在，不会告诉任何人是后缀记混了。
 *
 * 纪律：凡在 prompt 里给文件名示例，就给完整文件名。半截示例会被模型按最近的同类补全。
 */

const agentCoreRoot = join(import.meta.dir, '..')
const WRITE_COMMAND = join(agentCoreRoot, 'commands', 'write.md')

/** 任务书的真实文件名形态：章号段 + `.brief.md` */
const BRIEF_SUFFIX = '.brief.md'

describe('write.md 任务书路径契约', () => {
  const source = readFileSync(WRITE_COMMAND, 'utf8')

  test('任务书路径模式带 .brief.md 后缀', () => {
    expect(source).toContain(`.narracat/staging/ch-{三位章号}${BRIEF_SUFFIX}`)
  })

  test('文件名示例是完整文件名，不是半截的 ch-NNN', () => {
    // 取定义那一行，检查里面每个 `ch-数字` 形态的示例都带完整后缀
    const line = source.split('\n').find((l) => l.includes(`.narracat/staging/ch-{三位章号}${BRIEF_SUFFIX}`))
    expect(line).toBeDefined()
    const examples = line.match(/ch-\d{3}[.\w]*/g) ?? []
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) {
      // 允许出现正文示例 `ch-004.md`，但它必须是作为「别写成这个」的反例出现
      if (example.endsWith(BRIEF_SUFFIX)) continue
      expect(line).toMatch(/别写成|不是|区别|后缀不同/)
    }
    // 至少要有一个完整的任务书文件名示例
    expect(examples.some((e) => e.endsWith(BRIEF_SUFFIX))).toBe(true)
  })

  test('派发段引用任务书时用占位符，不自己拼半截路径', () => {
    // 四处 Task 派发都写「任务书路径: {brief 路径}」，由主会话填入步骤 3a 实际写入的路径；
    // 一旦有人把占位符换成硬拼的 `ch-{章号}.md`，这条会红。
    const dispatchLines = source.split('\n').filter((l) => l.trim().startsWith('任务书路径:'))
    expect(dispatchLines.length).toBeGreaterThan(0)
    for (const line of dispatchLines) {
      expect(line).toContain('{brief 路径}')
      expect(line).not.toMatch(/ch-\{[^}]*\}\.md/)
    }
  })
})
