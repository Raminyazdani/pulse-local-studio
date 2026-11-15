import { useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, Pause, Play, Repeat2, Trash2, WandSparkles } from 'lucide-react';
import type { Clip, Media } from '../lib/types';
import { availableBeatGroups, clipBeats, clipDuration, deleteClipBeats, generateRepeatedBeats,
  repeatClipBeats, resolveClipTime, selectedBeatInterval, sourceToOutput } from '../lib/engine';
import './BeatWorkbench.css';

interface Props {
  clip: Clip; media: Media[]; selected: number[]; disabled: boolean;
  onSelection: (times: number[]) => void;
  onChange: (clip: Clip) => void;
  onPause: () => void;
  onSeek: (time: number) => void;
  onError: (message: string) => void;
  onPreview: (clipId: string, beats: number[] | null) => void;
}
const near = (a: number, b: number) => Math.abs(a - b) < .0001;
const PAGE = 60;

export function BeatWorkbench(p: Props) {
  const groups = useMemo(() => availableBeatGroups(p.clip, p.media), [p.clip, p.media]);
  const beats = useMemo(() => clipBeats(p.clip, p.media).map(t => sourceToOutput(p.clip, t)), [p.clip, p.media]);
  const selected = useMemo(() => {
    const keys = new Set(beats.map(t => t.toFixed(6)));
    return p.selected.filter(t => keys.has(t.toFixed(6)));
  }, [p.selected, beats]);
  const selectedKeys = useMemo(() => new Set(selected.map(t => t.toFixed(6))), [selected]);
  const signature = useMemo(() => selected.map(t => t.toFixed(6)).join(','), [selected]);
  const [period, setPeriod] = useState('0.5');
  const [mode, setMode] = useState<'regular' | 'pattern'>('regular');
  const [fillBefore, setFillBefore] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [page, setPage] = useState(0);
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const audition = useRef<HTMLAudioElement | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const auditionToken = useRef(0);
  const duration = clipDuration(p.clip);

  useEffect(() => {
    try {
      const inferred = selectedBeatInterval(selected, mode);
      if (inferred !== undefined) setPeriod(String(Number(inferred.toFixed(6))));
    } catch { /* The generated-result panel explains an oversized selection. */ }
    // Selection values are the dependency; playback does not reset this field.
  }, [signature, mode]);
  useEffect(() => { setPage(0); setShowPreview(false); }, [p.clip.id]);
  useEffect(() => {
    const audio = audition.current;
    return () => {
      ++auditionToken.current; clearTimeout(stopTimer.current);
      if (audio) {
        audio.pause(); audio.onloadedmetadata = null; audio.onended = null;
        audio.onerror = null; audio.ontimeupdate = null; audio.removeAttribute('src'); audio.load();
      }
    };
  }, []);

  const generated = useMemo(() => {
    try {
      if (!selected.length) return { beats: [] as number[], error: '' };
      return { beats: generateRepeatedBeats(selected, duration, { period: Number(period), mode, fillBefore }), error: '' };
    } catch (error) { return { beats: [] as number[], error: (error as Error).message }; }
  }, [signature, duration, period, mode, fillBefore]);
  useEffect(() => {
    p.onPreview(p.clip.id, showPreview && !generated.error ? generated.beats : null);
    return () => p.onPreview(p.clip.id, null);
  }, [showPreview, generated, p.clip.id, p.onPreview]);

  function stopSample() {
    ++auditionToken.current; clearTimeout(stopTimer.current);
    audition.current?.pause(); setAuditioning(null);
  }
  function listen(mediaId: string, time: number, key: string) {
    if (auditioning === key) { stopSample(); return; }
    stopSample(); p.onPause();
    const asset = p.media.find(m => m.id === mediaId);
    if (!asset) return;
    const audio = audition.current ?? new Audio(); audition.current = audio;
    const token = ++auditionToken.current;
    const next = asset.beats?.find(b => b > time + .025);
    const start = Math.max(0, time - .025);
    const end = Math.min(asset.duration, time + .24, next === undefined ? Infinity : Math.max(time + .06, next - .015));
    setAuditioning(key); audio.preload = 'auto'; audio.src = asset.url;
    audio.onended = () => { if (token === auditionToken.current) stopSample(); };
    audio.ontimeupdate = () => { if (token === auditionToken.current && audio.currentTime >= end) stopSample(); };
    const play = async () => {
      if (token !== auditionToken.current) return;
      try {
        audio.currentTime = start; await audio.play();
        if (token !== auditionToken.current) return;
        stopTimer.current = setTimeout(stopSample, Math.max(60, (end - start) * 1000));
      } catch (error) {
        if (token === auditionToken.current) { stopSample(); p.onError(`Sample could not play: ${(error as Error).message}`); }
      }
    };
    audio.onloadedmetadata = () => void play();
    audio.onerror = () => { if (token === auditionToken.current) { stopSample(); p.onError('The local audio sample could not load.'); } };
  }
  function toggle(time: number) {
    p.onSelection(selected.some(t => near(t, time)) ? selected.filter(t => !near(t, time)) : [...selected, time].sort((a, b) => a - b));
  }
  function act(operation: () => Clip) {
    try { stopSample(); p.onChange(operation()); p.onSelection([]); setShowPreview(false); }
    catch (error) { p.onError((error as Error).message); }
  }
  const enabledGroups = p.clip.beatConfig?.enabledGroups;
  const manual = p.clip.beatEdits !== undefined;
  const pages = Math.max(1, Math.ceil(beats.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  return <div className="beat-workbench">
    <audio ref={audition} data-testid="beat-audition" preload="none" hidden />
    <section className="control-section beat-group-section" aria-label="Sound groups">
      <div className="section-label"><span><Headphones size={13} /> SOUND GROUPS</span><span className="count-pill">{groups.length}</span></div>
      <p className="hint">Listen to each sample. Keep the groups with the bass attacks you want.</p>
      {!groups.length && <p className="beat-empty">Detect beats to compare groups of similar sounds.</p>}
      {manual && groups.length > 0 && <div className="beat-manual-note">Using edited beats. <button type="button" disabled={p.disabled} onClick={() => {
        stopSample(); p.onSelection([]); p.onChange({ ...p.clip, beatEdits: undefined, beatConfig: { every: 1, offset: 0 },
          editSource: p.clip.editSource ? { ...p.clip.editSource, beatEdits: undefined } : undefined });
      }}>Use detected groups again</button></div>}
      <div className="beat-group-list">{groups.map(group => <div className="beat-group" key={group.key} data-group-key={group.key}>
        <label><input type="checkbox" aria-label={`Keep ${group.label}`} disabled={p.disabled || manual}
          checked={enabledGroups === undefined || enabledGroups.includes(group.key)} onChange={e => {
            const references = new Set([...p.clip.segments, ...(p.clip.editSource?.segments ?? [])].map(s => s.mediaId));
            const kept = enabledGroups ?? p.media.filter(m => references.has(m.id)).flatMap(m =>
              m.beatGroups?.length ? m.beatGroups.map(g => `${m.id}:${g.id}`) : (m.beats?.length ? [`${m.id}:unclassified`] : []));
            p.onSelection([]); p.onChange({ ...p.clip, beatConfig: { ...p.clip.beatConfig,
              enabledGroups: e.target.checked ? [...new Set([...kept, group.key])] : kept.filter(key => key !== group.key) } });
          }} /><span><strong>{group.label}</strong><small>{group.count} beats{group.bassScore === undefined ? '' : ` · ${Math.round(group.bassScore * 100)}% low energy`}</small></span></label>
        <button type="button" className={auditioning === group.key ? 'sample-button active' : 'sample-button'} aria-label={`${auditioning === group.key ? 'Stop' : 'Play'} ${group.label} sample`}
          onClick={() => listen(group.mediaId, group.sampleTime, group.key)}>{auditioning === group.key ? <Pause size={13} /> : <Play size={13} />}</button>
      </div>)}</div>
    </section>

    <section className="control-section" aria-label="Individual beats">
      <div className="section-label"><span>INDIVIDUAL BEATS</span><span className="count-pill">{selected.length} picked</span></div>
      <div className="beat-selection-actions"><button type="button" disabled={!beats.length || beats.length > 100000} onClick={() => p.onSelection(beats)}>Select all beats</button>
        <button type="button" disabled={!selected.length} onClick={() => p.onSelection([])}>Clear selection</button></div>
      <p className="hint">Click a numbered timeline beat. Ctrl-click adds beats; Shift-click selects a range.</p>
      <div className="beat-pick-list">{beats.slice(safePage * PAGE, (safePage + 1) * PAGE).map((time, i) => {
        const index = safePage * PAGE + i, resolved = resolveClipTime(p.clip, time);
        return <div className={`beat-pick-row ${selectedKeys.has(time.toFixed(6)) ? 'picked' : ''}`} key={time.toFixed(6)}>
          <label><input type="checkbox" aria-label={`Select beat ${index + 1}`} checked={selectedKeys.has(time.toFixed(6))} onChange={() => toggle(time)} />
            <span>#{index + 1}</span><time>{time.toFixed(3)}s</time></label>
          <button type="button" title={`Go to beat ${index + 1}`} aria-label={`Go to beat ${index + 1}`} onClick={() => { p.onPause(); p.onSeek(p.clip.start + time); }}><WandSparkles size={12} /></button>
          <button type="button" aria-label={`Play beat ${index + 1} sample`} disabled={!resolved} onClick={() => resolved && listen(resolved.mediaId, resolved.time, `beat:${time}`)}><Play size={12} /></button>
        </div>;
      })}</div>
      {pages > 1 && <div className="beat-pagination"><button type="button" disabled={!safePage} onClick={() => setPage(safePage - 1)}>Previous</button><span>{safePage + 1} / {pages}</span><button type="button" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>Next</button></div>}
      {!beats.length && <p className="beat-empty">No beats kept. Detect again or enable a sound group.</p>}
      <button type="button" className="button subtle full" disabled={p.disabled || !selected.length} onClick={() => act(() => deleteClipBeats(p.clip, selected, p.media))}><Trash2 size={13} />Delete selected beats</button>
    </section>

    <section className="control-section beat-repeat-section" aria-label="Filter and repeat">
      <div className="section-label"><span><Repeat2 size={13} /> FILTER & REPEAT</span></div>
      <p className="hint">Pick one or more beats. Replace every other marker with this repeating rhythm.</p>
      <label className="field-label">REPEAT MODE<select aria-label="Beat repeat mode" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="regular">Regular interval</option><option value="pattern">Repeat selected pattern</option>
      </select></label>
      <label className="field-label spaced">{mode === 'regular' ? 'INTERVAL' : 'PATTERN CYCLE'} · SEC<input aria-label="Beat repeat interval" type="number" min=".001" step=".001" value={period} onChange={e => setPeriod(e.target.value)} /></label>
      <p className="hint">{selected.length > 1 ? 'Suggested from your selected beats; you can change it.' : 'For example, 0.5 creates one beat every half-second.'}</p>
      <label className="beat-fill"><input type="checkbox" checked={fillBefore} onChange={e => setFillBefore(e.target.checked)} />Fill the whole clip, including before the first pick</label>
      <div className="beat-repeat-result" role="status">{generated.error ? generated.error : selected.length ? <><strong>{generated.beats.length} resulting beats</strong><span>{generated.beats.slice(0, 6).map(t => `${t.toFixed(3)}s`).join(' · ')}{generated.beats.length > 6 ? ' …' : ''}</span></> : 'Select a timeline beat or use the checkboxes above.'}</div>
      <label className="beat-fill"><input type="checkbox" aria-label="Preview repeated beats" disabled={!generated.beats.length || !!generated.error} checked={showPreview} onChange={e => setShowPreview(e.target.checked)} />Preview pattern on timeline</label>
      <button type="button" className="button primary full" disabled={p.disabled || !selected.length || !!generated.error || !generated.beats.length}
        onClick={() => act(() => repeatClipBeats(p.clip, selected, { period: Number(period), mode, fillBefore }, p.media))}><Repeat2 size={14} />Filter & repeat</button>
      <p className="beat-replace-note">Replaces the clip’s beat markers. Your music stays unchanged. Ctrl+Z restores the previous markers.</p>
    </section>
  </div>;
}
