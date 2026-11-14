import { describe, expect, it } from 'vitest'
import { alignClipToBeats } from './engine'
import { parseProject } from './project'
import type { Project } from './types'

const project = (): Project => ({
  id: 'project', name: 'My edit', version: 1, aspect: '16:9',
  media: [{ id: 'video', name: 'camera.mp4', kind: 'video', url: '/api/files/video/proxy', duration: 20, hasAudio: true }],
  tracks: [{ id: 'track', name: 'Video', kind: 'video', muted: false, hidden: false, locked: false }],
  clips: [{ id: 'clip', name: 'clip', trackId: 'track', start: 1, segments: [{ mediaId: 'video', in: 2, out: 14 }], signals: [0, 3, 12], muted: false, volume: 1 }],
})

describe('project persistence validation', () => {
  it('round-trips an actual aligned edit including nullable BPM and optional metadata', () => {
    const value = project()
    value.clips[0] = alignClipToBeats(value.clips[0], [2, 3.25, 8])
    value.media[0].bpm = null
    value.media[0].waveform = [0, 0.2, 1]
    value.clips[0].beatConfig = { every: 2, offset: 1, pattern: '101' }
    const restored = parseProject(JSON.parse(JSON.stringify(value)))
    expect(restored.clips[0].warp).toEqual(value.clips[0].warp)
    expect(restored.media[0].bpm).toBeNull()
    expect(restored.clips[0].segments[0].speed).toBe(1)
  })

  it('accepts an empty project and fills earlier optional defaults', () => {
    expect(parseProject({ id: 'x', name: '', media: [], tracks: [], clips: [] })).toEqual({ id: 'x', name: '', version: 1, aspect: '16:9', media: [], tracks: [], clips: [] })
  })

  it('accepts backend audio metadata with zero video dimensions and frame rate', () => {
    const value = project()
    value.media[0] = { ...value.media[0], kind: 'audio', width: 0, height: 0, fps: 0, bpm: null }
    value.tracks[0].kind = 'audio'
    expect(parseProject(value).media[0].width).toBe(0)
  })

  it('restores a full backend-shaped audio autosave with a null thumbnail URL', () => {
    const value = {
      id: 'backend-project', name: 'Music edit', version: 1, aspect: '16:9',
      media: [{
        id: 'audio-1', name: 'soundtrack.flac', kind: 'audio', duration: 41.632,
        width: 0, height: 0, fps: 0, hasAudio: true,
        waveform: [0, 0.25, 0.9, 1, 0.3], beats: [0.13, 0.63, 1.13, 1.63], bpm: null,
        size: 1504304, created: 1794680000.35,
        originalUrl: '/api/files/audio-1/original', thumbnailUrl: null,
        proxyUrl: '/api/files/audio-1/proxy', url: '/api/files/audio-1/proxy',
      }],
      tracks: [{ id: 'music', name: 'Soundtrack', kind: 'audio', muted: false, hidden: false, locked: false }],
      clips: [{
        id: 'music-clip', name: 'soundtrack.flac', trackId: 'music', start: 0,
        segments: [{ mediaId: 'audio-1', in: 0, out: 41.632, speed: 1 }],
        signals: [], muted: false, volume: 0.8, beatConfig: { every: 2, offset: 0 },
      }],
    }
    // The app uses this JSON stringify/parse path for both autosave and project files.
    const restored = parseProject(JSON.parse(JSON.stringify(value)))
    expect(restored.media[0].thumbnailUrl).toBeUndefined()
    expect(restored.media[0]).toMatchObject({ kind: 'audio', width: 0, height: 0, fps: 0, bpm: null, beats: value.media[0].beats })
    expect(restored.clips[0]).toMatchObject({ start: 0, volume: 0.8, beatConfig: { every: 2, offset: 0 } })
    expect(parseProject(JSON.parse(JSON.stringify(restored)))).toEqual(restored)
  })

  it('normalizes all nullable optional media URLs without accepting invalid non-string URLs', () => {
    const value = { ...project(), media: [{ ...project().media[0], thumbnailUrl: null, proxyUrl: null, originalUrl: null }] }
    const restored = parseProject(value)
    expect(restored.media[0].thumbnailUrl).toBeUndefined()
    expect(restored.media[0].proxyUrl).toBeUndefined()
    expect(restored.media[0].originalUrl).toBeUndefined()
    expect(() => parseProject({ ...value, media: [{ ...value.media[0], thumbnailUrl: 3 }] })).toThrow(/thumbnailUrl/)
  })

  it.each([null, [], 'text', { media: true, tracks: [], clips: [] }])('rejects invalid root data %j', value => {
    expect(() => parseProject(value)).toThrow(/Invalid Pulse project/)
  })

  it('rejects non-finite times, negative source ranges, empty spans, and zero speed', () => {
    for (const patch of [{ in: NaN }, { in: -1 }, { in: 5, out: 4 }, { speed: 0 }, { speed: Infinity }]) {
      const value = project()
      Object.assign(value.clips[0].segments[0], patch)
      expect(() => parseProject(value)).toThrow(/Invalid Pulse project/)
    }
  })

  it('rejects missing media/track references and duplicate clip IDs', () => {
    const missingMedia = project(); missingMedia.media = []
    expect(() => parseProject(missingMedia)).toThrow(/missing media/)
    const missingTrack = project(); missingTrack.tracks = []
    expect(() => parseProject(missingTrack)).toThrow(/missing track/)
    const duplicate = project(); duplicate.clips.push({ ...duplicate.clips[0] })
    expect(() => parseProject(duplicate)).toThrow(/duplicate IDs/)
  })

  it('rejects source spans beyond file duration but allows arbitrary still-image holds', () => {
    const value = project(); value.clips[0].segments[0].out = 30
    expect(() => parseProject(value)).toThrow(/past its source/)
    value.media[0].kind = 'image'
    expect(parseProject(value).clips[0].segments[0].out).toBe(30)
  })

  it('round-trips a 30-second image hold when the library thumbnail has a nominal 5-second duration', () => {
    const value = project()
    value.media[0] = { ...value.media[0], kind: 'image', duration: 5, hasAudio: false, width: 1920, height: 1080, fps: 0 }
    value.clips[0].segments = [{ mediaId: 'video', in: 0, out: 30, speed: 1 }]
    const restored = parseProject(JSON.parse(JSON.stringify(value)))
    expect(restored.media[0].duration).toBe(5)
    expect(restored.clips[0].segments[0].out).toBe(30)
    expect(parseProject(JSON.parse(JSON.stringify(restored)))).toEqual(restored)
  })

  it('rejects incompatible media/track types', () => {
    const value = project(); value.tracks[0].kind = 'audio'
    expect(() => parseProject(value)).toThrow(/incompatible track/)
  })

  it('rejects unanchored, reversed, duplicate, and incomplete warp maps', () => {
    const invalid = [
      [{ source: 0, target: 1 }, { source: 12, target: 3 }],
      [{ source: 0, target: 0 }, { source: 12, target: -1 }],
      [{ source: 0, target: 0 }, { source: 5, target: 2 }, { source: 5, target: 4 }],
      [{ source: 0, target: 0 }, { source: 10, target: 3 }],
      [{ source: 0, target: 0 }],
    ]
    for (const warp of invalid) {
      const value = project(); value.clips[0].warp = warp
      expect(() => parseProject(value)).toThrow(/Invalid Pulse project/)
    }
  })

  it('rejects invalid signal positions or beat selection before render can throw', () => {
    const badSignal = project(); badSignal.clips[0].signals = [50]
    expect(() => parseProject(badSignal)).toThrow(/outside its source/)
    const badPattern = project(); badPattern.clips[0].beatConfig = { pattern: '000' }
    expect(() => parseProject(badPattern)).toThrow(/at least one 1/)
    const badPhase = project(); badPhase.clips[0].beatConfig = { every: 2, offset: 3, pattern: '10' }
    expect(() => parseProject(badPhase)).toThrow(/offset/)
  })

  it('normalizes duplicate, unordered marker timestamps without mutating the parsed object', () => {
    const value = project(); value.clips[0].signals = [3, 0, 3, 12]
    const result = parseProject(value)
    expect(result.clips[0].signals).toEqual([0, 3, 12])
    expect(value.clips[0].signals).toEqual([3, 0, 3, 12])
  })

  it('rejects unsupported future versions instead of silently corrupting an edit', () => {
    expect(() => parseProject({ ...project(), version: 12 })).toThrow(/version/)
  })

  it('rejects overflowing timeline sizes before the ruler can allocate an unbounded grid', () => {
    const value = project(); value.clips[0].start = 1e300
    expect(() => parseProject(value)).toThrow(/24-hour/)
  })
})
