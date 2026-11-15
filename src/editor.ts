import type { Clip, Media, Project } from './lib/types';
import { canonicalClipBeats, clipBeatTimes } from './lib/engine';

export function canonicalBeats(clip: Clip, media: Media[]): number[] {
  return canonicalClipBeats(clip, media);
}
export function visibleBeats(clip: Clip, project: Project): number[] {
  return clipBeatTimes(clip, project.media);
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
