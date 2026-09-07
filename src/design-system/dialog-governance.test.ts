/**
 * 弹窗漂移治理（docs/design.md §9.7）。
 *
 * 之前的状态：规范只写了内容型一种形态，原语默认值却是轻确认框的形态，且没有任何机器守卫——
 * 于是 22 个弹窗里出现 11 种宽度、3 种取消钮样式、3 种页脚实现。本测试把"宽度档位只能来自
 * design-system 常量"这一条变成硬门：
 *
 * 1. 扫全部生产 .tsx 里的 `<DialogContent` / `<SheetContent`，className 必须引用 `DIALOG_CONTENT_*`
 *    常量（直接用，或经业务常量 `*_DIALOG_CONTENT_CLASS` 间接用，后者定义里必须含 design-system 常量）。
 *    字面量宽度一律不认。
 * 2. 存量偏差登记在 ACCEPTED_DEBT，每条附原因；表里的文件若已合规会红——债务清了表必须同步删，
 *    否则表就变成永久豁免。新弹窗不得进表。
 * 3. 规范文本与常量导出的存在性由 check:design 的 requiredContracts 守（这里只复核一遍口径）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/** 存量偏差：文件 → 原因。清掉一条删一条。 */
const ACCEPTED_DEBT: Readonly<Record<string, string>> = Object.freeze({
  'src/routes/library.tsx':
    '书架四个弹窗（元数据 640 / 删除 520 / 备份 520 / 无效项目 440）宽度都不在档位上，且删除/备份写了 bg-workspace 却没 p-0；要产品主人看一眼再归档',
  'src/components/workbench/AgentPanel.tsx': '「开始新对话」确认框宽 400，应归轻确认框 448 档，改动可见需真机看',
  'src/components/workbench/CharacterChatBoard.tsx': '「关于你」离开拦截宽 sm(384)，应归轻确认框 448 档',
  'src/components/workbench/artifacts/ManuscriptRevisionSheet.tsx':
    '唯一的 Sheet，宽 960 且 header/footer 内边距自成一派（px-5），Sheet 档位常量待与产品主人定',
})

const SRC_ROOT = 'src'

function listProductionTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...listProductionTsx(path))
    } else if (path.endsWith('.tsx') && !path.endsWith('.test.tsx')) {
      out.push(path.split('\\').join('/'))
    }
  }
  return out
}

interface DialogUsage {
  file: string
  tag: 'DialogContent' | 'SheetContent'
  /** className 属性原文；无 className 时为 null。 */
  className: string | null
  /** 字面量（"…"）还是表达式（{…}）。 */
  kind: 'literal' | 'expression' | 'missing'
}

/** `className={…}` 的花括号配平取值（模板字符串里的 `${}` 会让懒匹配提前收尾）。 */
function readBracedExpression(attrs: string, start: number): string | null {
  let depth = 0
  for (let index = start; index < attrs.length; index += 1) {
    const char = attrs[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return attrs.slice(start + 1, index)
    }
  }
  return null
}

/** 抓 `<DialogContent …>` / `<SheetContent …>` 开标签里的 className（单行或多行属性都认）。 */
export function extractDialogUsages(file: string, source: string): DialogUsage[] {
  const usages: DialogUsage[] = []
  const tagPattern = /<(DialogContent|SheetContent)\b([^>]*)>/g
  for (const match of source.matchAll(tagPattern)) {
    const attrs = match[2] ?? ''
    const literal = attrs.match(/className="([^"]*)"/)
    const braceStart = attrs.indexOf('className={')
    const expression = braceStart >= 0 ? readBracedExpression(attrs, braceStart + 'className='.length) : null
    usages.push({
      file,
      tag: match[1] as DialogUsage['tag'],
      className: literal?.[1] ?? expression?.trim() ?? null,
      kind: literal ? 'literal' : expression !== null ? 'expression' : 'missing',
    })
  }
  return usages
}

/** 业务常量定义（`export const X_DIALOG_CONTENT_CLASS = …`）的值文本，跨文件收集。 */
function collectBusinessConstants(files: Array<{ path: string; source: string }>): Map<string, string> {
  const definitions = new Map<string, string>()
  const pattern = /export const ([A-Z0-9_]+_DIALOG_CONTENT_CLASS)\s*=\s*([\s\S]*?)\n(?=\S|\n)/g
  for (const { source } of files) {
    for (const match of source.matchAll(pattern)) definitions.set(match[1]!, match[2]!)
  }
  return definitions
}

/** 一处使用是否合规：宽度来自 design-system 常量（直接或经业务常量）。 */
export function dialogUsageViolation(usage: DialogUsage, businessConstants: Map<string, string>): string | null {
  if (usage.kind === 'missing') return '缺少 className：宽度档位必须显式取自 DIALOG_CONTENT_* 常量'
  if (usage.kind === 'literal') {
    return `className 是字面量「${usage.className}」：宽度档位必须取自 DIALOG_CONTENT_* 常量，不在业务文件里手写`
  }
  const expression = usage.className ?? ''
  if (/\bDIALOG_CONTENT_[A-Z]+_CLASS\b/.test(expression)) return null
  const referenced = expression.match(/\b[A-Z0-9_]+_DIALOG_CONTENT_CLASS\b/g) ?? []
  for (const name of referenced) {
    const definition = businessConstants.get(name)
    if (definition && /\bDIALOG_CONTENT_[A-Z]+_CLASS\b/.test(definition)) return null
    if (definition) return `业务常量 ${name} 的定义没有引用 DIALOG_CONTENT_* 常量（手写了宽度）`
  }
  return `className 表达式「${expression}」没有引用任何 DIALOG_CONTENT_* 常量`
}

describe('dialog drift governance（§9.7）', () => {
  const files = listProductionTsx(SRC_ROOT).map((path) => ({ path, source: readFileSync(path, 'utf8') }))
  const businessConstants = collectBusinessConstants(files)
  const usages = files.flatMap(({ path, source }) => extractDialogUsages(path, source))

  test('扫描确实扫到了弹窗（扫不到时下面的断言会假绿）', () => {
    expect(usages.length).toBeGreaterThanOrEqual(15)
    expect(usages.some((usage) => usage.tag === 'SheetContent')).toBe(true)
  })

  test('债务表之外的每个 DialogContent / SheetContent 宽度都来自 design-system 常量', () => {
    const violations = usages
      .filter((usage) => !(usage.file in ACCEPTED_DEBT))
      .map((usage) => ({ usage, reason: dialogUsageViolation(usage, businessConstants) }))
      .filter((item) => item.reason !== null)
      .map((item) => `${item.usage.file} <${item.usage.tag}>：${item.reason}`)
    expect(violations).toEqual([])
  })

  test('债务表里的文件必须仍有偏差——清了就把它从表里删掉，别让表变成永久豁免', () => {
    const stale = Object.keys(ACCEPTED_DEBT).filter((file) => {
      const own = usages.filter((usage) => usage.file === file)
      return own.length === 0 || own.every((usage) => dialogUsageViolation(usage, businessConstants) === null)
    })
    expect(stale).toEqual([])
  })

  test('三段式底座含 gap-0 / p-0 / bg-workspace 三件套（漏一件就是标题下方一片空白或浮层色穿帮）', () => {
    const surfaces = readFileSync('src/design-system/surfaces.ts', 'utf8')
    const base = surfaces.match(/export const DIALOG_SECTIONED_BASE_CLASS = '([^']*)'/)?.[1] ?? ''
    for (const token of ['gap-0', 'p-0', 'bg-workspace', 'overflow-hidden']) expect(base).toContain(token)
    // 轻确认框保留原语默认的裸容器，只定宽度
    expect(surfaces).toMatch(/export const DIALOG_CONTENT_CONFIRM_CLASS = 'sm:max-w-md'/)
  })

  test('原语动效钉在 200ms：Dialog 与 Sheet 都不得写 300 以上（§8.2）', () => {
    for (const file of ['src/components/ui/dialog.tsx', 'src/components/ui/sheet.tsx']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/data-\[state=(open|closed)\]:duration-[3-9]\d\d/)
    }
  })

  test('规范写明了两种形态与分界线、Dialog/Sheet 判据、债务表', () => {
    const design = readFileSync('docs/design.md', 'utf8')
    for (const phrase of ['轻确认框', '分界线', 'Dialog 还是 Sheet', 'ACCEPTED_DEBT']) expect(design).toContain(phrase)
  })
})

describe('extractDialogUsages / dialogUsageViolation（纯函数）', () => {
  const constants = new Map([['PACK_DETAIL_DIALOG_CONTENT_CLASS', '`${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_DOCUMENT_CLASS}`']])

  test('直接引用常量：合规', () => {
    const [usage] = extractDialogUsages('x.tsx', '<DialogContent className={DIALOG_CONTENT_FORM_CLASS}>')
    expect(dialogUsageViolation(usage!, constants)).toBeNull()
  })

  test('模板字符串里拼常量：合规', () => {
    const [usage] = extractDialogUsages('x.tsx', '<DialogContent className={`${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_FORM_CLASS}`}>')
    expect(dialogUsageViolation(usage!, constants)).toBeNull()
  })

  test('经业务常量间接引用：常量定义含 design-system 常量才合规', () => {
    const [usage] = extractDialogUsages('x.tsx', '<DialogContent className={PACK_DETAIL_DIALOG_CONTENT_CLASS}>')
    expect(dialogUsageViolation(usage!, constants)).toBeNull()
    const bad = new Map([['PACK_DETAIL_DIALOG_CONTENT_CLASS', "'sm:max-w-[680px]'"]])
    expect(dialogUsageViolation(usage!, bad)).toContain('手写了宽度')
  })

  test('字面量宽度：违规，并把字面量报出来', () => {
    const [usage] = extractDialogUsages('x.tsx', '<DialogContent className="sm:max-w-[400px]" data-x="1">')
    expect(dialogUsageViolation(usage!, constants)).toContain('sm:max-w-[400px]')
  })

  test('多行属性也抓得到 className', () => {
    const source = '<DialogContent\n  className={DIALOG_CONTENT_FORM_CLASS}\n  data-x="1"\n>'
    const [usage] = extractDialogUsages('x.tsx', source)
    expect(usage?.kind).toBe('expression')
    expect(dialogUsageViolation(usage!, constants)).toBeNull()
  })
})
