import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import { CharacterChatBoardView, type CharacterChatBoardViewProps } from './CharacterChatBoard'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CharacterContact } from '@shared/types/character-chat'

function contact(uid: string, name: string, first = 1, last = 1, currentStatus?: string): CharacterContact {
  return {
    characterUid: uid,
    name,
    firstAppearedChapter: first,
    lastSeenChapter: last,
    currentStatus,
    settingPath: `bible/characters/${name}.md`,
  }
}

function render(overrides: Partial<CharacterChatBoardViewProps>): string {
  const props: CharacterChatBoardViewProps = {
    contacts: [],
    contactsPhase: 'loaded',
    contactsError: null,
    knowledgeBoundaryChapter: null,
    activeCharacterUid: null,
    modelServiceVerified: true,
    conversation: { messages: [], activeRunId: null, lastUserMessage: null },
    conversations: {},
    onSelectContact: () => {},
    onRetryContacts: () => {},
    onSendMessage: () => {},
    onRetryMessage: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>
        <CharacterChatBoardView {...props} />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

function dataClass(html: string, dataAttribute: string): string {
  return html.match(new RegExp(`<[^>]+class="([^"]+)"[^>]+${dataAttribute}`))?.[1] ?? ''
}

function source(): string {
  return readFileSync(fileURLToPath(new URL('./CharacterChatBoard.tsx', import.meta.url)), 'utf-8')
}

describe('CharacterChatBoardView', () => {
  test('渲染出场角色联系人，以 character_uid 为身份', () => {
    const html = render({
      contacts: [
        contact('uid-a', '林衍', 1, 3, '刚赢下一场硬战，右臂伤势未愈'),
        contact('uid-b', '苏暮', 3, 3, '刚救回伤员，精神紧绷'),
      ],
      knowledgeBoundaryChapter: 3,
      activeCharacterUid: 'uid-a',
    })

    expect(html).toContain('data-character-chat-board="true"')
    expect(html).toContain('data-character-chat-topbar="true"')
    expect(html).toContain('最新完成：第 3 章')
    expect(html).toContain('data-character-chat-contact-count="2"')
    expect(html).toContain('2 位可聊')
    expect(html).toContain('data-character-chat-search="true"')
    expect(html).toContain('data-character-chat-contact="uid-a"')
    expect(html).toContain('data-character-chat-contact="uid-b"')
    expect(html).toContain('林衍')
    expect(html).toContain('苏暮')
    expect(html).toContain('刚赢下一场硬战，右臂伤势未愈')
    expect(html).toContain('data-character-chat-current-status="uid-a"')
    expect(html).not.toContain('已装载角色设定，对话时补查 NovelMemory')
    expect(html).toContain('data-character-chat-atmosphere="true"')
    expect(html).toContain('data-brand-illustration="agent-ready"')
    expect(html).toContain('data-character-chat-topbar-illustration="true"')
    expect(dataClass(html, 'data-character-chat-topbar-illustration="true"')).toContain('size-11')
    expect(dataClass(html, 'data-character-chat-topbar-illustration="true"')).not.toContain('bg-brand/10')
    expect(dataClass(html, 'data-character-chat-topbar-illustration="true"')).not.toContain('rounded-row')
    expect(dataClass(html, 'data-character-chat-thread-shell="true"')).toContain('w-full')
    expect(dataClass(html, 'data-character-chat-thread-shell="true"')).toContain('flex-1')
  })

  test('唠嗑 titlebar 与联系人列表使用纯白工作区底色，联系人栏只保留搜索框', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 1, 3)],
      knowledgeBoundaryChapter: 3,
      activeCharacterUid: 'uid-a',
    })

    expect(dataClass(html, 'data-character-chat-topbar="true"')).toContain('bg-workspace')
    expect(dataClass(html, 'data-character-chat-contacts="true"')).toContain('bg-workspace')
    expect(dataClass(html, 'data-character-chat-contacts="true"')).toContain('w-[clamp(220px,26vw,300px)]')
    expect(dataClass(html, 'data-character-chat-contacts-filter="true"')).not.toContain('border-b')
    expect(html).not.toContain('data-lucide="users"')
    expect(html).not.toContain('<span class="text-sm font-medium text-foreground">角色联系人</span>')
  })

  test('联系人列表用最近角色回复摘要和同一行右侧时间', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 1, 3, '刚赢下一场硬战')],
      knowledgeBoundaryChapter: 3,
      activeCharacterUid: 'uid-a',
      conversations: {
        'uid-a': {
          activeRunId: null,
          lastUserMessage: '你还好吗',
          messages: [
            { id: 'm1', role: 'user', text: '你还好吗', status: 'complete', createdAt: 'bad-date' },
            {
              id: 'm2',
              role: 'character',
              text: '老大，我活着回来了，刚干赢了一场硬战。',
              status: 'complete',
              createdAt: 'bad-date',
            },
          ],
        },
      },
    })

    expect(html).toContain('data-character-chat-contact-preview="uid-a"')
    expect(html).toContain('老大，我活着回来了，刚干赢了一场硬战。')
    expect(html).toContain('data-character-chat-contact-reply-time="uid-a"')
    expect(html).toContain('时间未知')
  })

  test('在途回复且尚无角色气泡时，联系人列表预览显示「正在回复...」', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 1, 3)],
      activeCharacterUid: 'uid-a',
      conversations: {
        'uid-a': {
          activeRunId: 'run-1',
          lastUserMessage: '在吗',
          messages: [{ id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: 't' }],
        },
      },
    })

    expect(html).toContain('正在回复...')
  })

  test('联系人列表按最近一条消息时间倒序：最近的在最上，没聊过的沉底', () => {
    const html = render({
      contacts: [contact('uid-a', '甲'), contact('uid-b', '乙'), contact('uid-c', '丙')],
      activeCharacterUid: 'uid-a',
      conversations: {
        'uid-a': {
          activeRunId: null,
          lastUserMessage: null,
          messages: [
            { id: 'a1', role: 'character', text: '早些时候', status: 'complete', createdAt: '2026-06-24T10:00:00.000Z' },
          ],
        },
        'uid-b': {
          activeRunId: null,
          lastUserMessage: null,
          messages: [
            { id: 'b1', role: 'character', text: '刚刚', status: 'complete', createdAt: '2026-06-24T12:00:00.000Z' },
          ],
        },
        // uid-c 没有任何对话 → 沉底
      },
    })

    const posB = html.indexOf('data-character-chat-contact="uid-b"')
    const posA = html.indexOf('data-character-chat-contact="uid-a"')
    const posC = html.indexOf('data-character-chat-contact="uid-c"')
    expect(posB).toBeGreaterThanOrEqual(0)
    expect(posB).toBeLessThan(posA) // 乙(12:00) 比 甲(10:00) 新 → 在更上面
    expect(posA).toBeLessThan(posC) // 没聊过的 丙 沉到最底
  })

  test('头像使用圆形，资料标题栏与信息流标题栏高度一致', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 1, 3)],
      activeCharacterUid: 'uid-a',
    })
    const component = source()

    expect(dataClass(html, 'data-character-chat-avatar="true"')).toContain('rounded-full')
    expect(component).toContain("const CHAT_PANEL_HEADER_CLASS = 'min-h-[61px] justify-between bg-workspace pl-[18px] pr-[18px] py-2'")
    expect(component).toContain('data-character-chat-profile-titlebar')
    expect(component).toContain('data-character-chat-profile-avatar="true"')
    expect(component).toContain('rounded-full border border-brand-border')
  })

  test('唠嗑局部不使用无效 rounded-card，搜索框使用项目圆角 token', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 1, 3)],
      activeCharacterUid: 'uid-a',
    })

    expect(html).not.toContain('rounded-card')
    expect(dataClass(html, 'data-character-chat-search="true"')).toContain('rounded-row')
  })

  test('无联系人时显示中性空态，不渲染灰态未出场角色', () => {
    const html = render({ contacts: [], activeCharacterUid: null })
    expect(html).toContain('data-character-chat-contacts-empty="true"')
    expect(html).toContain('还没有出场角色')
    expect(html).toContain('角色在已完成章节出场后，<br/>会自动出现在这里。')
    expect(html).not.toContain('data-character-chat-contact="')
  })

  test('未选择角色时使用品牌插图作为右侧空态视觉', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      contactsPhase: 'loaded',
      activeCharacterUid: null,
    })

    expect(html).toContain('data-character-chat-no-contact="true"')
    expect(html).toContain('选择一个角色开始唠嗑')
    expect(html).toContain('data-brand-illustration="agent-ready"')
    expect(html).not.toContain('data-lucide="messages-square"')
    expect(dataClass(html, 'data-character-chat-no-contact="true"')).toContain('w-full')
    expect(dataClass(html, 'data-character-chat-no-contact="true"')).toContain('flex-1')
  })

  test('模型服务未验证时显示闸门并链接到设置', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      modelServiceVerified: false,
    })
    expect(html).toContain('data-character-chat-model-service-gate="true"')
    expect(html).toContain('模型服务尚未验证')
    expect(html).toContain('/settings?section=model')
    expect(dataClass(html, 'data-character-chat-model-service-gate="true"')).toContain('w-full')
    expect(dataClass(html, 'data-character-chat-model-service-gate="true"')).toContain('flex-1')
  })

  // 回归：闸门早 return 必须在 ConversationArea 的 drawer useState 之后才生效（Hook 声明在前）。
  // 同一会话从 verified→unverified 切换时若 Hook 在早 return 之后声明，React 抛
  // "Rendered fewer hooks" 白屏；这里以「选中联系人 + 未验证」分支渲染不抛错来护住声明顺序。
  test('已选中联系人但模型服务未验证：渲染闸门且不抛错（Hook 声明在早 return 之前）', () => {
    expect(() =>
      render({
        contacts: [contact('uid-a', '林衍')],
        activeCharacterUid: 'uid-a',
        modelServiceVerified: false,
        conversation: {
          activeRunId: null,
          lastUserMessage: '在吗',
          messages: [{ id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: 't' }],
        },
      }),
    ).not.toThrow()
  })

  test('联系人加载失败时显示重试', () => {
    const html = render({ contactsPhase: 'failed', contactsError: 'reader 崩了' })
    expect(html).toContain('reader 崩了')
    expect(html).toContain('重试')
  })

  test('渲染用户与角色消息气泡及「正在输入」气泡，含发送框', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      conversation: {
        activeRunId: 'run-1',
        lastUserMessage: '在吗',
        messages: [
          { id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: 't' },
          { id: 'm2', role: 'character', text: '在的', status: 'complete', createdAt: 't' },
        ],
      },
    })

    expect(html).toContain('data-character-chat-message="user"')
    expect(html).toContain('data-character-chat-message="character"')
    expect(html).toContain('在吗')
    expect(html).toContain('在的')
    // 在途回复期间显示微信式独立「正在输入」气泡
    expect(html).toContain('data-character-chat-typing-bubble="true"')
    // 流式期间发送按钮禁用
    expect(html).toContain('data-character-chat-composer="true"')
    expect(dataClass(html, 'data-character-chat-composer="true"')).toContain('items-center')
    expect(dataClass(html, 'data-character-chat-send="true"')).toContain('self-center')
  })

  test('消息流：角色消息带头像（uid 哈希底色）与发送时间，用户消息也带时间', () => {
    const local = new Date(2026, 5, 15, 9, 5, 0).toISOString()
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      conversation: {
        activeRunId: null,
        lastUserMessage: '在吗',
        messages: [
          { id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: local },
          { id: 'm2', role: 'character', text: '在的', status: 'complete', createdAt: local },
        ],
      },
    })

    // 角色消息行有头像（以 uid 为 seed），首字「林」，与列表 / 资料卡**同款品牌绿底色**（不再哈希配色）。
    expect(html).toContain('data-character-chat-message-avatar="uid-a"')
    expect(dataClass(html, 'data-character-chat-message-avatar="uid-a"')).toContain('rounded-full')
    expect(dataClass(html, 'data-character-chat-message-avatar="uid-a"')).toContain('bg-brand/10')
    // 名字右侧显示 24h HH:mm；两条消息（用户 + 角色）都带时间。
    expect(html).toContain('data-character-chat-message-time="true"')
    expect(html).toContain('09:05')
    expect((html.match(/data-character-chat-message-time="true"/g) ?? []).length).toBe(2)
  })

  test('消息流：createdAt 无法解析时不渲染时间占位', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      conversation: {
        activeRunId: null,
        lastUserMessage: '在吗',
        messages: [{ id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: 'bad-date' }],
      },
    })

    expect(html).not.toContain('data-character-chat-message-time="true"')
  })

  test('消息框 title 不再渲染头像（消息流已带头像，避免头像过多）', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      conversation: {
        activeRunId: null,
        lastUserMessage: null,
        messages: [{ id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: 't' }],
      },
    })

    // title 容器存在，但内部不再放 ContactAvatar（brand 底色头像）。
    expect(html).toContain('data-character-chat-active-contact="uid-a"')
    const titlebar = html.match(
      /data-character-chat-active-contact="uid-a"[\s\S]*?data-character-chat-profile-toggle/,
    )?.[0]
    expect(titlebar).toBeTruthy()
    expect(titlebar).not.toContain('data-character-chat-avatar="true"')
  })

  test('角色回复失败时在聊天流内显示错误并提供重试', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      conversation: {
        activeRunId: null,
        lastUserMessage: '在吗',
        messages: [
          { id: 'm1', role: 'user', text: '在吗', status: 'complete', createdAt: 't' },
          { id: 'm2', role: 'character', text: '网络错误', status: 'failed', createdAt: 't' },
        ],
      },
    })

    expect(html).toContain('data-character-chat-message-status="failed"')
    expect(html).toContain('网络错误')
    expect(html).toContain('data-character-chat-retry="true"')
  })

  test('空会话时显示轻量开场话题 chip', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍')],
      activeCharacterUid: 'uid-a',
      conversation: { messages: [], activeRunId: null, lastUserMessage: null },
    })
    expect(html).toContain('data-character-chat-opening-chips="true"')
    expect(html).toContain('data-character-chat-opening-chip="true"')
    expect(html).toContain('最近过得怎么样')
  })

  test('提供角色资料抽屉切换入口（默认不占聊天布局）', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 2, 9)],
      activeCharacterUid: 'uid-a',
      knowledgeBoundaryChapter: 9,
    })
    // 默认抽屉关闭，仅有切换入口
    expect(html).toContain('data-character-chat-profile-toggle="closed"')
    expect(html).not.toContain('data-character-chat-profile-drawer="true"')
  })

  test('角色资料抽屉有右侧滑入滑出动效，Profile 卡片不展示设定文件路径', () => {
    const component = source()

    expect(component).toContain("from 'framer-motion'")
    expect(component).toContain('<AnimatePresence initial={false}>')
    expect(component).toContain('data-character-chat-profile-backdrop="true"')
    expect(component).toContain('<motion.aside')
    expect(component).toContain('PROFILE_DRAWER_TRANSITION')
    // 抽屉容器动画提取为共用常量 DRAWER_ASIDE_MOTION（角色资料 / 关于你 复用，不重复造轮子）
    expect(component).toContain('{...DRAWER_ASIDE_MOTION}')
    expect(component).toContain("initial: { x: '100%', opacity: 0.98 }")
    expect(component).toContain('animate: { x: 0, opacity: 1 }')
    expect(component).toContain("exit: { x: '100%', opacity: 0.98 }")
    // 「关于你」抽屉与「角色资料」复用同一容器常量（宽度/阴影/动画一致），两处各引用一次
    expect(component.split('className={DRAWER_ASIDE_CLASS}').length - 1).toBe(2)
    expect(component.split('{...DRAWER_ASIDE_MOTION}').length - 1).toBe(2)
    // 两个抽屉标题栏也复用同一组件 DrawerTitleBar（同字号/字重/关闭按钮）
    expect(component.split('<DrawerTitleBar').length - 1).toBe(2)
    expect(component).not.toContain('PROFILE_DRAWER_ANIMATION_MS')
    expect(component).not.toContain('window.setTimeout(() => setDrawerMounted(false)')
    expect(component).not.toContain('window.requestAnimationFrame')
    expect(component).not.toContain('window.cancelAnimationFrame')
    expect(component).not.toContain('data-[state=open]:animate-in')
    expect(component).not.toContain('data-[state=open]:slide-in-from-right')
    expect(component).not.toContain('data-[state=closed]:animate-out')
    expect(component).not.toContain('data-[state=closed]:slide-out-to-right')
    expect(component).toContain('data-character-chat-profile-card="identity"')
    expect(component).toContain('data-character-chat-profile-card="appearances"')
    // 社交资料卡：别名 / 基本信息字段 / 当前动态 / 出场（入戏向基本信息）
    expect(component).toContain('data-character-chat-profile-aliases="true"')
    expect(component).toContain('data-character-chat-profile-card="basic-info"')
    expect(component).toContain('data-character-chat-profile-field=')
    expect(component).toContain('data-character-chat-profile-status="true"')
    expect(component).toContain('data-character-chat-profile-appearance="true"')
    // 已下线的「知道到第 N 章」chip 与冗余 basic 卡 / 上帝视角文案
    expect(component).not.toContain('data-character-chat-profile-card="basic"')
    expect(component).not.toContain('知道到 ')
    expect(component).not.toContain('已出场角色 · 可唠嗑')
    expect(component).not.toContain('基础信息')
    expect(component).toContain('w-[min(480px,calc(100%-24px))]')
    expect(component).not.toContain('w-[min(320px,calc(100%-24px))]')
    expect(component).toContain('border-l border-border bg-workspace shadow-[var(--shadow-floating)]')
    expect(component).not.toContain('border-l border-border bg-canvas shadow-[var(--shadow-floating)]')
    expect(component).not.toContain('label="设定档案"')
    expect(component).not.toContain('value={contact.settingPath}')
  })

  test('聊天头部有「关于你」入口，默认关闭', () => {
    const html = render({
      contacts: [contact('uid-a', '林衍', 1, 3)],
      activeCharacterUid: 'uid-a',
    })
    // 默认「关于你」抽屉关闭，仅有切换入口
    expect(html).toContain('data-character-chat-about-you-toggle="closed"')
    expect(html).not.toContain('data-character-chat-about-you-drawer="true"')
  })

  test('「关于你」与「角色资料」互斥：各自 toggle 时关闭另一方（源码约束）', () => {
    const component = source()
    // toggleAboutYou 必须调用 setDrawerOpen(false)
    expect(component).toContain('function toggleAboutYou')
    expect(component).toContain('setDrawerOpen(false)')
    // toggleProfileDrawer 必须调用 setAboutYouOpen(false)
    expect(component).toContain('setAboutYouOpen(false)')
    // AboutYouDrawer 组件存在且有 data 属性
    expect(component).toContain('data-character-chat-about-you-drawer="true"')
  })

  test('「关于你」画像点「保存」才落盘（显式保存，无 onBlur 隐式写）', () => {
    const component = source()
    expect(component).toContain('function handleSave')
    expect(component).not.toContain('onBlur={saveImpression}')
    expect(component).not.toContain('onBlur={saveAuthor}')
  })

  test('「关于你」未保存确认覆盖所有离开路径：X/遮罩/再点/切角色资料/切联系人（源码约束）', () => {
    const component = source()
    // 统一守卫 + 二次确认弹窗
    expect(component).toContain('function guardAboutYou')
    expect(component).toContain('aboutYouRef.current?.isDirty()')
    expect(component).toContain('data-character-chat-about-you-confirm="true"')
    // X/遮罩、再点「关于你」都经 attemptCloseAboutYou → guardAboutYou(closeAboutYou)
    expect(component).toContain('function attemptCloseAboutYou')
    expect(component).toContain('guardAboutYou(closeAboutYou)')
    // 父组件切联系人也走守卫：ConversationArea 暴露 requestLeave，selectContactGuarded 调用
    expect(component).toContain('requestLeave')
    expect(component).toContain('function selectContactGuarded')
  })

  // 回归：容器 CharacterChatBoard 必须把 projectPath 透传给 CharacterChatBoardView，
  // 否则 AboutYouDrawer 拿到空 path，readCharacterChatProfiles / saveCharacterChatProfile 写错位置。
  test('容器 CharacterChatBoard 渲染 CharacterChatBoardView 时透传 projectPath（源码约束）', () => {
    const component = source()
    // 容器调用处必须含 projectPath={projectPath}
    expect(component).toContain('projectPath={projectPath}')
    // AboutYouDrawer 消费 projectPath 的两处调用必须存在
    expect(component).toContain('readCharacterChatProfiles({ projectPath, characterUid')
    expect(component).toContain('saveCharacterChatProfile({ scope:')
  })
})
