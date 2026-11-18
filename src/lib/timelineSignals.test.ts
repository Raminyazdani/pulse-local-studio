import { describe, expect, it } from 'vitest'
import { clipDuration, resetSourceWindow, resolveClipTime, sourceToOutput, trimClip } from './engine'
import { parseProject } from './project'
import { normalizeTimelineSignals, replaceTimelineSignals, timelineSignalDraft } from './timelineSignals'
import type { Clip, Media, Project } from './types'

const media: Media[] = [
  { id: 'a', name: 'A.mov', kind: 'video', duration: 12, hasAudio: true, url: '/a', sourceSignals: [1, 3, 7] },
  { id: 'b', name: 'B.mov', kind: 'video', duration: 8, hasAudio: false, url: '/b', sourceSignals: [2, 4] },
]
const make = (patch: Partial<Clip> = {}): Clip => ({
  id: 'merged', name: 'Merged sequence', trackId: 'video', start: 7,
  segments: [{ mediaId: 'a', in: 0, out: 12, speed: 1 }],
  signals: [1, 3, 7, 11], muted: true, volume: .7, ...patch,
})
const project = (clip: Clip): Project => ({
  id: 'timeline-label-project', name: 'Timeline labels', version: 1, media,
  tracks: [{ id: 'video', name: 'Video', kind: 'video', locked: false, hidden: false, muted: false }], clips: [clip],
})
function expectSameFrames(before: Clip, after: Clip) {
  const duration = clipDuration(before)
  expect(clipDuration(after)).toBeCloseTo(duration, 10)
  expect(after.start).toBe(before.start)
  for (let i = 0; i < 500; i++) {
    const time = duration * i / 500
    const old = resolveClipTime(before, time)!, updated = resolveClipTime(after, time)!
    expect(updated.mediaId).toBe(old.mediaId)
    expect(updated.time).toBeCloseTo(old.time, 9)
    expect(updated.speed).toBeCloseTo(old.speed, 9)
    expect(updated.muted).toBe(old.muted)
    expect(updated.volume).toBeCloseTo(old.volume, 10)
  }
}

describe('timeline signal normalization', () => {
  it('preserves exact timestamps, both clip endpoints and last-retained deduplication', () => {
    expect(normalizeTimelineSignals([4, 0, 2.0000009, 2, 2.00000001], 4)).toEqual([0, 2, 2.0000009, 4])
    expect(normalizeTimelineSignals([0, .6e-7, 1.2e-7], 1)).toEqual([0, 1.2e-7])
    expect(normalizeTimelineSignals([], 0)).toEqual([])
  })

  it('rejects invalid times and oversized drafts without silently dropping them', () => {
    for (const signals of [[-.1], [4.000001], [NaN], [Infinity], [true as unknown as number], ['1' as unknown as number]])
      expect(() => normalizeTimelineSignals(signals, 4)).toThrow()
    for (const duration of [-1, NaN, Infinity]) expect(() => normalizeTimelineSignals([], duration)).toThrow()
    expect(() => normalizeTimelineSignals(Array.from({ length: 100001 }, () => 0), 1)).toThrow(/100,000/)
  })
})

describe('timeline composition signal drafts', () => {
  it('shows existing warped labels on the current output clock across repeated files and mixed rates', () => {
    const original = make({
      segments: [{ mediaId: 'a', in: 2, out: 8, speed: 2 }, { mediaId: 'b', in: 1, out: 5, speed: .5 }, { mediaId: 'a', in: 0, out: 2, speed: 1 }],
      signals: [0, 1, 3, 8, 13], beatEdits: [2, 9],
      warp: [{ source: 0, target: 0 }, { source: 4, target: 2 }, { source: 13, target: 11 }],
    })
    const before = JSON.stringify(original)
    const draft = timelineSignalDraft(original)
    expect(draft.signals).toEqual(original.signals.map(time => sourceToOutput(original, time)))
    expect(draft.warp).toBeUndefined()
    expect(draft.beatEdits).toEqual([1, 7])
    expectSameFrames(original, draft)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('creates an independent mutable inspection snapshot including retained ranges and beat settings', () => {
    const original = trimClip(make({ beatEdits: [1, 3, 7, 11], beatConfig: { pattern: [1, 0], enabledGroups: ['a:low'] } }), 9, 17, media)
    const before = JSON.stringify(original)
    const draft = timelineSignalDraft(original)
    draft.signals.push(5)
    draft.segments[0].in = 0
    draft.editSource!.signals.push(2)
    draft.editSource!.segments[0].out = 1
    draft.editSource!.beatEdits!.push(2)
    draft.sourceWindow!.in = 0
    draft.beatEdits!.push(4)
    ;(draft.beatConfig!.pattern as number[]).push(1)
    draft.beatConfig!.enabledGroups!.push('other')
    expect(JSON.stringify(original)).toBe(before)
  })

  it('retains a valid end signal across fractional-rate flattening roundoff', () => {
    for (let i = 1; i <= 100; i++) {
      const segments = [{ mediaId: 'a', in: .13, out: 3.79, speed: 1.27 },
        { mediaId: 'b', in: .32, out: 6.71, speed: 2.03 }, { mediaId: 'a', in: 8.14, out: 11.73, speed: .71 }]
      const canonicalEnd = segments.reduce((total, segment) => total + (segment.out - segment.in) / segment.speed, 0)
      const original = make({ segments, signals: [0, canonicalEnd], warp: [
        { source: 0, target: 0 }, { source: canonicalEnd * .37, target: i / 73 }, { source: canonicalEnd, target: i / 13 },
      ] })
      const draft = timelineSignalDraft(original)
      expect(draft.signals).toHaveLength(2)
      expect(draft.signals[1]).toBeCloseTo(clipDuration(original), 10)
      expect(draft.signals[1]).toBeLessThanOrEqual(clipDuration(draft))
      expect(replaceTimelineSignals(original, draft.signals)).toBe(original)
      const saved = replaceTimelineSignals(original, [clipDuration(original) / 2, clipDuration(original)])
      expect(saved.signals).toHaveLength(2)
      expect(saved.signals[1]).toBeCloseTo(clipDuration(original), 10)
      expect(saved.signals[1]).toBeLessThanOrEqual(clipDuration(saved))
    }
  })
})

describe('saving timeline clip labels', () => {
  it('keeps an unchanged saved clip and its warp as the exact same object', () => {
    const original = make({ warp: [{ source: 0, target: 0 }, { source: 4, target: 2 }, { source: 12, target: 10 }] })
    const output = timelineSignalDraft(original).signals
    expect(replaceTimelineSignals(original, [...output].reverse())).toBe(original)
    expect(original.warp).toHaveLength(3)
  })

  it('changes only this merged occurrence and preserves every physical frame, rate and audio setting', () => {
    const original = make({
      segments: [{ mediaId: 'a', in: 1, out: 7, speed: 2, muted: false, volume: .5 }, { mediaId: 'b', in: 0, out: 6, speed: 1, muted: true }, { mediaId: 'a', in: 8, out: 12, speed: 2 }],
      signals: [1, 6, 10], beatEdits: [1, 4, 9],
      warp: [{ source: 0, target: 0 }, { source: 4, target: 1 }, { source: 11, target: 8 }],
      beatConfig: { every: 2, offset: 1 },
    })
    const before = JSON.stringify(original), library = JSON.stringify(media)
    const saved = replaceTimelineSignals(original, [7, .5, 3, 3, 8])
    expect(saved.signals).toEqual([.5, 3, 7, 8])
    expect(saved.warp).toBeUndefined()
    expect(saved.beatEdits).toEqual(original.beatEdits!.map(time => sourceToOutput(original, time)))
    expect(saved.beatConfig).toEqual(original.beatConfig)
    expectSameFrames(original, saved)
    expect(JSON.stringify(original)).toBe(before)
    expect(JSON.stringify(media)).toBe(library)
  })

  it('replaces the visible range while keeping hidden labels and crop-end labels available after restore', () => {
    const cropped = trimClip(make(), 9, 15, media) // A[2..8], six seconds at timeline9.
    const saved = replaceTimelineSignals(cropped, [0, 2, 6])
    expect(saved.sourceWindow).toEqual({ in: 2, out: 8 })
    expect(saved.signals).toEqual([0, 2, 6])
    expect(saved.editSource!.signals).toEqual([1, 2, 4, 8, 11])
    expect(resetSourceWindow(saved, media).signals).toEqual([1, 2, 4, 8, 11])
    expectSameFrames(cropped, saved)
    const restored = parseProject(JSON.parse(JSON.stringify(project(saved)))).clips[0]
    expect(resetSourceWindow(restored, media).signals).toEqual([1, 2, 4, 8, 11])
  })

  it('rebases hidden ranges after a warped crop while preserving current timing and removing visible labels', () => {
    const cropped = trimClip(make({ beatEdits: [1, 3, 7, 11] }), 9, 15, media)
    const warped = { ...cropped, warp: [{ source: 0, target: 0 }, { source: 3, target: 1 }, { source: 6, target: 5 }] }
    const saved = replaceTimelineSignals(warped, [])
    expect(saved.signals).toEqual([])
    expect(saved.sourceWindow).toEqual({ in: 2, out: 7 })
    expect(saved.editSource!.signals).toEqual([1, 10])
    expect(resetSourceWindow(saved, media).signals).toEqual([1, 10])
    expect(saved.beatEdits).toEqual(warped.beatEdits!.map(time => sourceToOutput(warped, time)))
    expectSameFrames(warped, saved)
    expect(clipDuration(resetSourceWindow(saved, media))).toBeCloseTo(11, 10)
  })
})
