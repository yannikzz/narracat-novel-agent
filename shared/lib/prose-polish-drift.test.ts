import { describe, expect, test } from 'bun:test'
import {
  describePolishDrift,
  detectPolishDrift,
  extractNumberTokens,
  parseChineseNumeral,
  splitPolishParagraphs,
} from './prose-polish-drift'

const NAMES = ['林跃', '苏晚', '概率统计研究社']

function drift(original: string, polished: string, anchorNames: string[] = NAMES) {
  return detectPolishDrift({ original, polished, anchorNames })
}

describe('parseChineseNumeral', () => {
  test('解析常见写法', () => {
    expect(parseChineseNumeral('三')).toBe(3)
    expect(parseChineseNumeral('十二')).toBe(12)
    expect(parseChineseNumeral('三十五')).toBe(35)
    expect(parseChineseNumeral('一百零八')).toBe(108)
    expect(parseChineseNumeral('两千')).toBe(2000)
    expect(parseChineseNumeral('一万两千')).toBe(12000)
  })

  test('非数字串返回 null', () => {
    expect(parseChineseNumeral('起')).toBeNull()
    expect(parseChineseNumeral('')).toBeNull()
  })
})

describe('extractNumberTokens', () => {
  test('中文与阿拉伯写法归一到同一 token', () => {
    expect(extractNumberTokens('三天后')).toEqual(['3天'])
    expect(extractNumberTokens('3天后')).toEqual(['3天'])
  })

  test('阿拉伯数字不要求单位', () => {
    expect(extractNumberTokens('1998年那场雨')).toEqual(['1998年'])
    expect(extractNumberTokens('编号 4471')).toEqual(['4471'])
  })

  test('不带单位的中文数字不计入——它大量嵌在普通词里', () => {
    expect(extractNumberTokens('他们一起走，万一呢')).toEqual([])
  })

  test('长单位优先：十分钟是事实，十分安静是副词', () => {
    expect(extractNumberTokens('十分钟后')).toEqual(['10分钟'])
    expect(extractNumberTokens('十分安静')).toEqual([])
  })

  test('小数值配虚指量词不计入——润色最爱加的正是这类词', () => {
    expect(extractNumberTokens('一个人，又对折了一次，愣了两下')).toEqual([])
  })

  test('虚指量词过了阈值仍算事实', () => {
    expect(extractNumberTokens('三个人')).toEqual(['3个'])
  })
})

describe('detectPolishDrift', () => {
  test('纯文字润色不算漂移：句子改写、语序调整、人名换成代词', () => {
    const original = ['林跃把便条折了两折。', '「社团还招人吗。」他问。', '苏晚看了他一眼。'].join('\n')
    const polished = [
      '林跃把那张便条对折，又对折了一次。',
      '「社团……还招人吗？」他问，声音比预想的要轻。',
      '苏晚抬眼看他。',
    ].join('\n')

    const result = drift(original, polished)
    expect(result.drifted).toBe(false)
    expect(result.signals).toEqual([])
    expect(describePolishDrift(result)).toBe('事实未变')
  })

  test('已知角色整个消失 → 专名漂移', () => {
    const result = drift('林跃和苏晚站在门口。', '林跃一个人站在门口。')
    expect(result.drifted).toBe(true)
    expect(result.signals).toEqual(['names'])
    expect(result.detail.lostNames).toEqual(['苏晚'])
    expect(describePolishDrift(result)).toContain('少了 苏晚')
  })

  test('凭空多出一个已知角色 → 专名漂移', () => {
    const result = drift('林跃站在门口。', '林跃和苏晚站在门口。')
    expect(result.detail.addedNames).toEqual(['苏晚'])
    expect(result.drifted).toBe(true)
  })

  test('专名被缩写（社团简称）→ 判漂移，正是喂锚清单要压住的那类', () => {
    const result = drift('概率统计研究社的门开着。', '概统社的门开着。')
    expect(result.detail.lostNames).toEqual(['概率统计研究社'])
  })

  test('同一角色出现次数变化不算漂移——把重复人名换成代词是合法润色', () => {
    const original = '林跃站起来。林跃走了两步。林跃停下。'
    const polished = '林跃站起来，走了两步，又停下。'
    expect(drift(original, polished).drifted).toBe(false)
  })

  test('数字被改 → 数字漂移', () => {
    const result = drift('三天后他回来了。', '五天后他回来了。')
    expect(result.signals).toEqual(['numbers'])
    expect(result.detail.lostNumbers).toEqual(['3天'])
    expect(result.detail.addedNumbers).toEqual(['5天'])
  })

  test('中文数字改写成阿拉伯数字不算漂移', () => {
    expect(drift('三天后他回来了。', '3天后他回来了。').drifted).toBe(false)
  })

  test('小幅拆段重组节奏不算漂移', () => {
    const original = Array.from({ length: 20 }, () => '他没有说话，屋里很安静。').join('\n')
    const polished = [...original.split('\n'), '风停了。', '门开着。'].join('\n')
    expect(drift(original, polished, []).drifted).toBe(false)
  })

  test('段落数大幅变化 → 段落漂移', () => {
    const original = Array.from({ length: 20 }, () => '他没有说话，屋里很安静。').join('\n')
    const polished = original.split('\n').slice(0, 10).join('\n')
    const result = drift(original, polished, [])
    expect(result.signals).toEqual(['paragraphs'])
    expect(result.detail.originalParagraphs).toBe(20)
    expect(result.detail.polishedParagraphs).toBe(10)
  })

  test('多个信号同时命中', () => {
    const result = drift('林跃和苏晚约在三天后。', '林跃约在五天后。')
    expect(result.signals).toEqual(['names', 'numbers'])
    expect(result.drifted).toBe(true)
  })

  test('已知盲区：凭空造出的清单外角色抓不到——正则在中文里没有可用的误报边界', () => {
    // 试过用对白署名做开世界补充，两版都在误报（「王五笑道」→「王五笑」、
    // 「此事不难说清」→「事不难」）。误报会让常驻跳过整章正常润色，比漏报贵得多。
    const result = drift('林跃独自站在门口。', '林跃站在门口。「你来了。」王五说。')
    expect(result.detail.addedNames).toEqual([])
  })

  test('普通措辞润色绝不能被判成情节漂移', () => {
    for (const [before, after] of [
      ['他说这件事很难。', '此事不难说清。'],
      ['大家心里有数。', '都知道结果。'],
    ]) {
      expect(drift(before, after, ['林跃']).drifted).toBe(false)
    }
  })

  test('空锚清单时专名信号沉默，不误报', () => {
    expect(drift('林跃走了。', '他走了。', []).signals).toEqual([])
  })
})

describe('splitPolishParagraphs', () => {
  test('去空行与首尾空白', () => {
    expect(splitPolishParagraphs('  第一段。  \n\n第二段。\n\n\n')).toEqual(['第一段。', '第二段。'])
  })
})
