import { describe, expect, test } from 'bun:test'

import { readAutomationLevel, readUpdateNovelProjectMetadataInput } from './novel-metadata-input.ts'

describe('readUpdateNovelProjectMetadataInput', () => {
  test('放行 automationLevel：书架切档只有走通这条通道才落得进 config.yaml（#27）', () => {
    expect(readUpdateNovelProjectMetadataInput({ projectPath: '/novels/stars', automationLevel: 'auto' })).toEqual({
      projectPath: '/novels/stars',
      automationLevel: 'auto',
    })
    expect(
      readUpdateNovelProjectMetadataInput({ projectPath: '/novels/stars', automationLevel: 'collaborative' }),
    ).toEqual({ projectPath: '/novels/stars', automationLevel: 'collaborative' })
  })

  test('只带 automationLevel 也算「有可更新的信息」，不该被空写检查挡掉', () => {
    expect(() =>
      readUpdateNovelProjectMetadataInput({ projectPath: '/novels/stars', automationLevel: 'auto' }),
    ).not.toThrow()
    expect(() => readUpdateNovelProjectMetadataInput({ projectPath: '/novels/stars' })).toThrow(
      '没有可更新的小说信息。',
    )
  })

  test('三个字段可以同时改，projectPath 缺了就拒绝', () => {
    expect(
      readUpdateNovelProjectMetadataInput({
        projectPath: '/novels/stars',
        title: '星辰大海',
        coverPreset: 'cover-08',
        automationLevel: 'collaborative',
      }),
    ).toEqual({
      projectPath: '/novels/stars',
      title: '星辰大海',
      coverPreset: 'cover-08',
      automationLevel: 'collaborative',
    })
    expect(() => readUpdateNovelProjectMetadataInput({ automationLevel: 'auto' })).toThrow('缺少项目路径。')
  })

  test('白名单外的 key 一律丢弃，不原样透传给落盘', () => {
    expect(
      readUpdateNovelProjectMetadataInput({
        projectPath: '/novels/stars',
        automationLevel: 'auto',
        novel_id: 'forged',
        language: 'en-US',
      }),
    ).toEqual({ projectPath: '/novels/stars', automationLevel: 'auto' })
  })

  test('非法的自动化档拒绝落盘：引擎只认 auto / collaborative 两个死值', () => {
    for (const bad of ['Auto', 'AUTO', '', 'semi', 0, null, {}]) {
      expect(() => readUpdateNovelProjectMetadataInput({ projectPath: '/novels/stars', automationLevel: bad })).toThrow(
        '自动化级别非法。',
      )
    }
  })

  test('入参不是对象直接拒绝', () => {
    expect(() => readUpdateNovelProjectMetadataInput(null)).toThrow('小说信息参数非法。')
    expect(() => readUpdateNovelProjectMetadataInput(['/novels/stars'])).toThrow('小说信息参数非法。')
  })
})

describe('readAutomationLevel', () => {
  test('新建小说走同一把尺子', () => {
    expect(readAutomationLevel('auto')).toBe('auto')
    expect(readAutomationLevel('collaborative')).toBe('collaborative')
    expect(() => readAutomationLevel(undefined)).toThrow('自动化级别非法。')
  })
})
