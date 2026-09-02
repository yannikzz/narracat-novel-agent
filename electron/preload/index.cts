const { contextBridge, ipcRenderer } = require('electron')

const api = {
  platform: process.platform,
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  revealProjectFolder: (projectPath: string) => ipcRenderer.invoke('novel:reveal-folder', projectPath),
  setTitleBarOverlaySymbolColor: (symbolColor: string) =>
    ipcRenderer.invoke('window:set-titlebar-overlay-symbol-color', symbolColor),
  getProcessHealth: () => ipcRenderer.invoke('app:get-process-health'),
  checkReleaseGuard: () => ipcRenderer.invoke('release-guard:check'),
  getTelemetryState: () => ipcRenderer.invoke('telemetry:get-state'),
  setTelemetryEnabled: (enabled: boolean) => ipcRenderer.invoke('telemetry:set-enabled', enabled),
  acknowledgeTelemetryNotice: () => ipcRenderer.invoke('telemetry:ack-notice'),
  resetTelemetryAnonymousId: () => ipcRenderer.invoke('telemetry:reset-id'),
  revealTelemetryQueue: () => ipcRenderer.invoke('telemetry:reveal-queue'),
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  setPrimaryModel: (key: string) => ipcRenderer.invoke('config:set-primary-model', key),
  setApiKey: (provider: string, apiKey: string) => ipcRenderer.invoke('secret:set-api-key', { provider, apiKey }),
  deleteApiKey: (provider: string) => ipcRenderer.invoke('secret:delete-api-key', provider),
  hasApiKey: (provider: string) => ipcRenderer.invoke('secret:has-api-key', provider),
  testConnection: (provider: string) => ipcRenderer.invoke('provider:test-connection', provider),
  listProviderModels: (provider: string) => ipcRenderer.invoke('provider:list-models', provider),
  getNarraCatDiagnostics: () => ipcRenderer.invoke('narracat:diagnostics'),
  readOfficialSkillBody: (input: unknown) => ipcRenderer.invoke('official-skill:read-body', input),
  listProseBlocks: (input: unknown) => ipcRenderer.invoke('prose-blocks:list', input),
  setProseBlock: (input: unknown) => ipcRenderer.invoke('prose-blocks:set', input),
  resetProseBlock: (input: unknown) => ipcRenderer.invoke('prose-blocks:reset', input),
  resetAllProseBlocks: (input: unknown) => ipcRenderer.invoke('prose-blocks:reset-all', input),
  listAuthorRequests: (input: unknown) => ipcRenderer.invoke('author-requests:list', input),
  addAuthorRequest: (input: unknown) => ipcRenderer.invoke('author-requests:add', input),
  updateAuthorRequest: (input: unknown) => ipcRenderer.invoke('author-requests:update', input),
  removeAuthorRequest: (input: unknown) => ipcRenderer.invoke('author-requests:remove', input),
  listCapabilityPacks: () => ipcRenderer.invoke('packs:list'),
  previewCapabilityPackImport: () => ipcRenderer.invoke('packs:import-preview'),
  confirmCapabilityPackImport: (input: unknown) => ipcRenderer.invoke('packs:import-confirm', input),
  cancelCapabilityPackImport: (input: unknown) => ipcRenderer.invoke('packs:import-cancel', input),
  getCapabilityPackDetail: (input: unknown) => ipcRenderer.invoke('packs:detail', input),
  exportCapabilityPackTemplate: () => ipcRenderer.invoke('packs:export-template'),
  uninstallCapabilityPack: (input: unknown) => ipcRenderer.invoke('packs:uninstall', input),
  exportCapabilityPack: (input: unknown) => ipcRenderer.invoke('packs:export', input),
  listPackDrafts: () => ipcRenderer.invoke('packs:drafts-list'),
  getPackDraft: (input: unknown) => ipcRenderer.invoke('packs:draft-get', input),
  createPackDraft: (input: unknown) => ipcRenderer.invoke('packs:draft-create', input),
  updatePackDraft: (input: unknown) => ipcRenderer.invoke('packs:draft-update', input),
  deletePackDraft: (input: unknown) => ipcRenderer.invoke('packs:draft-delete', input),
  exportPackDraftProject: (input: unknown) => ipcRenderer.invoke('packs:draft-export-project', input),
  importPackDraftProject: () => ipcRenderer.invoke('packs:draft-import-project'),
  compileDraftCard: (input: unknown) => ipcRenderer.invoke('packs:draft-compile', input),
  previewDraftCard: (input: unknown) => ipcRenderer.invoke('packs:draft-preview', input),
  publishPackDraft: (input: unknown) => ipcRenderer.invoke('packs:draft-publish', input),
  copyPackToDraft: (input: unknown) => ipcRenderer.invoke('packs:copy-to-draft', input),
  getLocalPackContent: (input: unknown) => ipcRenderer.invoke('packs:local-content', input),
  pickLearnTxt: () => ipcRenderer.invoke('packs:learn-pick-txt'),
  estimateLearn: (input: unknown) => ipcRenderer.invoke('packs:learn-estimate', input),
  startLearn: (input: unknown) => ipcRenderer.invoke('packs:learn-start', input),
  cancelLearn: () => ipcRenderer.invoke('packs:learn-cancel'),
  startWizard: () => ipcRenderer.invoke('packs:wizard-start'),
  sendWizardMessage: (input: unknown) => ipcRenderer.invoke('packs:wizard-send', input),
  cancelWizard: () => ipcRenderer.invoke('packs:wizard-cancel'),
  getWizardSnapshot: () => ipcRenderer.invoke('packs:wizard-snapshot'),
  dismissWizard: () => ipcRenderer.invoke('packs:wizard-dismiss'),
  getNovelPacks: (input: unknown) => ipcRenderer.invoke('novel-packs:get', input),
  setNovelPacks: (input: unknown) => ipcRenderer.invoke('novel-packs:set', input),
  getChapterCapabilityReceipt: (input: unknown) => ipcRenderer.invoke('novel-packs:get-receipt', input),
  getPlanningCapabilityReceipts: (input: unknown) => ipcRenderer.invoke('novel-packs:get-planning-receipts', input),
  runPackagedAgentRuntimeProbe: () => ipcRenderer.invoke('runtime:packaged-agent-probe'),
  runEmbeddingHealthProbe: () => ipcRenderer.invoke('embedding:health-probe'),
  runCorpusHealthProbe: () => ipcRenderer.invoke('corpus:health-probe'),
  listResultNotifications: () => ipcRenderer.invoke('notifications:list'),
  upsertResultNotification: (notification: unknown) => ipcRenderer.invoke('notifications:upsert-result', notification),
  markResultNotificationRead: (id: string) => ipcRenderer.invoke('notifications:mark-read', id),
  markAllResultNotificationsRead: () => ipcRenderer.invoke('notifications:mark-all-read'),
  readWorkLocation: () => ipcRenderer.invoke('navigation:read-work-location'),
  writeWorkLocation: (input: unknown) => ipcRenderer.invoke('navigation:write-work-location', input),
  listNovelProjects: () => ipcRenderer.invoke('novel:list-projects'),
  createNovelProjectBackup: (projectPath: string) => ipcRenderer.invoke('novel:create-project-backup', projectPath),
  restoreNovelProjectBackup: () => ipcRenderer.invoke('novel:restore-project-backup'),
  rememberNovelProjectPath: (input: unknown) => ipcRenderer.invoke('novel:remember-project-path', input),
  createNovelProject: (input: unknown) => ipcRenderer.invoke('novel:create-project', input),
  updateNovelProjectMetadata: (input: unknown) => ipcRenderer.invoke('novel:update-project-metadata', input),
  deleteNovelProject: (input: unknown) => ipcRenderer.invoke('novel:delete-project', input),
  getNovelProject: (projectPath: string, selectedChapter?: number) =>
    ipcRenderer.invoke('novel:get-project', { projectPath, selectedChapter }),
  readNovelStatus: (projectPath: string) => ipcRenderer.invoke('novel:read-status', projectPath),
  refreshNovelStatus: (projectPath: string) => ipcRenderer.invoke('novel:refresh-status', projectPath),
  listAppearedCharacters: (projectPath: string) => ipcRenderer.invoke('novel:list-appeared-characters', projectPath),
  readCharacterState: (input: { projectPath: string; characterUid: string; characterName: string }) =>
    ipcRenderer.invoke('novel:read-character-state', input),
  readPlannedState: (input: unknown) => ipcRenderer.invoke('novel:read-planned-state', input),
  readPlannedStateCounts: (input: unknown) => ipcRenderer.invoke('novel:read-planned-state-counts', input),
  readMemoryGraph: (input: unknown) => ipcRenderer.invoke('novel:read-memory-graph', input),
  enrichCharacterStatuses: (input: { projectPath: string; characterUids: string[]; knowledgeBoundaryChapter: number | null }) =>
    ipcRenderer.invoke('novel:enrich-character-statuses', input),
  getNovelChapterArtifacts: (projectPath: string, chapterNumber: number, volumeNumber?: number) =>
    ipcRenderer.invoke('novel:get-chapter-artifacts', { projectPath, chapterNumber, volumeNumber }),
  getNovelWorkbenchArtifacts: (projectPath: string, objectId: string, volumeNumber?: number) =>
    ipcRenderer.invoke('novel:get-workbench-artifacts', { projectPath, objectId, volumeNumber }),
  submitPremiseFieldEdit: (input: unknown) => ipcRenderer.invoke('novel:submit-premise-edit', input),
  submitChapterOutlineFieldEdit: (input: unknown) => ipcRenderer.invoke('novel:submit-chapter-outline-edit', input),
  submitMasterOutlineFieldEdit: (input: unknown) => ipcRenderer.invoke('novel:submit-master-outline-edit', input),
  submitAuthoredState: (input: unknown) => ipcRenderer.invoke('novel:submit-authored-state', input),
  submitStyleAnchor: (input: unknown) => ipcRenderer.invoke('novel:submit-style-anchor', input),
  listStyleAnchors: (input: unknown) => ipcRenderer.invoke('novel:list-style-anchors', input),
  resolvePlannedState: (input: unknown) => ipcRenderer.invoke('novel:resolve-planned-state', input),
  updateChapterStateChanges: (input: unknown) => ipcRenderer.invoke('novel:update-chapter-state-changes', input),
  submitCharacterIdentity: (input: unknown) => ipcRenderer.invoke('novel:submit-character-identity', input),
  saveChapterManuscript: (input: unknown) => ipcRenderer.invoke('novel:save-chapter-manuscript', input),
  listManuscriptRevisions: (input: unknown) => ipcRenderer.invoke('novel:list-manuscript-revisions', input),
  readManuscriptRevision: (input: unknown) => ipcRenderer.invoke('novel:read-manuscript-revision', input),
  restoreManuscriptRevision: (input: unknown) => ipcRenderer.invoke('novel:restore-manuscript-revision', input),
  getManuscriptDraft: (input: unknown) => ipcRenderer.invoke('novel:get-manuscript-draft', input),
  saveManuscriptDraft: (input: unknown) => ipcRenderer.invoke('novel:save-manuscript-draft', input),
  discardManuscriptDraft: (input: unknown) => ipcRenderer.invoke('novel:discard-manuscript-draft', input),
  listManuscriptDrafts: (projectPath: string) => ipcRenderer.invoke('novel:list-manuscript-drafts', projectPath),
  getPendingMemorySync: (projectPath: string) => ipcRenderer.invoke('novel:get-pending-memory-sync', projectPath),
  clearPendingMemorySync: (input: unknown) => ipcRenderer.invoke('novel:clear-pending-memory-sync', input),
  pasteReferenceSource: (input: unknown) => ipcRenderer.invoke('novel:paste-reference-source', input),
  importReferenceSourceFiles: (projectPath: string) => ipcRenderer.invoke('dialog:import-reference-sources', projectPath),
  removeReferenceSource: (input: unknown) => ipcRenderer.invoke('novel:remove-reference-source', input),
  clearReferenceGuidance: (projectPath: string) => ipcRenderer.invoke('novel:clear-reference-guidance', projectPath),
  resetReferenceWorks: (projectPath: string) => ipcRenderer.invoke('novel:reset-reference-works', projectPath),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  startAgentRun: (request: unknown) => ipcRenderer.invoke('agent:start-run', request),
  cancelAgentRun: (input: unknown) => ipcRenderer.invoke('agent:cancel-run', input),
  answerAgentQuestion: (answer: unknown) => ipcRenderer.invoke('agent:answer-question', answer),
  forgetAgentSession: (input: unknown) => ipcRenderer.invoke('agent:forget-session', input),
  getAgentThreadSnapshot: (input: unknown) => ipcRenderer.invoke('agent:get-thread-snapshot', input),
  getAgentEventsAfter: (input: unknown) => ipcRenderer.invoke('agent:get-events-after', input),
  listAgentHistorySegments: (threadId: string) => ipcRenderer.invoke('agent:list-history-segments', threadId),
  startNewAgentConversation: (input: unknown) => ipcRenderer.invoke('agent:start-new-conversation', input),
  sendCharacterChatMessage: (request: unknown) => ipcRenderer.invoke('character-chat:send', request),
  cancelCharacterChat: (runId: string) => ipcRenderer.invoke('character-chat:cancel', runId),
  readCharacterChatTranscript: (input: unknown) => ipcRenderer.invoke('character-chat:read-transcript', input),
  saveCharacterChatTranscript: (input: unknown) => ipcRenderer.invoke('character-chat:save-transcript', input),
  readCharacterChatProfiles: (input: unknown) => ipcRenderer.invoke('character-chat:read-profiles', input),
  saveCharacterChatProfile: (input: unknown) => ipcRenderer.invoke('character-chat:save-profile', input),
  flushCharacterChatProfile: (input: unknown) => ipcRenderer.invoke('character-chat:flush-profile', input),
  listPolishRecipes: () => ipcRenderer.invoke('polish:list-recipes'),
  savePolishRecipe: (input: unknown) => ipcRenderer.invoke('polish:save-recipe', input),
  getPolishSettings: (input: unknown) => ipcRenderer.invoke('polish:get-settings', input),
  setStandingPolishSlot: (input: unknown) => ipcRenderer.invoke('polish:set-standing-slot', input),
  startPolishRun: (input: unknown) => ipcRenderer.invoke('polish:start', input),
  cancelPolishRun: (input: unknown) => ipcRenderer.invoke('polish:cancel', input),
  adoptPolishedChapter: (input: unknown) => ipcRenderer.invoke('polish:adopt', input),
  clearStandingPolishOutcome: (input: unknown) => ipcRenderer.invoke('polish:clear-standing-outcome', input),
  markStandingPromptAnswered: (input: unknown) =>
    ipcRenderer.invoke('polish:mark-standing-prompt-answered', input),
  onPolishEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('polish:event', listener)
    return () => ipcRenderer.removeListener('polish:event', listener)
  },
  onCharacterChatEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('character-chat:event', listener)
    return () => ipcRenderer.removeListener('character-chat:event', listener)
  },
  onAgentEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  onPackLearnEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('packs:learn-event', listener)
    return () => ipcRenderer.removeListener('packs:learn-event', listener)
  },
  onPackWizardEvent: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('packs:wizard-event', listener)
    return () => ipcRenderer.removeListener('packs:wizard-event', listener)
  },
  onOpenResultNotification: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('notifications:open-result', listener)
    return () => ipcRenderer.removeListener('notifications:open-result', listener)
  },
  onResultNotificationsChanged: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('notifications:changed', listener)
    return () => ipcRenderer.removeListener('notifications:changed', listener)
  },
  onUpdaterStateChanged: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  },
}

contextBridge.exposeInMainWorld('electron', api)

// 给 TypeScript 渲染端用的类型声明放在 shared/types/ipc.d.ts
export type ElectronApi = typeof api
