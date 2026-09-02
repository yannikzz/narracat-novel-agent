/**
 * 润色请求的提示词组装与产出清洗（纯函数，ADR-0041 §2）。
 *
 * **责任边界铁律**：这里只往模型嘴里放两样东西——作者的原话，和「哪些不许动」的事实锚。
 * 任何「该怎么写」的指令（风格档位、前章语感、立项卡、句法处方）一个字都不进来。风格是
 * 作者提示词的地盘：润出来难看确实是提示词的问题，润出来把人名改了才是我们的问题，两边的
 * 锅从输入层就分开。
 *
 * 唯一的例外是**输出格式**约定（只要正文、不要解释、不要 markdown）——那是机器契约不是写法，
 * 缺了它整条链路接不住模型的产出。
 */
import { extractNumberEntries } from '@shared/lib/prose-polish-drift'

/** 锚清单的条数上限：清单本身也占输入，且过长会诱导模型把它当成「要用上的素材」。 */
export const ANCHOR_NAME_LIMIT = 40
export const ANCHOR_NUMBER_LIMIT = 40

/**
 * 从全项目专名里挑出**本章真的出现过的**，长的排前面。
 *
 * 只喂本章出现过的：把全书角色名单倒给模型，等于给了它一份「可以写进来的人物表」，反而抬高
 * 凭空引入角色的概率——而那正是护栏要抓的漂移。
 */
export function selectAnchorNames(originalText: string, allNames: string[]): string[] {
  const present = [...new Set(allNames.map((name) => name.trim()).filter(Boolean))].filter((name) =>
    originalText.includes(name),
  )
  return present.sort((a, b) => b.length - a.length).slice(0, ANCHOR_NAME_LIMIT)
}

/** 本章出现过的数字，取正文里的原始写法（喂归一化写法会诱导模型把「三天」改写成「3天」）。 */
export function selectAnchorNumbers(originalText: string): string[] {
  return [...new Set(extractNumberEntries(originalText).map((entry) => entry.surface))].slice(
    0,
    ANCHOR_NUMBER_LIMIT,
  )
}

export interface BuildPolishSystemPromptInput {
  /** 作者原话，一个字不加工 */
  authorPrompt: string
  anchorNames: string[]
  anchorNumbers: string[]
}

export function buildPolishSystemPrompt(input: BuildPolishSystemPromptInput): string {
  const sections: string[] = [
    '你在给一章小说正文做文字加工。作者对这次加工的要求写在下面，完全按作者的要求来。',
    `## 作者的要求\n${input.authorPrompt.trim()}`,
  ]

  const anchors: string[] = []
  if (input.anchorNames.length > 0) anchors.push(`人名与专名：${input.anchorNames.join('、')}`)
  if (input.anchorNumbers.length > 0) anchors.push(`数字：${input.anchorNumbers.join('、')}`)
  if (anchors.length > 0) {
    sections.push(
      [
        '## 不许动的内容',
        '下面这些是这一章已经定下的事实。加工时原样保留，不要改成简称、代称或别的说法，也不要凭空加入清单以外的人物：',
        ...anchors.map((line) => `- ${line}`),
      ].join('\n'),
    )
  }

  sections.push(
    [
      '## 输出',
      '只输出加工后的正文全文。不要写任何说明、前言、总结或标题，不要用 markdown 代码块把正文包起来。',
      '正文是纯文本，一行一段，段与段之间用换行分隔。',
    ].join('\n'),
  )

  return sections.join('\n\n')
}

const CODE_FENCE = /^```[^\n]*\n([\s\S]*?)\n?```$/

/**
 * 清洗模型产出：剥掉整段包裹的代码围栏、统一换行、去首尾空白。
 *
 * 只做这三件确定性的事——不修剪内容、不改标点。护栏靠的是「原稿 vs 产出」的比对，任何我们
 * 自作主张的加工都会让那个比对失真。
 */
export function sanitizePolishOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const fenced = normalized.match(CODE_FENCE)
  return (fenced ? fenced[1] : normalized).trim()
}
