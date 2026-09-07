import type { ReactNode } from 'react'
import { BadgeCheck, Package } from 'lucide-react'
import { MarkdownRenderer } from '@/components/workbench/MarkdownRenderer'
import { Disclosure } from '@/components/ui/disclosure'
import { DIALOG_BODY_CLASS, DIALOG_CONTENT_DOCUMENT_CLASS, DIALOG_HEADER_SECTIONED_CLASS, DIALOG_SCROLL_SHELL_CLASS, MUTED_PILL_CLASS } from '@/design-system'
import { cn } from '@/lib/cn'
import type { CapabilityPackDetail, PackCardEntry, PackLocalSource } from '@shared/types/capability-pack'
import { CARD_TYPE_LABELS } from './pack-card-labels'

// 详情/导入确认弹窗容器规范（docs/design.md §9.7，对齐新建小说弹窗）：bg-workspace 覆盖默认浮层色、
// p-0 由内部分区自管间距、可见 DialogHeader（border-b）+ 滚动正文区；两处宿主（设置页导入确认 /
// 工作台详情）共用，避免各写一套漂移。
export const PACK_DETAIL_DIALOG_CONTENT_CLASS = `${DIALOG_SCROLL_SHELL_CLASS} ${DIALOG_CONTENT_DOCUMENT_CLASS}`
export const PACK_DETAIL_DIALOG_HEADER_CLASS = DIALOG_HEADER_SECTIONED_CLASS
export const PACK_DETAIL_DIALOG_BODY_CLASS = DIALOG_BODY_CLASS

const ICON_TILE_CLASS = 'flex size-12 shrink-0 items-center justify-center rounded-row'
const SECTION_TITLE_CLASS = 'text-xs font-medium leading-5 text-muted-foreground'

/** 卡条目 → 人读主文案 + 元数据副行（只消费 manifest 字段，展示边界：绝不渲染卡正文）。 */
function cardDisplay(card: PackCardEntry): { title: string; meta: string } {
  switch (card.type) {
    case 'persona':
      return { title: card.name, meta: card.keywords.join('、') }
    case 'craft':
      return { title: card.id, meta: [card.triggers.join('、'), card.technique_tags.join('、')].filter(Boolean).join(' · ') }
    case 'structure':
      return { title: card.one_line, meta: `${card.dimension} · ${card.stage}` }
    case 'benchmark':
      return { title: card.id, meta: card.genre }
  }
}

/**
 * 能力包详情内容（B2 刀2 spec §3）：一份纯展示组件，三处承载——
 * 设置页子视图 / 工作台 Dialog / 导入确认 Dialog（actions 插槽由宿主决定）。
 * 无 hooks：版本切换与数据刷新全由宿主驱动（detail.manifest 恒对应 selectedVersion）。
 *
 * `localCards`/`localSource`（B2 刀3 Task 13）：本机产物（造包中心创建/学习得来）的卡正文与
 * 来源标记，由宿主按需拉取（`getLocalPackContent`）后传入——不传即不渲染卡正文，维持导入包的
 * 展示降维边界。`localSource` 同时驱动两处信任提示：非本机产物（imported，origin='user' 且
 * 未传 localSource）在署名旁标「署名未验证」；learned-external（从外部作品学得）在卡内容区顶部
 * 标「仅本机使用 · 不可分享」。
 */
export function PackDetailContent({
  detail,
  selectedVersion,
  onSelectVersion,
  actions,
  localCards,
  localSource,
}: {
  detail: CapabilityPackDetail
  selectedVersion: string
  onSelectVersion: (version: string) => void
  actions?: ReactNode
  localCards?: Array<{ fileName: string; body: string }>
  localSource?: PackLocalSource
}) {
  const { manifest, origin } = detail
  const isOfficial = origin === 'official'
  const groups = (['persona', 'craft', 'structure', 'benchmark'] as const)
    .map((type) => ({ type, cards: manifest.cards.filter((card) => card.type === type) }))
    .filter((group) => group.cards.length > 0)

  return (
    <div className="space-y-5" data-pack-detail-content={`${manifest.id}@${selectedVersion}`}>
      <div className="flex items-start gap-3">
        <div
          className={cn(
            ICON_TILE_CLASS,
            isOfficial ? 'border border-brand-border bg-brand-soft text-brand' : 'border border-border bg-active text-muted-foreground',
          )}
          aria-hidden="true"
        >
          {isOfficial ? <BadgeCheck className="size-6" /> : <Package className="size-6" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold leading-tight text-foreground">{manifest.name}</h2>
            <span className={MUTED_PILL_CLASS}>{isOfficial ? '官方' : '用户'}</span>
            {isOfficial ? <span className={MUTED_PILL_CLASS}>随引擎更新</span> : null}
          </div>
          <p className="flex flex-wrap items-center gap-1.5 text-xs leading-5 text-muted-foreground">
            <span>
              {manifest.author} · v{selectedVersion}
            </span>
            {origin === 'user' && !localSource ? (
              <span className={MUTED_PILL_CLASS} data-pack-unverified-author="true">
                署名未验证
              </span>
            ) : null}
          </p>
          {detail.installedVersions.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-pack-version-switch="true">
              {detail.installedVersions.map((version) => (
                <button
                  key={version}
                  type="button"
                  className={cn(
                    MUTED_PILL_CLASS,
                    'cursor-pointer',
                    version === selectedVersion && 'border-brand-border bg-brand-soft text-brand',
                  )}
                  data-pack-version-option={version}
                  onClick={() => onSelectVersion(version)}
                >
                  v{version}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {manifest.description ? <p className="text-sm leading-6 text-body-foreground">{manifest.description}</p> : null}

      <div className="space-y-3">
        <p className={SECTION_TITLE_CLASS}>卡清单（{manifest.cards.length}）</p>
        {isOfficial ? (
          // 官方包只展示类别与数量，不逐卡露出选卡元数据——官方卡的 one_line/触发词承载蒸馏出的
          // 具体写作规则，属于产品家底；用户/社区包的元数据是作者自己写的，保持逐卡透明。
          <div className="space-y-1" data-pack-card-summary="true">
            {groups.map((group) => (
              <div
                key={group.type}
                className="flex items-center justify-between rounded-row border border-border bg-surface px-3 py-2"
              >
                <span className="text-sm leading-6 text-foreground">{CARD_TYPE_LABELS[group.type]}</span>
                <span className="text-xs leading-5 text-muted-foreground">{group.cards.length} 张</span>
              </div>
            ))}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.type} className="space-y-1.5">
              <p className="text-xs leading-5 text-muted-foreground">
                {CARD_TYPE_LABELS[group.type]} · {group.cards.length}
              </p>
              <div className="space-y-1">
                {group.cards.map((card) => {
                  const display = cardDisplay(card)
                  return (
                    <div key={card.id} className="rounded-row border border-border bg-surface px-3 py-2" data-pack-card={card.id}>
                      <div className="truncate text-sm leading-6 text-foreground">{display.title}</div>
                      {display.meta ? <div className="truncate text-xs leading-5 text-muted-foreground">{display.meta}</div> : null}
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {localCards && localCards.length > 0 ? (
        <div className="space-y-1.5" data-pack-local-content="true">
          <div className="flex items-center gap-2">
            <p className={SECTION_TITLE_CLASS}>卡内容</p>
            {localSource === 'learned-external' ? (
              <span className={MUTED_PILL_CLASS} data-pack-local-external-pill="true">
                仅本机使用 · 不可分享
              </span>
            ) : null}
          </div>
          <div className="space-y-1.5">
            {localCards.map((card) => (
              <Disclosure
                key={card.fileName}
                className="rounded-row border border-border bg-surface"
                data-pack-local-card={card.fileName}
                summary={<span className="cursor-pointer px-3 py-2 text-sm leading-6 text-foreground">{card.fileName}</span>}
              >
                <div className="border-t border-border px-3 py-3">
                  <MarkdownRenderer text={card.body} variant="document" />
                </div>
              </Disclosure>
            ))}
          </div>
        </div>
      ) : null}

      {manifest.changelog ? (
        <div className="space-y-1.5">
          <p className={SECTION_TITLE_CLASS}>版本说明</p>
          <p className="whitespace-pre-wrap text-sm leading-6 text-body-foreground">{manifest.changelog}</p>
        </div>
      ) : null}

      {detail.readme ? (
        <div className="space-y-1.5" data-pack-readme="true">
          <p className={SECTION_TITLE_CLASS}>包说明</p>
          <MarkdownRenderer text={detail.readme} variant="document" />
          {detail.readmeTruncated ? (
            <p className="text-xs leading-5 text-muted-foreground">说明过长，已截断展示。</p>
          ) : null}
        </div>
      ) : null}

      {actions ? <div className="flex items-center gap-2 border-t border-border pt-4">{actions}</div> : null}
    </div>
  )
}
