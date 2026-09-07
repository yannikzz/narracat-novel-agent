/**
 * 输出上限取值规则的测试。风险不在「抬不上去」，而在「抬过头」——发一个超过模型上限的 max_tokens
 * 是硬 400。所以重点钉：白名单外一律 undefined、用户值权威（可高可低）、脏值剥掉回到缺省语义。
 */
import { describe, expect, test } from 'bun:test'
import {
  documentedMaxOutputTokens,
  MAX_OUTPUT_TOKENS_RANGE,
  normalizeMaxOutputTokens,
  PI_UPSTREAM_MAX_OUTPUT_CAP,
  resolveMaxOutputTokens,
  suggestedMaxOutputTokens,
  TARGET_MAX_OUTPUT_TOKENS,
} from './model-output-limits'

describe('suggestedMaxOutputTokens（文档白名单）', () => {
  test('收录的模型取 TARGET 与文档上限的较小值', () => {
    // DeepSeek 文档上限 384K，远高于 TARGET，故取 TARGET。
    expect(suggestedMaxOutputTokens('deepseek', 'deepseek-v4-pro')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(suggestedMaxOutputTokens('anthropic', 'claude-opus-5')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    // Haiku 4.5 文档上限 64K，恰等于 TARGET。
    expect(suggestedMaxOutputTokens('anthropic', 'claude-haiku-4-5')).toBe(64_000)
  })

  test('GLM / Kimi 现已有第一手依据（问题 2 的根因①：此前被封在 32000）', () => {
    expect(suggestedMaxOutputTokens('glm', 'glm-5.2')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(suggestedMaxOutputTokens('glm', 'glm-4.5-air')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(documentedMaxOutputTokens('glm', 'glm-4.5-air')).toBe(96_000)
    expect(suggestedMaxOutputTokens('kimi', 'kimi-k3')).toBe(TARGET_MAX_OUTPUT_TOKENS)
  })

  test('[1m] 长上下文变体归一到基础模型——同一个模型，输出上限相同', () => {
    expect(suggestedMaxOutputTokens('anthropic', 'claude-opus-5[1m]')).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(suggestedMaxOutputTokens('glm', 'glm-5.2[1m]')).toBe(TARGET_MAX_OUTPUT_TOKENS)
  })

  test('未收录的模型一律 undefined——失败方向朝「维持现状」，不是朝「赌一把」', () => {
    // 同一家的其它模型（老 deepseek-chat 输出上限低得多）绝不能被顺带抬上去。
    expect(suggestedMaxOutputTokens('deepseek', 'deepseek-chat')).toBeUndefined()
    expect(suggestedMaxOutputTokens('anthropic', 'claude-sonnet-4-5')).toBeUndefined()
    // 官方没写最大输出的整家不收。
    expect(suggestedMaxOutputTokens('minimax', 'MiniMax-M3')).toBeUndefined()
    expect(suggestedMaxOutputTokens('kimi', 'kimi-k2.6')).toBeUndefined()
  })

  test('键是 provider 限定的：custom 渠道挂同名模型不蹭 deepseek 的依据', () => {
    expect(suggestedMaxOutputTokens('custom', 'deepseek-v4-pro')).toBeUndefined()
  })
})

describe('normalizeMaxOutputTokens（用户输入）', () => {
  test('合法整数原样返回；字符串形式（输入框）同样认', () => {
    expect(normalizeMaxOutputTokens(128_000)).toBe(128_000)
    expect(normalizeMaxOutputTokens(' 128000 ')).toBe(128_000)
  })

  test('空串 / 非数字 / 小数 / 越界 一律 undefined', () => {
    expect(normalizeMaxOutputTokens('')).toBeUndefined()
    expect(normalizeMaxOutputTokens('abc')).toBeUndefined()
    expect(normalizeMaxOutputTokens(64_000.5)).toBeUndefined()
    expect(normalizeMaxOutputTokens(MAX_OUTPUT_TOKENS_RANGE.min - 1)).toBeUndefined()
    expect(normalizeMaxOutputTokens(MAX_OUTPUT_TOKENS_RANGE.max + 1)).toBeUndefined()
    expect(normalizeMaxOutputTokens(null)).toBeUndefined()
    expect(normalizeMaxOutputTokens(undefined)).toBeUndefined()
  })

  test('区间边界含端点', () => {
    expect(normalizeMaxOutputTokens(MAX_OUTPUT_TOKENS_RANGE.min)).toBe(MAX_OUTPUT_TOKENS_RANGE.min)
    expect(normalizeMaxOutputTokens(MAX_OUTPUT_TOKENS_RANGE.max)).toBe(MAX_OUTPUT_TOKENS_RANGE.max)
  })
})

describe('resolveMaxOutputTokens（三层取值）', () => {
  test('用户值优先于建议值，且可以高于 TARGET', () => {
    expect(resolveMaxOutputTokens({ provider: 'deepseek', modelId: 'deepseek-v4-pro', maxOutputTokens: 128_000 })).toBe(
      128_000,
    )
  })

  test('用户值可以低于上游 32000——自定义后端的上限只有用户知道', () => {
    expect(resolveMaxOutputTokens({ provider: 'custom', modelId: 'tiny-model', maxOutputTokens: 8_192 })).toBe(8_192)
    expect(PI_UPSTREAM_MAX_OUTPUT_CAP).toBeGreaterThan(8_192)
  })

  test('无用户值回落建议值；两者都没有 → undefined（不改写请求体）', () => {
    expect(resolveMaxOutputTokens({ provider: 'glm', modelId: 'glm-5' })).toBe(TARGET_MAX_OUTPUT_TOKENS)
    expect(resolveMaxOutputTokens({ provider: 'custom', modelId: 'whatever' })).toBeUndefined()
  })

  test('脏用户值（越界）不算数，回到建议值语义', () => {
    expect(resolveMaxOutputTokens({ provider: 'glm', modelId: 'glm-5', maxOutputTokens: 10 })).toBe(
      TARGET_MAX_OUTPUT_TOKENS,
    )
  })
})
