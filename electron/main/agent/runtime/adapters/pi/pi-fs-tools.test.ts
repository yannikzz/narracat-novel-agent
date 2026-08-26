import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGrepToolDefinition, truncateLine } from '@mariozechner/pi-coding-agent'
import { createPortableFindTool, createPortableGrepTool } from './pi-fs-tools.ts'

/**
 * pi 内置 find 依赖 fd 二进制：先查系统 PATH，找不到就去 GitHub Releases 下载。
 * 两条路在生产上都不通——macOS 从 Finder 启动的 App 继承 launchd 的窄 PATH（不含
 * /opt/homebrew/bin），而目标用户（网文作者）机器上本来就没有 fd，GitHub 下载对
 * 国内用户更是基本不可达。真机打包版实测 find 一半调用直接报
 * 「fd is not available and could not be downloaded」。
 *
 * 本模块用 Node 内置 fs.glob 提供 FindOperations，复用 pi 自己的
 * createFindToolDefinition，只换底层实现——schema / 描述 / 输出格式全部不动，零漂移。
 */

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'narracat-find-'))
  mkdirSync(join(root, 'manuscript', 'vol-01'), { recursive: true })
  mkdirSync(join(root, 'bible', 'characters'), { recursive: true })
  mkdirSync(join(root, '.narracat', 'staging'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true })
  writeFileSync(join(root, 'manuscript', 'vol-01', 'ch-001.md'), '第一章\n苏见推开门。\n屋里没人。')
  writeFileSync(join(root, 'manuscript', 'vol-01', 'ch-002.md'), '第二章\n苏见又来了。')
  writeFileSync(join(root, 'bible', 'characters', 'su-jian.md'), '苏见\n代号 SU-JIAN')
  writeFileSync(join(root, '.narracat', 'staging', 'ch-021.md'), '任务书\n苏见的转折')
  writeFileSync(join(root, 'node_modules', 'junk', 'noise.md'), '不该出现 苏见')
  writeFileSync(join(root, 'cover.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

async function runFind(pattern: string, path?: string): Promise<string> {
  const tool = createPortableFindTool(root)
  const result = await tool.execute(
    'call-1',
    { pattern, ...(path === undefined ? {} : { path }) } as never,
    undefined,
    undefined,
    undefined,
  )
  const first = result.content[0]
  return first && first.type === 'text' ? first.text : ''
}

describe('createPortableFindTool（不依赖 fd 的 find）', () => {
  test('工具名与内置 find 一致——同名才能覆盖掉依赖 fd 的那个', () => {
    expect(createPortableFindTool(root).name).toBe('find')
  })

  test('递归匹配章节文件', async () => {
    const text = await runFind('**/ch-*.md')
    expect(text).toContain('manuscript/vol-01/ch-001.md')
    expect(text).toContain('manuscript/vol-01/ch-002.md')
  })

  test('返回相对搜索根的路径，不泄露本机绝对路径', async () => {
    const text = await runFind('**/ch-*.md')
    expect(text).not.toContain(root)
    expect(text).not.toContain(tmpdir())
    for (const line of text.split('\n').filter(Boolean)) {
      expect(line.startsWith('/')).toBe(false)
    }
  })

  test('能搜到隐藏目录里的任务书（.narracat 是引擎的工作区，不能被当成隐藏文件跳过）', async () => {
    const text = await runFind('**/staging/*.md')
    expect(text).toContain('.narracat/staging/ch-021.md')
  })

  test('限定子目录搜索时，路径相对该子目录', async () => {
    const text = await runFind('*.md', 'bible/characters')
    expect(text).toContain('su-jian.md')
    expect(text).not.toContain('bible/characters/su-jian.md')
  })

  test('排除 node_modules', async () => {
    const text = await runFind('**/*.md')
    expect(text).not.toContain('noise.md')
  })

  test('无匹配时给出明确结果，不是报错', async () => {
    const text = await runFind('**/*.does-not-exist')
    expect(text).toContain('No files found')
  })

  test('搜索路径不存在时报错，而不是静默返回空', async () => {
    await expect(runFind('*.md', 'no/such/dir')).rejects.toThrow()
  })
})

/**
 * pi 内置 grep 依赖 ripgrep，坏法与 find 完全同源（窄 PATH + 作者机器没装 + GitHub 下载不可达）。
 * 差别是 grep 换不掉搜索实现——GrepOperations 只暴露 isDirectory/readFile，`ensureTool("rg")`
 * 是无条件的。所以这里只继承 pi 的工具定义、重写 execute，测试相应分两层：
 * ① 继承的那一面（name/description/schema）逐字不漂移；② 自己写的那一面（输出格式、上限、
 * 截断提示）与 pi 的 rg 版本行为一致。
 */
async function runGrep(
  args: {
    pattern: string
    path?: string
    glob?: string
    ignoreCase?: boolean
    literal?: boolean
    context?: number
    limit?: number
  },
  cwd: string = root,
): Promise<string> {
  const tool = createPortableGrepTool(cwd)
  const result = await tool.execute('call-1', args as never, undefined, undefined, undefined)
  const first = result.content[0]
  return first && first.type === 'text' ? first.text : ''
}

describe('createPortableGrepTool（不依赖 ripgrep 的 grep）', () => {
  test('工具名与内置 grep 一致——同名才能覆盖掉依赖 rg 的那个', () => {
    expect(createPortableGrepTool(root).name).toBe('grep')
  })

  test('模型看到的那一面逐字继承 pi 的定义（description/schema 零漂移）', () => {
    const ours = createPortableGrepTool(root)
    const builtin = createGrepToolDefinition(root)
    expect(ours.description).toBe(builtin.description)
    expect(ours.label).toBe(builtin.label)
    expect(ours.promptSnippet).toBe(builtin.promptSnippet)
    expect(ours.parameters).toEqual(builtin.parameters)
  })

  test('匹配行按 `路径:行号: 正文` 输出，路径相对搜索根', async () => {
    const text = await runGrep({ pattern: '苏见' })
    expect(text).toContain('manuscript/vol-01/ch-001.md:2: 苏见推开门。')
    expect(text).toContain('bible/characters/su-jian.md:1: 苏见')
  })

  test('不泄露本机绝对路径', async () => {
    const text = await runGrep({ pattern: '苏见' })
    expect(text).not.toContain(root)
    expect(text).not.toContain(tmpdir())
  })

  test('能搜到隐藏目录里的任务书（.narracat 是引擎工作区，不是该跳过的隐藏文件）', async () => {
    const text = await runGrep({ pattern: '转折' })
    expect(text).toContain('.narracat/staging/ch-021.md:2: 苏见的转折')
  })

  test('排除 node_modules', async () => {
    const text = await runGrep({ pattern: '不该出现' })
    expect(text).toContain('No matches found')
  })

  test('glob 过滤不带 / 时按 rg 语义匹配任意深度，而不是只匹配一层', async () => {
    const text = await runGrep({ pattern: '苏见', glob: 'ch-*.md' })
    expect(text).toContain('manuscript/vol-01/ch-001.md')
    expect(text).not.toContain('su-jian.md')
  })

  test('glob 带路径时按搜索根解析——rg 是按进程 cwd 匹配的，打包版里那等于恒零命中', async () => {
    const text = await runGrep({ pattern: '苏见', glob: 'manuscript/**/*.md' })
    expect(text).toContain('manuscript/vol-01/ch-001.md')
    expect(text).not.toContain('bible/')
  })

  test('context 给出前后文，且上下文行用 `-行号- ` 前缀区别于匹配行', async () => {
    const text = await runGrep({ pattern: '推开门', context: 1 })
    expect(text).toContain('manuscript/vol-01/ch-001.md-1- 第一章')
    expect(text).toContain('manuscript/vol-01/ch-001.md:2: 苏见推开门。')
    expect(text).toContain('manuscript/vol-01/ch-001.md-3- 屋里没人。')
  })

  test('ignoreCase 生效', async () => {
    expect(await runGrep({ pattern: 'su-jian' })).toContain('No matches found')
    expect(await runGrep({ pattern: 'su-jian', ignoreCase: true })).toContain('代号 SU-JIAN')
  })

  test('literal 把正则元字符当字面量', async () => {
    expect(await runGrep({ pattern: '苏.推' })).toContain('ch-001.md:2:')
    expect(await runGrep({ pattern: '苏.推', literal: true })).toContain('No matches found')
  })

  test('单文件搜索时路径退化成文件名，不带目录前缀', async () => {
    const text = await runGrep({ pattern: '苏见', path: 'bible/characters/su-jian.md' })
    expect(text).toContain('su-jian.md:1: 苏见')
    expect(text).not.toContain('bible/characters/su-jian.md')
  })

  test('二进制文件跳过，不把乱码塞进模型上下文', async () => {
    const text = await runGrep({ pattern: 'PNG' })
    expect(text).toContain('No matches found')
  })

  test('无匹配时给出明确结果，不是报错', async () => {
    const text = await runGrep({ pattern: '不存在的词' })
    expect(text).toContain('No matches found')
  })

  test('搜索路径不存在时报错，而不是静默返回空', async () => {
    await expect(runGrep({ pattern: '苏见', path: 'no/such/dir' })).rejects.toThrow('Path not found')
  })

  test('非法正则报错，而不是当成零匹配', async () => {
    await expect(runGrep({ pattern: '[' })).rejects.toThrow('Invalid pattern')
  })

  test('撞上匹配上限时截断并给出可操作提示（复刻 pi 的文案）', async () => {
    const text = await runGrep({ pattern: '苏见', limit: 1 })
    expect(text.split('\n').filter((line) => line.includes(':1:') || line.includes(':2:'))).toHaveLength(1)
    expect(text).toContain('[1 matches limit reached. Use limit=2 for more, or refine pattern]')
  })

  test('多文件命中时顺序稳定——同一次搜索两次结果必须逐字相同', async () => {
    expect(await runGrep({ pattern: '苏见' })).toBe(await runGrep({ pattern: '苏见' }))
  })

  test('超长行按 pi 的上限截断并给出提示', async () => {
    const longRoot = mkdtempSync(join(tmpdir(), 'narracat-grep-long-'))
    writeFileSync(join(longRoot, 'long.md'), `${'甲'.repeat(600)}钩子`)
    try {
      const text = await runGrep({ pattern: '甲' }, longRoot)
      expect(text).toContain('... [truncated]')
      expect(text).toContain('Some lines truncated to 500 chars')
    } finally {
      rmSync(longRoot, { recursive: true, force: true })
    }
  })

  test('守卫：pi 的行截断上限仍是 500——它一旦改，上面那句提示文案就是错的', () => {
    expect(truncateLine('x'.repeat(500)).wasTruncated).toBe(false)
    expect(truncateLine('x'.repeat(501)).text).toBe(`${'x'.repeat(500)}... [truncated]`)
  })

  test('守卫：父会话与子会话两条装配路径都要注入——写手/审校跑在子会话里', () => {
    const assembly = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
    const injections = assembly.match(/createPortableGrepTool\(cwd\)/g) ?? []
    expect(injections.length).toBe(2)
  })
})
