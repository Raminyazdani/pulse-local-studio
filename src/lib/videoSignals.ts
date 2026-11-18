import { editRange, editSourceClip, flattenClip } from './engine'
import type { Clip, Media, Segment } from './types'

const EPSILON = 1e-7
const MAX_SIGNALS = 100000

/** Browser frame stepping uses the reported average rate; presented VFR labels may keep their exact timestamp. */
export function videoFrameRate(media: Pick<Media, 'fps'>): number {
  return media.fps !== undefined && Number.isFinite(media.fps) && media.fps > 0 ? media.fps : 30
}

/** Snap an editing/seek position to the nearest valid frame, never to media EOF. */
export function quantizeVideoSignal(time: number, duration: number, fps = 30): number {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0)
    throw new Error('A video signal needs finite timing, a positive duration and a positive frame rate.')
  const lastFrame = Math.max(0, Math.ceil(duration * fps - EPSILON) - 1)
  return Math.min(lastFrame, Math.max(0, Math.round(time * fps))) / fps
}

/** Canonicalize a draft without rounding away exact decoded frame timestamps. */
export function normalizeSourceSignals(values: readonly number[], duration: number): number[] {
  if (!Array.isArray(values) || values.length > MAX_SIGNALS)
    throw new Error('A video can contain at most 100,000 source signals.')
  if (!Number.isFinite(duration) || duration < 0 || values.some(time => typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time >= duration))
    throw new Error('Video source signals must be finite seconds inside the original file, before its end.')
  return unique([...values])
}

function speedOf(segment: Segment): number {
  const speed = segment.speed ?? 1
  if (!Number.isFinite(speed) || speed <= 0 || !Number.isFinite(segment.in) || !Number.isFinite(segment.out) || segment.in < 0 || segment.out <= segment.in)
    throw new Error('Video signal mapping requires nonempty source spans with positive speed.')
  return speed
}

function unique(values: number[]): number[] {
  const result: number[] = []
  for (const time of values.sort((a, b) => a - b)) {
    if (!result.length || time - result[result.length - 1] > EPSILON) result.push(time)
  }
  return result
}

/** Map reusable file labels onto canonical local time, including repeated, trimmed and sped-up spans. */
export function createVideoClipSignals(media: Media[], segments: Segment[]): number[] {
  const assets = new Map(media.map(asset => [asset.id, asset]))
  const signals: number[] = []
  let cursor = 0
  for (const segment of segments) {
    const speed = speedOf(segment)
    const asset = assets.get(segment.mediaId)
    if (asset?.kind === 'video') {
      for (const time of normalizeSourceSignals(asset.sourceSignals ?? [], asset.duration)) {
        // A source-out point is the next span's boundary, not another frame in this one.
        if (time >= segment.in && time < segment.out)
          signals.push(cursor + (time - segment.in) / speed)
      }
    }
    cursor += (segment.out - segment.in) / speed
  }
  return unique(signals)
}

/** Replace only markers owned by one file, preserving other files in a compound composition. */
function replaceSignals(segments: Segment[], oldSignals: number[], asset: Media): number[] {
  const ends: number[] = []
  let cursor = 0
  for (const segment of segments) {
    cursor += (segment.out - segment.in) / speedOf(segment)
    ends.push(cursor)
  }
  const kept: number[] = []
  let index = 0
  for (const signal of [...oldSignals].sort((a, b) => a - b)) {
    // Shared boundaries belong to the next span, matching resolveClipTime.
    while (index < segments.length - 1 && signal >= ends[index] - EPSILON) index++
    if (segments[index]?.mediaId !== asset.id) kept.push(signal)
  }
  return unique([...kept, ...createVideoClipSignals([asset], segments)])
}

/**
 * Apply library labels to an existing occurrence without changing any displayed
 * frame's original time or playback rate. Current warp timing is baked into
 * spans; a future Sync must explicitly pair the newly changed signal sequence.
 */
export function applyVideoSourceSignals(clip: Clip, media: Media[], mediaId: string, newSignals: readonly number[]): Clip {
  const asset = media.find(item => item.id === mediaId)
  if (!asset || asset.kind !== 'video') throw new Error('Choose a video source before applying its sync signals.')
  const signals = normalizeSourceSignals(newSignals, asset.duration)
  if (![...clip.segments, ...(clip.editSource?.segments ?? [])].some(segment => segment.mediaId === mediaId)) return clip
  const flat = flattenClip(clip)
  const range = editRange(flat, media)
  const full = editSourceClip(flat, media)
  const allSignals = replaceSignals(full.segments, full.signals, { ...asset, sourceSignals: signals })
  // Existing clip semantics allow a sync marker exactly on the crop's end.
  // Retain that boundary so later extension cannot lose the hidden source label.
  const visible = allSignals.filter(time => time >= range.in - EPSILON && time <= range.out + EPSILON)
    .map(time => Math.max(0, Math.min(range.duration, time - range.in)))
  return {
    ...flat,
    signals: unique(visible),
    warp: undefined,
    editSource: {
      segments: full.segments.map(segment => ({ ...segment })),
      signals: allSignals,
      ...(full.beatEdits === undefined ? {} : { beatEdits: [...full.beatEdits] }),
    },
    sourceWindow: { in: range.in, out: range.out },
  }
}
