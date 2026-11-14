import type { Clip, Media, Project } from './lib/types';
import { sourceToOutput, selectBeats } from './lib/engine';

export function canonicalBeats(clip: Clip, media: Media[]): number[] {
  if (clip.beatEdits !== undefined) return clip.beatEdits;
  let cursor = 0;
  const values: number[] = [];
  for (const segment of clip.segments) {
    const asset = media.find(m => m.id === segment.mediaId);
    for (const beat of asset?.beats ?? []) {
      if (beat >= segment.in && beat < segment.out) values.push(cursor + (beat - segment.in) / (segment.speed ?? 1));
    }
    cursor += (segment.out - segment.in) / (segment.speed ?? 1);
  }
  return values.sort((a,b) => a-b);
}
export function visibleBeats(clip: Clip, project: Project): number[] {
  const beats = selectBeats(canonicalBeats(clip, project.media), clip.beatConfig ?? {every:1,offset:0});
  return beats.map(b => clip.start + sourceToOutput(clip,b));
}
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try { const body = await response.json(); message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body); } catch { /* keep HTTP status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export function downloadJSON(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
