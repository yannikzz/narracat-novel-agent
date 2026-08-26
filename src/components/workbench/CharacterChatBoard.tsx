import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, type Transition } from 'framer-motion'
import { Link } from 'react-router'
import { AlertCircle, Brain, Loader2, RotateCcw, Search, SendHorizontal, UserRound, X } from 'lucide-react'

import { BrandIllustration } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  EMPTY_PRIMARY_BODY_CLASS,
  EMPTY_PRIMARY_TITLE_CLASS,
  READING_BODY_FONT_CLASS,
  SIDEBAR_ROW_CLASS,
} from '@/design-system'
import { cn } from '@/lib/cn'
import {
  ensureCharacterChatSubscription,
  useCharacterChatStore,
  type CharacterChatContactsPhase,
  type CharacterChatConversation,
} from '@/lib/character-chat-store'
import { avatarInitial, formatChatTime } from '@/lib/character-chat-avatar'
import { onCharacterChatEvent, readCharacterChatProfiles, saveCharacterChatProfile } from '@/lib/ipc'
import type { CharacterChatMessage, CharacterContact } from '@shared/types/character-chat'

const BOARD_HEADER_CLASS = 'flex shrink-0 items-center gap-2 border-b border-border px-5 py-4'
// 方案 A（上下分区）后聊天卡在 caption 带下方，右缘不再需要 --titlebar-inset-right 让位。
const CHAT_PANEL_HEADER_CLASS = 'min-h-[61px] justify-between bg-workspace pl-[18px] pr-[18px] py-2'
const PROFILE_DRAWER_TRANSITION: Transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
// 右侧滑出抽屉容器（「角色资料」与「关于你」共用，统一宽度/阴影/动画，避免重复造轮子）。
const DRAWER_BACKDROP_CLASS = 'absolute inset-0 z-10 cursor-default bg-transparent'
const DRAWER_ASIDE_CLASS =
  'absolute inset-y-0 right-0 z-20 flex min-h-0 w-[min(480px,calc(100%-24px))] shrink-0 flex-col border-l border-border bg-workspace shadow-[var(--shadow-floating)]'
const DRAWER_ASIDE_MOTION = {
  initial: { x: '100%', opacity: 0.98 },
  animate: { x: 0, opacity: 1 },
  exit: { x: '100%', opacity: 0.98 },
} as const

/**
 * 唠个嗑（Character chat）板块 —— Option A 通讯器：左侧联系人列表 + 右侧一对一聊天区。
 *
 * 本切片（#200）落地：板块外壳、联系人加载与渲染、中性空态、模型服务验证闸门。
 * 消息发送与流式回复由 #201 接入，transcript 持久化由 #202 接入。
 *
 * 容器只接 store + 副作用；纯展示在 CharacterChatBoardView（便于无 store 直测渲染分支）。
 */
const EMPTY_CONVERSATION: CharacterChatConversation = { messages: [], activeRunId: null, lastUserMessage: null }

export function CharacterChatBoard({ projectPath }: { projectPath: string }) {
  const setProjectPath = useCharacterChatStore((state) => state.setProjectPath)
  const loadContacts = useCharacterChatStore((state) => state.loadContacts)
  const refreshModelServiceVerification = useCharacterChatStore((state) => state.refreshModelServiceVerification)
  const contactsPhase = useCharacterChatStore((state) => state.contactsPhase)
  const contacts = useCharacterChatStore((state) => state.contacts)
  const contactsError = useCharacterChatStore((state) => state.contactsError)
  const knowledgeBoundaryChapter = useCharacterChatStore((state) => state.knowledgeBoundaryChapter)
  const activeCharacterUid = useCharacterChatStore((state) => state.activeCharacterUid)
  const selectContact = useCharacterChatStore((state) => state.selectContact)
  const modelServiceVerified = useCharacterChatStore((state) => state.modelServiceVerified)
  const sendMessage = useCharacterChatStore((state) => state.sendMessage)
  const retryLastMessage = useCharacterChatStore((state) => state.retryLastMessage)
  const conversations = useCharacterChatStore((state) => state.conversations)
  const conversation = useCharacterChatStore((state) =>
    activeCharacterUid ? (state.conversations[activeCharacterUid] ?? EMPTY_CONVERSATION) : EMPTY_CONVERSATION,
  )

  useEffect(() => {
    if (!projectPath) return
    setProjectPath(projectPath)
    void loadContacts(projectPath)
    void refreshModelServiceVerification()
  }, [projectPath, setProjectPath, loadContacts, refreshModelServiceVerification])

  // 角色聊天流事件订阅常驻 app 生命周期（模块级 once 守卫），board 卸载时刻意不取消、不 cancel。
  // 切场景（board 卸载）时在途 run 继续跑，delta/completed 仍被 applyStreamEvent 回填：
  // 回复完成后照常入档、清 activeRunId，回板块即见完成的回复（沉浸感），composer 不卡。
  // 显式取消保留在 store.cancelActiveRuns（供未来「取消」按钮），不绑卸载。
  useEffect(() => {
    ensureCharacterChatSubscription(onCharacterChatEvent)
  }, [])

  return (
    <CharacterChatBoardView
      projectPath={projectPath}
      contacts={contacts}
      contactsPhase={contactsPhase}
      contactsError={contactsError}
      knowledgeBoundaryChapter={knowledgeBoundaryChapter}
      activeCharacterUid={activeCharacterUid}
      modelServiceVerified={modelServiceVerified}
      conversation={conversation}
      conversations={conversations}
      onSelectContact={selectContact}
      onRetryContacts={() => void loadContacts(projectPath)}
      onSendMessage={(uid, message) => void sendMessage(uid, message)}
      onRetryMessage={(uid) => void retryLastMessage(uid)}
    />
  )
}

export interface CharacterChatBoardViewProps {
  projectPath?: string
  contacts: CharacterContact[]
  contactsPhase: CharacterChatContactsPhase
  contactsError: string | null
  knowledgeBoundaryChapter: number | null
  activeCharacterUid: string | null
  modelServiceVerified: boolean | null
  conversation: CharacterChatConversation
  conversations: Record<string, CharacterChatConversation>
  onSelectContact: (characterUid: string) => void
  onRetryContacts: () => void
  onSendMessage: (characterUid: string, message: string) => void
  onRetryMessage: (characterUid: string) => void
}

/** 纯展示板块：所有状态经 props 注入，不读 store（便于直测各渲染分支）。 */
export function CharacterChatBoardView({
  projectPath = '',
  contacts,
  contactsPhase,
  contactsError,
  knowledgeBoundaryChapter,
  activeCharacterUid,
  modelServiceVerified,
  conversation,
  conversations,
  onSelectContact,
  onRetryContacts,
  onSendMessage,
  onRetryMessage,
}: CharacterChatBoardViewProps) {
  const activeContact = useMemo(
    () => contacts.find((contact) => contact.characterUid === activeCharacterUid) ?? null,
    [contacts, activeCharacterUid],
  )
  const conversationAreaRef = useRef<{ requestLeave: (proceed: () => void) => void } | null>(null)
  // 切联系人会卸载「关于你」抽屉，先让 ConversationArea 走 dirty 守卫。
  function selectContactGuarded(characterUid: string) {
    const area = conversationAreaRef.current
    if (area) area.requestLeave(() => onSelectContact(characterUid))
    else onSelectContact(characterUid)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas" data-character-chat-board="true">
      <BoardTopbar
        contactsCount={contacts.length}
        contactsPhase={contactsPhase}
        knowledgeBoundaryChapter={knowledgeBoundaryChapter}
        onRefresh={onRetryContacts}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <ContactsColumn
          contacts={contacts}
          phase={contactsPhase}
          error={contactsError}
          activeCharacterUid={activeCharacterUid}
          conversations={conversations}
          onSelect={selectContactGuarded}
          onRetry={onRetryContacts}
        />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-workspace" data-character-chat-conversation="true">
          <ConversationArea
            ref={conversationAreaRef}
            projectPath={projectPath}
            contact={activeContact}
            contactsPhase={contactsPhase}
            knowledgeBoundaryChapter={knowledgeBoundaryChapter}
            modelServiceVerified={modelServiceVerified}
            conversation={conversation}
            onSendMessage={onSendMessage}
            onRetryMessage={onRetryMessage}
          />
        </div>
      </div>
    </div>
  )
}

function BoardTopbar({
  contactsCount,
  contactsPhase,
  knowledgeBoundaryChapter,
  onRefresh,
}: {
  contactsCount: number
  contactsPhase: CharacterChatContactsPhase
  knowledgeBoundaryChapter: number | null
  onRefresh: () => void
}) {
  const loading = contactsPhase === 'loading'
  return (
    <header
      className="flex min-w-0 shrink-0 items-center justify-between gap-4 border-b border-border bg-workspace px-5 py-4"
      data-character-chat-topbar="true"
    >
      <div className="flex min-w-0 items-center gap-3">
        <BrandIllustration
          purpose="agent-ready"
          size="sm"
          decorative
          className="size-11"
          loading="eager"
          data-character-chat-topbar-illustration="true"
        />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">唠个嗑</h2>
            {contactsCount > 0 ? (
              <span
                className="shrink-0 rounded-full bg-active px-1.5 py-0.5 text-[11px] font-medium leading-none text-muted-foreground"
                data-character-chat-contact-count={contactsCount}
              >
                {contactsCount} 位可聊
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">角色联系人 · 只读已完成剧情</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground"
          data-character-chat-boundary-pill="true"
        >
          {knowledgeBoundaryChapter !== null ? `最新完成：第 ${knowledgeBoundaryChapter} 章` : '尚无完成章节'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={onRefresh}
          data-character-chat-refresh="true"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          刷新角色状态
        </Button>
      </div>
    </header>
  )
}

function ContactsColumn({
  contacts,
  phase,
  error,
  activeCharacterUid,
  conversations,
  onSelect,
  onRetry,
}: {
  contacts: CharacterContact[]
  phase: CharacterChatContactsPhase
  error: string | null
  activeCharacterUid: string | null
  conversations: Record<string, CharacterChatConversation>
  onSelect: (characterUid: string) => void
  onRetry: () => void
}) {
  const [query, setQuery] = useState('')
  const trimmedQuery = query.trim()
  const visibleContacts = useMemo(() => {
    const filtered = trimmedQuery
      ? contacts.filter((contact) => contact.name.toLowerCase().includes(trimmedQuery.toLowerCase()))
      : contacts
    // 按最近一条消息时间倒序：最近聊过的在最上；没聊过的（time=0）沉底，并保持原顺序（稳定排序）。
    return [...filtered].sort(
      (a, b) =>
        lastMessageTimeMs(conversations[b.characterUid]) - lastMessageTimeMs(conversations[a.characterUid]),
    )
  }, [contacts, conversations, trimmedQuery])

  return (
    <aside
      className="flex h-full min-h-0 w-[clamp(220px,26vw,300px)] shrink-0 flex-col border-r border-border bg-workspace"
      data-character-chat-contacts="true"
    >
      <div className="shrink-0 px-4 py-3" data-character-chat-contacts-filter="true">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-hint-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="搜索角色"
            placeholder="搜索角色"
            className="h-9 w-full rounded-row border border-border bg-workspace pl-8 pr-3 text-sm text-foreground outline-none placeholder:text-hint-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            data-character-chat-search="true"
          />
        </label>
      </div>

      {phase === 'loading' ? (
        <div className="flex flex-1 items-center justify-center" data-character-chat-contacts-loading="true">
          <Loader2 className="size-4 animate-spin text-hint-foreground" />
        </div>
      ) : phase === 'failed' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <AlertCircle className="size-5 text-hint-foreground" />
          <div className="text-xs leading-snug text-muted-foreground">{error ?? '联系人读取失败'}</div>
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            重试
          </Button>
        </div>
      ) : contacts.length === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
          data-character-chat-contacts-empty="true"
        >
          <div className="text-sm font-medium text-foreground">还没有出场角色</div>
          <div className="text-xs leading-snug text-muted-foreground">
            角色在已完成章节出场后，
            <br />
            会自动出现在这里。
          </div>
        </div>
      ) : visibleContacts.length === 0 ? (
        <div
          className="flex flex-1 flex-col items-center justify-center gap-1 px-4 text-center"
          data-character-chat-contacts-no-results="true"
        >
          <div className="text-sm font-medium text-foreground">没有匹配角色</div>
          <div className="text-xs leading-snug text-muted-foreground">换个名字试试。</div>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <nav aria-label="角色联系人" className="space-y-1.5 p-2">
            {visibleContacts.map((contact) => {
              const active = contact.characterUid === activeCharacterUid
              const preview = contactReplyPreview(conversations[contact.characterUid])
              return (
                <button
                  key={contact.characterUid}
                  type="button"
                  data-character-chat-contact={contact.characterUid}
                  data-active={active}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSelect(contact.characterUid)}
                  className={cn(
                    SIDEBAR_ROW_CLASS,
                    'min-h-[70px] items-center justify-start gap-3 rounded-row border px-3 py-2.5',
                    active
                      ? 'border-border bg-workspace font-semibold text-foreground shadow-[0_8px_20px_rgba(24,24,27,0.06)] hover:bg-workspace'
                      : 'border-transparent text-muted-foreground hover:bg-hover hover:text-foreground',
                  )}
                >
                  <ContactAvatar name={contact.name} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm">{contact.name}</span>
                      <span
                        className="shrink-0 text-[11px] font-normal text-muted-foreground"
                        data-character-chat-contact-reply-time={contact.characterUid}
                      >
                        {preview.timeLabel}
                      </span>
                    </span>
                    <span
                      className="mt-0.5 block truncate text-xs font-normal text-muted-foreground"
                      data-character-chat-contact-preview={contact.characterUid}
                    >
                      {preview.text}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>
        </ScrollArea>
      )}
    </aside>
  )
}

function ContactAvatar({ name }: { name: string }) {
  const initial = [...name][0] ?? '角'
  return (
    <span
      aria-hidden="true"
      className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border bg-brand/10 text-sm font-medium text-brand"
      data-character-chat-avatar="true"
    >
      {initial}
    </span>
  )
}

function displayCharacterStatus(contact: CharacterContact, knowledgeBoundaryChapter: number | null): string {
  const status = contact.currentStatus?.trim()
  if (status) return status
  return contactStoryStatus(contact, knowledgeBoundaryChapter)
}

function contactStoryStatus(contact: CharacterContact, knowledgeBoundaryChapter: number | null): string {
  if (knowledgeBoundaryChapter !== null && contact.lastSeenChapter === knowledgeBoundaryChapter) {
    return '刚到最新完成章'
  }
  if (contact.firstAppearedChapter === contact.lastSeenChapter) {
    return `第 ${contact.firstAppearedChapter} 章出场`
  }
  return `最近第 ${contact.lastSeenChapter} 章`
}

/** 会话最近一条消息的时间戳（ms）；无消息或时间非法返回 0，用于联系人列表倒序排序（0 沉底）。 */
function lastMessageTimeMs(conversation: CharacterChatConversation | undefined): number {
  const messages = conversation?.messages
  if (!messages || messages.length === 0) return 0
  const ts = Date.parse(messages[messages.length - 1].createdAt)
  return Number.isFinite(ts) ? ts : 0
}

function contactReplyPreview(conversation: CharacterChatConversation | undefined): { text: string; timeLabel: string } {
  const messages = conversation?.messages ?? []
  // 在途回复且本回合尚无角色气泡上屏 → 微信式「正在回复...」（角色气泡只有 complete/failed，无 streaming 占位）
  if (conversation?.activeRunId != null && messages[messages.length - 1]?.role !== 'character') {
    return { text: '正在回复...', timeLabel: '' }
  }
  const reply = [...messages].reverse().find((message) => message.role === 'character' && message.text.trim())
  if (!reply) return { text: '还没有聊天记录', timeLabel: '未聊' }

  const text = compactContactPreviewText(reply.text || (reply.status === 'failed' ? '回复失败' : ''))
  return { text, timeLabel: formatContactReplyTime(reply.createdAt) }
}

function compactContactPreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim() || '回复内容为空'
}

function formatContactReplyTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

const ConversationArea = forwardRef<
  { requestLeave: (proceed: () => void) => void },
  {
    projectPath: string
    contact: CharacterContact | null
    contactsPhase: CharacterChatContactsPhase
    knowledgeBoundaryChapter: number | null
    modelServiceVerified: boolean | null
    conversation: CharacterChatConversation
    onSendMessage: (characterUid: string, message: string) => void
    onRetryMessage: (characterUid: string) => void
  }
>(function ConversationArea(
  {
    projectPath,
    contact,
    contactsPhase,
    knowledgeBoundaryChapter,
    modelServiceVerified,
    conversation,
    onSendMessage,
    onRetryMessage,
  },
  ref,
) {
  // Hook 必须在任何早 return 之前声明，否则 modelServiceVerified 由 null/true 切到 false
  // 时同实例 Hook 数量变化，React 抛 "Rendered fewer hooks"（#200 模型服务闸门切换场景）。
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [aboutYouOpen, setAboutYouOpen] = useState(false)
  const [aboutYouConfirm, setAboutYouConfirm] = useState(false)
  const aboutYouRef = useRef<{ isDirty: () => boolean; save: () => Promise<void> } | null>(null)
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)

  // 离开「关于你」前统一守卫：有未保存改动则弹二次确认、确认后执行 proceed；否则直接 proceed。
  function guardAboutYou(proceed: () => void) {
    if (aboutYouOpen && aboutYouRef.current?.isDirty()) {
      setPendingLeave(() => proceed)
      setAboutYouConfirm(true)
    } else {
      proceed()
    }
  }

  // 暴露给父组件：切联系人等外部离开路径也走同一 dirty 守卫。
  useImperativeHandle(ref, () => ({ requestLeave: guardAboutYou }), [aboutYouOpen])

  if (modelServiceVerified === false) {
    return <ModelServiceGate />
  }

  if (!contact) {
    return (
      <div
        className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        data-character-chat-no-contact="true"
      >
        <BrandIllustration purpose="agent-ready" size="md" decorative />
        <div className={EMPTY_PRIMARY_TITLE_CLASS}>{contactsPhase === 'loaded' ? '选择一个角色开始唠嗑' : '唠个嗑'}</div>
        <div className={cn(EMPTY_PRIMARY_BODY_CLASS, 'max-w-sm')}>
          和已出场的角色一对一聊天。角色只知道截至最新完成章节的剧情，聊天不写入正史。
        </div>
      </div>
    )
  }

  const streaming = conversation.activeRunId !== null
  const isEmpty = conversation.messages.length === 0

  function toggleProfileDrawer() {
    // 切到「角色资料」会卸载「关于你」抽屉，先走 dirty 守卫。
    if (aboutYouOpen) {
      guardAboutYou(() => {
        setAboutYouOpen(false)
        setDrawerOpen(true)
      })
      return
    }
    setDrawerOpen((open) => !open)
  }

  function closeProfileDrawer() {
    setDrawerOpen(false)
  }

  function toggleAboutYou() {
    // 再点「关于你」会关闭抽屉，走 dirty 守卫。
    if (aboutYouOpen) {
      guardAboutYou(closeAboutYou)
      return
    }
    setAboutYouOpen(true)
    setDrawerOpen(false)
  }

  function closeAboutYou() {
    setAboutYouOpen(false)
  }

  // 关闭「关于你」（标题栏 X / 点遮罩）：统一走 dirty 守卫。
  function attemptCloseAboutYou() {
    guardAboutYou(closeAboutYou)
  }

  return (
    <div
      className="relative isolate flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden"
      data-character-chat-thread-shell="true"
    >
      <div
        className="pointer-events-none absolute bottom-20 right-8 z-0 hidden opacity-[0.14] lg:block"
        data-character-chat-atmosphere="true"
      >
        <BrandIllustration purpose="agent-ready" size="xl" decorative />
      </div>

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={cn(BOARD_HEADER_CLASS, CHAT_PANEL_HEADER_CLASS)}
          data-character-chat-active-contact={contact.characterUid}
        >
          {/* title 不再放头像：消息流已带头像，避免头像过多。title 保留角色名 + 状态。 */}
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <div className="truncate text-base font-semibold text-foreground">{contact.name}</div>
              <div className="flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
                <StatusDot />
                <span className="truncate" data-character-chat-current-status={contact.characterUid}>
                  {displayCharacterStatus(contact, knowledgeBoundaryChapter)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <IconTooltip label={drawerOpen ? '收起角色资料' : '角色资料'}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="角色资料"
                aria-pressed={drawerOpen}
                data-character-chat-profile-toggle={drawerOpen ? 'open' : 'closed'}
                onClick={toggleProfileDrawer}
              >
                <UserRound className="size-4" />
              </Button>
            </IconTooltip>
            <IconTooltip label={aboutYouOpen ? '收起关于你' : '关于你'}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="关于你"
                aria-pressed={aboutYouOpen}
                data-character-chat-about-you-toggle={aboutYouOpen ? 'open' : 'closed'}
                onClick={toggleAboutYou}
              >
                <Brain className="size-4" />
              </Button>
            </IconTooltip>
          </div>
        </div>

        {isEmpty ? (
          <OpeningState
            contactName={contact.name}
            onPick={(message) => onSendMessage(contact.characterUid, message)}
          />
        ) : (
          <MessageList
            contactName={contact.name}
            characterUid={contact.characterUid}
            messages={conversation.messages}
            typing={streaming}
            onRetry={() => onRetryMessage(contact.characterUid)}
          />
        )}

        <Composer
          contactName={contact.name}
          disabled={streaming}
          onSubmit={(message) => onSendMessage(contact.characterUid, message)}
        />
      </div>

      <AnimatePresence initial={false}>
        {drawerOpen ? (
          <motion.button
            key="character-chat-profile-backdrop"
            type="button"
            aria-label="关闭角色资料"
            className={DRAWER_BACKDROP_CLASS}
            data-character-chat-profile-backdrop="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={PROFILE_DRAWER_TRANSITION}
            onClick={closeProfileDrawer}
          />
        ) : null}
        {drawerOpen ? (
          <ProfileDrawer
            key={`character-chat-profile-drawer-${contact.characterUid}`}
            contact={contact}
            knowledgeBoundaryChapter={knowledgeBoundaryChapter}
            onClose={closeProfileDrawer}
          />
        ) : null}
        {aboutYouOpen ? (
          <motion.button
            key="character-chat-about-you-backdrop"
            type="button"
            aria-label="关闭关于你"
            className={DRAWER_BACKDROP_CLASS}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={PROFILE_DRAWER_TRANSITION}
            onClick={attemptCloseAboutYou}
          />
        ) : null}
        {aboutYouOpen ? (
          <AboutYouDrawer
            ref={aboutYouRef}
            key={`character-chat-about-you-${contact.characterUid}`}
            projectPath={projectPath}
            contact={contact}
            onClose={attemptCloseAboutYou}
          />
        ) : null}
      </AnimatePresence>
      <Dialog
        open={aboutYouConfirm}
        onOpenChange={(open) => {
          setAboutYouConfirm(open)
          if (!open) setPendingLeave(null)
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm" data-character-chat-about-you-confirm="true">
          <DialogHeader>
            <DialogTitle>改动还没保存</DialogTitle>
            <DialogDescription>「关于你」里的修改要点「保存」才会生效，直接退出会丢失。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                const proceed = pendingLeave
                setAboutYouConfirm(false)
                setPendingLeave(null)
                proceed?.()
              }}
            >
              直接退出
            </Button>
            <Button
              type="button"
              onClick={() => {
                void aboutYouRef.current?.save().then(() => {
                  const proceed = pendingLeave
                  setAboutYouConfirm(false)
                  setPendingLeave(null)
                  proceed?.()
                })
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})

function StatusDot() {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full bg-brand shadow-[0_0_0_4px_var(--brand-soft)]"
    />
  )
}

/** 2-3 个轻量开场话题 chip：点选即发普通聊天消息，不是 Agent action，也不写正史。 */
function openingChips(contactName: string): string[] {
  return [`${contactName}，最近过得怎么样？`, '聊聊你现在最在意的事吧', '说说你身边的人']
}

function OpeningState({
  contactName,
  onPick,
}: {
  contactName: string
  onPick: (message: string) => void
}) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-4 bg-workspace p-6 text-center"
      data-character-chat-opening="true"
    >
      <div className={cn(EMPTY_PRIMARY_BODY_CLASS, 'max-w-sm')}>发消息开始和「{contactName}」唠嗑。</div>
      <div className="flex flex-wrap items-center justify-center gap-2" data-character-chat-opening-chips="true">
        {openingChips(contactName).map((chip) => (
          <Button
            key={chip}
            type="button"
            size="xs"
            variant="outline"
            data-character-chat-opening-chip="true"
            onClick={() => onPick(chip)}
          >
            {chip}
          </Button>
        ))}
      </div>
    </div>
  )
}

// 抽屉标题栏（角色资料 / 关于你 共用：同底色/字号/字重/关闭按钮；profileTitlebar 仅角色资料带测试锚点）。
function DrawerTitleBar({
  title,
  onClose,
  profileTitlebar,
}: {
  title: string
  onClose: () => void
  profileTitlebar?: boolean
}) {
  return (
    <div
      className={cn(BOARD_HEADER_CLASS, CHAT_PANEL_HEADER_CLASS)}
      data-character-chat-profile-titlebar={profileTitlebar ? 'true' : undefined}
    >
      <span className="text-sm font-medium text-foreground">{title}</span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label={`关闭${title}`} onClick={onClose}>
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

function ProfileDrawer({
  contact,
  knowledgeBoundaryChapter,
  onClose,
}: {
  contact: CharacterContact
  knowledgeBoundaryChapter: number | null
  onClose: () => void
}) {
  // 入戏向社交资料卡：拉取角色档案「基本信息」（年龄/性别/外貌/职业/当前处境…）+ 别名 + 当前动态 + 出场，
  // 隐藏欲望·核心矛盾·弧线方向等上帝视角创作笔记（带剧透、破坏代入）。完整设定在【设定】栏可看。
  const aliases = (contact.aliases ?? []).filter((alias) => alias && alias !== contact.name)
  const basicInfo = contact.basicInfo ?? []
  const status = displayCharacterStatus(contact, knowledgeBoundaryChapter)
  const appearance =
    contact.firstAppearedChapter === contact.lastSeenChapter
      ? `第 ${contact.firstAppearedChapter} 章登场`
      : `第 ${contact.firstAppearedChapter}–${contact.lastSeenChapter} 章`

  return (
    <motion.aside
      className={DRAWER_ASIDE_CLASS}
      data-character-chat-profile-drawer="true"
      {...DRAWER_ASIDE_MOTION}
      transition={PROFILE_DRAWER_TRANSITION}
    >
      <DrawerTitleBar title="角色资料" onClose={onClose} profileTitlebar />
      <ScrollArea className="min-h-0 flex-1 bg-workspace">
        <div className="space-y-4 bg-workspace px-5 py-6">
          <section
            className="flex flex-col items-center text-center"
            data-character-chat-profile-card="identity"
          >
            <ProfileAvatar name={contact.name} />
            <div className="mt-4 text-lg font-semibold leading-tight text-foreground">{contact.name}</div>
            {aliases.length > 0 ? (
              <div className="mt-1 text-xs text-muted-foreground" data-character-chat-profile-aliases="true">
                又名 {aliases.join(' · ')}
              </div>
            ) : null}
          </section>

          {basicInfo.length > 0 ? (
            <section
              className="space-y-3 rounded-panel border border-border bg-surface px-4 py-4"
              data-character-chat-profile-card="basic-info"
            >
              {basicInfo.map((field) => (
                <div key={field.label} data-character-chat-profile-field={field.label}>
                  <div className="text-xs text-muted-foreground">{field.label}</div>
                  <div className="mt-0.5 text-sm leading-relaxed text-foreground">{field.value}</div>
                </div>
              ))}
            </section>
          ) : null}

          <section
            className="space-y-3.5 rounded-panel border border-border bg-surface px-4 py-4"
            data-character-chat-profile-card="appearances"
          >
            <div data-character-chat-profile-row="当前动态">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">当前动态</span>
                <StatusDot />
              </div>
              <div className="mt-1.5 text-sm leading-snug text-foreground" data-character-chat-profile-status="true">
                {status}
              </div>
            </div>
            <div className="border-t border-border" />
            <div data-character-chat-profile-row="出场">
              <div className="text-xs text-muted-foreground">出场</div>
              <div className="mt-1 text-sm leading-snug text-foreground" data-character-chat-profile-appearance="true">
                {appearance}
              </div>
            </div>
          </section>

          <div className="rounded-row border border-border bg-workspace px-3 py-2 text-xs leading-snug text-muted-foreground">
            角色只知道截至最新完成章节的剧情，聊天内容不写入正史与小说记忆。
          </div>
        </div>
      </ScrollArea>
    </motion.aside>
  )
}

function ProfileAvatar({ name }: { name: string }) {
  const initial = [...name][0] ?? '角'
  return (
    <span
      aria-hidden="true"
      className="mx-auto flex size-20 items-center justify-center rounded-full border border-brand-border bg-gradient-to-br from-brand/20 to-brand/5 text-2xl font-semibold text-brand"
      data-character-chat-profile-avatar="true"
    >
      {initial}
    </span>
  )
}

const AboutYouDrawer = forwardRef<
  { isDirty: () => boolean; save: () => Promise<void> },
  { projectPath: string; contact: CharacterContact; onClose: () => void }
>(function AboutYouDrawer({ projectPath, contact, onClose }, ref) {
  const [impression, setImpression] = useState('')
  const [authorProfile, setAuthorProfile] = useState('')
  // 已落盘基准：判断是否有未保存改动（dirty）。
  const [savedImpression, setSavedImpression] = useState('')
  const [savedAuthor, setSavedAuthor] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    void readCharacterChatProfiles({ projectPath, characterUid: contact.characterUid })
      .then((p) => {
        if (!alive) return
        setImpression(p.impression)
        setAuthorProfile(p.authorProfile)
        setSavedImpression(p.impression)
        setSavedAuthor(p.authorProfile)
        setLoaded(true)
      })
      .catch(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [projectPath, contact.characterUid])

  const dirty = impression !== savedImpression || authorProfile !== savedAuthor

  // 显式保存：编辑/清空只改本地状态，点「保存」才落盘（画像写入是点击保存才生效）。
  function save() {
    return Promise.all([
      saveCharacterChatProfile({ scope: 'impression', content: impression, projectPath, characterUid: contact.characterUid }),
      saveCharacterChatProfile({ scope: 'author', content: authorProfile, projectPath, characterUid: contact.characterUid }),
    ]).then(() => {
      setSavedImpression(impression)
      setSavedAuthor(authorProfile)
      setSaved(true)
    })
  }

  // 暴露给上层：关闭前查未保存 + 保存（未保存二次确认弹窗用）。
  useImperativeHandle(
    ref,
    () => ({ isDirty: () => dirty, save: () => save().then(() => undefined) }),
    [dirty, impression, authorProfile],
  )

  function handleSave() {
    void save()
  }

  return (
    <motion.aside
      className={DRAWER_ASIDE_CLASS}
      data-character-chat-about-you-drawer="true"
      {...DRAWER_ASIDE_MOTION}
      transition={PROFILE_DRAWER_TRANSITION}
    >
      <DrawerTitleBar title="关于你" onClose={onClose} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-5">
          <section className="flex flex-col gap-2">
            <div className="text-sm font-medium text-foreground">{contact.name}眼里的你</div>
            {loaded && !impression.trim() ? (
              <div className="text-xs text-muted-foreground">还没攒下印象，多聊几句 ta 就懂你了。</div>
            ) : null}
            <textarea
              className="min-h-[120px] w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
              value={impression}
              onChange={(e) => {
                setImpression(e.target.value)
                setSaved(false)
              }}
              aria-label="角色对你的印象"
            />
            <button
              type="button"
              className="self-end text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setImpression('')
                setSaved(false)
              }}
            >
              清空
            </button>
          </section>
          <section className="flex flex-col gap-2 border-t border-border pt-5">
            <div className="text-sm font-medium text-foreground">所有角色都知道的你</div>
            {loaded && !authorProfile.trim() ? (
              <div className="text-xs text-muted-foreground">填写后，所有角色聊天时都能感知到。</div>
            ) : null}
            <textarea
              className="min-h-[120px] w-full resize-y rounded-md border border-border bg-background p-2 text-sm"
              value={authorProfile}
              onChange={(e) => {
                setAuthorProfile(e.target.value)
                setSaved(false)
              }}
              aria-label="全局作者画像"
            />
            <button
              type="button"
              className="self-end text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setAuthorProfile('')
                setSaved(false)
              }}
            >
              清空
            </button>
          </section>
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border px-5 py-3">
        {saved ? (
          <span className="text-xs text-muted-foreground" data-character-chat-about-you-saved="true">
            已保存
          </span>
        ) : null}
        <Button type="button" size="sm" onClick={handleSave} disabled={!loaded}>
          保存
        </Button>
      </div>
    </motion.aside>
  )
})

function MessageList({
  contactName,
  characterUid,
  messages,
  typing,
  onRetry,
}: {
  contactName: string
  characterUid: string
  messages: CharacterChatMessage[]
  typing: boolean
  onRetry: () => void
}) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, typing])

  if (messages.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-6 text-center"
        data-character-chat-conversation-empty="true"
      >
        <div className={cn(EMPTY_PRIMARY_BODY_CLASS, 'max-w-sm')}>发消息开始和「{contactName}」唠嗑。</div>
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1" data-character-chat-messages={characterUid}>
      <div className="flex flex-col gap-4 px-6 py-6">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            contactName={contactName}
            characterUid={characterUid}
            message={message}
            onRetry={onRetry}
          />
        ))}
        {typing ? <TypingBubble contactName={contactName} characterUid={characterUid} /> : null}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}

function MessageBubble({
  contactName,
  characterUid,
  message,
  onRetry,
}: {
  contactName: string
  characterUid: string
  message: CharacterChatMessage
  onRetry: () => void
}) {
  const isUser = message.role === 'user'
  const time = formatChatTime(message.createdAt)

  if (message.role === 'character' && message.status === 'failed') {
    return (
      <div
        className="flex w-full items-start gap-2.5"
        data-character-chat-message="character"
        data-character-chat-message-status="failed"
      >
        <ChatAvatar seed={characterUid} name={contactName} />
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <ChatMessageMeta name={contactName} time={time} />
          <div className="flex items-center gap-2 rounded-row border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>{message.text || '发送失败'}</span>
          </div>
          <Button type="button" size="xs" variant="ghost" onClick={onRetry} data-character-chat-retry="true">
            <RotateCcw className="size-3" />
            重试
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn('flex w-full items-start gap-2.5', isUser ? 'justify-end' : 'justify-start')}
      data-character-chat-message={message.role}
      data-character-chat-message-status={message.status}
    >
      {!isUser ? <ChatAvatar seed={characterUid} name={contactName} /> : null}
      <div className={cn('flex max-w-[84%] flex-col gap-1.5 sm:max-w-[620px]', isUser ? 'items-end' : 'items-start')}>
        <ChatMessageMeta name={isUser ? '我' : contactName} time={time} align={isUser ? 'end' : 'start'} />
        <div
          className={cn(
            `whitespace-pre-wrap break-words rounded-panel px-3.5 py-2.5 ${READING_BODY_FONT_CLASS} leading-6`,
            isUser
              ? 'bg-foreground text-background'
              : 'border border-border bg-workspace text-foreground',
          )}
        >
          {message.text}
        </div>
      </div>
    </div>
  )
}

/** 消息行头像（size-9 = 36px，走刻度规范）：与联系人列表 / 角色资料卡**同一个来源**——名字首字 + 品牌底色圆形。 */
function ChatAvatar({ seed, name }: { seed: string; name: string }) {
  return (
    <span
      aria-hidden="true"
      className="-mt-1 flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-brand/10 text-xs font-medium text-brand"
      data-character-chat-message-avatar={seed}
    >
      {avatarInitial(name)}
    </span>
  )
}

/** 名字 + 右侧发送时间（24h HH:mm）。用户行右对齐保持气泡一致。 */
function ChatMessageMeta({ name, time, align = 'start' }: { name: string; time: string; align?: 'start' | 'end' }) {
  return (
    <div
      className={cn('flex items-center gap-2 px-1 text-xs text-muted-foreground', align === 'end' ? 'flex-row-reverse' : '')}
    >
      <span className="truncate font-medium text-foreground/80">{name}</span>
      {time ? (
        <span className="shrink-0 tabular-nums text-hint-foreground" data-character-chat-message-time="true">
          {time}
        </span>
      ) : null}
    </div>
  )
}

/** 微信式「对方正在输入」独立气泡：在途回复期间显示在消息流末尾。 */
function TypingBubble({ contactName, characterUid }: { contactName: string; characterUid: string }) {
  return (
    <div className="flex w-full items-start justify-start gap-2.5" data-character-chat-typing-bubble="true">
      <ChatAvatar seed={characterUid} name={contactName} />
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <ChatMessageMeta name={contactName} time="" />
        <div className="rounded-panel border border-border bg-workspace px-3.5 py-2.5">
          <span className="inline-flex items-center gap-1" role="status" aria-label="正在输入">
            <Loader2 className="size-3 animate-spin text-hint-foreground" />
          </span>
        </div>
      </div>
    </div>
  )
}

function Composer({
  contactName,
  disabled,
  onSubmit,
}: {
  contactName: string
  disabled: boolean
  onSubmit: (message: string) => void
}) {
  const [value, setValue] = useState('')

  function submit() {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
    setValue('')
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    submit()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing 守卫（T6 评审 Minor-3 顺手修）：中文输入法组合期按 Enter 是确认候选词，不是发送。
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return (
    <form
      className="relative z-10 mx-5 mb-5 mt-2 flex shrink-0 items-center gap-2 rounded-panel border border-border bg-workspace p-2 shadow-[0_8px_20px_rgba(24,24,27,0.04)]"
      data-character-chat-composer="true"
      onSubmit={handleSubmit}
    >
      <textarea
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`和「${contactName}」说点什么…`}
        aria-label={`和${contactName}聊天`}
        className="max-h-32 min-h-8 flex-1 resize-none border-0 bg-transparent px-2 py-1 text-sm leading-6 text-foreground outline-none placeholder:text-hint-foreground focus-visible:ring-0"
      />
      <Button
        type="submit"
        size="icon-sm"
        className="self-center"
        disabled={disabled || value.trim().length === 0}
        aria-label="发送"
        data-character-chat-send="true"
      >
        <SendHorizontal className="size-4" />
      </Button>
    </form>
  )
}

function ModelServiceGate() {
  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
      data-character-chat-model-service-gate="true"
    >
      <BrandIllustration purpose="model-service-needed" size="md" decorative />
      <div className={EMPTY_PRIMARY_TITLE_CLASS}>模型服务尚未验证</div>
      <div className={cn(EMPTY_PRIMARY_BODY_CLASS, 'max-w-sm')}>
        角色聊天需要可用的模型服务。请先在设置中完成「测试连接」。
      </div>
      <Button asChild size="sm" data-character-chat-settings-link="true">
        <Link to="/settings?section=model" state={{ from: '/workbench' }}>打开模型服务</Link>
      </Button>
    </div>
  )
}
