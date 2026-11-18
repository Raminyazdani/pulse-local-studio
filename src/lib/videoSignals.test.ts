import { describe, expect, it } from 'vitest'
import { clipDuration, resetSourceWindow, resolveClipTime, slipClip, splitClip, trimClip } from './engine'
import { parseProject } from './project'
import { applyVideoSourceSignals, createVideoClipSignals, normalizeSourceSignals, quantizeVideoSignal, videoFrameRate } from './videoSignals'
import type { Clip, Media, Project } from './types'

const media: Media[] = [
  { id: 'a', name: 'A.mov', kind: 'video', duration: 12, hasAudio: true, url: '/api/files/a/proxy', fps: 30, sourceSignals: [0, 1, 2, 4, 8, 11] },
  { id: 'b', name: 'B.mov', kind: 'video', duration: 10, hasAudio: false, url: '/api/files/b/proxy', sourceSignals: [1, 3] },
]
const make = (patch: Partial<Clip> = {}): Clip => ({
  id: 'clip', name: 'Clip', trackId: 'video', start: 3,
  segments: [{ mediaId: 'a', in: 0, out: 12 }], signals: [.5, 9], muted: true, volume: .7, ...patch,
})
const project = (clip: Clip, assets = media): Project => ({
  id: 'project', name: 'Video labels', version: 1, media: assets,
  tracks: [{ id: 'video', name: 'Video', kind: 'video', muted: false, hidden: false, locked: false }], clips: [clip],
})

describe('source video label timing', () => {
  it('quantizes frame edits without ever returning media EOF, including fractional frame rates', () => {
    expect(videoFrameRate({ fps: 0 })).toBe(30)
    expect(videoFrameRate({ fps: NaN })).toBe(30)
    expect(videoFrameRate({ fps: 29.97 })).toBe(29.97)
    expect(quantizeVideoSignal(-5, 1, 30)).toBe(0)
    expect(quantizeVideoSignal(20, 1, 30)).toBe(29 / 30)
    expect(quantizeVideoSignal(.0501, 1, 30)).toBe(2 / 30)
    expect(quantizeVideoSignal(99, 1.001, 30)).toBe(1)
    for (const fps of [23.976, 29.97, 59.94, 120]) {
      const time = quantizeVideoSignal(50, 1, fps)
      expect(time).toBeLessThan(1)
      expect(time * fps).toBeCloseTo(Math.round(time * fps), 10)
    }
    expect(() => quantizeVideoSignal(NaN, 1)).toThrow()
    expect(() => quantizeVideoSignal(0, 0)).toThrow()
  })

  it('keeps exact decoded timestamps while canonicalizing draft order and duplicates', () => {
    const presented = .999999
    expect(normalizeSourceSignals([presented, .2, .2 + 1e-8, 0], 1)).toEqual([0, .2, presented])
    // Deduplication is anchored to the last retained value, matching the API.
    // A chain of individually close values must not erase a later distinct one.
    expect(normalizeSourceSignals([0, .6e-7, 1.2e-7], 1)).toEqual([0, 1.2e-7])
    expect(normalizeSourceSignals([1, 1 + .6e-7, 1 + 1.2e-7], 2)).toEqual([1, 1 + 1.2e-7])
    for (const values of [[1], [-.1], [Infinity], [NaN]]) expect(() => normalizeSourceSignals(values, 1)).toThrow()
    expect(normalizeSourceSignals([], 0)).toEqual([])
  })

  it('maps half-open source spans through trims, speeds, compound order and repeated files', () => {
    const spans = [{ mediaId: 'a', in: 2, out: 8, speed: 2 }, { mediaId: 'b', in: 0, out: 4 }, { mediaId: 'a', in: 0, out: 2, speed: .5 }]
    expect(createVideoClipSignals(media, spans)).toEqual([0, 1, 4, 6, 7, 9])
    expect(createVideoClipSignals([{ ...media[0], sourceSignals: undefined }], spans)).toEqual([])
    expect(() => createVideoClipSignals(media, [{ mediaId: 'a', in: 1, out: 3, speed: 0 }])).toThrow()
  })
})

describe('applying reusable labels to timeline occurrences', () => {
  it('replaces source labels without changing originals or an unrelated occurrence', () => {
    const original = make(), old = JSON.stringify(original), assets = JSON.stringify(media)
    const result = applyVideoSourceSignals(original, media, 'a', [10, 1, 4])
    expect(result.signals).toEqual([1, 4, 10])
    expect(result.editSource?.signals).toEqual([1, 4, 10])
    expect(result.start).toBe(original.start)
    expect(result.volume).toBe(.7)
    expect(result.muted).toBe(true)
    expect(JSON.stringify(original)).toBe(old)
    expect(JSON.stringify(media)).toBe(assets)
    const unrelated = make({ segments: [{ mediaId: 'b', in: 0, out: 4 }] })
    expect(applyVideoSourceSignals(unrelated, media, 'a', [1])).toBe(unrelated)
  })

  it('keeps hidden labels and exact crop-boundary labels available after slip, split and restore', () => {
    const cut = trimClip(make(), 5, 9, media) // A[2..6], including a signal exactly on the crop end.
    const applied = applyVideoSourceSignals(cut, media, 'a', [1, 3, 6, 10])
    expect(applied.sourceWindow).toEqual({ in: 2, out: 6 })
    expect(applied.signals).toEqual([1, 4])
    expect(resetSourceWindow(applied, media).signals).toEqual([1, 3, 6, 10])
    expect(slipClip(applied, 2, media).signals).toEqual([2])
    const split = splitClip(applied, 7, media)
    for (const child of split) expect(resetSourceWindow(child, media).signals).toEqual([1, 3, 6, 10])
    expect(resetSourceWindow(parseProject(JSON.parse(JSON.stringify(project(applied)))).clips[0], media).signals).toEqual([1, 3, 6, 10])
  })

  it('updates every repeated target-file span and preserves manual markers belonging to other files', () => {
    const original = make({ segments: [{ mediaId: 'a', in: 0, out: 4 }, { mediaId: 'b', in: 0, out: 4 }, { mediaId: 'a', in: 4, out: 8 }],
      signals: [.5, 4, 4.5, 6, 9, 12] })
    const result = applyVideoSourceSignals(original, media, 'a', [1, 3, 5, 7])
    expect(result.signals).toEqual([1, 3, 4, 4.5, 6, 9, 11])
    expect(result.segments).toEqual(original.segments)
    expect(applyVideoSourceSignals(result, media, 'a', []).signals).toEqual([4, 4.5, 6])
  })

  it('bakes the old sync map while preserving every physical source time and instantaneous rate', () => {
    const warped = make({ signals: [2, 8], warp: [{ source: 0, target: 0 }, { source: 4, target: 2 }, { source: 12, target: 10 }] })
    const result = applyVideoSourceSignals(warped, media, 'a', [1, 4, 9])
    expect(result.warp).toBeUndefined()
    expect(result.signals).toEqual([.5, 2, 7])
    expect(clipDuration(result)).toBe(clipDuration(warped))
    for (const time of [0, .1, 1.99, 2, 4.9, 9.99]) {
      const before = resolveClipTime(warped, time)!, after = resolveClipTime(result, time)!
      expect(after.time).toBeCloseTo(before.time, 10)
      expect(after.speed).toBeCloseTo(before.speed, 10)
      expect(after.muted).toBe(before.muted)
      expect(after.volume).toBe(before.volume)
    }
  })

  it('reconciles warped visible ranges with untouched hidden composition before replacing labels', () => {
    const cropped = trimClip(make(), 5, 11, media) // A[2..8], initially six seconds.
    const warped = { ...cropped, warp: [{ source: 0, target: 0 }, { source: 3, target: 1 }, { source: 6, target: 5 }] }
    const result = applyVideoSourceSignals(warped, media, 'a', [1, 3, 5, 8, 9, 11])
    expect(result.sourceWindow).toEqual({ in: 2, out: 7 })
    expect(result.signals[0]).toBeCloseTo(1 / 3, 10)
    expect(result.signals.slice(1)).toEqual([1, 5])
    const restored = resetSourceWindow(result, media)
    expect(restored.signals[0]).toBe(1)
    expect(restored.signals.slice(-2)).toEqual([8, 10])
    for (const time of [0, .1, .99, 1, 3.5, 4.99]) {
      expect(resolveClipTime(result, time)!.time).toBeCloseTo(resolveClipTime(warped, time)!.time, 10)
      expect(resolveClipTime(result, time)!.speed).toBeCloseTo(resolveClipTime(warped, time)!.speed, 10)
    }
    expect(parseProject(JSON.parse(JSON.stringify(project(result)))).clips[0].sourceWindow).toEqual(result.sourceWindow)
  })
})

describe('source label project compatibility', () => {
  it('round-trips source labels and accepts older projects without them', () => {
    expect(parseProject(project(make())).media[0].sourceSignals).toEqual(media[0].sourceSignals)
    expect(parseProject(project(make(), media.map(asset => ({ ...asset, sourceSignals: undefined })))).media[0].sourceSignals).toBeUndefined()
  })

  it('rejects non-video labels and invalid, duplicate, unordered or endpoint labels', () => {
    for (const labels of [[12], [NaN], [Infinity], [-1], [2, 1], [1, 1], [1, 1 + 1e-8]])
      expect(() => parseProject(project(make(), [{ ...media[0], sourceSignals: labels }, media[1]]))).toThrow(/source signals/)
    const image = { ...media[1], kind: 'image' as const, sourceSignals: [] }
    expect(() => parseProject(project(make(), [media[0], image]))).toThrow(/only valid for video/)
    const audio = { ...media[1], kind: 'audio' as const, sourceSignals: [] }
    expect(() => parseProject(project(make(), [media[0], audio]))).toThrow(/only valid for video/)
  })
})
