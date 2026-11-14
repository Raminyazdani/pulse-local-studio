import { memo, useMemo } from 'react';
import type { Clip, Media } from '../lib/types';
import { clipDuration, resolveClipTime } from '../lib/engine';

interface Props { clip: Clip; media: Media[]; zoom: number; phase?: number; visibleStart?: number; visibleEnd?: number }
const PITCH = 2;

/** Fixed pixel pitch adds/removes waveform columns when trimming, never scales
 * the old waveform into a new width. Its source phase also survives left trims. */
export const ClipWaveform = memo(function ClipWaveform({ clip, media, zoom, phase = 0, visibleStart = 0, visibleEnd = Infinity }: Props) {
  const width = clipDuration(clip) * zoom;
  const path = useMemo(() => {
    const library = new Map(media.map(asset => [asset.id, asset]));
    const first = Math.max(0, Math.floor((visibleStart + phase) / PITCH) - 1);
    const last = Math.min(Math.ceil((width + phase) / PITCH), Math.ceil((visibleEnd + phase) / PITCH) + 1);
    const output: string[] = [];
    for (let index = first; index <= last; index++) {
      const x = index * PITCH - phase;
      if (x < -.001 || x >= width) continue;
      const resolved = resolveClipTime(clip, x / zoom), asset = resolved && library.get(resolved.mediaId);
      if (!asset?.waveform?.length || !resolved || !asset.duration) continue;
      const position = Math.max(0, Math.min(asset.waveform.length - 1, resolved.time / asset.duration * (asset.waveform.length - 1)));
      const low = Math.floor(position), fraction = position - low;
      const amplitude = Math.max(0, Math.min(1, asset.waveform[low] * (1 - fraction) + asset.waveform[Math.min(asset.waveform.length - 1, low + 1)] * fraction));
      const extent = Math.max(.5, amplitude * 23);
      output.push(`M${x.toFixed(2)},${(27 - extent).toFixed(2)}V${(27 + extent).toFixed(2)}`);
    }
    return output.join('');
  }, [clip, media, zoom, phase, width, visibleStart, visibleEnd]);
  return <svg className="waveform" aria-hidden="true" data-waveform-width={width.toFixed(4)} data-waveform-phase={phase.toFixed(4)} width={Math.max(1, width)} height="54" viewBox={`0 0 ${Math.max(1, width)} 54`}><path d={path} fill="none" stroke="currentColor" strokeWidth="1" /></svg>;
});
