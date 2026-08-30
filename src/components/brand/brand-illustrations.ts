export type BrandIllustrationPurpose =
  | 'empty-library'
  | 'create-novel'
  | 'agent-ready'
  | 'model-service-needed'
  | 'setup-needed'
  | 'reference-works-needed'
  | 'reference-works-ready'
  | 'outline-needed'
  | 'draft-needed'
  | 'review-needed'
  | 'checkpoint'
  | 'project-missing'
  | 'home-agents'
  | 'agent-question'
  | 'about'
  | 'wizard-guide'
  | 'wizard-journey'
  | 'telemetry-notice'

export interface BrandIllustrationAsset {
  src: string
  label: string
}

export const BRAND_ILLUSTRATION_PURPOSES = [
  'empty-library',
  'create-novel',
  'agent-ready',
  'model-service-needed',
  'setup-needed',
  'reference-works-needed',
  'reference-works-ready',
  'outline-needed',
  'draft-needed',
  'review-needed',
  'checkpoint',
  'project-missing',
  'home-agents',
  'agent-question',
  'about',
  'wizard-guide',
  'wizard-journey',
  'telemetry-notice',
] as const satisfies readonly BrandIllustrationPurpose[]

export const brandIllustrations: Record<BrandIllustrationPurpose, BrandIllustrationAsset> = {
  'empty-library': {
    src: new URL('../../assets/illustrations/narracat/reading-book-pile.webp', import.meta.url).href,
    label: '空小说库',
  },
  'create-novel': {
    src: new URL('../../assets/illustrations/narracat/feather-writing.webp', import.meta.url).href,
    label: '新建小说',
  },
  'agent-ready': {
    src: new URL('../../assets/illustrations/narracat/laptop-chat.webp', import.meta.url).href,
    label: 'Agent 等待输入',
  },
  'model-service-needed': {
    src: new URL('../../assets/illustrations/narracat/laptop-chat.webp', import.meta.url).href,
    label: '模型服务待接通',
  },
  'setup-needed': {
    src: new URL('../../assets/illustrations/narracat/character-board.webp', import.meta.url).href,
    label: '创作根基缺失',
  },
  'reference-works-needed': {
    src: new URL('../../assets/illustrations/narracat/book-feedback.webp', import.meta.url).href,
    label: '参考作品缺失',
  },
  'reference-works-ready': {
    src: new URL('../../assets/illustrations/narracat/idea-writing.webp', import.meta.url).href,
    label: '参考作品待分析',
  },
  'outline-needed': {
    src: new URL('../../assets/illustrations/narracat/story-map.webp', import.meta.url).href,
    label: '大纲缺失',
  },
  'draft-needed': {
    src: new URL('../../assets/illustrations/narracat/laptop-draft.webp', import.meta.url).href,
    label: '正文草稿缺失',
  },
  'review-needed': {
    src: new URL('../../assets/illustrations/narracat/manuscript-review.webp', import.meta.url).href,
    label: '审修反馈',
  },
  checkpoint: {
    src: new URL('../../assets/illustrations/narracat/milestone-celebration.webp', import.meta.url).href,
    label: '任务检查点',
  },
  'project-missing': {
    src: new URL('../../assets/illustrations/narracat/inspect-notes.webp', import.meta.url).href,
    label: '项目缺失',
  },
  'home-agents': {
    src: new URL('../../assets/illustrations/narracat/agents.webp', import.meta.url).href,
    label: 'Library 首页 Agents',
  },
  'agent-question': {
    src: new URL('../../assets/illustrations/narracat/thinking-draft.webp', import.meta.url).href,
    label: 'Agent 提问',
  },
  about: {
    src: new URL('../../assets/illustrations/narracat/fantasy-reading.webp', import.meta.url).href,
    label: 'NarraCat 品牌介绍',
  },
  // 作家向导（造包中心）：头像用「灵感写作」（把你脑子里的想法写下来，正是向导的职责气质）；
  // feather-writing 已强绑定「新建小说」、thinking-draft 已绑定「Agent 提问」互动卡，避免语义撞车。
  'wizard-guide': {
    src: new URL('../../assets/illustrations/narracat/idea-writing.webp', import.meta.url).href,
    label: '写法向导',
  },
  // 作家向导开场页：旅程地图气质（聊想法 → 试写挑版 → 炼成卡的三步旅程预告）。
  'wizard-journey': {
    src: new URL('../../assets/illustrations/narracat/story-map.webp', import.meta.url).href,
    label: '作家向导访谈旅程',
  },
  // 匿名统计告知屏：这一屏要说的不是「我们在看着你」，是「你的稿子我们不碰」——
  // 用抱着心的猫，把一屏本来像法务通知的东西还原成一次坦诚的打招呼。
  'telemetry-notice': {
    src: new URL('../../assets/illustrations/narracat/heart-support.webp', import.meta.url).href,
    label: '匿名使用统计告知',
  },
}

export function getBrandIllustration(purpose: BrandIllustrationPurpose): BrandIllustrationAsset {
  return brandIllustrations[purpose]
}
