import { describe, expect, test } from 'bun:test'
import {
  buildWorkbenchSectionHref,
  buildWorkbenchObjectHref,
  buildWorkbenchTargetHref,
  readWorkbenchSectionId,
  readWorkbenchTabId,
  readWorkbenchObjectId,
  readWorkbenchChapterView,
  chapterNumberFromObjectId,
  workbenchObjectIdForChapter,
} from './workbench-selection'
import type { NovelProjectDetail } from '@shared/types/novel'

const project: NovelProjectDetail = {
  id: 'stars',
  title: '星辰大海',
  path: '/novels/stars',
  status: 'ready',
  chapterProgress: '1 / 2 章',
  wordCountLabel: '2100 字',
  tocItems: [],
  treeItems: [
    { id: 'master-outline', kind: 'master-outline', title: '全书大纲', level: 0, exists: true },
    { id: 'references', kind: 'reference-list', title: '参考作品', level: 0, exists: false },
    { id: 'volume-outline-1', kind: 'volume-outline', title: '第一卷大纲', level: 1, volumeNumber: 1, exists: true },
    { id: 'chapter-1', kind: 'chapter', title: '第一章', level: 1, chapterNumber: 1, volumeNumber: 1 },
  ],
}

describe('workbench selection helpers', () => {
  test('reads only supported chapter subviews', () => {
    expect(readWorkbenchChapterView(new URLSearchParams({ view: 'review' }))).toBe('review')
    expect(readWorkbenchChapterView(new URLSearchParams({ view: 'future' }))).toBeUndefined()
  })

  test('reads object query before legacy chapter query', () => {
    const params = new URLSearchParams({
      project: '/novels/stars',
      object: 'volume-outline-1',
      chapter: '2',
    })

    expect(readWorkbenchObjectId(params)).toBe('volume-outline-1')
  })

  test('falls back from legacy chapter query to chapter object id', () => {
    const params = new URLSearchParams({
      project: '/novels/stars',
      chapter: '12',
    })

    expect(readWorkbenchObjectId(params)).toBe('chapter-12')
  })

  test('builds hrefs with project and object selection', () => {
    expect(
      buildWorkbenchObjectHref({
        projectPath: '/novels/stars',
        objectId: 'master-outline',
      }),
    ).toBe('/workbench?project=%2Fnovels%2Fstars&object=master-outline')
  })

  test('formats chapter object ids consistently', () => {
    expect(workbenchObjectIdForChapter(7)).toBe('chapter-7')
  })

  test('reads a chapter number back out of an object id, rejecting non-chapter ids', () => {
    expect(chapterNumberFromObjectId(workbenchObjectIdForChapter(7))).toBe(7)
    expect(chapterNumberFromObjectId('chapter-128')).toBe(128)
    expect(chapterNumberFromObjectId('master-outline')).toBeNull()
    expect(chapterNumberFromObjectId('chapter-0')).toBeNull()
    expect(chapterNumberFromObjectId('chapter-')).toBeNull()
    expect(chapterNumberFromObjectId('chapter-2b')).toBeNull()
    expect(chapterNumberFromObjectId('')).toBeNull()
  })

  test('reads section query with blueprint fallback for unknown values', () => {
    expect(readWorkbenchSectionId(new URLSearchParams({ section: 'settings' }))).toBe('settings')
    expect(readWorkbenchSectionId(new URLSearchParams({ section: 'reference-works' }))).toBe('reference-works')
    expect(readWorkbenchSectionId(new URLSearchParams({ section: 'unknown' }))).toBe('blueprint')
    expect(readWorkbenchSectionId(new URLSearchParams())).toBe('blueprint')
  })

  test('reads tab query before legacy object and chapter queries', () => {
    expect(
      readWorkbenchTabId(
        new URLSearchParams({
          tab: 'bible-scenes',
          object: 'master-outline',
          chapter: '2',
        }),
      ),
    ).toBe('bible-scenes')

    expect(readWorkbenchTabId(new URLSearchParams({ object: 'volume-outline-1' }))).toBe('volume-outline-1')
    expect(readWorkbenchTabId(new URLSearchParams({ chapter: '12' }))).toBe('chapter-12')
    expect(readWorkbenchTabId(new URLSearchParams())).toBeNull()
  })

  test('builds hrefs with project and section selection', () => {
    expect(
      buildWorkbenchSectionHref({
        projectPath: '/novels/stars',
        sectionId: 'settings',
      }),
    ).toBe('/workbench?project=%2Fnovels%2Fstars&section=settings')
  })

  test('builds target hrefs for generated section tabs and chapter objects', () => {
    expect(
      buildWorkbenchTargetHref({
        project,
        projectPath: '/novels/stars',
        target: {
          sectionId: 'blueprint',
          tabId: 'master-outline',
          objectId: 'master-outline',
        },
      }),
    ).toBe('/workbench?project=%2Fnovels%2Fstars&section=blueprint&tab=master-outline')

    expect(
      buildWorkbenchTargetHref({
        project,
        projectPath: '/novels/stars',
        target: {
          sectionId: 'reference-works',
          tabId: 'references',
          objectId: 'references',
        },
      }),
    ).toBe('/workbench?project=%2Fnovels%2Fstars&section=reference-works&tab=references')

    expect(
      buildWorkbenchTargetHref({
        project,
        projectPath: '/novels/stars',
        target: {
          sectionId: 'blueprint',
          tabId: 'chapter-1',
          objectId: 'chapter-1',
        },
      }),
    ).toBe('/workbench?project=%2Fnovels%2Fstars&object=chapter-1')
  })
})
