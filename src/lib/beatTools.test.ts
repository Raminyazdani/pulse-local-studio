import { describe, expect, it } from 'vitest'
import {
  availableBeatGroups, canonicalClipBeats, clipBeatTimes, clipBeats, clipDuration,
  deleteClipBeats, generateRepeatedBeats, repeatClipBeats, replaceClipBeats,
  resetSourceWindow, resolveClipTime, selectedBeatInterval, trimClip,
} from './engine'
import { canonicalBeats, visibleBeats } from '../editor'
import { parseProject } from './project'
import type { Clip, Media, Project } from './types'

const asset: Media = {
  id: 'music', name: 'Bass and hats.wav', kind: 'audio', duration: 8, hasAudio: true,
  url: '/api/files/music/proxy', beats: [.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
  beatGroups: [
    { id: 'group-1', label: 'Bass-heavy', beatIndices: [0, 2, 4, 6], sampleTime: .5, bassScore: .95 },
    { id: 'group-2', label: 'Bright attack', beatIndices: [1, 3, 5, 7], sampleTime: 1, bassScore: .1 },
  ],
}
const make = (patch: Partial<Clip> = {}): Clip => ({ id: 'audio', name: 'Soundtrack', trackId: 'audio-track', start: 4,
  segments: [{ mediaId: asset.id, in: 0, out: 8 }], signals: [], muted: false, volume: 1, ...patch })
const project = (clip: Clip, media: Media[] = [asset]): Project => ({ id: 'beat-project', name: 'Beat precision', version: 1,
  media, tracks: [{ id: 'audio-track', name: 'Music', kind: 'audio', muted: false, hidden: false, locked: false }], clips: [clip] })

describe('acoustic group selection', () => {
  it('filters acoustic membership before applying every-N or custom sampling', () => {
    const clip = make({ beatConfig: { enabledGroups: ['music:group-1'], every: 2 } })
    expect(clipBeats(clip, [asset])).toEqual([.5, 2.5])
    expect(clipBeats({ ...clip, beatConfig: { enabledGroups: ['music:group-1'], pattern: '01' } }, [asset])).toEqual([1.5, 3.5])
    expect(canonicalBeats(clip, [asset])).toEqual(asset.beats)
    expect(visibleBeats(clip, project(clip))).toEqual([4.5, 6.5])
    expect(clipBeats(make({ beatConfig: { enabledGroups: [] } }), [asset])).toEqual([])
    expect(clipBeats(make(), [asset])).toEqual(asset.beats)
  })

  it('maps selected groups through source trims, segment speed and a warp', () => {
    const clip = make({ segments: [{ mediaId: 'music', in: 1, out: 3, speed: 2 }],
      warp: [{ source: 0, target: 0 }, { source: 1, target: 2 }], beatConfig: { enabledGroups: ['music:group-1'] } })
    expect(canonicalClipBeats(clip, [asset], true)).toEqual([.25, .75])
    expect(clipBeatTimes(clip, [asset])).toEqual([4.5, 5.5])
    expect(availableBeatGroups(clip, [asset])).toMatchObject([
      { key: 'music:group-1', mediaId: 'music', label: 'Bass-heavy', count: 2, beats: [.25, .75], sampleTime: .5, bassScore: .95 },
      { key: 'music:group-2', count: 2, beats: [0, .5] },
    ])
  })

  it('qualifies duplicate group IDs by asset and counts repeated source occurrences', () => {
    const other = { ...asset, id: 'second' }
    const clip = make({ segments: [{ mediaId: 'music', in: 0, out: 2 }, { mediaId: 'second', in: 0, out: 2 }, { mediaId: 'music', in: 0, out: 2 }],
      beatConfig: { enabledGroups: ['second:group-1'] } })
    expect(clipBeats(clip, [asset, other])).toEqual([2.5, 3.5])
    const rows = availableBeatGroups(clip, [asset, other])
    expect(rows.find(row => row.key === 'music:group-1')!.beats).toEqual([.5, 1.5, 4.5, 5.5])
    expect(rows.find(row => row.key === 'second:group-1')!.count).toBe(2)
  })

  it('keeps old analyzed projects usable and manual markers independent of groups', () => {
    const legacy = { ...asset, beatGroups: undefined }
    expect(availableBeatGroups(make(), [legacy])[0]).toMatchObject({ key: 'music:unclassified', label: 'Unclassified beats', count: 8 })
    expect(clipBeats(make({ beatConfig: { enabledGroups: ['music:unclassified'] } }), [legacy])).toEqual(asset.beats)
    expect(clipBeats(make({ beatEdits: [.3, .8], beatConfig: { enabledGroups: [] } }), [asset])).toEqual([.3, .8])
    expect(clipBeats(make({ beatEdits: [] }), [asset])).toEqual([])
  })
})

describe('precise filter and repeat', () => {
  it('infers regular spacing and a longer cycle for an entire motif', () => {
    expect(selectedBeatInterval([2.5, .5, 1, 1.5, 2])).toBe(.5)
    expect(selectedBeatInterval([.2, .45, .7], 'pattern')).toBeCloseTo(.75)
    expect(selectedBeatInterval([.5])).toBeUndefined()
  })

  it('uses the selected phase across the whole clip and can start at the selection instead', () => {
    expect(generateRepeatedBeats([1.2], 2, { period: .5 })).toEqual([.2, .7, 1.2, 1.7])
    expect(generateRepeatedBeats([1.2], 2, { period: .5, fillBefore: false })).toEqual([1.2, 1.7])
    expect(generateRepeatedBeats([.5, 1], 2, { period: .5 })).toEqual([0, .5, 1, 1.5])
  })

  it('preserves non-uniform selected offsets in pattern mode', () => {
    expect(generateRepeatedBeats([.2, .45], 2, { period: 1, mode: 'pattern' })).toEqual([.2, .45, 1.2, 1.45])
    expect(() => generateRepeatedBeats([.2, .8], 2, { period: .5, mode: 'pattern' })).toThrow(/longer/)
  })

  it('does not accumulate floating point drift or emit a marker at the clip end', () => {
    const result = generateRepeatedBeats([.3, .4], 10, { period: .1 })
    expect(result).toHaveLength(100)
    expect(result[0]).toBe(0)
    expect(result.at(-1)).toBe(9.9)
    result.forEach((value, index) => expect(value).toBe(index / 10))
    expect(generateRepeatedBeats([0], 3, { period: 1 / 3 })).toHaveLength(9)
  })

  it('rejects missing selections, invalid periods and runaway marker counts', () => {
    for (const selected of [[], [NaN], [-1], [2]])
      expect(() => generateRepeatedBeats(selected, 2, { period: .5 })).toThrow()
    for (const period of [0, -1, NaN, Infinity, 1e-20])
      expect(() => generateRepeatedBeats([0], 8, { period })).toThrow()
    expect(() => generateRepeatedBeats([0], 86401, { period: 1 })).toThrow()
  })

  it('replaces filtered detected markers and prevents hidden old markers returning after restore', () => {
    const cut = trimClip(make({ beatEdits: [.5, 1, 2, 3, 5, 7] }), 5, 8, [asset])
    const result = repeatClipBeats(cut, [.25, .75], { period: .5 }, [asset])
    expect(result.beatEdits).toEqual([.25, .75, 1.25, 1.75, 2.25, 2.75])
    expect(result.beatConfig).toEqual({ every: 1, offset: 0 })
    const reopened = parseProject(JSON.parse(JSON.stringify(project(result)))).clips[0]
    const restored = resetSourceWindow(reopened, [asset])
    expect(restored.beatEdits).toEqual([1.25, 1.75, 2.25, 2.75, 3.25, 3.75])
    expect(restored.beatEdits).not.toContain(5)
    expect(restored.beatEdits).not.toContain(7)
  })

  it('deletes selected displayed output markers without changing a warped audio edit', () => {
    const clip = make({ segments: [{ mediaId: 'music', in: 0, out: 4 }], signals: [1],
      warp: [{ source: 0, target: 0 }, { source: 2, target: 1 }, { source: 4, target: 3 }],
      beatConfig: { enabledGroups: ['music:group-1'], every: 1 } })
    const before = clipBeatTimes(clip, [asset]).map(time => time - clip.start)
    const result = deleteClipBeats(clip, [before[1], before[3]], [asset])
    expect(clipBeatTimes(result, [asset]).map(time => time - result.start)).toEqual([before[0], before[2]])
    expect(clipDuration(result)).toBe(clipDuration(clip))
    expect(result.warp).toBeUndefined()
    expect(result.signals).toEqual([.5])
    for (const time of [0, .4, .9, 1.1, 2.8]) {
      expect(resolveClipTime(result, time)!.time).toBeCloseTo(resolveClipTime(clip, time)!.time, 9)
      expect(resolveClipTime(result, time)!.speed).toBeCloseTo(resolveClipTime(clip, time)!.speed, 9)
    }
  })

  it('supports deleting every marker and rejects stale or out-of-range marker edits', () => {
    expect(deleteClipBeats(make(), asset.beats!, [asset]).beatEdits).toEqual([])
    expect(() => deleteClipBeats(make(), [.37], [asset])).toThrow(/no longer visible/)
    expect(() => replaceClipBeats(make(), [8], [asset])).toThrow(/inside/)
    expect(() => deleteClipBeats(make(), [], [asset])).toThrow(/Select/)
  })
})

describe('beat group project persistence', () => {
  it('round-trips group samples, confidence and checkbox selection without altering membership', () => {
    const clip = make({ beatConfig: { enabledGroups: ['music:group-1'], every: 2 } })
    const loaded = parseProject(JSON.parse(JSON.stringify(project(clip))))
    expect(loaded.media[0].beatGroups).toEqual(asset.beatGroups)
    expect(loaded.clips[0].beatConfig).toEqual({ ...clip.beatConfig, offset: 0 })
    expect(clipBeats(loaded.clips[0], loaded.media)).toEqual([.5, 2.5])
    expect(parseProject(project(make({ beatConfig: { enabledGroups: [] } }))).clips[0].beatConfig?.enabledGroups).toEqual([])
  })

  it('rejects malformed memberships, samples and group checkbox values', () => {
    for (const patch of [
      { beatIndices: [0, 999] }, { beatIndices: [0, 0] }, { beatIndices: [.5] }, { beatIndices: [] },
      { sampleTime: 1 }, { sampleTime: 8 }, { bassScore: 2 }, { id: 'group-2' },
    ]) {
      const broken = { ...asset, beatGroups: [{ ...asset.beatGroups![0], ...patch }, asset.beatGroups![1]] }
      expect(() => parseProject(project(make(), [broken]))).toThrow(/Invalid Pulse project/)
    }
    expect(() => parseProject(project(make({ beatConfig: { enabledGroups: ['music:group-1', 'music:group-1'] } })))).toThrow()
    expect(() => parseProject(project(make(), [{ ...asset, beats: [...asset.beats!].reverse() }]))).toThrow(/ordered/)
    expect(() => parseProject(project(make(), [{ ...asset, beatGroups: [asset.beatGroups![0]] }]))).toThrow(/cover/)
    expect(parseProject(project(make(), [{ ...asset, beatGroups: undefined }])).media[0].beatGroups).toBeUndefined()
  })
})
