import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { api } from '../editor';
import { parseProject } from './project';
import { ProjectSaveQueue } from './projectPersistence';
import type { SavedProject } from './projectPersistence';
import type { Project } from './types';

export const PROJECT_STORAGE_KEY = 'pulse.project.v1';
type SaveStatus = 'loading' | 'pending' | 'saving' | 'saved' | 'error';

function cacheProject(project: Project) {
  try { localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project)); } catch { /* The folder copy remains authoritative. */ }
}

export function useProjectPersistence(
  project: Project,
  setProject: Dispatch<SetStateAction<Project>>,
  createProject: () => Project,
  reportError: (message: string, error?: boolean) => void,
) {
  const [ready, setReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [initializationError, setInitializationError] = useState('');
  const [projects, setProjects] = useState<SavedProject[]>([]);
  const [retry, setRetry] = useState(0);
  const current = useRef(project);
  current.current = project;
  const lastSaved = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transitioning = useRef(false);
  const boot = useRef<Promise<{ project: Project | null }> | null>(null);
  const writer = useRef<ProjectSaveQueue | null>(null);
  if (!writer.current) writer.current = new ProjectSaveQueue((id, body) => api(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
  }));

  const refreshProjects = useCallback(async () => {
    const result = await api<{ projects: SavedProject[] }>('/api/projects');
    setProjects(result.projects);
    return result.projects;
  }, []);

  const persist = useCallback(async (snapshot: Project) => {
    const serialized = JSON.stringify(snapshot);
    setStatus('saving');
    const saved = await writer.current!.save(snapshot);
    lastSaved.current = serialized;
    setProjects(existing => [
      { id: snapshot.id, name: snapshot.name, updated: saved.updated },
      ...existing.filter(item => item.id !== snapshot.id),
    ].sort((a, b) => b.updated - a.updated));
    if (JSON.stringify(current.current) === serialized) setStatus('saved');
    else setStatus('pending');
    return saved;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setInitializationError('');
    setStatus('loading');
    // Keep one request across React StrictMode's setup/cleanup replay.
    if (!boot.current) boot.current = api<{ project: Project | null }>('/api/projects/active');
    void boot.current.then(async result => {
      if (cancelled) return;
      const loaded = result.project ? parseProject(result.project) : current.current;
      // Only the first folder initialization imports the browser recovery copy.
      // Existing folder projects always win over another machine's browser.
      if (!result.project) await writer.current!.save(loaded);
      if (cancelled) return;
      lastSaved.current = JSON.stringify(loaded);
      current.current = loaded;
      setProject(loaded);
      cacheProject(loaded);
      setStatus('saved');
      setReady(true);
      await refreshProjects();
    }).catch((error: Error) => {
      if (!cancelled) {
        setStatus('error');
        setInitializationError(error.message);
      }
    });
    return () => { cancelled = true; };
  }, [retry, refreshProjects, setProject]);

  useEffect(() => {
    if (!ready || switching) return;
    cacheProject(project);
    const snapshot = JSON.stringify(project);
    clearTimeout(timer.current);
    if (snapshot === lastSaved.current) {
      setStatus('saved');
      return;
    }
    setStatus('pending');
    timer.current = setTimeout(() => {
      void persist(project).catch((error: Error) => {
        setStatus('error');
        reportError(`Could not save to the project folder: ${error.message}. Your browser recovery copy is retained.`, true);
      });
    }, 600);
    return () => clearTimeout(timer.current);
  }, [project, ready, switching, persist, reportError]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    await writer.current!.drain();
    const snapshot = current.current;
    if (JSON.stringify(snapshot) !== lastSaved.current) await persist(snapshot);
  }, [persist]);

  useEffect(() => {
    if (!ready) return;
    const beforeClose = (event: BeforeUnloadEvent) => {
      cacheProject(current.current);
      if (JSON.stringify(current.current) !== lastSaved.current) {
        void flush().catch(() => undefined);
        // The prompt only appears for edits that have not reached the folder.
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flush().catch(() => setStatus('error'));
    };
    window.addEventListener('beforeunload', beforeClose);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', beforeClose);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ready, flush]);

  const activate = useCallback(async (load: () => Promise<Project>) => {
    if (!ready || transitioning.current) return false;
    transitioning.current = true;
    setSwitching(true);
    setInitializationError('');
    try {
      await flush();
      const loaded = await load();
      // Saving also switches the active folder pointer; all older saves have
      // finished, so reopening another project cannot accidentally undo it.
      const saved = await writer.current!.save(loaded);
      lastSaved.current = JSON.stringify(loaded);
      current.current = loaded;
      cacheProject(loaded);
      setProject(loaded);
      setProjects(existing => [
        { id: loaded.id, name: loaded.name, updated: saved.updated },
        ...existing.filter(item => item.id !== loaded.id),
      ].sort((a, b) => b.updated - a.updated));
      setStatus('saved');
      return true;
    } catch (error) {
      setStatus('error');
      reportError(`Could not switch projects: ${(error as Error).message}. Your current project is still open.`, true);
      return false;
    } finally {
      transitioning.current = false;
      setSwitching(false);
    }
  }, [ready, flush, reportError, setProject]);

  const switchProject = useCallback((id: string) => activate(async () => {
    const result = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`);
    return parseProject(result.project);
  }), [activate]);

  const addProject = useCallback(() => activate(async () => ({
    ...createProject(),
    media: current.current.media,
    name: projects.length ? `Untitled sequence ${projects.length + 1}` : 'Untitled sequence',
  })), [activate, createProject, projects.length]);

  const importProject = useCallback((loaded: Project) => activate(async () => loaded), [activate]);

  const retryInitialization = useCallback(() => {
    boot.current = null;
    setRetry(value => value + 1);
  }, []);

  return {
    ready, switching, status, projects, initializationError,
    refreshProjects, switchProject, addProject, importProject, flush, retryInitialization,
  };
}
