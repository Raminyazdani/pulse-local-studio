import type { BeatSelection, Clip, ClipEditSource, Media, Project, ResolvedClipTime, Segment, WarpPoint } from './types'

const EPSILON = 1e-7

export function uid(prefix = 'id'): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`
}

function segmentSpeed(segment: Segment): number {
  const value = segment.speed ?? 1
  if (!Number.isFinite(value) || value <= 0) throw new Error('Clip speed must be a positive number.')
  return value
}

export function sourceDuration(clip: Pick<Clip, 'segments'>): number {
  return clip.segments.reduce((total, segment) => total + Math.max(0, segment.out - segment.in) / segmentSpeed(segment), 0)
}

function validWarp(clip: Pick<Clip, 'warp'>): WarpPoint[] | undefined {
  const points = clip.warp
  if (!points || points.length < 2) return undefined
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    if (!Number.isFinite(point.source) || !Number.isFinite(point.target)) throw new Error('Speed map contains a non-finite timestamp.')
    if (i && (point.source <= points[i - 1].source || point.target <= points[i - 1].target)) {
      throw new Error('Speed map must increase strictly in source and output time.')
    }
  }
  return points
}

function interpolate(points: WarpPoint[], value: number, inverse: boolean): number {
  const x = inverse ? 'target' : 'source'
  const y = inverse ? 'source' : 'target'
  let index = 0
  while (index < points.length - 2 && value >= points[index + 1][x]) index++
  const a = points[index]
  const b = points[index + 1]
  return a[y] + ((value - a[x]) / (b[x] - a[x])) * (b[y] - a[y])
}

export function sourceToOutput(clip: Pick<Clip, 'warp'>, localSourceTime: number): number {
  const points = validWarp(clip)
  return points ? interpolate(points, localSourceTime, false) : localSourceTime
}

export function outputToSource(clip: Pick<Clip, 'warp'>, localOutputTime: number): number {
  const points = validWarp(clip)
  return points ? interpolate(points, localOutputTime, true) : localOutputTime
}

export function clipDuration(clip: Pick<Clip, 'segments' | 'warp'>): number {
  return sourceToOutput(clip, sourceDuration(clip))
}

export function projectDuration(project: Pick<Project, 'clips'>): number {
  return project.clips.reduce((end, clip) => Math.max(end, clip.start + clipDuration(clip)), 0)
}

function warpSlope(clip: Pick<Clip, 'warp'>, time: number): number {
  const points = validWarp(clip)
  if (!points) return 1
  let index = 0
  while (index < points.length - 2 && time >= points[index + 1].source) index++
  return (points[index + 1].target - points[index].target) / (points[index + 1].source - points[index].source)
}

/** Resolve a local output timestamp, including a time-varying speed, into an original asset. */
export function resolveClipTime(clip: Clip, localOutputTime: number): ResolvedClipTime | null {
  const duration = clipDuration(clip)
  if (localOutputTime < -EPSILON || localOutputTime >= duration || !clip.segments.length) return null
  const sourceTime = Math.max(0, outputToSource(clip, localOutputTime))
  let cursor = 0
  for (let i = 0; i < clip.segments.length; i++) {
    const segment = clip.segments[i]
    const speed = segmentSpeed(segment)
    const end = cursor + (segment.out - segment.in) / speed
    if (sourceTime < end - EPSILON || i === clip.segments.length - 1) {
      return {
        mediaId: segment.mediaId,
        time: Math.min(segment.out, segment.in + Math.max(0, sourceTime - cursor) * speed),
        speed: speed / warpSlope(clip, sourceTime),
        segmentIndex: i,
        muted: clip.muted || Boolean(segment.muted),
        volume: clip.volume * (segment.volume ?? 1),
      }
    }
    cursor = end
  }
  return null
}

/** Bake a warp into source spans. This does not encode or alter the original files. */
function flattenVisibleClip(clip: Clip): Clip {
  const points = validWarp(clip)
  if (!points) return { ...clip, segments: clip.segments.map(segment => ({ ...segment })), signals: [...clip.signals], warp: undefined }
  const segments: Segment[] = []
  let cursor = 0
  for (const segment of clip.segments) {
    const speed = segmentSpeed(segment)
    const end = cursor + (segment.out - segment.in) / speed
    const cuts = [cursor, ...points.map(point => point.source).filter(time => time > cursor + EPSILON && time < end - EPSILON), end]
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i]
      const b = cuts[i + 1]
      if (b - a < EPSILON) continue
      const outputLength = sourceToOutput(clip, b) - sourceToOutput(clip, a)
      segments.push({
        ...segment,
        in: segment.in + (a - cursor) * speed,
        out: segment.in + (b - cursor) * speed,
        speed: speed * (b - a) / outputLength,
      })
    }
    cursor = end
  }
  return {
    ...clip,
    segments,
    signals: clip.signals.map(signal => sourceToOutput(clip, signal)),
    beatEdits: clip.beatEdits?.map(beat => sourceToOutput(clip, beat)),
    warp: undefined,
  }
}

function compactSegments(input: Segment[]): Segment[] {
  const result: Segment[] = []
  for (const segment of input) {
    const previous = result.at(-1)
    if (previous && previous.mediaId === segment.mediaId && Math.abs(previous.out - segment.in) < EPSILON &&
        Math.abs(segmentSpeed(previous) - segmentSpeed(segment)) < 1e-12 &&
        Boolean(previous.muted) === Boolean(segment.muted) && (previous.volume ?? 1) === (segment.volume ?? 1)) {
      previous.out = segment.out
    } else result.push({ ...segment })
  }
  return result
}

function cutSegments(input: Segment[], a: number, b: number): Segment[] {
  const result: Segment[] = []
  let cursor = 0
  for (const segment of input) {
    const speed = segmentSpeed(segment)
    const end = cursor + (segment.out - segment.in) / speed
    const left = Math.max(cursor, a)
    const right = Math.min(end, b)
    if (right - left > EPSILON) {
      result.push({ ...segment, in: segment.in + (left - cursor) * speed, out: segment.in + (right - cursor) * speed })
    }
    cursor = end
  }
  return compactSegments(result)
}

const cloneSource = (source: ClipEditSource): ClipEditSource => ({
  segments: source.segments.map(segment => ({ ...segment })), signals: [...source.signals],
  beatEdits: source.beatEdits ? [...source.beatEdits] : undefined,
})
const sourceLength = (source: ClipEditSource) => sourceDuration(source)
const inRange = (time: number, a: number, b: number) => time >= a - EPSILON && time <= b + EPSILON

function detectedSourceBeats(segments: Segment[], media: Media[]): number[] {
  return clipBeats({ id: '', name: '', trackId: '', start: 0, segments, signals: [], muted: false, volume: 1 }, media)
}

type EditContext = { source: ClipEditSource; a: number; b: number; still: boolean }

/** Reconcile visible edits into the retained source before a new crop operation. */
function sourceContext(clip: Clip, media: Media[] = []): EditContext {
  const visible = flattenVisibleClip(clip)
  const length = sourceDuration(visible)
  if (clip.editSource && clip.sourceWindow) {
    const old = cloneSource(clip.editSource)
    const { in: a, out: oldB } = clip.sourceWindow
    const oldTotal = sourceLength(old)
    if (!Number.isFinite(a) || !Number.isFinite(oldB) || a < 0 || oldB <= a || oldB > oldTotal + EPSILON) {
      throw new Error('The retained source range is invalid.')
    }
    const delta = length - (oldB - a)
    const rebase = (values: number[], replacement: number[]) => uniqueTimes([
      ...values.filter(value => value < a - EPSILON),
      ...replacement.map(value => a + value),
      ...values.filter(value => value > oldB + EPSILON).map(value => value + delta),
    ])
    const source: ClipEditSource = {
      segments: compactSegments([...cutSegments(old.segments, 0, a), ...visible.segments.map(s => ({ ...s })), ...cutSegments(old.segments, oldB, oldTotal)]),
      signals: rebase(old.signals, visible.signals),
    }
    if (old.beatEdits !== undefined || visible.beatEdits !== undefined) {
      source.beatEdits = rebase(old.beatEdits ?? detectedSourceBeats(old.segments, media),
        visible.beatEdits ?? detectedSourceBeats(visible.segments, media))
    }
    const still = source.segments.every(s => s.mediaId === source.segments[0]?.mediaId) &&
      media.find(asset => asset.id === source.segments[0]?.mediaId)?.kind === 'image'
    return { source, a, b: a + length, still }
  }
  const first = visible.segments[0]
  const last = visible.segments.at(-1)
  // Only a single original-file span has unambiguous legacy source handles.
  // A legacy compound has no record of intentionally omitted child ranges.
  const singleFile = clip.segments.every((segment, index, list) => segment.mediaId === list[0]?.mediaId &&
    (!index || Math.abs(list[index - 1].out - segment.in) < EPSILON))
  const prefix: Segment[] = singleFile && first && first.in > EPSILON ? [{ ...first, in: 0, out: first.in }] : []
  const lastMedia = media.find(asset => asset.id === last?.mediaId)
  const suffix: Segment[] = singleFile && last && lastMedia && lastMedia.kind !== 'image' && lastMedia.duration > last.out + EPSILON
    ? [{ ...last, in: last.out, out: lastMedia.duration }] : []
  const a = sourceDuration({ segments: prefix })
  const segments = compactSegments([...prefix, ...visible.segments.map(segment => ({ ...segment })), ...suffix])
  const source: ClipEditSource = { segments, signals: visible.signals.map(signal => a + signal) }
  if (visible.beatEdits !== undefined) {
    source.beatEdits = uniqueTimes([
      ...detectedSourceBeats(prefix, media), ...visible.beatEdits.map(beat => a + beat),
      ...detectedSourceBeats(suffix, media).map(beat => a + length + beat),
    ])
  }
  const still = segments.every(s => s.mediaId === first?.mediaId) && media.find(asset => asset.id === first?.mediaId)?.kind === 'image'
  return { source, a, b: a + length, still }
}

function extendStill(context: EditContext, end: number): EditContext {
  const total = sourceLength(context.source)
  if (!context.still || end <= total) return context
  const last = context.source.segments.at(-1)!
  return { ...context, source: { ...context.source, segments: [...context.source.segments.slice(0, -1),
    { ...last, out: last.out + (end - total) * segmentSpeed(last) }] } }
}

function croppedClip(clip: Clip, context: EditContext, a: number, b: number, start: number): Clip {
  return {
    ...clip, start, segments: cutSegments(context.source.segments, a, b), warp: undefined,
    signals: context.source.signals.filter(value => inRange(value, a, b)).map(value => Math.max(0, value - a)),
    beatEdits: context.source.beatEdits?.filter(value => inRange(value, a, b)).map(value => Math.max(0, value - a)),
    editSource: cloneSource(context.source), sourceWindow: { in: a, out: b },
  }
}

/** Bake visible speed changes while retaining the ranges hidden by trimming. */
export function flattenClip(clip: Clip): Clip {
  const flat = flattenVisibleClip(clip)
  if (!clip.editSource || !clip.sourceWindow) return flat
  const context = sourceContext(clip)
  return { ...flat, editSource: context.source, sourceWindow: { in: context.a, out: context.b } }
}

export interface EditRange {
  in: number
  out: number
  duration: number
  total: number
  /** Absolute timeline bounds of a reversible edge trim. */
  minStart: number
  maxEnd: number
  canSlip: boolean
}

export function editRange(clip: Clip, media?: Media[]): EditRange {
  const context = sourceContext(clip, media)
  const total = sourceLength(context.source)
  const anchor = clip.start - context.a
  return { in: context.a, out: context.b, duration: context.b - context.a, total,
    minStart: Math.max(0, anchor), maxEnd: context.still ? Math.min(86400, anchor + 86400) : anchor + total,
    canSlip: !context.still && total - (context.b - context.a) > EPSILON }
}

/** Full source on the same timeline anchor; useful for crop ghosts and overviews. */
export function editSourceClip(clip: Clip, media?: Media[]): Clip {
  const context = sourceContext(clip, media)
  return { ...clip, start: clip.start - context.a, segments: context.source.segments,
    signals: context.source.signals, beatEdits: context.source.beatEdits, warp: undefined,
    editSource: undefined, sourceWindow: undefined }
}

/** Trim/extend edges using absolute timeline seconds, keeping the opposite edge fixed. */
export function trimClip(clip: Clip, absoluteStart: number, absoluteEnd: number, media?: Media[]): Clip {
  if (!Number.isFinite(absoluteStart) || !Number.isFinite(absoluteEnd) || absoluteEnd - absoluteStart < EPSILON) {
    throw new Error('Select a nonempty range inside this clip.')
  }
  let context = sourceContext(clip, media)
  const anchor = clip.start - context.a
  context = extendStill(context, Math.min(86400, 86400 - anchor, context.a + absoluteEnd - clip.start))
  const a = Math.max(0, -anchor, context.a + absoluteStart - clip.start)
  const b = Math.min(sourceLength(context.source), context.a + absoluteEnd - clip.start)
  if (b - a < EPSILON) throw new Error('Select a nonempty range inside this clip.')
  return croppedClip(clip, context, a, b, Math.max(0, anchor, absoluteStart))
}

/** Choose a range in the full source without moving the timeline container's start. */
export function setSourceWindow(clip: Clip, sourceIn: number, sourceOut: number, media?: Media[]): Clip {
  if (!Number.isFinite(sourceIn) || !Number.isFinite(sourceOut) || sourceOut - sourceIn < EPSILON) {
    throw new Error('Select a nonempty source range.')
  }
  let context = sourceContext(clip, media)
  context = extendStill(context, Math.min(86400 - clip.start, sourceOut))
  const a = Math.max(0, sourceIn)
  const b = Math.min(sourceLength(context.source), sourceOut)
  if (b - a < EPSILON) throw new Error('Select a nonempty source range.')
  return croppedClip(clip, context, a, b, clip.start)
}

/** Slip later/earlier source content inside a fixed-duration, fixed-position container. */
export function slipClip(clip: Clip, deltaOutputSeconds: number, media?: Media[]): Clip {
  if (!Number.isFinite(deltaOutputSeconds)) throw new Error('Source shift must be finite.')
  const context = sourceContext(clip, media)
  const length = context.b - context.a
  const a = Math.max(0, Math.min(sourceLength(context.source) - length, context.a + deltaOutputSeconds))
  return croppedClip(clip, context, a, a + length, clip.start)
}

/** Restore every retained frame, preserving the full source anchor unless it is before zero. */
export function resetSourceWindow(clip: Clip, media?: Media[]): Clip {
  const context = sourceContext(clip, media)
  return croppedClip(clip, context, 0, sourceLength(context.source), Math.max(0, clip.start - context.a))
}
export const restoreClipSource = resetSourceWindow

export function splitClip(clip: Clip, absoluteTimelineTime: number, media?: Media[]): [Clip, Clip] {
  const end = clip.start + clipDuration(clip)
  if (absoluteTimelineTime <= clip.start + EPSILON || absoluteTimelineTime >= end - EPSILON) throw new Error('Place the playhead inside the clip to split it.')
  return [trimClip(clip, clip.start, absoluteTimelineTime, media), { ...trimClip(clip, absoluteTimelineTime, end, media), id: uid('clip') }]
}

/** Concatenate clips chronologically; gaps are closed and originals remain untouched. */
export function mergeClips(clips: Clip[], media: Media[] = []): Clip {
  if (!clips.length) throw new Error('Add clips to this track before merging.')
  const sorted = [...clips].sort((a, b) => a.start - b.start)
  if (sorted.some(clip => clip.trackId !== sorted[0].trackId)) throw new Error('Merge clips from one track at a time.')
  const segments: Segment[] = []
  const signals: number[] = []
  const beats: number[] = []
  const preserveBeatSelection = sorted.some(clip => clip.beatEdits !== undefined || clip.beatConfig !== undefined)
  let cursor = 0
  for (const clip of sorted) {
    const flat = flattenClip(clip)
    segments.push(...flat.segments.map(segment => ({
      ...segment,
      volume: (segment.volume ?? 1) * flat.volume,
      muted: Boolean(segment.muted) || flat.muted,
    })))
    signals.push(...flat.signals.map(signal => cursor + signal))
    if (preserveBeatSelection) beats.push(...clipBeats(flat, media).map(beat => cursor + beat))
    cursor += sourceDuration(flat)
  }
  const merged: Clip = {
    id: uid('clip'),
    name: sorted.length === 1 ? sorted[0].name : `Merged sequence · ${sorted.length} clips`,
    trackId: sorted[0].trackId,
    start: sorted[0].start,
    segments,
    signals: uniqueTimes(signals),
    muted: false,
    volume: 1,
  }
  if (preserveBeatSelection) merged.beatEdits = uniqueTimes(beats)
  merged.editSource = { segments: segments.map(segment => ({ ...segment })), signals: [...merged.signals], beatEdits: merged.beatEdits ? [...merged.beatEdits] : undefined }
  merged.sourceWindow = { in: 0, out: cursor }
  return merged
}

function uniqueTimes(times: number[]): number[] {
  return times.filter(Number.isFinite).sort((a, b) => a - b).filter((time, index, sorted) => !index || time - sorted[index - 1] > EPSILON)
}

export function selectBeats(beats: number[], selection: BeatSelection = {}): number[] {
  const ordered = uniqueTimes(beats).filter(time => time >= 0)
  if (selection.pattern !== undefined && selection.pattern !== '') {
    const pattern = Array.isArray(selection.pattern)
      ? selection.pattern
      : selection.pattern.replace(/[\s,;|]+/g, '').split('').map(Number)
    if (!pattern.length || pattern.some(value => value !== 0 && value !== 1) || !pattern.includes(1)) {
      throw new Error('Use a repeating pattern of 0 and 1 with at least one 1, such as 100 or 1,0,0.')
    }
    return ordered.filter((_, index) => pattern[index % pattern.length] === 1)
  }
  const every = selection.every ?? 1
  const offset = selection.offset ?? 0
  if (!Number.isInteger(every) || every < 1 || !Number.isInteger(offset) || offset < 0 || offset >= every) {
    throw new Error('Keep-every must be a positive integer; offset must be between 0 and keep-every minus one.')
  }
  return ordered.filter((_, index) => index % every === offset)
}

/** Canonical local beat positions, accounting for source trims and segment speeds. */
export function clipBeats(clip: Clip, media: Media[]): number[] {
  if (clip.beatEdits) return selectBeats(clip.beatEdits, clip.beatConfig)
  const beats: number[] = []
  let cursor = 0
  for (const segment of clip.segments) {
    const asset = media.find(item => item.id === segment.mediaId)
    const speed = segmentSpeed(segment)
    for (const beat of asset?.beats ?? []) {
      if (beat >= segment.in - EPSILON && beat < segment.out - EPSILON) beats.push(cursor + Math.max(0, beat - segment.in) / speed)
    }
    cursor += (segment.out - segment.in) / speed
  }
  return selectBeats(beats, clip.beatConfig)
}

export function clipBeatTimes(clip: Clip, media: Media[]): number[] {
  return clipBeats(clip, media).map(beat => clip.start + sourceToOutput(clip, beat))
}

/** Resample asset waveforms on the actual trimmed/compound/warped output timeline. */
export function clipWaveform(clip: Clip, media: Media[], sampleCount = 512): number[] {
  const count = Math.max(1, Math.min(4096, Math.round(sampleCount)))
  const duration = clipDuration(clip)
  return sampleClipWaveform(clip, media, Array.from({ length: count }, (_, index) => (index + 0.5) * duration / count))
}

/** Sample explicit output timestamps so a constant pixel/time pitch never stretches peaks. */
export function sampleClipWaveform(clip: Clip, media: Media[], outputTimes: number[]): number[] {
  const assets = new Map(media.map(asset => [asset.id, asset]))
  return outputTimes.map(time => {
    const resolved = resolveClipTime(clip, time)
    const asset = resolved ? assets.get(resolved.mediaId) : undefined
    const waveform = asset?.waveform
    if (!resolved || !asset || !waveform?.length || asset.duration <= 0) return 0
    const position = Math.max(0, Math.min(waveform.length - 1, resolved.time / asset.duration * (waveform.length - 1)))
    const lower = Math.floor(position)
    const fraction = position - lower
    return waveform[lower] * (1 - fraction) + waveform[Math.min(waveform.length - 1, lower + 1)] * fraction
  })
}

/** Map successive source signals exactly onto successive absolute music beats. */
export function alignClipToBeats(clip: Clip, absoluteBeats: number[]): Clip {
  const duration = sourceDuration(clip)
  const signals = uniqueTimes(clip.signals)
  if (signals.length < 2) throw new Error('Add at least two beat signals to the video.')
  if (signals.some(signal => signal < 0 || signal > duration + EPSILON)) throw new Error('A beat signal lies outside the clip.')
  const beats = uniqueTimes(absoluteBeats).filter(beat => beat >= 0)
  if (beats.length < signals.length) throw new Error(`This video has ${signals.length} signals, but only ${beats.length} selected music beats are available.`)
  const paired = beats.slice(0, signals.length)
  const firstSlope = (paired[1] - paired[0]) / (signals[1] - signals[0])
  const last = signals.length - 1
  const lastSlope = (paired[last] - paired[last - 1]) / (signals[last] - signals[last - 1])
  const prefix = signals[0] * firstSlope
  const start = paired[0] - prefix
  if (start < -EPSILON) throw new Error('The first music beat is too early for the video prefix. Trim the video prefix or choose a later first beat.')
  const warp: WarpPoint[] = [{ source: 0, target: 0 }]
  for (let i = 0; i < signals.length; i++) {
    if (signals[i] <= EPSILON) continue
    warp.push({ source: signals[i], target: paired[i] - start })
  }
  if (duration - signals[last] > EPSILON) {
    warp.push({ source: duration, target: paired[last] - start + (duration - signals[last]) * lastSlope })
  }
  if (warp.length < 2) throw new Error('Signals must have different timestamps.')
  const aligned = { ...clip, start: Math.max(0, start), warp, signals }
  if (!clip.editSource || !clip.sourceWindow) return aligned
  const context = sourceContext(aligned)
  return { ...aligned, editSource: context.source, sourceWindow: { in: context.a, out: context.b } }
}

export function addSignal(clip: Clip, absoluteTimelineTime: number): Clip {
  const local = absoluteTimelineTime - clip.start
  if (local < -EPSILON || local > clipDuration(clip) + EPSILON) throw new Error('Place the playhead inside the selected video.')
  const signal = Math.max(0, Math.min(sourceDuration(clip), outputToSource(clip, local)))
  return { ...clip, signals: uniqueTimes([...clip.signals, signal]) }
}

export function formatTime(seconds: number, decimals = 2): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  const remainder = (safe % 60).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')
  return `${String(minutes).padStart(2, '0')}:${remainder}`
}
