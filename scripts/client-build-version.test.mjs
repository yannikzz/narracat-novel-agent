import { describe, expect, test } from 'bun:test'

import {
  CLIENT_BUILD_VERSION_PREFIX,
  formatClientBuildVersion,
  CLIENT_VERSION_OVERRIDE_ENV,
  readGitCommitCount,
  resolveClientBuildVersion,
  resolveOverridableClientVersion,
} from './client-build-version.mjs'

describe('client build version', () => {
  test('formats the release commit count as the user-facing client version', () => {
    expect(CLIENT_BUILD_VERSION_PREFIX).toBe('0.1')
    expect(formatClientBuildVersion(253)).toBe('0.1.253')
  })

  test('rejects invalid commit counts', () => {
    expect(() => formatClientBuildVersion(-1)).toThrow('commit count')
    expect(() => formatClientBuildVersion(1.5)).toThrow('commit count')
  })

  test('resolves the version through an injectable commit-count reader', () => {
    expect(resolveClientBuildVersion({ readCommitCount: () => 42 })).toBe('0.1.42')
  })

  test('falls back to the macOS git path when PATH lookup is unavailable', () => {
    const commands = []
    const count = readGitCommitCount('/repo', {
      execFile: (command) => {
        commands.push(command)
        if (command === 'git') throw Object.assign(new Error('missing git'), { code: 'ENOENT' })
        return '7\n'
      },
    })

    expect(count).toBe(7)
    expect(commands).toEqual(['git', '/usr/bin/git'])
  })
})

describe('resolveOverridableClientVersion — 打包链版本号 SSOT', () => {
  const stubCount = () => 64

  test('未设覆盖时与 resolveClientBuildVersion 同值', () => {
    expect(resolveOverridableClientVersion({ env: {}, readCommitCount: stubCount })).toBe(
      resolveClientBuildVersion({ readCommitCount: stubCount }),
    )
  })

  test('设了就用它——测试包要能压过线上版本，否则会被 electron-updater 静默换掉', () => {
    expect(
      resolveOverridableClientVersion({
        env: { [CLIENT_VERSION_OVERRIDE_ENV]: '0.1.9999' },
        readCommitCount: stubCount,
      }),
    ).toBe('0.1.9999')
  })

  test('空白值视同未设', () => {
    expect(
      resolveOverridableClientVersion({
        env: { [CLIENT_VERSION_OVERRIDE_ENV]: '  ' },
        readCommitCount: stubCount,
      }),
    ).toBe('0.1.64')
  })

  test('非法值 fail-loud，不静默打出坏版本号', () => {
    for (const bad of ['abc', '0.1', '0.1.2.3', 'v0.1.2']) {
      expect(() =>
        resolveOverridableClientVersion({
          env: { [CLIENT_VERSION_OVERRIDE_ENV]: bad },
          readCommitCount: stubCount,
        }),
      ).toThrow(new RegExp(CLIENT_VERSION_OVERRIDE_ENV))
    }
  })

  test('正式发布链路不吃这个环境变量：release.mjs 只引用无覆盖的那支', async () => {
    const { readFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'release.mjs'), 'utf8')
    expect(src).not.toContain(CLIENT_VERSION_OVERRIDE_ENV)
    expect(src).not.toContain('resolveOverridableClientVersion')
  })
})
