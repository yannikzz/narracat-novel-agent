import { describe, expect, test } from 'bun:test'
import {
  ANCHOR_NAME_LIMIT,
  buildPolishSystemPrompt,
  sanitizePolishOutput,
  selectAnchorNames,
  selectAnchorNumbers,
} from './polish-prompt.ts'

describe('selectAnchorNames', () => {
  const roster = ['林跃', '苏晚', '陈教授', '概率统计研究社']

  test('只挑本章真的出现过的——把全书角色名单倒给模型等于给它一份可用人物表', () => {
    expect(selectAnchorNames('林跃走进概率统计研究社。', roster)).toEqual(['概率统计研究社', '林跃'])
  })

  test('长的排前面，便于模型先匹配长专名', () => {
    const names = selectAnchorNames('概率统计研究社的林跃', ['林跃', '概率统计研究社'])
    expect(names[0]).toBe('概率统计研究社')
  })

  test('去重去空白', () => {
    expect(selectAnchorNames('林跃在。', ['林跃', ' 林跃 ', '', '  '])).toEqual(['林跃'])
  })

  test('超上限截断', () => {
    const many = Array.from({ length: ANCHOR_NAME_LIMIT + 10 }, (_, index) => `角色${index}`)
    expect(selectAnchorNames(many.join('、'), many)).toHaveLength(ANCHOR_NAME_LIMIT)
  })
})

describe('selectAnchorNumbers', () => {
  test('给模型看正文里的原始写法，不给归一化写法', () => {
    // surface 原样保留正文写法（含数字与量词之间的空格），归一化写法只用于判漂移
    expect(selectAnchorNumbers('三天后，他交了 200 块。')).toEqual(['200 块', '三天'])
  })

  test('虚指量词不进锚清单', () => {
    expect(selectAnchorNumbers('他一个人愣了一下。')).toEqual([])
  })
})

describe('buildPolishSystemPrompt', () => {
  test('作者原话原样进入，不加工', () => {
    const prompt = buildPolishSystemPrompt({
      authorPrompt: '别用比喻，句子长一点',
      anchorNames: [],
      anchorNumbers: [],
    })
    expect(prompt).toContain('别用比喻，句子长一点')
  })

  test('锚清单进「不许动的内容」', () => {
    const prompt = buildPolishSystemPrompt({
      authorPrompt: 'x',
      anchorNames: ['林跃'],
      anchorNumbers: ['三天'],
    })
    expect(prompt).toContain('不许动的内容')
    expect(prompt).toContain('人名与专名：林跃')
    expect(prompt).toContain('数字：三天')
  })

  test('无锚时不出现空的「不许动」段', () => {
    const prompt = buildPolishSystemPrompt({ authorPrompt: 'x', anchorNames: [], anchorNumbers: [] })
    expect(prompt).not.toContain('不许动的内容')
  })

  test('责任边界：一个字的写法指令都不许混进去', () => {
    const prompt = buildPolishSystemPrompt({
      authorPrompt: '作者说了算',
      anchorNames: ['林跃'],
      anchorNumbers: ['三天'],
    })
    for (const forbidden of ['短句', '长句', '节奏', '文风', '网文', '比喻', '画面感', '代入感']) {
      expect(prompt).not.toContain(forbidden)
    }
  })
})

describe('sanitizePolishOutput', () => {
  test('剥掉整段包裹的代码围栏', () => {
    expect(sanitizePolishOutput('```\n正文第一段。\n正文第二段。\n```')).toBe('正文第一段。\n正文第二段。')
  })

  test('带语言标记的围栏同样剥掉', () => {
    expect(sanitizePolishOutput('```markdown\n正文。\n```')).toBe('正文。')
  })

  test('正文中间的围栏不动——只剥整段包裹的那一层', () => {
    const text = '第一段。\n```\n第二段。\n```\n第三段。'
    expect(sanitizePolishOutput(text)).toBe(text)
  })

  test('统一换行并去首尾空白', () => {
    expect(sanitizePolishOutput('\r\n  第一段。\r\n第二段。\r\n\r\n')).toBe('第一段。\n第二段。')
  })

  test('不改标点、不动内容', () => {
    const text = '「站住。」他说……'
    expect(sanitizePolishOutput(text)).toBe(text)
  })
})
