import { clipDuration, flattenClip, sourceToOutput } from './engine'
import type { Clip } from './types'

const EPSILON = 1e-7
const MAX_SIGNALS = 100000

/** Clip markers may sit at either end of the visible composition. */
export function normalizeTimelineSignals(values: readonly number[], duration: number): number[] {
  if (!Array.isArray(values) || values.length > MAX_SIGNALS)
    throw new Error('A clip can contain at most 100,000 beat signals.')
  if (!Number.isFinite(duration) || duration < 0 || values.some(time =>
    typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time > duration + EPSILON))
    throw new Error('Clip beat signals must be finite seconds inside the clip, including its end.')
  const result: number[] = []
  // Summing flattened spans may differ from the equivalent warp endpoint by a
  // few floating-point units. Keep a valid boundary label at the actual end.
  for (const time of values.map(time => Math.min(time, duration)).sort((a, b) => a - b)) {
    if (!result.length || time - result[result.length - 1] > EPSILON) result.push(time)
  }
  return result
}

/** Inspect the current output clock without modifying the saved clip or its timing. */
export function timelineSignalDraft(clip: Clip): Clip {
  const flat = flattenClip(clip)
  return {
    ...flat,
    signals: normalizeTimelineSignals(flat.signals, clipDuration(flat)),
    beatEdits: flat.beatEdits ? [...flat.beatEdits] : undefined,
    beatConfig: flat.beatConfig ? {
      ...flat.beatConfig,
      pattern: Array.isArray(flat.beatConfig.pattern) ? [...flat.beatConfig.pattern] : flat.beatConfig.pattern,
      enabledGroups: flat.beatConfig.enabledGroups ? [...flat.beatConfig.enabledGroups] : undefined,
    } : undefined,
    editSource: flat.editSource ? {
      segments: flat.editSource.segments.map(segment => ({ ...segment })),
      signals: [...flat.editSource.signals],
      beatEdits: flat.editSource.beatEdits ? [...flat.editSource.beatEdits] : undefined,
    } : undefined,
    sourceWindow: flat.sourceWindow ? { ...flat.sourceWindow } : undefined,
  }
}

/**
 * Save labels on this occurrence only. A changed draft bakes the current warp
 * into spans, keeping every displayed frame/rate unchanged. Reconcile the new
 * visible labels into the retained composition so later extension restores both
 * the edited range and untouched hidden labels. No source asset is annotated.
 */
export function replaceTimelineSignals(clip: Clip, values: readonly number[]): Clip {
  const duration = clipDuration(clip)
  const signals = normalizeTimelineSignals(values, duration)
  const previous = normalizeTimelineSignals(clip.signals.map(time => sourceToOutput(clip, time)), duration)
  if (signals.length === previous.length && signals.every((time, index) => Math.abs(time - previous[index]) < 1e-8))
    return clip
  const flat = flattenClip(clip)
  return flattenClip({ ...flat, signals: normalizeTimelineSignals(signals, clipDuration(flat)) })
}
