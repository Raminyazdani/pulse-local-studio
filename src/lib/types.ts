export type MediaKind = 'video' | 'audio' | 'image'

/** An acoustic cluster of detected attacks; indices refer to the asset's beats. */
export interface BeatGroup {
  id: string
  label: string
  beatIndices: number[]
  /** Representative attack timestamp in the original media. */
  sampleTime: number
  bassScore?: number
}

export interface Media {
  id: string
  name: string
  kind: MediaKind
  duration: number
  width?: number
  height?: number
  hasAudio: boolean
  thumbnailUrl?: string | null
  url: string
  proxyUrl?: string
  originalUrl?: string
  fps?: number
  size?: number
  waveform?: number[]
  beats?: number[]
  beatGroups?: BeatGroup[]
  bpm?: number | null
}

/** in/out are seconds in the original file. speed is original seconds/output second. */
export interface Segment {
  mediaId: string
  in: number
  out: number
  speed?: number
  muted?: boolean
  volume?: number
}

export interface WarpPoint {
  source: number
  target: number
}

/** Retained, flattened source composition. This is edit metadata, never another encode. */
export interface ClipEditSource {
  segments: Segment[]
  signals: number[]
  beatEdits?: number[]
}

export interface SourceWindow {
  /** Seconds on the retained composition's output clock, before cropping. */
  in: number
  out: number
}

export interface Clip {
  id: string
  name: string
  trackId: string
  start: number
  segments: Segment[]
  /** Ordered seconds on the canonical, pre-warp local source timeline. */
  signals: number[]
  /** Monotonic map from canonical local source seconds to local output seconds. */
  warp?: WarpPoint[]
  muted: boolean
  volume: number
  beatConfig?: BeatSelection
  /** Optional manually edited detected beats, before the sampling pattern is applied. */
  beatEdits?: number[]
  /** Full composition retained when its visible range is trimmed or slipped. */
  editSource?: ClipEditSource
  sourceWindow?: SourceWindow
}

export interface Track {
  id: string
  name: string
  kind: 'video' | 'audio'
  muted: boolean
  hidden: boolean
  locked: boolean
}

export interface Project {
  version?: 1
  aspect?: '16:9' | '9:16' | '1:1'
  id: string
  name: string
  media: Media[]
  tracks: Track[]
  clips: Clip[]
}

export interface ExportSettings {
  width: number
  height: number
  fps: number
  quality: 'high' | 'master'
  format: 'mp4' | 'mov'
}

export interface BeatSelection {
  every?: number
  /** Zero-based index within each every-N group. */
  offset?: number
  /** Repeating keep/drop mask, e.g. '100', '1,0,0' or [1, 0, 0]. */
  pattern?: string | number[]
  /** Asset-qualified group keys. Undefined keeps all groups; [] keeps none. */
  enabledGroups?: string[]
}

export interface ResolvedClipTime {
  mediaId: string
  /** Absolute timestamp in the original media. */
  time: number
  /** Instantaneous source seconds per output second. */
  speed: number
  segmentIndex: number
  muted: boolean
  volume: number
}
