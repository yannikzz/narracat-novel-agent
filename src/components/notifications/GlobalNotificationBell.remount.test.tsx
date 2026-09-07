// 通知铃铛在 React StrictMode（dev 双挂载）下的真实 DOM 回归：首载必须在第二次挂载后完成，
// 不能因为「只首载一次」的 ref 守卫 + 卸载时的序号 +1 而永远转圈、列表永远空。
//
// happy-dom 全局注册必须先于 @testing-library/react 的加载；查询一律用 container，不用 screen。
// 组件经 @/lib/ipc 直接调 window.electron.*，这里给 window.electron 装假实现即可，不碰 mock.module。
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

const { afterAll, afterEach, describe, expect, test } = await import('bun:test')
const { StrictMode } = await import('react')
const { act, cleanup, render, waitFor } = await import('@testing-library/react')
const { MemoryRouter } = await import('react-router')
const { GlobalNotificationBell } = await import('./GlobalNotificationBell')
type ResultNotificationList = import('@shared/types/notifications').ResultNotificationList

const list: ResultNotificationList = {
  notifications: [
    {
      id: 'notification-run-1',
      runId: 'run-1',
      threadId: 'thread-1',
      status: 'success',
      title: '第 1 章正文已生成',
      summary: 'Agent 已完成章节正文生成。',
      projectName: '长夜星河',
      projectPath: '/novels/stars',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z',
    },
  ],
  unreadCount: 1,
}

let listCalls = 0
;(window as unknown as { electron: Record<string, unknown> }).electron = {
  listResultNotifications: async () => {
    listCalls += 1
    // 让首载跨过 StrictMode 的卸载→再挂载：请求在第一次挂载发出、第二次挂载后才回来
    await new Promise((resolve) => setTimeout(resolve, 20))
    return list
  },
  onResultNotificationsChanged: () => () => {},
}

afterEach(() => {
  cleanup()
})

afterAll(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await GlobalRegistrator.unregister()
})

describe('GlobalNotificationBell（StrictMode 双挂载）', () => {
  test('首载在第二次挂载后完成：铃铛不再转圈，未读红点出现', async () => {
    try {
      window.localStorage.clear()
    } catch {
      // 无 localStorage 也不影响本用例
    }
    const view = render(
      <StrictMode>
        <MemoryRouter>
          <GlobalNotificationBell />
        </MemoryRouter>
      </StrictMode>,
    )
    const bell = () => view.container.querySelector('[data-global-notification-bell="true"]')
    expect(bell()).not.toBeNull()
    await waitFor(() => {
      expect(bell()?.querySelector('.animate-spin')).toBeNull()
    })
    // 每次挂载各发一次首载（StrictMode 下 2 次）；陈旧那次被序号丢掉，不会把 loading 卡住
    expect(listCalls).toBeGreaterThanOrEqual(1)
    expect(bell()?.querySelector('.bg-destructive')).not.toBeNull()
  })
})
