/**
 * IPC 错误的产品化处理（#38）。
 *
 * Electron 会把主进程抛出的 Error 包成
 * `Error invoking remote method 'novel:refresh-status': Error: <原文>` 再交给渲染端。
 * 这层外壳是纯实现细节，直接渲染给作者既看不懂，还会把唯一有用的信息挤到后面。
 */

const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/

export function stripIpcErrorPrefix(message: string): string {
  return message.replace(IPC_WRAPPER, '').trim()
}

/**
 * 「项目文件不完整」的判据文案，主进程抛出、渲染端识别，双方共用这一份。
 * 各写各的字符串会在改动一侧时静默失配——损坏项目退回「红条 + 重试」的老样子，且无测试会红。
 */
export const NOVEL_PROJECT_INCOMPLETE_MESSAGE = '缺少 .narracat/config.yaml 或 .narracat/state.yaml'

export function isProjectIncompleteError(message: string): boolean {
  return stripIpcErrorPrefix(message).startsWith(NOVEL_PROJECT_INCOMPLETE_MESSAGE)
}
