import type { AgentRunRequest } from '../../../agent-runner.ts'
import type { AppConfig } from '../../../config.ts'
import { buildRunOptionsWithSessionContext } from '../run-options.ts'
import type { CreateSessionFingerprintFn, RunPlan, SdkThreadSession } from '../run-options.ts'
import type { AgentRuntimeAdapter, RuntimeRunConfig } from '../../runtime/types.ts'
import { createDirectChatPrompt, DIRECT_CHAT_SYSTEM_PROMPT } from '../runtime-status.ts'

function canResumeSdkSession(
  session: SdkThreadSession | undefined,
  projectPath: string | undefined,
): session is SdkThreadSession {
  if (!session) return false
  return !projectPath || session.projectPath === projectPath
}

export interface DirectChatPathInput {
  request: AgentRunRequest
  runtime: AgentRuntimeAdapter
  config: AppConfig
  apiKey: string
  abortController: AbortController
  appRoot: string
  resourcesPath?: string
  userDataPath?: string
  sdkSession: SdkThreadSession | undefined
  canUseTool: RuntimeRunConfig['canUseTool']
  createSessionFingerprint?: CreateSessionFingerprintFn
}

/**
 * 兜底路径：不是 write-next / recover-write / narracat-command，也没命中「resume 已有
 * project-command 会话续聊」或「engineContext freeform」，落到这里——纯「唠个嗑」，不挂引擎运行时。
 * 若同 thread 有可复用的 SDK session 且 projectPath 兼容，resume 它。从 run-manager.ts startRun
 * 尾段原样迁出，无前置失败校验（本路径不产出 preparationFailure）。
 *
 * 曾有第二种形态「运行时状态查询」（needsNarraCatRuntime=true，换一句检查 Agent Core 的提示词），
 * 随 continue / adjust-style / revise-character 三个死代码命令于 2026-09-09 一并删除。
 */
export async function buildDirectChatRunPlan(input: DirectChatPathInput): Promise<RunPlan> {
  const {
    request,
    runtime,
    config,
    apiKey,
    abortController,
    appRoot,
    resourcesPath,
    userDataPath,
    sdkSession,
    canUseTool,
    createSessionFingerprint,
  } = input

  const prompt = createDirectChatPrompt(request)
  const projectPath = request.projectPath ?? sdkSession?.projectPath
  const canResumeSession = canResumeSdkSession(sdkSession, projectPath)

  const { options, sessionContext } = await buildRunOptionsWithSessionContext({
    runtime,
    config,
    apiKey,
    abortController,
    appRoot,
    resourcesPath,
    userDataPath,
    loadNarraCatRuntime: false,
    projectPath,
    systemPrompt: DIRECT_CHAT_SYSTEM_PROMPT,
    canUseTool,
    agents: undefined,
    resume: canResumeSession ? sdkSession.sessionId : undefined,
    sessionMode: 'direct',
    selectedChapter: request.selectedChapter ?? (canResumeSession ? sdkSession.selectedChapter : undefined),
    createSessionFingerprint,
  })

  return { prompt, options, sessionContext }
}
