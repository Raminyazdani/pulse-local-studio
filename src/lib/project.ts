import { selectBeats, sourceDuration } from './engine'
import type { BeatGroup, BeatSelection, Clip, Media, Project, Segment, Track, WarpPoint } from './types'

type JsonObject = Record<string, unknown>
const TOLERANCE = 1e-5

function fail(message: string): never {
  throw new Error(`Invalid Pulse project: ${message}`)
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`)
  return value as JsonObject
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`)
  return value
}

function string(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) fail(`${label} must be ${nonempty ? 'a nonempty' : 'a'} string.`)
  return value
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) fail(`${label} must be a finite number of at least ${minimum}.`)
  return value
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`)
  return value
}

function times(value: unknown, label: string, maximum: number): number[] {
  return array(value, label).map((item, index) => {
    const time = number(item, `${label}[${index}]`)
    if (time > maximum + TOLERANCE) fail(`${label}[${index}] lies outside its source.`)
    return Math.min(time, maximum)
  }).sort((a, b) => a - b).filter((value, index, sorted) => !index || value - sorted[index - 1] > 1e-7)
}

function optionalNumber(value: unknown, label: string, minimum = 0): number | undefined {
  return value === undefined ? undefined : number(value, label, minimum)
}

function parseBeatGroups(value: unknown, beats: number[], duration: number): BeatGroup[] {
  if (beats.some(beat => beat >= duration)) fail('grouped detected beats must lie inside the source duration.')
  const used = new Set<number>()
  const ids = new Set<string>()
  const groups = array(value, 'beat groups').map((entry): BeatGroup => {
    const group = object(entry, 'beat group')
    const id = string(group.id, 'beat group ID', true)
    if (id.length > 128 || ids.has(id)) fail('beat group IDs must be unique and at most 128 characters.')
    ids.add(id)
    const label = string(group.label, 'beat group label', true)
    const beatIndices = array(group.beatIndices, 'beat group indices').map(value => {
      const index = number(value, 'beat group index')
      if (!Number.isInteger(index) || index >= beats.length || used.has(index)) fail('each detected beat must belong to exactly one group.')
      used.add(index)
      return index
    })
    if (!beatIndices.length) fail('a beat group must contain at least one detected beat.')
    const sampleTime = number(group.sampleTime, 'beat group sample time')
    if (sampleTime >= duration || !beatIndices.some(index => Math.abs(beats[index] - sampleTime) <= TOLERANCE))
      fail('a beat group sample must reference one of its detected attacks inside the source.')
    const bassScore = optionalNumber(group.bassScore, 'beat group bass score')
    if (bassScore !== undefined && bassScore > 1) fail('beat group bass score must be between zero and one.')
    return { id, label, beatIndices, sampleTime, ...(bassScore === undefined ? {} : { bassScore }) }
  })
  if (used.size !== beats.length) fail('beat groups must cover every detected beat.')
  return groups
}

function parseMedia(value: unknown, index: number): Media {
  const data = object(value, `media[${index}]`)
  const id = string(data.id, 'media ID', true)
  if (!['video', 'audio', 'image'].includes(String(data.kind))) fail(`media ${id} has an unknown kind.`)
  const duration = number(data.duration, `media ${id} duration`)
  const media: Media = {
    id,
    name: string(data.name, `media ${id} name`),
    kind: data.kind as Media['kind'],
    duration,
    hasAudio: boolean(data.hasAudio, `media ${id} hasAudio`),
    url: string(data.url, `media ${id} URL`),
    width: optionalNumber(data.width, `media ${id} width`),
    height: optionalNumber(data.height, `media ${id} height`),
    fps: optionalNumber(data.fps, `media ${id} frame rate`),
    size: optionalNumber(data.size, `media ${id} size`),
  }
  for (const key of ['thumbnailUrl', 'proxyUrl', 'originalUrl'] as const) {
    // public_media intentionally returns thumbnailUrl:null for audio assets.
    // Normalize nullable optional URLs to absent values in saved project state.
    if (data[key] !== undefined && data[key] !== null) media[key] = string(data[key], `media ${id} ${key}`)
  }
  if (data.beats !== undefined) media.beats = times(data.beats, `media ${id} beats`, duration)
  if (data.beatGroups !== undefined) {
    if (data.beats === undefined) fail('beat groups require detected beats.')
    const originalBeats = array(data.beats, 'detected beats')
    if (originalBeats.length !== media.beats!.length || originalBeats.some((value, index) => value !== media.beats![index]))
      fail('grouped detected beats must be unique, ordered source timestamps.')
    media.beatGroups = parseBeatGroups(data.beatGroups, media.beats!, duration)
  }
  if (data.waveform !== undefined) media.waveform = array(data.waveform, `media ${id} waveform`).map((sample, sampleIndex) => number(sample, `waveform[${sampleIndex}]`))
  if (data.bpm !== undefined) media.bpm = data.bpm === null ? null : number(data.bpm, `media ${id} BPM`)
  return media
}

function parseTrack(value: unknown, index: number): Track {
  const data = object(value, `tracks[${index}]`)
  const id = string(data.id, 'track ID', true)
  if (data.kind !== 'video' && data.kind !== 'audio') fail(`track ${id} has an unknown kind.`)
  return {
    id,
    name: string(data.name, `track ${id} name`),
    kind: data.kind,
    muted: boolean(data.muted, `track ${id} mute`),
    hidden: boolean(data.hidden, `track ${id} visibility`),
    locked: boolean(data.locked, `track ${id} lock`),
  }
}

function parseSegment(value: unknown, clipId: string, media: Media[], track: Track): Segment {
  const data = object(value, `clip ${clipId} source span`)
  const mediaId = string(data.mediaId, `clip ${clipId} media ID`, true)
  const asset = media.find(item => item.id === mediaId)
  if (!asset) fail(`clip ${clipId} references missing media ${mediaId}.`)
  if ((track.kind === 'audio') !== (asset.kind === 'audio')) fail(`clip ${clipId} is on an incompatible track.`)
  const sourceIn = number(data.in, `clip ${clipId} source in`)
  const sourceOut = number(data.out, `clip ${clipId} source out`)
  if (sourceOut <= sourceIn) fail(`clip ${clipId} has an empty or reversed source span.`)
  if (asset.kind !== 'image' && sourceOut > asset.duration + TOLERANCE) fail(`clip ${clipId} extends past its source file.`)
  const speed = data.speed === undefined ? 1 : number(data.speed, `clip ${clipId} speed`, Number.MIN_VALUE)
  return {
    mediaId, in: sourceIn, out: sourceOut, speed,
    muted: boolean(data.muted, `clip ${clipId} source mute`),
    volume: data.volume === undefined ? 1 : number(data.volume, `clip ${clipId} source volume`),
  }
}

function parseWarp(value: unknown, clipId: string, duration: number): WarpPoint[] | undefined {
  if (value === undefined) return undefined
  const entries = array(value, `clip ${clipId} speed map`)
  if (!entries.length) return undefined
  if (entries.length < 2) fail(`clip ${clipId} speed map needs at least two points.`)
  const points = entries.map((entry, index) => {
    const point = object(entry, `clip ${clipId} speed point ${index}`)
    return { source: number(point.source, 'speed map source time'), target: number(point.target, 'speed map output time') }
  })
  if (Math.abs(points[0].source) > TOLERANCE || Math.abs(points[0].target) > TOLERANCE) fail(`clip ${clipId} speed map must start at zero.`)
  if (Math.abs(points[points.length - 1].source - duration) > TOLERANCE) fail(`clip ${clipId} speed map must end at the source duration.`)
  points[0] = { source: 0, target: 0 }
  points[points.length - 1].source = duration
  for (let i = 1; i < points.length; i++) {
    if (points[i].source <= points[i - 1].source || points[i].target <= points[i - 1].target) fail(`clip ${clipId} speed map must increase strictly.`)
  }
  return points
}

function parseBeatConfig(value: unknown): BeatSelection | undefined {
  if (value === undefined) return undefined
  const data = object(value, 'beat selection')
  const result: BeatSelection = {
    every: data.every === undefined ? 1 : number(data.every, 'beat sampling interval', 1),
    offset: data.offset === undefined ? 0 : number(data.offset, 'beat sampling offset'),
  }
  if (data.enabledGroups !== undefined) {
    const keys = array(data.enabledGroups, 'enabled beat groups').map(value => string(value, 'enabled beat group key', true))
    if (new Set(keys).size !== keys.length || keys.length > 10000 || keys.some(key => key.length > 300))
      fail('enabled beat group keys must be unique and bounded.')
    result.enabledGroups = keys
  }
  if (data.pattern !== undefined) {
    if (typeof data.pattern !== 'string' && !Array.isArray(data.pattern)) fail('beat pattern must be a string or a numeric mask.')
    result.pattern = Array.isArray(data.pattern) ? [...data.pattern] as number[] : data.pattern as string
  }
  try { selectBeats([0, 1], result) } catch (error) { fail((error as Error).message) }
  // Validate every/offset as well when a custom pattern is active.
  try { selectBeats([0, 1], { every: result.every, offset: result.offset }) } catch (error) { fail((error as Error).message) }
  return result
}

function uniqueIds(items: { id: string }[], label: string): void {
  if (new Set(items.map(item => item.id)).size !== items.length) fail(`${label} contain duplicate IDs.`)
}

/** Validate an autosave/import before it can reach rendering or the media engine. */
export function parseProject(input: unknown): Project {
  const data = object(input, 'project')
  if (data.version !== undefined && data.version !== 1) fail('this project version is not supported.')
  if (data.aspect !== undefined && !['16:9', '9:16', '1:1'].includes(String(data.aspect))) fail('unknown canvas aspect ratio.')
  const media = array(data.media, 'media').map(parseMedia)
  const tracks = array(data.tracks, 'tracks').map(parseTrack)
  uniqueIds(media, 'Media')
  uniqueIds(tracks, 'Tracks')
  const clips = array(data.clips, 'clips').map((value, index): Clip => {
    const clip = object(value, `clips[${index}]`)
    const id = string(clip.id, 'clip ID', true)
    const trackId = string(clip.trackId, `clip ${id} track ID`, true)
    const track = tracks.find(item => item.id === trackId)
    if (!track) fail(`clip ${id} references a missing track.`)
    const segments = array(clip.segments, `clip ${id} sources`).map(segment => parseSegment(segment, id, media, track))
    if (!segments.length) fail(`clip ${id} has no source spans.`)
    const duration = sourceDuration({ segments })
    if (!Number.isFinite(duration) || duration <= 0) fail(`clip ${id} has an invalid duration.`)
    const parsed: Clip = {
      id,
      name: string(clip.name, `clip ${id} name`),
      trackId,
      start: number(clip.start, `clip ${id} start time`),
      segments,
      signals: times(clip.signals, `clip ${id} signals`, duration),
      muted: boolean(clip.muted, `clip ${id} mute`),
      volume: clip.volume === undefined ? 1 : number(clip.volume, `clip ${id} volume`),
      warp: parseWarp(clip.warp, id, duration),
      beatConfig: parseBeatConfig(clip.beatConfig),
    }
    const outputDuration = parsed.warp?.[parsed.warp.length - 1].target ?? duration
    if (!Number.isFinite(parsed.start + outputDuration) || parsed.start + outputDuration > 86400) {
      fail(`clip ${id} extends past the supported 24-hour project length.`)
    }
    if (clip.beatEdits !== undefined) parsed.beatEdits = times(clip.beatEdits, `clip ${id} edited beats`, duration)
    if ((clip.editSource === undefined) !== (clip.sourceWindow === undefined)) fail(`clip ${id} retained source and window must be saved together.`)
    if (clip.editSource !== undefined) {
      const retained = object(clip.editSource, `clip ${id} retained source`)
      if (retained.warp !== undefined) fail(`clip ${id} retained source must use flattened source spans.`)
      const fullSegments = array(retained.segments, `clip ${id} retained spans`).map(segment => parseSegment(segment, id, media, track))
      if (!fullSegments.length) fail(`clip ${id} retained source has no spans.`)
      const fullDuration = sourceDuration({ segments: fullSegments })
      if (!Number.isFinite(fullDuration) || fullDuration > 86400) fail(`clip ${id} retained source exceeds 24 hours.`)
      const range = object(clip.sourceWindow, `clip ${id} source window`)
      const sourceIn = number(range.in, `clip ${id} source window in`)
      const sourceOut = number(range.out, `clip ${id} source window out`)
      if (sourceOut <= sourceIn || sourceIn >= fullDuration || sourceOut > fullDuration + TOLERANCE || Math.abs(sourceOut - sourceIn - outputDuration) > TOLERANCE) {
        fail(`clip ${id} source window does not match the visible output range.`)
      }
      parsed.editSource = { segments: fullSegments, signals: times(retained.signals, `clip ${id} retained signals`, fullDuration) }
      if (retained.beatEdits !== undefined) parsed.editSource.beatEdits = times(retained.beatEdits, `clip ${id} retained beats`, fullDuration)
      parsed.sourceWindow = { in: sourceIn, out: Math.min(sourceOut, fullDuration) }
    }
    return parsed
  })
  uniqueIds(clips, 'Clips')
  return {
    id: string(data.id, 'project ID', true),
    name: string(data.name, 'project name'),
    version: 1,
    aspect: data.aspect === undefined ? '16:9' : data.aspect as Project['aspect'],
    media, tracks, clips,
  }
}

export const validateProject = parseProject
