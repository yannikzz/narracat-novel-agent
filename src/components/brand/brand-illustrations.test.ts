import { describe, expect, test } from 'bun:test'
import {
  BRAND_ILLUSTRATION_PURPOSES,
  brandIllustrations,
  getBrandIllustration,
  type BrandIllustrationPurpose,
} from './brand-illustrations'

const expectedPurposes: BrandIllustrationPurpose[] = [
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
]

describe('brand illustration registry', () => {
  test('covers the approved purpose list', () => {
    expect(BRAND_ILLUSTRATION_PURPOSES).toEqual(expectedPurposes)
    expect(Object.keys(brandIllustrations).sort()).toEqual([...expectedPurposes].sort())
  })

  test('keeps every approved purpose mapped to a stable WebP asset and label', () => {
    for (const purpose of expectedPurposes) {
      const asset = getBrandIllustration(purpose)

      expect(asset.src).toContain('/assets/illustrations/narracat/')
      expect(asset.src).toMatch(/\.webp$/)
      expect(asset.label.trim().length).toBeGreaterThan(0)
    }
  })

  test('maps purposes to stable NarraCat illustration assets', () => {
    expect(getBrandIllustration('empty-library').src).toContain('reading-book-pile.webp')
    expect(getBrandIllustration('create-novel').src).toContain('feather-writing.webp')
    expect(getBrandIllustration('agent-ready').src).toContain('laptop-chat.webp')
    expect(getBrandIllustration('model-service-needed').src).toContain('laptop-chat.webp')
    expect(getBrandIllustration('setup-needed').src).toContain('character-board.webp')
    expect(getBrandIllustration('reference-works-needed').src).toContain('book-feedback.webp')
    expect(getBrandIllustration('reference-works-ready').src).toContain('idea-writing.webp')
    expect(getBrandIllustration('outline-needed').src).toContain('story-map.webp')
    expect(getBrandIllustration('draft-needed').src).toContain('laptop-draft.webp')
    expect(getBrandIllustration('review-needed').src).toContain('manuscript-review.webp')
    expect(getBrandIllustration('checkpoint').src).toContain('milestone-celebration.webp')
    expect(getBrandIllustration('project-missing').src).toContain('inspect-notes.webp')
    expect(getBrandIllustration('home-agents').src).toContain('agents.webp')
    expect(getBrandIllustration('agent-question').src).toContain('thinking-draft.webp')
    expect(getBrandIllustration('about').src).toContain('fantasy-reading.webp')
    expect(getBrandIllustration('telemetry-notice').src).toContain('heart-support.webp')
    expect(getBrandIllustration('wizard-guide').src).toContain('idea-writing.webp')
    expect(getBrandIllustration('wizard-journey').src).toContain('story-map.webp')
  })
})
