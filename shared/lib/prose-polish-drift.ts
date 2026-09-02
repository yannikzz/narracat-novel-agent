/**
 * 润色护栏：判断一版润色有没有动过「事实」（ADR-0041 §5）。
 *
 * **为什么不复用 `manuscript-triage.ts`**：那套三信号（变更句含实体名 / 整段增删 / 变更字符
 * 超 200）是为「人手改几句话」设计的。整章润色是全篇重述，字符变更量天然远超阈值、角色名
 * 必然出现在变更句里 → 每章必判 impact → 每章一个红点全是假警报 → 作者三章之后学会无视
 * 红点 → 真出事那次也被无视，等于废掉 ADR-0031 的第二档闸。
 *
 * 所以润色判的是**「改了什么」而非「改了多少」**：集合比对专名与数字，段落数只在大幅变化
 * 时才算信号（拆段重组节奏是合法润色，2026-07-27 实验里的 S2 策略正是如此）。
 *
 * 纯函数、零依赖（`shared/` 不得 import `electron/`，故段落切分在此自持一份，
 * 不复用 manuscript-triage 的同名工具）。
 */
import type { PolishDrift, PolishDriftDetail, PolishDriftSignal } from '@shared/types/prose-polish'

/** 段落数变化的绝对下限与相对比例，两者取大——低于它的增删视为节奏重组，不算动情节。 */
export const PARAGRAPH_DRIFT_MIN_DELTA = 3
export const PARAGRAPH_DRIFT_RATIO = 0.3

/** 网文正文惯例一行一段。 */
export function splitPolishParagraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// --- 数字归一化 --------------------------------------------------------------

const CN_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const CN_SMALL_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
const CN_BIG_UNITS: Record<string, number> = { 万: 10000, 亿: 100000000 }

/**
 * 中文数字只在**紧跟量词/单位**时才计入。
 *
 * 理由：中文数字大量嵌在普通词里（一起、一样、万一、三三两两），裸取会把语序调整误判成
 * 事实漂移，而常驻模式下一次误判 = 整章润色被跳过。带单位的才是作者在意的那种数字
 * （三天后、五百块、第七层）。阿拉伯数字无此歧义，不要求单位。
 *
 * 长单位排在前面并优先匹配：「十分钟」是事实，「十分安静」是副词——只认单字「分」会把后者
 * 当成 `10分`，这是实测撞出来的第一类误报。
 */
const UNITS = [
  '分钟',
  '小时',
  '个月',
  '年',
  '月',
  '天',
  '日',
  '岁',
  '秒',
  '次',
  '个',
  '人',
  '层',
  '级',
  '阶',
  '重',
  '件',
  '把',
  '条',
  '章',
  '卷',
  '回',
  '点',
  '里',
  '米',
  '斤',
  '块',
  '元',
  '倍',
  '成',
  '步',
  '招',
  '式',
  '颗',
  '粒',
  '枚',
  '张',
  '页',
  '遍',
  '度',
  '只',
].sort((a, b) => b.length - a.length)

/**
 * 虚指量词：小数值配这些单位几乎总是语气而非事实（「一个人站着」「又对折了一次」
 * 「愣了两下」）。润色最常见的加法恰恰就是这类词，计入它们会让纯文字润色被判成漂移——
 * 这是实测撞出来的第二类误报。阈值以上（三个人、五次）仍照常计入。
 */
const VAGUE_UNITS = new Set(['个', '次', '点', '步', '遍', '回', '只', '把', '条', '重'])
const VAGUE_MAX_VALUE = 2

const CN_NUMERAL_RUN = new RegExp(`[${Object.keys(CN_DIGITS).join('')}十百千万亿]+`, 'g')
const ARABIC_RUN = /\d+(?:[.]\d+)?/g

/**
 * 取紧跟在数字后的单位（长单位优先），允许中间隔一个空格——正文里「200 块」「3 天」这类
 * 写法很常见，不容它就等于数字护栏对这批数字全盲。返回单位本身与它在正文里的原始尾巴
 * （含那个空格），后者用来还原「原样保留」清单里的写法。
 */
function matchUnitAt(text: string, from: number): { unit: string; raw: string } {
  const gap = /^[ \u3000]?/.exec(text.slice(from))?.[0] ?? ''
  const unit = UNITS.find((candidate) => text.startsWith(candidate, from + gap.length)) ?? ''
  return { unit, raw: unit ? `${gap}${unit}` : '' }
}

/** 解析一段纯中文数字串；无法确定解析（如「三三两两」）时返回 null。 */
export function parseChineseNumeral(text: string): number | null {
  if (!text) return null

  let total = 0
  let section = 0
  let current = 0
  let sawDigit = false

  for (const char of text) {
    if (char in CN_DIGITS) {
      current = CN_DIGITS[char]
      sawDigit = true
      continue
    }
    if (char in CN_SMALL_UNITS) {
      const unit = CN_SMALL_UNITS[char]
      // 「十二」这类省略前导一的写法
      section += (current === 0 ? 1 : current) * unit
      current = 0
      sawDigit = true
      continue
    }
    if (char in CN_BIG_UNITS) {
      total += (section + current) * CN_BIG_UNITS[char]
      section = 0
      current = 0
      sawDigit = true
      continue
    }
    return null
  }

  if (!sawDigit) return null
  return total + section + current
}

export interface NumberEntry {
  /** 归一化文本，如 `3天`：判漂移用，让「三天」与「3天」等价 */
  token: string
  /** 正文里的原始写法，如 `三天`：喂给模型当「原样保留」清单时用，归一化写法会误导它改写 */
  surface: string
}

/**
 * 抽取一段正文里的数字并归一化，使「三天」与「3天」等价——同一事实的不同写法不该被判成
 * 漂移，而「三天」→「五天」必须被判成漂移。
 */
export function extractNumberEntries(text: string): NumberEntry[] {
  const entries: NumberEntry[] = []

  const push = (value: number, unit: string, surface: string): void => {
    if (unit && VAGUE_UNITS.has(unit) && value <= VAGUE_MAX_VALUE) return
    entries.push({ token: `${value}${unit}`, surface })
  }

  for (const match of text.matchAll(ARABIC_RUN)) {
    const raw = match[0]
    const { unit, raw: unitRaw } = matchUnitAt(text, (match.index ?? 0) + raw.length)
    push(Number(raw), unit, `${raw}${unitRaw}`)
  }

  for (const match of text.matchAll(CN_NUMERAL_RUN)) {
    const raw = match[0]
    const { unit, raw: unitRaw } = matchUnitAt(text, (match.index ?? 0) + raw.length)
    if (!unit) continue
    const value = parseChineseNumeral(raw)
    if (value === null) continue
    push(value, unit, `${raw}${unitRaw}`)
  }

  return entries
}

export function extractNumberTokens(text: string): string[] {
  return extractNumberEntries(text).map((entry) => entry.token)
}

/** 多重集差：返回 a 里有而 b 里不足的元素（按出现次数）。 */
function multisetDifference(a: string[], b: string[]): string[] {
  const remaining = new Map<string, number>()
  for (const item of b) remaining.set(item, (remaining.get(item) ?? 0) + 1)

  const missing: string[] = []
  for (const item of a) {
    const count = remaining.get(item) ?? 0
    if (count > 0) {
      remaining.set(item, count - 1)
      continue
    }
    missing.push(item)
  }
  return missing
}

/** 去重并保持首次出现顺序（展示给作者时不要出现重复条目）。 */
function distinct(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * ⚠️ **已知盲区：专名比对是闭世界的，凭空造出的新角色抓不到。**
 *
 * 试过用「对白署名」做开世界补充（`X说 / X道` 前面的 2-3 字），两版都在误报：
 * 贪婪匹配把「王五笑道」切成「王五笑」；改懒匹配后「此事不难说清」→「事不难」、
 * 「都知道结果」→「都知」。中文没有词边界，正则在这件事上没有可用的误报边界。
 *
 * **误报比漏报贵得多**：一次误报会让常驻模式跳过整章正常润色，而漏报只是少一道保险。
 * 故明确接受这个盲区，靠三件事兜：①喂给模型的锚清单明写「不要凭空加入清单以外的人物」；
 * ②试验模式有人在读；③常驻的前提是该配方已在试验阶段验证过。
 * 真要检测得上分词或模型，那不属于「确定性护栏」这一层。
 */
export interface DetectPolishDriftInput {
  /** 润色前的可见正文 */
  original: string
  /** 润色后的可见正文 */
  polished: string
  /**
   * 已知专名清单（角色名 + 别名 + 伏笔关键词）。同一份清单也会喂给模型当「原样保留」的锚，
   * 喂它正是为了压低这里的误报率（ADR-0041 §2）。
   */
  anchorNames: string[]
}

/**
 * 专名判据用**出现与否**而非出现次数：润色把重复的人名换成「他」是合法且常见的润色，
 * 按次数比会把它误判成漂移；而「角色整个消失」或「凭空多出一个已知角色」才是真的动了情节。
 */
function detectNameDrift(input: DetectPolishDriftInput): Pick<PolishDriftDetail, 'lostNames' | 'addedNames'> {
  const lostNames: string[] = []
  const addedNames: string[] = []

  for (const name of distinct(input.anchorNames.map((item) => item.trim()).filter(Boolean))) {
    const inOriginal = input.original.includes(name)
    const inPolished = input.polished.includes(name)
    if (inOriginal && !inPolished) lostNames.push(name)
    if (!inOriginal && inPolished) addedNames.push(name)
  }

  return { lostNames, addedNames }
}

export function detectPolishDrift(input: DetectPolishDriftInput): PolishDrift {
  const { lostNames, addedNames } = detectNameDrift(input)

  const originalNumbers = extractNumberTokens(input.original)
  const polishedNumbers = extractNumberTokens(input.polished)
  const lostNumbers = distinct(multisetDifference(originalNumbers, polishedNumbers))
  const addedNumbers = distinct(multisetDifference(polishedNumbers, originalNumbers))

  const originalParagraphs = splitPolishParagraphs(input.original).length
  const polishedParagraphs = splitPolishParagraphs(input.polished).length
  const paragraphThreshold = Math.max(
    PARAGRAPH_DRIFT_MIN_DELTA,
    Math.round(originalParagraphs * PARAGRAPH_DRIFT_RATIO),
  )
  const paragraphDrifted = Math.abs(polishedParagraphs - originalParagraphs) > paragraphThreshold

  const signals: PolishDriftSignal[] = []
  if (lostNames.length > 0 || addedNames.length > 0) signals.push('names')
  if (lostNumbers.length > 0 || addedNumbers.length > 0) signals.push('numbers')
  if (paragraphDrifted) signals.push('paragraphs')

  return {
    drifted: signals.length > 0,
    signals,
    detail: {
      lostNames,
      addedNames,
      lostNumbers,
      addedNumbers,
      originalParagraphs,
      polishedParagraphs,
    },
  }
}

/** 把漂移结果翻成贴在版本顶上的一句作者话；无漂移返回「事实未变」。 */
export function describePolishDrift(drift: PolishDrift): string {
  if (!drift.drifted) return '事实未变'

  const parts: string[] = []
  const { detail } = drift
  if (detail.lostNames.length > 0) parts.push(`少了 ${detail.lostNames.join('、')}`)
  if (detail.addedNames.length > 0) parts.push(`多了 ${detail.addedNames.join('、')}`)
  if (detail.lostNumbers.length > 0) parts.push(`改动数字 ${detail.lostNumbers.join('、')}`)
  if (detail.addedNumbers.length > 0 && detail.lostNumbers.length === 0) {
    parts.push(`新增数字 ${detail.addedNumbers.join('、')}`)
  }
  if (drift.signals.includes('paragraphs')) {
    parts.push(`段落 ${detail.originalParagraphs} → ${detail.polishedParagraphs}`)
  }
  return parts.join(' · ')
}
