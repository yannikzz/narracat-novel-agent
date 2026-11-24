import { describe, expect, test } from 'bun:test'
import { CURRENT_PRO_NOTICE_VERSION, PRO_SITE_URL, proDownloadUrl } from './pro-edition'
import { proNoticeNeeded } from './use-pro-notice'

describe('proDownloadUrl', () => {
  test('按平台给专业版安装包直链，并带上入口来源', () => {
    expect(proDownloadUrl('darwin', 'oss-notice')).toBe(
      'https://pro-update.narracat.com/mac-arm64/latest.dmg?src=oss-notice',
    )
    expect(proDownloadUrl('win32', 'oss-titlebar')).toBe(
      'https://pro-update.narracat.com/win-x64/latest.exe?src=oss-titlebar',
    )
  })

  test('专业版没出包的平台和拿不到平台时给官网', () => {
    expect(proDownloadUrl('linux', 'oss-settings')).toBe(`${PRO_SITE_URL}?src=oss-settings`)
    expect(proDownloadUrl(undefined, 'oss-settings')).toBe(`${PRO_SITE_URL}?src=oss-settings`)
  })
})

describe('proNoticeNeeded', () => {
  test('没看过（缺省或 0）就弹，看过当前版本就不弹', () => {
    expect(proNoticeNeeded(undefined)).toBe(true)
    expect(proNoticeNeeded(0)).toBe(true)
    expect(proNoticeNeeded(CURRENT_PRO_NOTICE_VERSION)).toBe(false)
  })
})
