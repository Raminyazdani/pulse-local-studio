import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Download, FolderCheck, Github, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api } from '../editor';
import './UpdateDialog.css';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready' | 'installing' | 'error' | 'unsupported';

export interface UpdateState {
  currentVersion: string;
  latestVersion?: string;
  status: UpdateStatus;
  progress: number;
  portable: boolean;
  repository?: string;
  releaseUrl?: string;
  changelog?: string;
  message?: string;
  error?: string;
}

export interface UpdateDialogProps {
  onClose: () => void;
  /** Stop preview and flush project edits to disk before the application exits. */
  onBeforeInstall: () => Promise<void>;
  /** Defaults to reloading the editor after the new version is healthy. */
  onInstalled?: () => void;
}

const activeStatuses: UpdateStatus[] = ['checking', 'downloading', 'installing'];
const installingStatuses: UpdateStatus[] = ['downloading', 'installing'];
const normalizeVersion = (version: string) => version.replace(/^v/, '');

class UpdateHttpError extends Error {}

async function requestInstall(): Promise<UpdateState> {
  const response = await fetch('/api/updates/install', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (typeof payload.detail === 'string') message = payload.detail;
    } catch { /* Preserve the HTTP status when its body is not JSON. */ }
    throw new UpdateHttpError(message);
  }
  return response.json() as Promise<UpdateState>;
}

function safeReleaseUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function statusHeading(state: UpdateState | null, restarting: boolean, complete: boolean): string {
  if (complete) return 'Update installed';
  if (restarting) return 'Restarting Pulse';
  if (!state || state.status === 'checking') return 'Checking for a new version';
  switch (state.status) {
    case 'available': return 'A new version is ready';
    case 'up-to-date': return 'You have the latest version';
    case 'downloading': return 'Downloading your update';
    case 'ready': return 'Your update is ready to install';
    case 'installing': return 'Installing your update';
    case 'unsupported': return 'Use the portable edition to update';
    case 'error': return 'The update could not finish';
    default: return 'Check for a new version';
  }
}

export function UpdateDialog({ onClose, onBeforeInstall, onInstalled }: UpdateDialogProps) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [complete, setComplete] = useState(false);
  const initialCheck = useRef<Promise<UpdateState> | null>(null);
  const mounted = useRef(true);
  const installRequested = useRef(false);
  const lastActiveUpdate = useRef(0);
  const originalVersion = useRef('');
  const completed = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const installedCallback = useRef(onInstalled);
  installedCallback.current = onInstalled;

  const finish = useCallback(() => {
    if (completed.current || !mounted.current) return;
    completed.current = true;
    installRequested.current = false;
    setRestarting(false);
    setComplete(true);
    setError('');
    reloadTimer.current = setTimeout(() => {
      if (installedCallback.current) installedCallback.current();
      else window.location.reload();
    }, 850);
  }, []);

  const acceptState = useCallback((next: UpdateState) => {
    if (!mounted.current) return;
    if (!originalVersion.current && next.currentVersion) originalVersion.current = normalizeVersion(next.currentVersion);
    setState(next);
    if (installRequested.current && ['downloading', 'ready', 'installing'].includes(next.status)) {
      // Large releases and extraction can legitimately take several minutes.
      // A healthy worker reporting activity is never a failed restart.
      lastActiveUpdate.current = Date.now();
    }
    if (installRequested.current && normalizeVersion(next.currentVersion) !== originalVersion.current) {
      finish();
      return;
    }
    if (next.status === 'error') {
      installRequested.current = false;
      setRestarting(false);
    }
    if (next.status === 'installing' || next.status === 'ready' && installRequested.current) setRestarting(true);
  }, [finish]);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    // Opening this dialog is the user's request to check. Keep a single POST
    // across React StrictMode's effect setup/cleanup replay.
    if (!initialCheck.current) initialCheck.current = api<UpdateState>('/api/updates/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    let cancelled = false;
    void initialCheck.current.then(next => {
      if (!cancelled) acceptState(next);
    }).catch((failure: Error) => {
      if (!cancelled) setError(failure.message);
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      clearTimeout(reloadTimer.current);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [acceptState]);

  const busy = saving || restarting || installRequested.current || !!state && installingStatuses.includes(state.status);
  const polling = !complete && (!!state && activeStatuses.includes(state.status) || restarting || installRequested.current);

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let pollingNow = false;
    let failures = 0;
    async function poll() {
      if (pollingNow) return;
      pollingNow = true;
      try {
        const next = await api<UpdateState>('/api/updates');
        if (cancelled) return;
        failures = 0;
        acceptState(next);
      } catch (failure) {
        if (cancelled) return;
        failures++;
        if (!installRequested.current) {
          if (failures >= 3) {
            setError((failure as Error).message);
            setState(current => current ? { ...current, status: 'error' } : current);
          }
          return;
        }
        // The server disappears briefly while its files are replaced. Do not
        // repeat the install POST after an uncertain response.
        setRestarting(true);
      } finally {
        pollingNow = false;
      }
      if (!installRequested.current || cancelled || completed.current) return;
      try {
        const health = await api<{ ok: boolean; version?: string }>('/api/health');
        if (cancelled) return;
        if (health.ok && health.version && normalizeVersion(health.version) !== originalVersion.current) {
          finish();
          return;
        }
      } catch {
        // Continue waiting for the same installation; never re-submit it.
      }
      if (!cancelled && Date.now() - lastActiveUpdate.current > 180_000) {
        installRequested.current = false;
        setRestarting(false);
        setError('Pulse is taking longer to restart. Open Pulse.exe from this folder again, then check for updates. Your saved projects remain in the data folder.');
        setState(current => current ? { ...current, status: 'error' } : current);
      }
    }
    const timer = setInterval(() => { void poll(); }, 900);
    return () => { cancelled = true; clearInterval(timer); };
  }, [polling, acceptState, finish]);

  async function checkAgain() {
    if (busy) return;
    setError('');
    setState(current => current ? { ...current, status: 'checking' } : current);
    try {
      acceptState(await api<UpdateState>('/api/updates/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      }));
    } catch (failure) {
      setError((failure as Error).message);
      setState(current => current ? { ...current, status: 'error' } : current);
    }
  }

  async function install() {
    if (installRequested.current || busy || !state || !['available', 'ready'].includes(state.status)) return;
    setError('');
    setSaving(true);
    try {
      await onBeforeInstall();
    } catch (failure) {
      if (mounted.current) {
        setError(`Save your project before updating: ${(failure as Error).message}`);
        setSaving(false);
      }
      return;
    }
    if (!mounted.current) return;
    installRequested.current = true;
    lastActiveUpdate.current = Date.now();
    originalVersion.current = normalizeVersion(state.currentVersion);
    setSaving(false);
    setState(current => current ? { ...current, status: 'downloading', progress: 0 } : current);
    try {
      acceptState(await requestInstall());
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof UpdateHttpError) {
        installRequested.current = false;
        setRestarting(false);
        setError(failure.message);
        setState(current => current ? { ...current, status: 'error' } : current);
        return;
      }
      // A server can stop before its response reaches the browser. Observe its
      // status/restart instead of risking a second concurrent installation.
      setRestarting(true);
      setError(`Waiting for the update result. ${(failure as Error).message}`);
    }
  }

  function close() { if (!busy && !complete) onClose(); }
  const releaseUrl = safeReleaseUrl(state?.releaseUrl);
  const progress = Math.round(Math.max(0, Math.min(1, Number.isFinite(state?.progress) ? state!.progress : 0)) * 100);
  const heading = error && !busy ? 'Unable to update Pulse' : statusHeading(state, restarting, complete);
  const hasError = !!error || state?.status === 'error';
  const working = saving || restarting || !state && !error || !!state && activeStatuses.includes(state.status);
  const canInstall = !!state && ['available', 'ready'].includes(state.status) && state.portable && !busy;
  const showProgress = !!state && installingStatuses.includes(state.status) || restarting;

  return <div className="modal-backdrop pulse-update-backdrop" onClick={close}>
    <div className="modal pulse-update-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pulse-update-title" aria-describedby="pulse-update-description" onClick={event => event.stopPropagation()} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]');
        if (!focusable?.length) { event.preventDefault(); return; }
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
      <button ref={closeButton} className="modal-close" onClick={close} disabled={busy || complete} aria-label="Close updates"><X size={18}/></button>
      <span className="eyebrow">PULSE / UPDATES</span>
      <h2 id="pulse-update-title">Keep Pulse up to date<span className="small-accent">.</span></h2>
      <p id="pulse-update-description">Get the latest portable version from GitHub.</p>

      <div className={`pulse-update-status ${hasError ? 'error' : complete || state?.status === 'up-to-date' ? 'success' : ''}`} aria-live="polite" role="status">
        <span className="pulse-update-status-icon">{complete || state?.status === 'up-to-date' ? <Check size={20}/> : hasError && !working ? <CircleAlert size={20}/> : working ? <LoaderCircle size={20} className="spin"/> : <Download size={20}/>}</span>
        <div><strong>{saving ? 'Saving your current project' : heading}</strong><span>{complete ? 'The editor will reopen in a moment.' : restarting ? 'The editor will reopen after the new version starts.' : state?.message ?? (state?.status === 'available' ? 'Download, install and restart from this folder.' : 'Updates are checked only when you ask.')}</span></div>
      </div>

      <div className="pulse-update-versions"><div><span>INSTALLED</span><strong>{state?.currentVersion ? `v${normalizeVersion(state.currentVersion)}` : '—'}</strong></div><ArrowRight size={17}/><div><span>LATEST</span><strong>{state?.latestVersion ? `v${normalizeVersion(state.latestVersion)}` : '—'}</strong></div></div>

      {showProgress && <div className="pulse-update-progress"><div><span>{restarting ? 'Installing and restarting' : 'Downloading update'}</span><strong>{restarting ? '' : `${progress}%`}</strong></div><progress aria-label="Update download progress" value={restarting ? undefined : progress} max="100"/></div>}
      {hasError && <p className="pulse-update-error" role="alert">{error || state?.error || state?.message || 'Check your internet connection and try again.'}</p>}
      {state?.changelog && <details className="pulse-update-notes"><summary>What’s new</summary><pre>{state.changelog}</pre></details>}

      <div className="pulse-update-folder"><FolderCheck size={18}/><p>Your projects, original media and exports stay in this folder. The update replaces program files.</p></div>
      {canInstall ? <button className="button primary full" onClick={() => { void install(); }}><Download size={15}/>Update now<ArrowRight size={15}/></button> : busy || complete ? <button className="button primary full" disabled><LoaderCircle size={15} className="spin"/>{complete ? 'Reopening editor…' : saving ? 'Saving project…' : restarting ? 'Restarting Pulse…' : 'Updating Pulse…'}</button> : <button className="button outline full" disabled={state?.status === 'checking'} onClick={() => { void checkAgain(); }}><RefreshCw size={14}/>{hasError ? 'Try again' : state?.status === 'checking' ? 'Checking…' : 'Check again'}</button>}
      {releaseUrl && <a className="pulse-update-release" href={releaseUrl} target="_blank" rel="noopener noreferrer"><Github size={13}/>View release on GitHub<ArrowUpRight size={12}/></a>}
    </div>
  </div>;
}
