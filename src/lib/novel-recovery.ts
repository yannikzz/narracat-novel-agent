import type { NovelProjectSummary } from '@shared/types/novel'

export interface CheckpointSummary {
  hasCheckpoint: boolean
  commandLabel: string
  stepLabel: string
  timeLabel: string
}

export interface WritePrerequisiteGuidance {
  blocked: boolean
  title: string
  detail: string
}

export function getCheckpointSummary(project: Pick<NovelProjectSummary, 'checkpoint'>): CheckpointSummary {
  const checkpoint = project.checkpoint

  if (!checkpoint?.lastCommand) {
    return {
      hasCheckpoint: false,
      commandLabel: '无未完成命令',
      stepLabel: '无步骤',
      timeLabel: '无时间记录',
    }
  }

  return {
    hasCheckpoint: true,
    commandLabel: checkpoint.lastCommand,
    stepLabel: checkpoint.lastStep ? `步骤 ${checkpoint.lastStep}` : '步骤未记录',
    timeLabel: checkpoint.timestamp ? new Date(checkpoint.timestamp).toLocaleString() : '无时间记录',
  }
}

export function getWritePrerequisiteGuidance(
  project: Pick<NovelProjectSummary, 'status'> | null | undefined,
): WritePrerequisiteGuidance {
  if (!project) {
    return {
      blocked: true,
      title: '先选择小说项目',
      detail: '从图书馆打开一本小说后，才能运行写作类操作。',
    }
  }

  if (project.status === 'missing') {
    return {
      blocked: true,
      title: '项目文件夹不在了',
      detail: '这本书的文件夹已不在原位置。请返回图书馆，从原位置或备份里找回后再继续。',
    }
  }

  if (project.status === 'invalid') {
    return {
      blocked: true,
      title: '项目结构需要检查',
      detail: '当前路径缺少 NarraCat 必需文件。请返回图书馆检查项目或插件配置。',
    }
  }

  if (project.status === 'needs-setup') {
    return {
      blocked: true,
      title: '先完成小说设定',
      detail: '完成小说设定引导后，Agent 才有足够上下文开始写章节。',
    }
  }

  if (project.status === 'needs-outline') {
    return {
      blocked: true,
      title: '先完成大纲规划',
      detail: '写下一章前，需要先在大纲里定好这一章的目标、冲突和关键事件。',
    }
  }

  return {
    blocked: false,
    title: '可以开始写作',
    detail: '当前项目满足写作操作的最低前置条件。',
  }
}
