import { describe, expect, test } from 'bun:test'
import { isOpencodeGoEndpoint, NARRACAT_USER_AGENT, providerRequestHeaders } from './provider-request-headers'

describe('isOpencodeGoEndpoint', () => {
  test('opencode.ai 及其子域命中', () => {
    expect(isOpencodeGoEndpoint('https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isOpencodeGoEndpoint('https://api.OpenCode.ai/v1')).toBe(true)
  })

  test('其它渠道、空值、非法地址、仿冒域名都不命中', () => {
    expect(isOpencodeGoEndpoint(undefined)).toBe(false)
    expect(isOpencodeGoEndpoint('')).toBe(false)
    expect(isOpencodeGoEndpoint('not a url')).toBe(false)
    expect(isOpencodeGoEndpoint('https://api.deepseek.com/anthropic')).toBe(false)
    expect(isOpencodeGoEndpoint('https://notopencode.ai/v1')).toBe(false)
    expect(isOpencodeGoEndpoint('https://opencode.ai.example.com/v1')).toBe(false)
  })
})

describe('providerRequestHeaders', () => {
  test('opencode go：带客户端标识与调用方给的会话 id', () => {
    expect(providerRequestHeaders('https://opencode.ai/zen/go/v1', 'conv-1')).toEqual({
      'User-Agent': NARRACAT_USER_AGENT,
      'x-opencode-session': 'conv-1',
    })
  })

  test('一次性请求不给会话 id：每次随机生成，仍然必带', () => {
    const first = providerRequestHeaders('https://opencode.ai/zen/go/v1')?.['x-opencode-session']
    const second = providerRequestHeaders('https://opencode.ai/zen/go/v1')?.['x-opencode-session']
    expect(first).toBeTruthy()
    expect(first).not.toBe(second)
  })

  test('其它渠道不加任何头', () => {
    expect(providerRequestHeaders('https://api.deepseek.com/anthropic', 'conv-1')).toBeUndefined()
    expect(providerRequestHeaders(undefined)).toBeUndefined()
  })
})
