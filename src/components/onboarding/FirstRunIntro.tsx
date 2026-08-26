import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { BrandMark } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { BlurText } from '@/components/motion/BlurText'
import { ShinyText } from '@/components/motion/ShinyText'
import { TextType } from '@/components/motion/TextType'
import { Threads } from '@/components/motion/Threads'
import { TextParticles } from '@/components/motion/TextParticles'
import { CircularGallery } from '@/components/motion/CircularGallery'
import { characterGalleryItems, hasCharacterImages } from './character-gallery'

// 与 globals.css 的 slide-up-fade 同一条出场曲线。
const REVEAL_EASE = [0.16, 1, 0.3, 1] as const

// 序幕·品牌理念（官网作者寄语全文）。emphasis 句用前景强调色，呼应官网的白色收尾句。
const MANIFESTO: { text: string; emphasis?: boolean }[] = [
  { text: '故事，一直来自人的记忆、情感与想象。' },
  { text: '技术不断改变表达方式，但创造故事的，始终是人。', emphasis: true },
  { text: '在智能时代，创作不必再被时间与执行成本限制。' },
  { text: 'NarraCat 让智能先理解你的所想，再协助构建世界观、推进剧情结构、生成章节内容。' },
  { text: '你决定故事的意义与方向，智能负责让故事持续生长。', emphasis: true },
  { text: '我们不试图替代创作者，' },
  { text: '只希望——让更多故事，有机会被完成。', emphasis: true },
]

const FEATURES = [
  { key: 'craft', title: '你写，我一直在', body: '从第一个字，陪到完结那一章' },
  { key: 'characters', title: '让笔下的人活过来', body: '他们记得发生过的事，也会回你的话' },
  { key: 'memory', title: '一百万字，它都记得', body: '你只管往前写，回收伏笔的事交给它' },
] as const

const SLOGAN = '故事生于人，成于智能。'
const TOTAL_STEPS = 2 + FEATURES.length // 序幕 + 三幕 + 终幕
const STAGE_KEYS = ['manifesto', 'craft', 'characters', 'memory', 'finale'] as const

// 各幕动画参数默认值（生产固定用这套；dev 下可经调试面板实时调整）。
type StageParams = Record<string, Record<string, number | string>>
const STAGE_DEFAULTS: StageParams = {
  manifesto: { charStagger: 0.02, duration: 0.35, lineDelay: 0.45 },
  craft: { threadsColor: '#e6e6e6', bgColor: '#ffffff', lineCount: 10, lineWidth: 3.5, lineBlur: 14, amplitude: 1, distance: 0 },
  characters: { bend: 3.4, borderRadius: 0.07, textColor: '#9b9ba4', height: 390, scrollSpeed: 1.9, scrollEase: 0.05 },
  memory: { count: 600, baseSize: 750, spread: 8.5, speed: 0.36, sizeRandomness: 2, brandRatio: 0.4 },
  finale: { typingSpeed: 90, initialDelay: 400, shinySpeed: 3 },
}

function hexToRgb01(hex: string): [number, number, number] {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  const n = parseInt(full || '04c853', 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function copyJson(obj: unknown) {
  void navigator.clipboard?.writeText(JSON.stringify(obj, null, 2))
}

// dev-only：调试面板动态加载，生产 import.meta.env.DEV 为 false → 该 import 被 tree-shake，src/dev 不打包。
const AnimationDebugPanel = import.meta.env.DEV
  ? lazy(() => import('@/dev/AnimationDebugPanel').then((m) => ({ default: m.AnimationDebugPanel })))
  : null

function StepContent({ step, reduced, params }: { step: number; reduced: boolean; params: StageParams }) {
  // 序幕·理念
  if (step === 0) {
    const m = params.manifesto
    return (
      <div className="flex flex-col items-center gap-2.5">
        {MANIFESTO.map((line, i) => (
          <BlurText
            key={i}
            as="p"
            text={line.text}
            startDelay={0.3 + i * Number(m.lineDelay)}
            charStagger={Number(m.charStagger)}
            duration={Number(m.duration)}
            className={cn(
              'justify-center text-base leading-relaxed sm:text-lg',
              line.emphasis ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          />
        ))}
      </div>
    )
  }

  // 终幕·Logo + NarraCat + 打字机 Slogan
  if (step === TOTAL_STEPS - 1) {
    const f = params.finale
    return (
      <div className="flex flex-col items-center gap-6">
        <motion.div
          initial={{ opacity: 0, scale: reduced ? 1 : 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: REVEAL_EASE }}
        >
          <BrandMark size="xl" />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: reduced ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2, ease: REVEAL_EASE }}
        >
          <ShinyText text="NarraCat" speed={Number(f.shinySpeed)} className="text-3xl font-bold sm:text-4xl" />
        </motion.div>
        <TextType
          as="p"
          text={SLOGAN}
          typingSpeed={Number(f.typingSpeed)}
          initialDelay={Number(f.initialDelay)}
          loop={false}
          cursorCharacter="▍"
          cursorClassName="text-brand"
          className="text-xl text-muted-foreground sm:text-2xl"
        />
      </div>
    )
  }

  const feature = FEATURES[step - 1]

  // 第三幕·角色：CircularGallery 角色画廊（全窗口宽）。
  if (feature.key === 'characters') {
    const c = params.characters
    return (
      <div className="flex w-full flex-col items-center gap-5">
        <BlurText
          as="h2"
          text={feature.title}
          startDelay={0.15}
          charStagger={0.04}
          className="justify-center text-2xl font-semibold text-foreground sm:text-3xl"
        />
        {hasCharacterImages ? (
          reduced ? (
            // reduced-motion：静态角色图网格，不跑画廊的持续 WebGL 动画。
            <div className="flex w-full max-w-4xl flex-wrap items-end justify-center gap-4 px-6">
              {characterGalleryItems.slice(0, 6).map((item, i) => (
                <figure key={i} className="flex flex-col items-center gap-2">
                  <img src={item.image} alt="" draggable={false} className="h-44 w-auto rounded-2xl object-cover" />
                  <figcaption className="text-xs text-muted-foreground">{item.text}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="w-full max-w-full overflow-hidden" style={{ height: `${Number(c.height)}px` }}>
              <CircularGallery
                items={characterGalleryItems}
                bend={Number(c.bend)}
                borderRadius={Number(c.borderRadius)}
                textColor={String(c.textColor)}
                scrollSpeed={Number(c.scrollSpeed)}
                scrollEase={Number(c.scrollEase)}
              />
            </div>
          )
        ) : (
          <div className="flex h-[280px] w-full max-w-md items-center justify-center rounded-2xl border border-dashed border-border px-8 text-center text-sm leading-relaxed text-muted-foreground">
            把角色图放进 <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">characters</code> 目录，这里会变成可旋转浏览的角色画廊
          </div>
        )}
        <BlurText
          as="p"
          text={feature.body}
          startDelay={0.45}
          charStagger={0.02}
          className="justify-center text-base text-muted-foreground sm:text-lg"
        />
      </div>
    )
  }

  // 第2幕(Threads 白底，固定浅色配色、不跟随暗色主题) / 第4幕(文字粒子，跟随主题)。
  const onLightStage = feature.key === 'craft'
  return (
    <div className="flex flex-col items-center gap-3">
      <BlurText
        as="h2"
        text={feature.title}
        startDelay={0.15}
        charStagger={0.04}
        className={cn(
          'justify-center text-3xl font-semibold sm:text-4xl',
          onLightStage ? 'text-zinc-900' : 'text-foreground',
        )}
      />
      <BlurText
        as="p"
        text={feature.body}
        startDelay={0.5}
        charStagger={0.02}
        className={cn(
          'justify-center text-lg sm:text-xl',
          onLightStage ? 'text-zinc-500' : 'text-muted-foreground',
        )}
      />
    </div>
  )
}

export interface FirstRunIntroProps {
  /** 看完或跳过后调用——进入首页并回写已看版本号 */
  onDone: () => void
}

/**
 * 首次启动的仪式化介绍：序幕理念 → 功能三幕(Threads / 角色画廊 / 文字奔流) → 终幕(Logo + NarraCat + 打字机 Slogan)。
 * 动效移植自官网 / React Bits（framer-motion + ogl）。支持跳过、键盘推进、reduced-motion 降级。
 * dev 下右上角有动画调参面板（src/dev，生产不打包）。
 */
export function FirstRunIntro({ onDone }: FirstRunIntroProps) {
  const reduced = useReducedMotion()
  const [step, setStep] = useState(0)
  const [params, setParams] = useState<StageParams>(STAGE_DEFAULTS)
  const [replayKey, setReplayKey] = useState(0)
  const isFinale = step === TOTAL_STEPS - 1
  const stageKey = STAGE_KEYS[step]
  const featureKey = FEATURES[step - 1]?.key
  const isCharacterStage = featureKey === 'characters'
  // 第2幕固定白底（craft.bgColor），整幕用固定浅色配色，避免暗色主题下白底浅字不可读。
  const onLightStage = featureKey === 'craft'

  // 第2/4幕的全屏背景动效（reduced-motion 下不挂）。
  const stageBackground = reduced
    ? null
    : featureKey === 'craft'
      ? (
          <div
            className="h-full w-full"
            style={{ backgroundColor: String(params.craft.bgColor) || undefined }}
          >
            <Threads
              color={hexToRgb01(String(params.craft.threadsColor))}
              amplitude={Number(params.craft.amplitude)}
              distance={Number(params.craft.distance)}
              lineCount={Number(params.craft.lineCount)}
              lineWidth={Number(params.craft.lineWidth)}
              lineBlur={Number(params.craft.lineBlur)}
            />
          </div>
        )
      : featureKey === 'memory'
        ? (
            <TextParticles
              count={Number(params.memory.count)}
              baseSize={Number(params.memory.baseSize)}
              spread={Number(params.memory.spread)}
              speed={Number(params.memory.speed)}
              sizeRandomness={Number(params.memory.sizeRandomness)}
              brandRatio={Number(params.memory.brandRatio)}
            />
          )
        : null

  const advance = useCallback(() => {
    setStep((current) => {
      if (current >= TOTAL_STEPS - 1) {
        onDone()
        return current
      }
      return current + 1
    })
  }, [onDone])

  // 键盘：Enter / → 推进，Esc 跳过。
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        event.preventDefault()
        advance()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onDone()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [advance, onDone])

  const updateParam = useCallback(
    (key: string, value: unknown) => {
      setParams((prev) => ({ ...prev, [stageKey]: { ...prev[stageKey], [key]: value as number | string } }))
    },
    [stageKey],
  )

  const slideY = reduced ? 0 : 12

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-canvas"
      role="dialog"
      aria-modal="true"
      aria-label="NarraCat 介绍"
      data-first-run-intro="true"
    >
      {/* 全屏背景动效层（仅第2/4幕） */}
      {stageBackground && (
        <motion.div
          key={`${featureKey}-${replayKey}`}
          aria-hidden
          className="pointer-events-none absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          {stageBackground}
        </motion.div>
      )}

      {/* 跳过（终幕不显示，那里只剩“开始创作”）。右侧预留 Windows caption 按钮区。 */}
      <div className="relative z-10 flex h-14 shrink-0 items-center justify-end pl-[1.25rem] pr-[max(1.25rem,var(--titlebar-inset-right))]">
        {!isFinale && (
          <Button
            variant="ghost"
            size="xs"
            className={onLightStage ? 'text-zinc-500' : 'text-muted-foreground'}
            onClick={onDone}
          >
            跳过
          </Button>
        )}
      </div>

      {/* 内容区 */}
      <div
        className={cn(
          'relative z-10 flex min-w-0 flex-1 items-center justify-center overflow-hidden',
          isCharacterStage ? 'px-0' : 'px-6',
        )}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={`${step}-${replayKey}`}
            initial={{ opacity: 0, y: slideY }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -slideY }}
            transition={{ duration: 0.4, ease: REVEAL_EASE }}
            className={cn(
              'flex w-full min-w-0 flex-col items-center text-center',
              isCharacterStage ? 'max-w-none' : 'max-w-lg',
            )}
          >
            <StepContent step={step} reduced={Boolean(reduced)} params={params} />
          </motion.div>
        </AnimatePresence>
      </div>

      {/* 底部：进度点 + 推进按钮 */}
      <div className="relative z-10 flex shrink-0 items-center justify-between px-8 pb-10 pt-4">
        <div className="flex items-center gap-2" aria-hidden>
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <span
              key={i}
              className={cn(
                'size-1.5 rounded-full transition-colors duration-300',
                i === step ? 'bg-brand' : onLightStage ? 'bg-zinc-300' : 'bg-border',
              )}
            />
          ))}
        </div>
        <Button onClick={advance} className={cn(isFinale && 'px-6')}>
          {isFinale ? '开始创作' : '下一步'}
        </Button>
      </div>

      {/* dev-only 动画调参面板（生产不打包） */}
      {import.meta.env.DEV && AnimationDebugPanel && (
        <Suspense fallback={null}>
          <AnimationDebugPanel
            stageKey={stageKey}
            step={step}
            totalSteps={TOTAL_STEPS}
            values={params[stageKey]}
            onChange={updateParam}
            onCopyStage={() => copyJson({ [stageKey]: params[stageKey] })}
            onCopyAll={() => copyJson(params)}
            onReplay={() => setReplayKey((k) => k + 1)}
          />
        </Suspense>
      )}
    </div>
  )
}
