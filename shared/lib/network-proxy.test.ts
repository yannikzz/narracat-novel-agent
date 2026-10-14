import { describe, expect, test } from 'bun:test'
import { checkNetworkProxyUrl, normalizeNetworkProxyUrl } from './network-proxy'

describe('checkNetworkProxyUrl', () => {
  test('留空 = 不使用代理', () => {
    expect(checkNetworkProxyUrl('')).toEqual({ ok: true, url: '' })
    expect(checkNetworkProxyUrl('   ')).toEqual({ ok: true, url: '' })
    expect(checkNetworkProxyUrl(undefined)).toEqual({ ok: true, url: '' })
  })

  test('http / https 代理原样收下，去掉多余斜杠', () => {
    expect(checkNetworkProxyUrl('http://127.0.0.1:7890')).toEqual({ ok: true, url: 'http://127.0.0.1:7890' })
    expect(checkNetworkProxyUrl(' https://proxy.example.com:8443/ ')).toEqual({ ok: true, url: 'https://proxy.example.com:8443' })
  })

  test('只写「主机:端口」按 http:// 补全', () => {
    expect(checkNetworkProxyUrl('127.0.0.1:7890')).toEqual({ ok: true, url: 'http://127.0.0.1:7890' })
  })

  test('SOCKS 给出可操作提示', () => {
    const result = checkNetworkProxyUrl('socks5://127.0.0.1:7891')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain('http://127.0.0.1:7890')
  })

  test('带账号密码、非法协议、乱填都拒收', () => {
    expect(checkNetworkProxyUrl('http://user:pass@127.0.0.1:7890').ok).toBe(false)
    expect(checkNetworkProxyUrl('ftp://127.0.0.1:21').ok).toBe(false)
    expect(checkNetworkProxyUrl('http://').ok).toBe(false)
  })
})

describe('normalizeNetworkProxyUrl', () => {
  test('非法地址按不使用代理落盘', () => {
    expect(normalizeNetworkProxyUrl('socks5://127.0.0.1:7891')).toBe('')
    expect(normalizeNetworkProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
  })
})
