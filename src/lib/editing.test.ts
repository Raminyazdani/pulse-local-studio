import { describe, expect, it } from 'vitest'
import {
  alignClipToBeats, clipDuration, editRange, editSourceClip, flattenClip, mergeClips,
  resetSourceWindow, resolveClipTime, sampleClipWaveform, setSourceWindow, slipClip,
  sourceToOutput, splitClip, trimClip,
} from './engine'
import { parseProject } from './project'
import type { Clip, Media, Project } from './types'

const assets: Media[] = [
  { id: 'a', name: 'A.mov', kind: 'video', duration: 20, hasAudio: true, url: '/api/files/a/proxy', waveform: [0, 1] },
  { id: 'b', name: 'B.mov', kind: 'video', duration: 20, hasAudio: true, url: '/api/files/b/proxy', waveform: [1, 0] },
]
const make = (patch: Partial<Clip> = {}): Clip => ({
  id: 'clip', name: 'Clip', trackId: 'track', start: 2,
  segments: [{ mediaId: 'a', in: 0, out: 12 }], signals: [1, 4, 9], muted: false, volume: 1,
  ...patch,
})
const visibleAt = (clip: Clip, output: number) => resolveClipTime(clip, output)!
const project = (clip: Clip): Project => ({
  id: 'project', name: 'Editing', version: 1, media: assets,
  tracks: [{ id: 'track', name: 'Video', kind: 'video', muted: false, hidden: false, locked: false }], clips: [clip],
})

describe('reversible clip range editing', () => {
  it('restores trimmed ends and hidden markers without undo or reimporting', () => {
    const original = make()
    const cut = trimClip(original, 5, 10, assets)
    expect(cut.start).toBe(5)
    expect(clipDuration(cut)).toBe(5)
    expect(visibleAt(cut, 0).time).toBe(3)
    expect(cut.signals).toEqual([1])
    const restored = trimClip(cut, 2, 14, assets)
    expect(restored.start).toBe(2)
    expect(restored.signals).toEqual(original.signals)
    for (const time of [0, .25, 4, 8.8, 11.99]) expect(visibleAt(restored, time).time).toBeCloseTo(visibleAt(original, time).time, 10)
    expect(original.editSource).toBeUndefined()
  })

  it('hydrates available source handles in an old project and clamps timeline zero and file end', () => {
    const old = make({ segments: [{ mediaId: 'a', in: 4, out: 9 }], signals: [] })
    expect(editRange(old, assets)).toMatchObject({ in: 4, out: 9, total: 20, minStart: 0, maxEnd: 18, canSlip: true })
    const extended = trimClip(old, -10, 100, assets)
    expect(extended.start).toBe(0)
    expect(visibleAt(extended, 0).time).toBe(2)
    expect(extended.start + clipDuration(extended)).toBe(18)
    expect(extended.segments.at(-1)?.out).toBe(20)
  })

  it('restores whole compound spans that were completely hidden by a trim', () => {
    const original = make({ start: 3, segments: [
      { mediaId: 'a', in: 0, out: 4 }, { mediaId: 'b', in: 3, out: 7 }, { mediaId: 'a', in: 6, out: 10 },
    ], signals: [1, 5, 10] })
    const cut = trimClip(original, 7.5, 10, assets)
    expect(cut.segments).toHaveLength(1)
    expect(cut.segments[0].mediaId).toBe('b')
    const restored = trimClip(cut, 3, 15, assets)
    expect(restored.segments).toHaveLength(3)
    for (const t of [.2, 3.9, 4.1, 7.7, 8.2, 11.9]) {
      expect(visibleAt(restored, t)).toMatchObject({ mediaId: visibleAt(original, t).mediaId, time: visibleAt(original, t).time })
    }
    expect(restored.signals).toEqual(original.signals)
  })

  it('restores variable speeds and each original-media timestamp after a warped trim', () => {
    const original = alignClipToBeats(make({ start: 0, signals: [0, 3, 8, 12] }), [2, 3, 7, 8])
    const cut = trimClip(original, 2.4, 7.3, assets)
    const restored = trimClip(cut, original.start, original.start + clipDuration(original), assets)
    for (let t = 0; t < clipDuration(original) - .01; t += .113) {
      expect(visibleAt(restored, t).time).toBeCloseTo(visibleAt(original, t).time, 8)
      expect(visibleAt(restored, t).speed).toBeCloseTo(visibleAt(original, t).speed, 8)
    }
    restored.signals.forEach((signal, index) => expect(signal).toBeCloseTo(sourceToOutput(original, original.signals[index]), 9))
  })

  it('allows either split piece to extend back into the retained source', () => {
    const original = make({ start: 0 })
    const [left, right] = splitClip(original, 5, assets)
    expect(clipDuration(trimClip(left, 0, 8, assets))).toBe(8)
    const restoredRight = trimClip(right, 1, 12, assets)
    expect(restoredRight.start).toBe(1)
    expect(visibleAt(restoredRight, 0).time).toBe(1)
    const merged = mergeClips([left, right])
    for (const t of [0, 4.9, 5.1, 11.9]) expect(visibleAt(merged, t).time).toBeCloseTo(t)
  })

  it('treats a merged selection as its own full source rather than reintroducing omitted child footage', () => {
    const a = make({ id: 'a-cut', start: 0, segments: [{ mediaId: 'a', in: 2, out: 5 }], signals: [] })
    const b = make({ id: 'b-cut', start: 3, segments: [{ mediaId: 'b', in: 4, out: 8 }], signals: [] })
    const merged = mergeClips([a, b], assets)
    expect(editRange(merged, assets)).toMatchObject({ in: 0, out: 7, total: 7, canSlip: false })
    expect(clipDuration(resetSourceWindow(merged, assets))).toBe(7)
    const cut = trimClip(merged, 2, 5, assets)
    const restored = resetSourceWindow(cut, assets)
    expect(restored.start).toBe(0)
    expect(restored.segments.map(segment => [segment.mediaId, segment.in, segment.out])).toEqual([['a', 2, 5], ['b', 4, 8]])
  })

  it('preserves per-child manual audio beat selections when merging', () => {
    const a = make({ id: 'first', start: 0, segments: [{ mediaId: 'a', in: 0, out: 4 }], beatEdits: [.5, 1.5, 2.5], beatConfig: { every: 2 } })
    const b = make({ id: 'second', start: 4, segments: [{ mediaId: 'a', in: 4, out: 8 }], beatEdits: [1, 2] })
    expect(mergeClips([a, b], assets).beatEdits).toEqual([.5, 2.5, 5, 6])
  })

  it('slips source content without moving or resizing its timeline container', () => {
    const cut = trimClip(make(), 5, 10, assets)
    const shifted = slipClip(cut, 2, assets)
    expect(shifted.start).toBe(cut.start)
    expect(clipDuration(shifted)).toBeCloseTo(clipDuration(cut))
    expect(visibleAt(shifted, 0).time).toBe(5)
    expect(shifted.signals).toEqual([4])
    const atStart = slipClip(shifted, -100, assets)
    const atEnd = slipClip(shifted, 100, assets)
    expect(editRange(atStart, assets).in).toBe(0)
    expect(editRange(atEnd, assets).out).toBe(20)
    expect(clipDuration(atStart)).toBe(5)
    expect(clipDuration(atEnd)).toBe(5)
  })

  it('keeps a warped compound container fixed while slipping across a media boundary', () => {
    const original = alignClipToBeats(make({ start: 0, segments: [{ mediaId: 'a', in: 0, out: 6 }, { mediaId: 'b', in: 0, out: 6 }], signals: [0, 3, 9, 12] }), [1, 2, 5, 6])
    const cut = trimClip(original, 2, 4, assets)
    const slipped = slipClip(cut, 1, assets)
    expect(slipped.start).toBe(2)
    expect(clipDuration(slipped)).toBeCloseTo(2)
    for (let t = 0; t < 1.99; t += .19) {
      expect(visibleAt(slipped, t).time).toBeCloseTo(visibleAt(original, t + 2).time, 8)
      expect(visibleAt(slipped, t).mediaId).toBe(visibleAt(original, t + 2).mediaId)
    }
  })

  it('reconciles edited visible signals without losing hidden signals', () => {
    const cut = trimClip(make(), 5, 10, assets)
    const marked = { ...flattenClip(cut), signals: [2] }
    const restored = trimClip(marked, 2, 14, assets)
    expect(restored.signals).toEqual([1, 5, 9])
  })

  it('retains manual audio beats through repeated trim/restore and source slip', () => {
    const original = make({ beatEdits: [.5, 2, 4, 8, 10] })
    const cut = trimClip(original, 4, 10, assets)
    const restored = trimClip(cut, 2, 14, assets)
    expect(restored.beatEdits).toEqual(original.beatEdits)
    const slip = slipClip(cut, 1, assets)
    expect(slip.beatEdits).toEqual([1, 5])
  })

  it('preserves a new sync map and source handles after syncing a previously trimmed clip', () => {
    const cut = trimClip(make({ signals: [0, 3, 7, 12] }), 5, 14, assets)
    const synced = alignClipToBeats(cut, [3, 4, 7])
    expect(synced.signals.map(s => synced.start + sourceToOutput(synced, s))).toEqual([3, 4, 7])
    expect(synced.sourceWindow!.out - synced.sourceWindow!.in).toBeCloseTo(clipDuration(synced))
    const restored = resetSourceWindow(synced, assets)
    expect(restored.segments[0].in).toBe(0)
    expect(restored.segments.at(-1)?.out).toBe(20)
    expect(restored.start).toBeGreaterThanOrEqual(0)
  })

  it('uses explicit source range selection without moving clip.start', () => {
    const selected = setSourceWindow(make(), 4, 9, assets)
    expect(selected.start).toBe(2)
    expect(clipDuration(selected)).toBe(5)
    expect(visibleAt(selected, 0).time).toBe(4)
    const full = editSourceClip(selected, assets)
    expect(full.start).toBe(-2)
    expect(clipDuration(full)).toBe(20)
    expect(resetSourceWindow(selected, assets).start).toBe(0)
  })

  it('extends a still-image hold instead of treating its nominal duration as a hard file boundary', () => {
    const image = [{ ...assets[0], kind: 'image' as const, duration: 5, hasAudio: false }]
    const clip = make({ start: 0, segments: [{ mediaId: 'a', in: 0, out: 5 }], signals: [] })
    const longer = trimClip(clip, 0, 30, image)
    expect(clipDuration(longer)).toBe(30)
    expect(parseProject({ ...project(longer), media: image }).clips[0].sourceWindow?.out).toBe(30)
  })
})

describe('source-aware persistence and waveforms', () => {
  it('round-trips retained source and restores it after a saved project is reopened', () => {
    const edited = slipClip(trimClip(make(), 5, 10, assets), 1, assets)
    const loaded = parseProject(JSON.parse(JSON.stringify(project(edited)))).clips[0]
    expect(loaded.editSource).toMatchObject({ segments: edited.editSource!.segments, signals: edited.editSource!.signals })
    expect(loaded.sourceWindow).toEqual(edited.sourceWindow)
    expect(visibleAt(resetSourceWindow(loaded, assets), 0).time).toBe(0)
  })

  it('rejects malformed or unmatched retained windows before rendering', () => {
    const cut = trimClip(make(), 5, 10, assets)
    for (const changes of [
      { sourceWindow: undefined }, { sourceWindow: { in: 8, out: 7 } },
      { sourceWindow: { in: 0, out: 100 } }, { sourceWindow: { in: 0, out: 3 } },
      { editSource: { ...cut.editSource!, segments: [{ mediaId: 'missing', in: 0, out: 10 }] } },
    ]) expect(() => parseProject(project({ ...cut, ...changes }))).toThrow(/Invalid Pulse project/)
  })

  it('keeps waveform peaks at fixed source times when either edge changes', () => {
    const audio = [{ ...assets[0], kind: 'audio' as const, duration: 20, waveform: [0, 1] }]
    const original = make({ segments: [{ mediaId: 'a', in: 0, out: 20 }] })
    const cut = trimClip(original, 6, 12, audio)
    const rightExtended = trimClip(cut, 6, 17, audio)
    expect(sampleClipWaveform(cut, audio, [0, 1, 3, 5])).toEqual(sampleClipWaveform(rightExtended, audio, [0, 1, 3, 5]))
    const leftExtended = trimClip(cut, 3, 12, audio)
    expect(sampleClipWaveform(cut, audio, [0, 1, 3, 5])).toEqual(sampleClipWaveform(leftExtended, audio, [3, 4, 6, 8]))
  })
})

