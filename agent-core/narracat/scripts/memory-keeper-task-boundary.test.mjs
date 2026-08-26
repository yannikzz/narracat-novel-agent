import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * 墓碑测试：防「memory-keeper 四路任务串档」回归。
 *
 * 病型（真机 durable 事件实锤，issue #37 追查中发现）：write.md 步骤 6 并行派发 4 个
 * memory-keeper —— 3 个事实暂存（envelope 给 run_id）+ 1 个收尾入库（envelope 无 run_id）。
 * 真机三次 /write 里，收尾那一路越界执行了抽取：
 *
 *   - novel_extraction_scaffold 每章被调 4 次（抽取专用准备工具，只该被 3 路暂存任务调）
 *   - novel_stage_extraction 每章被调 6-7 次（设计值 3 次）
 *   - 其中 2 次直接报 `run_id: must have required properties run_id` —— 收尾任务的
 *     envelope 里根本没有 run_id，它想传也传不出来，几千 token 的整章抽取被 schema 拒掉
 *
 * 根因是分诊太弱，两条腿都软：
 *   ① 派发端 Task B 的 envelope 只说「收尾入库」，没说「不要抽取」；
 *   ② agent 端「准备：抽取脚手架」一节夹在「一、章节收尾」与「二、事实暂存」之间，且用无条件
 *      祈使句「提交事实清单前，先调…」——顺序读文档的模型做完收尾正好撞上它，照做即越界。
 *
 * 注意 run_id 必填不是缺陷，是护栏：收尾任务若能随手编一个 run_id 混进暂存区，
 * novel_commit_extraction_union 的 staged_runs 容错计数会失真。所以修法是堵越界，不是放宽 schema。
 *
 * 真机验收指标：修好后每章 novel_extraction_scaffold 应为 3 次（不是 4 次）。
 */

const agentCoreRoot = join(import.meta.dir, '..')
const WRITE_COMMAND = join(agentCoreRoot, 'commands', 'write.md')
const MEMORY_KEEPER = join(agentCoreRoot, 'agents', 'memory-keeper.md')

/** 抽取路径专用工具：收尾任务碰任何一个都是串档 */
const EXTRACTION_ONLY_TOOLS = ['novel_extraction_scaffold', 'novel_stage_extraction']

function read(path) {
  return readFileSync(path, 'utf8')
}

/** 取 write.md 步骤 6 里 Task B（收尾入库）那一段派发文案（envelope 由一对双引号包住） */
function taskBEnvelope(source) {
  const match = source.match(/Task B（memory-keeper）:\s*"([\s\S]*?)"/)
  if (!match) throw new Error('write.md 里找不到 Task B（memory-keeper）的派发文案')
  return match[1]
}

/** 取 memory-keeper.md 开头的分诊段（「先看任务 envelope」到第一个二级标题为止） */
function triageSection(source) {
  const start = source.indexOf('先看任务 envelope')
  if (start === -1) throw new Error('memory-keeper.md 里找不到分诊段')
  const end = source.indexOf('\n## ', start)
  return source.slice(start, end === -1 ? undefined : end)
}

describe('memory-keeper 四路任务边界', () => {
  test('write.md 的三路暂存任务各自带 run_id（分诊的唯一显式信号，不能丢）', () => {
    const source = read(WRITE_COMMAND)
    for (const runId of [1, 2, 3]) {
      expect(source).toContain(`run_id: ${runId}`)
    }
  })

  test('write.md 的收尾任务 envelope 明说不做事实抽取', () => {
    const envelope = taskBEnvelope(read(WRITE_COMMAND))
    // sanity：确认真抓到了 envelope 正文，否则下面的断言会在空串上「通过」
    expect(envelope).toContain('收尾入库')
    expect(envelope).toContain('正文路径')
    // 派发端一次说清，别指望 agent 端自觉：envelope 是模型唯一确定「我是哪一路」的依据
    expect(envelope).toMatch(/不.*抽取/)
  })

  test('memory-keeper 分诊段点名收尾任务不碰抽取工具', () => {
    const triage = triageSection(read(MEMORY_KEEPER))
    for (const tool of EXTRACTION_ONLY_TOOLS) {
      expect(triage).toContain(tool)
    }
    expect(triage).toMatch(/不调|不要调/)
  })

  test('抽取脚手架一节排在事实暂存之后，不夹在收尾与暂存之间', () => {
    const source = read(MEMORY_KEEPER)
    const commitHeading = source.indexOf('## 一、章节收尾')
    const stageHeading = source.indexOf('## 二、事实暂存')
    const scaffoldMention = source.indexOf('novel_extraction_scaffold({')

    expect(commitHeading).toBeGreaterThan(-1)
    expect(stageHeading).toBeGreaterThan(-1)
    expect(scaffoldMention).toBeGreaterThan(-1)
    // 顺序读文档的模型做完「一、章节收尾」不应紧接着撞上一条无条件的「先调 scaffold」
    expect(scaffoldMention).toBeGreaterThan(stageHeading)
  })

  test('抽取脚手架的调用指令是条件句，限定在抽取任务内', () => {
    const source = read(MEMORY_KEEPER)
    const line = source.split('\n').find((l) => l.includes('novel_extraction_scaffold({'))
    expect(line).toBeDefined()
    // 无条件祈使句（「提交事实清单前，先调…」）正是收尾任务照做越界的入口
    expect(line).toMatch(/本轮|这一轮|抽取任务|暂存任务/)
  })
})
