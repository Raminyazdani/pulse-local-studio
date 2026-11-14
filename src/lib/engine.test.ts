import { describe, expect, it } from 'vitest'
import {
  addSignal, alignClipToBeats, clipBeats, clipBeatTimes, clipDuration, clipWaveform, flattenClip,
  mergeClips, outputToSource, projectDuration, resolveClipTime, selectBeats,
  sourceDuration, sourceToOutput, splitClip, trimClip,
} from './engine'
import type { Clip, Media } from './types'

const makeClip = (changes: Partial<Clip> = {}): Clip => ({
  id: 'clip-1', name: 'Camera', trackId: 'video-1', start: 2,
  segments: [{ mediaId: 'video', in: 10, out: 22 }], signals: [], muted: false, volume: 1,
  ...changes,
})

describe('beat sampling', () => {
  it('keeps all beats or one in every N with a zero-based phase', () => {
    const beats = [0, 1, 2, 3, 4, 5, 6]
    expect(selectBeats(beats)).toEqual(beats)
    expect(selectBeats(beats, { every: 2 })).toEqual([0, 2, 4, 6])
    expect(selectBeats(beats, { every: 3, offset: 1 })).toEqual([1, 4])
  })

  it('supports repeating, custom keep/drop patterns', () => {
    expect(selectBeats([0, 1, 2, 3, 4, 5, 6], { pattern: '1,0,1' })).toEqual([0, 2, 3, 5, 6])
    expect(selectBeats([0, 1, 2, 3], { pattern: [0, 1] })).toEqual([1, 3])
  })

  it('normalizes unsorted duplicates and invalid timestamps', () => {
    expect(selectBeats([3, NaN, 1, 1, -1, Infinity, 2])).toEqual([1, 2, 3])
  })

  it('rejects empty patterns and invalid phases', () => {
    expect(() => selectBeats([1, 2], { pattern: '000' })).toThrow(/at least one 1/)
    expect(() => selectBeats([1, 2], { every: 2, offset: 2 })).toThrow(/offset/)
    expect(() => selectBeats([1, 2], { pattern: '1x0' })).toThrow(/pattern/)
  })
})

describe('piecewise beat alignment', () => {
  it('maps each video signal exactly to its paired music beat at different speeds', () => {
    const clip = makeClip({ signals: [0, 3, 7, 12] })
    const aligned = alignClipToBeats(clip, [1, 2, 4, 5, 9, 12])
    expect(aligned.start).toBe(1)
    expect(aligned.signals.map(signal => aligned.start + sourceToOutput(aligned, signal))).toEqual([1, 2, 4, 5])
    expect(clipDuration(aligned)).toBe(4)
    expect(resolveClipTime(aligned, 0.5)?.speed).toBe(3)
    expect(resolveClipTime(aligned, 2)?.speed).toBe(2)
    expect(resolveClipTime(aligned, 3.5)?.speed).toBe(5)
  })

  it('uses the first/last interval speed for unmarked prefix/suffix', () => {
    const clip = makeClip({ signals: [2, 6, 10] })
    const aligned = alignClipToBeats(clip, [3, 5, 6])
    expect(aligned.start).toBe(2)
    expect(aligned.warp?.[0]).toEqual({ source: 0, target: 0 })
    expect(aligned.warp?.at(-1)).toEqual({ source: 12, target: 4.5 })
    expect(aligned.signals.map(signal => aligned.start + sourceToOutput(aligned, signal))).toEqual([3, 5, 6])
  })

  it('inverts the mapping over every interval and extrapolates consistently', () => {
    const aligned = alignClipToBeats(makeClip({ signals: [0, 2, 5, 12] }), [1, 2.2, 8.7, 10])
    for (let i = -20; i < 150; i++) {
      const time = i / 10
      expect(outputToSource(aligned, sourceToOutput(aligned, time))).toBeCloseTo(time, 10)
    }
  })

  it('replaces rather than compounds the previous alignment', () => {
    const original = makeClip({ signals: [0, 3, 12] })
    const twice = alignClipToBeats(alignClipToBeats(original, [0, 2, 8]), [2, 3, 5])
    expect(twice.signals.map(signal => twice.start + sourceToOutput(twice, signal))).toEqual([2, 3, 5])
  })

  it('requires enough distinct signals and beats and avoids a negative clip start', () => {
    expect(() => alignClipToBeats(makeClip({ signals: [1] }), [1, 2])).toThrow(/at least two/)
    expect(() => alignClipToBeats(makeClip({ signals: [0, 1, 2] }), [1, 2])).toThrow(/only 2/)
    expect(() => alignClipToBeats(makeClip({ signals: [3, 6] }), [0, 2])).toThrow(/too early/)
  })

  it('adds a source-stable marker at the current warped output time', () => {
    const clip = alignClipToBeats(makeClip({ signals: [0, 6, 12] }), [2, 4, 8])
    const marked = addSignal(clip, 3)
    expect(marked.signals).toEqual([0, 3, 6, 12])
    expect(() => addSignal(clip, 20)).toThrow(/inside/)
  })
})

describe('source resolution and nondestructive edits', () => {
  it('resolves media transitions at exact segment boundaries', () => {
    const clip = makeClip({ segments: [{ mediaId: 'a', in: 4, out: 8, speed: 2 }, { mediaId: 'b', in: 10, out: 20 }] })
    expect(sourceDuration(clip)).toBe(12)
    expect(resolveClipTime(clip, 1)).toMatchObject({ mediaId: 'a', time: 6, speed: 2 })
    expect(resolveClipTime(clip, 2)).toMatchObject({ mediaId: 'b', time: 10, speed: 1 })
    expect(resolveClipTime(clip, 12)).toBeNull()
    expect(resolveClipTime(clip, -1)).toBeNull()
  })

  it('flattens speed changes across segment boundaries without changing the picture', () => {
    const clip = makeClip({
      segments: [{ mediaId: 'a', in: 4, out: 14, speed: 2 }, { mediaId: 'b', in: 10, out: 17 }],
      signals: [0, 3, 8, 12],
    })
    const warped = alignClipToBeats(clip, [2, 4, 8, 9])
    const flat = flattenClip(warped)
    expect(flat.warp).toBeUndefined()
    expect(clipDuration(flat)).toBeCloseTo(clipDuration(warped), 10)
    for (let time = 0; time < clipDuration(warped) - 0.001; time += 0.137) {
      const before = resolveClipTime(warped, time)!
      const after = resolveClipTime(flat, time)!
      expect(after.mediaId).toBe(before.mediaId)
      expect(after.time).toBeCloseTo(before.time, 9)
      expect(after.speed).toBeCloseTo(before.speed, 9)
    }
    expect(flat.signals).toEqual([0, 2, 6, 7])
  })

  it('trims a warped compound clip while preserving source positions and exact speed', () => {
    const clip = alignClipToBeats(makeClip({ signals: [0, 3, 8, 12] }), [2, 3, 7, 8])
    const trimmed = trimClip(clip, 2.5, 7.5)
    expect(trimmed.start).toBe(2.5)
    expect(clipDuration(trimmed)).toBeCloseTo(5)
    for (let time = 0; time < 5; time += 0.17) {
      expect(resolveClipTime(trimmed, time)?.time).toBeCloseTo(resolveClipTime(clip, time + 0.5)!.time, 9)
    }
    expect(trimmed.signals).toEqual([0.5, 4.5])
  })

  it('splits a warped clip then merges back with identical source motion', () => {
    const clip = alignClipToBeats(makeClip({ signals: [0, 3, 8, 12] }), [2, 3, 7, 8])
    const [left, right] = splitClip(clip, 4.25)
    expect(left.id).toBe(clip.id)
    expect(right.id).not.toBe(clip.id)
    expect(left.start + clipDuration(left)).toBeCloseTo(right.start)
    expect(clipDuration(left) + clipDuration(right)).toBeCloseTo(clipDuration(clip))
    const merged = mergeClips([right, left])
    for (let time = 0; time < clipDuration(clip); time += 0.17) {
      expect(resolveClipTime(merged, time)?.time).toBeCloseTo(resolveClipTime(clip, time)!.time, 9)
    }
  })

  it('concatenates clips chronologically, closes gaps and preserves per-clip mute/volume', () => {
    const a = makeClip({ id: 'a', start: 1, muted: true, segments: [{ mediaId: 'a', in: 0, out: 2 }], signals: [1] })
    const b = makeClip({ id: 'b', start: 8, volume: 0.4, segments: [{ mediaId: 'b', in: 0, out: 3, volume: 0.5 }], signals: [2] })
    const merged = mergeClips([b, a])
    expect(merged.start).toBe(1)
    expect(clipDuration(merged)).toBe(5)
    expect(merged.signals).toEqual([1, 4])
    expect(resolveClipTime(merged, 1)?.muted).toBe(true)
    expect(resolveClipTime(merged, 3)?.volume).toBeCloseTo(0.2)
    expect(a.segments[0].muted).toBeUndefined()
  })

  it('does not split edges, merge different tracks, or accept reversed trim bounds', () => {
    const clip = makeClip()
    expect(() => splitClip(clip, clip.start)).toThrow(/inside/)
    expect(() => mergeClips([clip, makeClip({ trackId: 'other' })])).toThrow(/one track/)
    expect(() => trimClip(clip, 6, 5)).toThrow(/nonempty/)
  })

  it('reports true total project length including gaps', () => {
    expect(projectDuration({ clips: [makeClip(), makeClip({ start: 20, segments: [{ mediaId: 'b', in: 0, out: 2 }] })] })).toBe(22)
  })
})

describe('music beat mapping', () => {
  const media: Media[] = [{ id: 'music', name: 'song', kind: 'audio', duration: 20, hasAudio: true, url: '', beats: [0, 1, 2, 3, 4, 5, 6, 7, 8] }]

  it('accounts for source trims, compound offsets and source speed before sampling', () => {
    const clip = makeClip({ segments: [{ mediaId: 'music', in: 2, out: 5, speed: 2 }, { mediaId: 'music', in: 6, out: 9 }], beatConfig: { every: 2 } })
    expect(clipBeats(clip, media)).toEqual([0, 1, 2.5])
    expect(clipBeatTimes(clip, media)).toEqual([2, 3, 4.5])
  })

  it('uses manual beat edits as the pre-pattern source of truth', () => {
    const clip = makeClip({ beatEdits: [0.25, 1.5, 3], beatConfig: { every: 2 } })
    expect(clipBeats(clip, media)).toEqual([0.25, 3])
  })

  it('rebases manually edited beats when trimming and flattening', () => {
    const clip = alignClipToBeats(makeClip({ signals: [0, 6, 12], beatEdits: [1, 4, 7, 10] }), [2, 4, 8])
    const trimmed = trimClip(clip, 3, 7)
    expect(trimmed.beatEdits).toHaveLength(3)
    expect(trimmed.beatEdits?.[0]).toBeCloseTo(1 / 3)
    expect(trimmed.beatEdits?.[2]).toBeCloseTo(11 / 3)
  })

  it('draws the actual trimmed and compound source waveform at each output position', () => {
    const assets: Media[] = [
      { id: 'a', name: 'a', kind: 'audio', duration: 10, hasAudio: true, url: '', waveform: [0, 1] },
      { id: 'b', name: 'b', kind: 'audio', duration: 10, hasAudio: true, url: '', waveform: [1, 0] },
    ]
    const clip = makeClip({ segments: [{ mediaId: 'a', in: 5, out: 10 }, { mediaId: 'b', in: 0, out: 5 }] })
    expect(clipWaveform(clip, assets, 2)).toEqual([0.75, 0.75])
  })
})
