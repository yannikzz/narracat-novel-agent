/**
 * IPC 通道 → 功能模块归属表（ADR-0039）。
 *
 * 埋点不在 130 个业务点各埋各的，而是在 IPC 装配处统一挂钩（见 ipc/telemetry-tap.ts），
 * 由这张表决定"这次调用算哪个模块被用了"。好处是新增功能不必记得埋点，坏处是必须有人
 * 给新通道判归属——所以 ipc-modules.test.ts 会强制每个已注册通道都在表里出现，
 * 漏一个就红。这是刻意的：**判归属是个产品决定，不该被静默跳过**。
 *
 * null 的含义是"显式不计入功能使用度"，不是"还没想好"。三类走 null：
 *   ①读取与轮询（打开页面就会调，计入会把所有模块的使用率抬到 100%，等于没测）；
 *   ②基建（健康探针、门控、通知、窗口、导航状态）；
 *   ③由专用事件承担的（agent:start-run 的写章节走 chapter_write_* 两个事件，更准）。
 */
import type { TelemetryModule } from '@shared/types/telemetry'

export const IPC_CHANNEL_MODULES: Readonly<Record<string, TelemetryModule | null>> = Object.freeze({
  // ── 立项 ────────────────────────────────────────────────────────────
  'novel:create-project': 'premise',
  'novel:submit-premise-edit': 'premise',

  // ── 大纲 ────────────────────────────────────────────────────────────
  'novel:submit-master-outline-edit': 'outline',
  'novel:submit-chapter-outline-edit': 'outline',

  // ── 正文编辑 ────────────────────────────────────────────────────────
  'novel:save-chapter-manuscript': 'manuscript-edit',
  'novel:save-manuscript-draft': 'manuscript-edit',
  'novel:discard-manuscript-draft': 'manuscript-edit',
  'novel:restore-manuscript-revision': 'manuscript-edit',
  'novel:get-manuscript-draft': null,
  'novel:list-manuscript-drafts': null,
  'novel:list-manuscript-revisions': null,
  'novel:read-manuscript-revision': null,

  // ── 角色状态 ────────────────────────────────────────────────────────
  'novel:submit-character-identity': 'character-state',
  'novel:submit-authored-state': 'character-state',
  'novel:update-chapter-state-changes': 'character-state',
  'novel:enrich-character-statuses': 'character-state',
  'novel:resolve-planned-state': 'character-state',
  'novel:read-character-state': null,
  'novel:read-planned-state': null,
  'novel:read-planned-state-counts': null,
  'novel:list-appeared-characters': null,

  // ── 唠个嗑 ──────────────────────────────────────────────────────────
  'character-chat:send': 'character-chat',
  'character-chat:save-profile': 'character-chat',
  'character-chat:cancel': 'character-chat',
  'character-chat:read-profiles': null,
  'character-chat:read-transcript': null,
  // 发完消息后由主进程自动落盘，不是用户动作。
  'character-chat:save-transcript': null,
  'character-chat:flush-profile': null,

  // ── 记忆星图 ────────────────────────────────────────────────────────
  // 虽是读操作，但它只在用户主动打开星图时才会调用，是这个模块唯一的使用信号。
  'novel:read-memory-graph': 'memory-graph',
  'novel:get-pending-memory-sync': null,
  'novel:clear-pending-memory-sync': null,

  // ── 能力包：使用 ────────────────────────────────────────────────────
  'novel-packs:set': 'packs-use',
  'packs:import-preview': 'packs-use',
  'packs:import-confirm': 'packs-use',
  'packs:uninstall': 'packs-use',
  'packs:export': 'packs-use',
  'packs:export-template': 'packs-use',
  'packs:import-cancel': null,
  'packs:list': null,
  'packs:detail': null,
  'packs:local-content': null,
  'novel-packs:get': null,
  'novel-packs:get-receipt': null,
  'novel-packs:get-planning-receipts': null,

  // ── 能力包：造包中心 ────────────────────────────────────────────────
  'packs:draft-create': 'packs-author',
  'packs:draft-update': 'packs-author',
  'packs:draft-delete': 'packs-author',
  'packs:draft-compile': 'packs-author',
  'packs:draft-preview': 'packs-author',
  'packs:draft-publish': 'packs-author',
  'packs:draft-export-project': 'packs-author',
  'packs:draft-import-project': 'packs-author',
  'packs:copy-to-draft': 'packs-author',
  'packs:drafts-list': null,
  'packs:draft-get': null,

  // ── 能力包：从书学写法 ──────────────────────────────────────────────
  'packs:learn-pick-txt': 'packs-learn',
  'packs:learn-estimate': 'packs-learn',
  'packs:learn-start': 'packs-learn',
  'packs:learn-cancel': null,

  // ── 能力包：作家向导 ────────────────────────────────────────────────
  'packs:wizard-start': 'packs-wizard',
  'packs:wizard-send': 'packs-wizard',
  'packs:wizard-cancel': null,
  'packs:wizard-dismiss': null,
  'packs:wizard-snapshot': null,

  // ── 参考书与风格锚 ──────────────────────────────────────────────────
  'dialog:import-reference-sources': 'reference-works',
  'novel:paste-reference-source': 'reference-works',
  'novel:remove-reference-source': 'reference-works',
  'novel:reset-reference-works': 'reference-works',
  'novel:submit-style-anchor': 'reference-works',
  'novel:clear-reference-guidance': 'reference-works',
  'novel:list-style-anchors': null,

  // ── 写作指令编辑（含作者要求） ──────────────────────────────────────
  'prose-blocks:set': 'prose-blocks',
  'prose-blocks:reset': 'prose-blocks',
  'prose-blocks:reset-all': 'prose-blocks',
  'author-requests:add': 'prose-blocks',
  'author-requests:update': 'prose-blocks',
  'author-requests:remove': 'prose-blocks',
  'prose-blocks:list': null,
  'author-requests:list': null,

  // ── 项目备份与恢复 ──────────────────────────────────────────────────
  'novel:create-project-backup': 'project-backup',
  'novel:restore-project-backup': 'project-backup',

  // ── 模型服务配置 ────────────────────────────────────────────────────
  'config:set-primary-model': 'model-config',
  'provider:test-connection': 'model-config',
  'provider:list-models': 'model-config',
  'secret:set-api-key': 'model-config',
  'secret:delete-api-key': 'model-config',
  'secret:has-api-key': null,
  // config:save 承载所有设置页的保存动作，不专属模型；config:get 每次启动即调。
  'config:get': null,
  'config:save': null,

  // ── 软件更新 ────────────────────────────────────────────────────────
  'updater:check': 'updater',
  'updater:install': 'updater',
  'updater:get-state': null,

  // ── Agent 运行：由 chapter_write_* 两个专用事件承担，通道本身不计 ────
  'agent:start-run': null,
  'agent:cancel-run': null,
  'agent:answer-question': null,
  'agent:forget-session': null,
  'agent:start-new-conversation': null,
  'agent:get-thread-snapshot': null,
  'agent:get-events-after': null,
  'agent:list-history-segments': null,

  // ── 基建：探针 / 门控 / 通知 / 导航 / 窗口 / 项目管理读写 ────────────
  ping: null,
  'app:get-process-health': null,
  'release-guard:check': null,
  'narracat:diagnostics': null,
  'corpus:health-probe': null,
  'embedding:health-probe': null,
  'official-skill:read-body': null,
  'window:set-titlebar-overlay-symbol-color': null,
  'dialog:select-directory': null,
  'navigation:read-work-location': null,
  'navigation:write-work-location': null,
  'notifications:list': null,
  'notifications:mark-read': null,
  'notifications:mark-all-read': null,
  'notifications:upsert-result': null,
  'novel:list-projects': null,
  'novel:get-project': null,
  'novel:get-workbench-artifacts': null,
  'novel:get-chapter-artifacts': null,
  'novel:read-status': null,
  'novel:refresh-status': null,
  'novel:remember-project-path': null,
  'novel:update-project-metadata': null,
  'novel:delete-project': null,
  'novel:reveal-folder': null,

  // ── 埋点自身：绝不自我计数（否则"打开设置页"会被记成一次功能使用） ────
  'telemetry:get-state': null,
  'telemetry:set-enabled': null,
  'telemetry:ack-notice': null,
  'telemetry:reset-id': null,
  'telemetry:reveal-queue': null,
})

/**
 * 这次 IPC 调用算哪个模块被用了；null = 不计入（含表里没有的通道——新通道在守卫测试里会红，
 * 运行期则宁可少记一条也不猜归属）。
 */
export function resolveModuleForChannel(channel: string): TelemetryModule | null {
  return IPC_CHANNEL_MODULES[channel] ?? null
}
