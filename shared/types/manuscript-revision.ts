export type ManuscriptRevisionSource =
  | 'author-save'
  | 'agent-write'
  | 'agent-rewrite'
  | 'revision-restore'
  /** 作者自持的润色通道采用了某一版（ADR-0041） */
  | 'llm-polish'

export interface ManuscriptRevisionSummary {
  addedChars: number
  removedChars: number
}

export interface ManuscriptRevisionEntry {
  id: string
  chapter: number
  source: ManuscriptRevisionSource
  createdAt: string
  summary: ManuscriptRevisionSummary
}

export interface ManuscriptRevisionList {
  revisions: ManuscriptRevisionEntry[]
  storageBytes: number
}

export interface ManuscriptRevisionContent {
  revision: ManuscriptRevisionEntry
  visibleText: string
}

export interface ManuscriptRevisionInput {
  projectPath: string
  chapter: number
}

export interface ReadManuscriptRevisionInput extends ManuscriptRevisionInput {
  revisionId: string
}

export interface RestoreManuscriptRevisionInput extends ReadManuscriptRevisionInput {
  expectedVisibleText: string
}
