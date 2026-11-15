import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  CircleHelp,
  Clapperboard,
  Download,
  Film,
  Flag,
  FolderOpen,
  Image,
  Layers2,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Redo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import type { Clip, ExportSettings, Media, Project, Track } from "./lib/types";
import {
  alignClipToBeats,
  clipDuration,
  deleteClipBeats,
  flattenClip,
  formatTime,
  mergeClips,
  projectDuration,
  replaceClipBeats,
  selectedBeatInterval,
  sourceToOutput,
  splitClip,
  uid,
} from "./lib/engine";
import { parseProject } from "./lib/project";
import {
  PROJECT_STORAGE_KEY,
  useProjectPersistence,
} from "./lib/useProjectPersistence";
import { api, downloadJSON, visibleBeats } from "./editor";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { SourceRange } from "./components/SourceRange";
import { UpdateDialog } from "./components/UpdateDialog";
import { BeatWorkbench } from "./components/BeatWorkbench";
import { useWorkspaceResize, WorkspaceResizeHandle, WorkspacePanelHandles, PanelDragHandle, PreviewSizeControl } from "./components/WorkspaceResize";

const STORAGE = PROJECT_STORAGE_KEY;
function newProject(): Project {
  return {
    id: uid("project"),
    name: "Untitled sequence",
    version: 1,
    aspect: "16:9",
    media: [],
    tracks: [
      {
        id: uid("track"),
        name: "Video 01",
        kind: "video",
        muted: false,
        hidden: false,
        locked: false,
      },
      {
        id: uid("track"),
        name: "Soundtrack",
        kind: "audio",
        muted: false,
        hidden: false,
        locked: false,
      },
    ],
    clips: [],
  };
}
function initialProject() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) return parseProject(JSON.parse(raw));
  } catch {
    /* fresh project */
  }
  return newProject();
}
const iconFor = (kind: string, size = 16) =>
  kind === "audio" ? (
    <Music2 size={size} />
  ) : kind === "image" ? (
    <Image size={size} />
  ) : (
    <Film size={size} />
  );
type Job = {
  id: string;
  status: string;
  progress: number;
  error?: string;
  url?: string;
};

export default function App() {
  const workspaceResize = useWorkspaceResize();
  const [project, setProject] = useState<Project>(initialProject);
  const currentProject = useRef(project);
  currentProject.current = project;
  const [selected, setSelected] = useState<string[]>([]);
  const [beatSelection, setBeatSelection] = useState<{ clipId: string; times: number[]; anchor?: number }>({ clipId: "", times: [] });
  const [beatRepeatPreview, setBeatRepeatPreview] = useState<{ clipId: string; times: number[] } | null>(null);
  const pauseForSample = useCallback(() => setPlaying(false), []);
  const showBeatRepeatPreview = useCallback((clipId: string, beats: number[] | null) => {
    setBeatRepeatPreview(beats ? { clipId, times: beats } : null);
  }, []);
  const [editPreview, setEditPreview] = useState<Clip[] | null>(null);
  const [selectedTrack, setSelectedTrack] = useState("");
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(38);
  const [tool, setTool] = useState<"select" | "marker" | "slip">("select");
  const [libraryFilter, setLibraryFilter] = useState("all");
  const [tab, setTab] = useState<"clip" | "beats" | "sync">("beats");
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [online, setOnline] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    width: 1920,
    height: 1080,
    fps: 30,
    quality: "high",
    format: "mp4",
  });
  const [sensitivity, setSensitivity] = useState(1);
  const [minInterval, setMinInterval] = useState(0.22);
  const [syncVideo, setSyncVideo] = useState("");
  const [syncAudio, setSyncAudio] = useState("");
  const [beatOffset, setBeatOffset] = useState(0);
  const [history, setHistory] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), error ? 10000 : 4500);
  }, []);
  const persistence = useProjectPersistence(
    project,
    setProject,
    newProject,
    notify,
  );
  const commit = useCallback(
    (next: Project) => {
      const previous = currentProject.current;
      setHistory((h) => [...h.slice(-49), previous]);
      setFuture([]);
      currentProject.current = next;
      setProject(next);
    },
    [],
  );
  const isLocked = (id: string) =>
    project.tracks.find(
      (t) => t.id === project.clips.find((c) => c.id === id)?.trackId,
    )?.locked;
  const updateClip = (id: string, patch: Partial<Clip>) => {
    if (isLocked(id)) {
      notify("Unlock this track to edit its clips.", true);
      return;
    }
    if (["segments", "warp", "sourceWindow", "beatEdits", "beatConfig"].some(key => Object.prototype.hasOwnProperty.call(patch, key)))
      setBeatSelection(previous => previous.clipId === id ? { clipId: "", times: [] } : previous);
    commit({
      ...project,
      clips: project.clips.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        if (Object.prototype.hasOwnProperty.call(patch, "beatEdits") &&
            patch.beatEdits === undefined && next.editSource)
          next.editSource = { ...next.editSource, beatEdits: undefined };
        return Object.prototype.hasOwnProperty.call(patch, "segments") ||
          Object.prototype.hasOwnProperty.call(patch, "warp")
          ? flattenClip(next)
          : next;
      }),
    });
  };
  const undo = () => {
    setBeatSelection({ clipId: "", times: [] });
    const previous = history.at(-1);
    if (previous) {
      setFuture((f) => [project, ...f]);
      setProject(previous);
      setHistory((h) => h.slice(0, -1));
    }
  };
  const redo = () => {
    setBeatSelection({ clipId: "", times: [] });
    const next = future[0];
    if (next) {
      setHistory((h) => [...h, project]);
      setProject(next);
      setFuture((f) => f.slice(1));
    }
  };
  const duration = projectDuration(project);
  const previewProject = editPreview
    ? { ...project, clips: editPreview }
    : project;
  const showEditPreview = useCallback((clips: Clip[] | null, at?: number) => {
    setPlaying(false);
    setEditPreview(clips);
    if (at !== undefined) setTime(Math.max(0, at));
  }, []);
  const showSourcePreview = useCallback(
    (draft: Clip | null, at?: number) => {
      showEditPreview(
        draft
          ? project.clips.map((c) => (c.id === draft.id ? draft : c))
          : null,
        at,
      );
    },
    [project.clips, showEditPreview],
  );
  const clip = project.clips.find((c) => c.id === selected[0]);
  const clipTrack = project.tracks.find((t) => t.id === clip?.trackId);
  const asset = project.media.find((m) => m.id === clip?.segments[0]?.mediaId);
  const audioClips = project.clips.filter(
    (c) => project.tracks.find((t) => t.id === c.trackId)?.kind === "audio",
  );
  const videoClips = project.clips.filter(
    (c) => project.tracks.find((t) => t.id === c.trackId)?.kind === "video",
  );
  const activeAudio =
    audioClips.find((c) => c.id === syncAudio) ??
    audioClips.find((c) => selected.includes(c.id)) ??
    audioClips[0];
  const activeVideo =
    videoClips.find((c) => c.id === syncVideo) ??
    videoClips.find((c) => selected.includes(c.id)) ??
    videoClips[0];

  useEffect(() => {
    setEditPreview(null);
    setBeatSelection({ clipId: "", times: [] });
    setBeatRepeatPreview(null);
    setSelected([]);
    setSelectedTrack("");
    setTime(0);
    setPlaying(false);
    setHistory([]);
    setFuture([]);
    setSyncVideo("");
    setSyncAudio("");
    setBeatOffset(0);
    setProjectMenu(false);
  }, [project.id]);
  useEffect(() => {
    let stopped = false;
    async function check() {
      try {
        const health = await api<{ ok: boolean }>("/api/health");
        if (!stopped) setOnline(health.ok);
      } catch {
        if (!stopped) setOnline(false);
      }
    }
    void check();
    const timer = setInterval(check, 15000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!online || !persistence.ready || persistence.switching) return;
    let stopped = false;
    void api<{ media: Media[] }>("/api/media")
      .then((result) => {
        if (stopped) return;
        setProject((p) => ({
          ...p,
          media: [
            ...p.media.map((m) => result.media.find((a) => a.id === m.id) ?? m),
            ...result.media.filter((m) => !p.media.some((a) => a.id === m.id)),
          ],
        }));
      })
      .catch((e) => notify(String(e), true));
    return () => {
      stopped = true;
    };
  }, [online, persistence.ready, persistence.switching, project.id, notify]);
  useEffect(() => {
    if (
      !job ||
      !["pending", "queued", "processing", "running", "rendering"].includes(
        job.status,
      )
    )
      return;
    let stopped = false;
    const timer = setInterval(() => {
      void api<Job>(`/api/export/${job.id}`)
        .then((result) => {
          if (!stopped) setJob(result);
        })
        .catch((e) => {
          if (!stopped) notify(String(e), true);
        });
    }, 900);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status, notify]);

  function select(ids: string[]) {
    setBeatSelection({ clipId: "", times: [] });
    setSelected(ids);
    const c = project.clips.find((c) => c.id === ids[0]);
    if (c) {
      setSelectedTrack(c.trackId);
      if (project.tracks.find((t) => t.id === c.trackId)?.kind === "audio") {
        setSyncAudio(c.id);
        setTab("clip");
      } else {
        setSyncVideo(c.id);
        setTab("clip");
      }
    }
  }
  function addTrack(kind: "video" | "audio") {
    const track: Track = {
      id: uid("track"),
      name:
        kind === "video"
          ? `Video ${String(project.tracks.filter((t) => t.kind === "video").length + 1).padStart(2, "0")}`
          : `Audio ${project.tracks.filter((t) => t.kind === "audio").length + 1}`,
      kind,
      muted: false,
      hidden: false,
      locked: false,
    };
    commit({
      ...project,
      tracks:
        kind === "video"
          ? [
              ...project.tracks.filter((t) => t.kind === "video"),
              track,
              ...project.tracks.filter((t) => t.kind === "audio"),
            ]
          : [...project.tracks, track],
    });
    setSelectedTrack(track.id);
  }
  function addMedia(mediaId: string, trackId?: string, at?: number) {
    const media = project.media.find((m) => m.id === mediaId);
    if (!media) return;
    const kind = media.kind === "audio" ? "audio" : "video";
    let track =
      project.tracks.find(
        (t) => t.id === trackId && t.kind === kind && !t.locked,
      ) ??
      project.tracks.find(
        (t) => t.id === selectedTrack && t.kind === kind && !t.locked,
      ) ??
      project.tracks.find((t) => t.kind === kind && !t.locked);
    if (
      trackId &&
      !project.tracks.some((t) => t.id === trackId && t.kind === kind)
    ) {
      notify(
        "Use an audio track for music, or a video track for video and images.",
        true,
      );
      return;
    }
    const tracks = [...project.tracks];
    if (!track) {
      track = {
        id: uid("track"),
        name: kind === "video" ? "Video" : "Soundtrack",
        kind,
        muted: false,
        hidden: false,
        locked: false,
      };
      if (kind === "video") tracks.unshift(track);
      else tracks.push(track);
    }
    const start =
      at ??
      Math.max(
        0,
        ...project.clips
          .filter((c) => c.trackId === track.id)
          .map((c) => c.start + clipDuration(c)),
      );
    const added: Clip = {
      id: uid("clip"),
      name: media.name,
      trackId: track.id,
      start,
      segments: [
        { mediaId: media.id, in: 0, out: media.duration || 5, speed: 1 },
      ],
      signals: [],
      muted: false,
      volume: 1,
    };
    commit({ ...project, tracks, clips: [...project.clips, added] });
    setSelected([added.id]);
    setSelectedTrack(track.id);
    if (kind === "audio") {
      setSyncAudio(added.id);
      setTab("beats");
    } else {
      setSyncVideo(added.id);
      setTab("clip");
    }
  }
  async function upload(files: FileList | File[] | null) {
    if (!files?.length) return;
    setBusy(`Importing ${files.length} file${files.length > 1 ? "s" : ""}…`);
    const form = new FormData();
    Array.from(files).forEach((file) => form.append("files", file));
    try {
      const result = await api<{
        media: Media[];
        errors?: { name: string; error: string }[];
      }>("/api/media", { method: "POST", body: form });
      setProject((p) => ({
        ...p,
        media: [
          ...p.media,
          ...result.media.filter((m) => !p.media.some((a) => a.id === m.id)),
        ],
      }));
      if (result.errors?.length)
        notify(
          `${result.media.length} imported. Could not import: ${result.errors.map((e) => `${e.name}: ${e.error}`).join("; ")}`,
          true,
        );
      else
        notify(
          `${result.media.length} file${result.media.length > 1 ? "s" : ""} ready. Drag to a track or click +.`,
        );
    } catch (e) {
      notify(`Import failed: ${(e as Error).message}`, true);
    } finally {
      setBusy("");
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  function removeSelected() {
    if (!selected.length) return;
    commit({
      ...project,
      clips: project.clips.filter(
        (c) => !selected.includes(c.id) || isLocked(c.id),
      ),
    });
    setSelected(selected.filter(isLocked));
  }
  function split() {
    if (!clip) return;
    if (isLocked(clip.id)) {
      notify("Unlock this track to split its clips.", true);
      return;
    }
    try {
      const parts = splitClip(clip, time, project.media);
      commit({
        ...project,
        clips: project.clips.flatMap((c) => (c.id === clip.id ? parts : [c])),
      });
      setSelected([parts[1].id]);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  function merge() {
    const track =
      project.tracks.find((t) => t.id === selectedTrack) ??
      project.tracks.find((t) => t.kind === "video");
    if (!track || track.locked) {
      notify("Select an unlocked track first.", true);
      return;
    }
    const clips = project.clips.filter((c) => c.trackId === track.id);
    if (clips.length < 2) {
      notify("Add at least two clips to this track to merge.", true);
      return;
    }
    try {
      const merged = mergeClips(clips, project.media);
      commit({
        ...project,
        clips: [...project.clips.filter((c) => c.trackId !== track.id), merged],
      });
      setSelected([merged.id]);
      setSyncVideo(merged.id);
      setTab("sync");
      notify("Track merged. Original media retained; gaps closed.");
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  function marker(id: string, local: number) {
    const target = project.clips.find((c) => c.id === id);
    if (!target) return;
    const track = project.tracks.find((t) => t.id === target.trackId);
    if (track?.locked) return;
    if (local < 0 || local >= clipDuration(target)) return;
    if (track?.kind === "audio") {
      const beats = visibleBeats(target, project).map(t => t - target.start);
      const nearest = beats.findIndex((b) => Math.abs(b - local) < 0.1);
      const edited =
        nearest >= 0
          ? beats.filter((_, i) => i !== nearest)
          : [...beats, local].sort((a, b) => a - b);
      updateClip(id, replaceClipBeats(target, edited, project.media));
      setBeatSelection({ clipId: "", times: [] });
      notify(nearest >= 0 ? "Beat removed." : "Manual beat added.");
    } else {
      const flat = flattenClip(target);
      if (flat.signals.some((s) => Math.abs(s - local) < 0.02)) return;
      updateClip(id, {
        ...flat,
        signals: [...flat.signals, local].sort((a, b) => a - b),
      });
      setSelected([id]);
      setSyncVideo(id);
      notify(`Beat signal ${target.signals.length + 1} added.`);
    }
  }
  function removeSignal(id: string, index: number) {
    const target = project.clips.find((c) => c.id === id);
    if (!target) return;
    const flat = flattenClip(target);
    updateClip(id, {
      ...flat,
      signals: flat.signals.filter((_, i) => i !== index),
    });
  }
  async function analyze() {
    setBeatSelection({ clipId: "", times: [] });
    const target = clipTrack?.kind === "audio" ? clip : activeAudio;
    const media = project.media.find(
      (m) => m.id === target?.segments[0]?.mediaId,
    );
    if (!media) {
      notify("Add a soundtrack to an audio track first.", true);
      return;
    }
    setBusy("Listening for kick transients…");
    try {
      const result = await api<{
        beats: number[];
        bpm: number;
        waveform: number[];
        beatGroups: NonNullable<Media["beatGroups"]>;
        duration: number;
      }>(`/api/analyze/${media.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sensitivity, minInterval }),
      });
      const latest = currentProject.current;
      if (latest.id !== project.id) {
        notify("Analysis completed. Reopen the soundtrack to load its detected beats.");
        return;
      }
      setBeatSelection({ clipId: "", times: [] });
      commit({
        ...latest,
        media: latest.media.map((m) =>
          m.id === media.id ? { ...m, ...result } : m,
        ),
        clips: latest.clips.map((c) =>
          [...c.segments, ...(c.editSource?.segments ?? [])].some((s) => s.mediaId === media.id)
            ? { ...c, beatEdits: undefined, beatConfig: { ...c.beatConfig, enabledGroups: undefined },
                editSource: c.editSource ? { ...c.editSource, beatEdits: undefined } : undefined }
            : c,
        ),
      });
      notify(
        `${result.beats.length} attacks in ${result.beatGroups.length} sound groups. Listen and keep the groups you want.`,
      );
    } catch (e) {
      notify(`Analysis failed: ${(e as Error).message}`, true);
    } finally {
      setBusy("");
    }
  }
  function align() {
    if (!activeVideo || !activeAudio) return;
    if (isLocked(activeVideo.id)) {
      notify("Unlock the video track before syncing.", true);
      return;
    }
    try {
      const beats = visibleBeats(activeAudio, project).slice(beatOffset);
      const aligned = alignClipToBeats(activeVideo, beats);
      commit({
        ...project,
        clips: project.clips.map((c) =>
          c.id === activeVideo.id ? aligned : c,
        ),
      });
      setSelected([aligned.id]);
      notify(
        `${aligned.signals.length} signals aligned. Each interval now has its own speed.`,
      );
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function render() {
    setPlaying(false);
    setJob(null);
    try {
      const result = await api<{ id: string }>("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, settings: exportSettings }),
      });
      setJob({ id: result.id, status: "queued", progress: 0 });
    } catch (e) {
      notify(`Export failed: ${(e as Error).message}`, true);
    }
  }
  async function openProject(file: File | undefined) {
    if (!file) return;
    if (busy) {
      notify("Wait for the current import or analysis to finish.", true);
      if (projectInput.current) projectInput.current.value = "";
      return;
    }
    try {
      const loaded = parseProject(JSON.parse(await file.text()));
      setPlaying(false);
      if (await persistence.importProject(loaded)) {
        setTime(0);
        setSelected([]);
        setHistory([]);
        setFuture([]);
        notify("Project opened and saved to this folder.");
      }
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      if (projectInput.current) projectInput.current.value = "";
    }
  }
  async function saveBackup() {
    let saved = true;
    try {
      await persistence.flush();
    } catch (e) {
      saved = false;
      notify(
        `Folder save failed: ${(e as Error).message}. A backup file is being downloaded.`,
        true,
      );
    }
    downloadJSON(project, `${project.name}.pulse.json`);
    if (saved) notify("Saved to this folder; backup downloaded.");
  }
  async function chooseProject(id: string) {
    if (busy) {
      notify("Wait for the current import or analysis to finish.", true);
      return;
    }
    setProjectMenu(false);
    setPlaying(false);
    await persistence.switchProject(id);
  }
  async function createSavedProject() {
    if (busy) {
      notify("Wait for the current import or analysis to finish.", true);
      return;
    }
    setProjectMenu(false);
    setPlaying(false);
    await persistence.addProject();
  }
  async function prepareUpdate() {
    if (busy)
      throw new Error(
        "Wait for the current import or audio analysis to finish.",
      );
    if (
      job &&
      ["pending", "queued", "processing", "running", "rendering"].includes(
        job.status,
      )
    )
      throw new Error("Wait for your film export to finish before updating.");
    setPlaying(false);
    await persistence.flush();
  }

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        !persistence.ready ||
        persistence.switching ||
        updateOpen ||
        exportOpen ||
        help ||
        editPreview !== null
      )
        return;
      const el = e.target as HTMLElement;
      const beatCheckbox = el instanceof HTMLInputElement && el.type === "checkbox" && !!el.closest(".beat-workbench");
      if (
        (el.tagName === "INPUT" && !beatCheckbox) ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable
      )
        return;
      if ((e.key === " " || e.key === "Enter") && (el.closest("button") || beatCheckbox)) return;
      if (e.key === " ") {
        e.preventDefault();
        if (duration > 0) setPlaying((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void saveBackup();
      }
      if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) split();
      if (e.key.toLowerCase() === "b") setTool("marker");
      if (e.key.toLowerCase() === "v") setTool("select");
      if (e.key.toLowerCase() === "y") setTool("slip");
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (beatSelection.times.length) {
          const target = project.clips.find(c => c.id === beatSelection.clipId);
          if (target && !isLocked(target.id) && !busy) {
            try { updateClip(target.id, deleteClipBeats(target, beatSelection.times, project.media)); }
            catch (error) { notify((error as Error).message, true); }
            setBeatSelection({ clipId: "", times: [] });
          }
        } else removeSelected();
      }
      if (e.key === "Escape") {
        setBeatSelection({ clipId: "", times: [] });
      }
      if (e.key.toLowerCase() === "m" && clip)
        marker(clip.id, time - clip.start);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        setTime((t) => Math.min(duration, t + 1 / exportSettings.fps));
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        setTime((t) => Math.max(0, t - 1 / exportSettings.fps));
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const beatClip = clipTrack?.kind === "audio" ? clip : activeAudio;
  const beatMedia = project.media.find(
    (m) => m.id === beatClip?.segments[0]?.mediaId,
  );
  const beatConfig = beatClip?.beatConfig ?? { every: 1, offset: 0 };
  const shownBeats = beatClip ? visibleBeats(beatClip, project) : [];
  const beatSpacing = shownBeats.length > 2 ? selectedBeatInterval(shownBeats.slice(0, 2048)) : undefined;
  const selectedBpm = beatSpacing ? 60 / beatSpacing : beatMedia?.bpm;
  const patchBeats = (patch: Partial<NonNullable<Clip["beatConfig"]>>) => {
    if (beatClip)
      updateClip(beatClip.id, { beatConfig: { ...beatConfig, ...patch } });
  };
  const syncBeats = activeAudio
    ? visibleBeats(activeAudio, project).slice(beatOffset)
    : [];

  return (
    <div
      ref={workspaceResize.containerRef}
      className="studio resizable-workspace"
      style={workspaceResize.style}
      aria-busy={!persistence.ready || persistence.switching}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!persistence.ready || persistence.switching) {
          e.preventDefault();
          return;
        }
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void upload(e.dataTransfer.files);
        }
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="audio/*,video/*,image/*,.mkv,.mov,.flac,.aiff,.m4a"
        hidden
        onChange={(e) => void upload(e.target.files)}
      />
      <input
        ref={projectInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => void openProject(e.target.files?.[0])}
      />
      {updateOpen && (
        <UpdateDialog
          onClose={() => setUpdateOpen(false)}
          onBeforeInstall={prepareUpdate}
        />
      )}
      <header className="app-header">
        <a className="brand" href="#" onClick={(e) => e.preventDefault()}>
          <span className="brand-mark">
            <Activity size={24} strokeWidth={2.2} />
          </span>
          <span>
            pulse<span className="brand-dot">.</span>
          </span>
          <span className="brand-divider" />
          <span className="brand-subtitle">LOCAL STUDIO</span>
        </a>
        <div className="project-title">
          <span className="tiny-square" />
          <input
            aria-label="Project name"
            value={project.name}
            disabled={!persistence.ready || persistence.switching}
            onChange={(e) => setProject({ ...project, name: e.target.value })}
          />
          <button
            className="project-menu-toggle"
            aria-label="Saved projects"
            aria-expanded={projectMenu}
            disabled={!!busy || !persistence.ready}
            onClick={() => {
              setProjectMenu((v) => !v);
              void persistence
                .refreshProjects()
                .catch((e) => notify((e as Error).message, true));
            }}
          >
            <ChevronDown size={13} />
          </button>
          <span
            className={`saved-label ${persistence.status}`}
            title={
              persistence.status === "saved"
                ? "Project and edits are saved inside this program folder."
                : "Wait for “Saved to folder” before copying or closing the folder."
            }
          >
            {persistence.status === "saved" ? (
              <Check size={11} />
            ) : persistence.status === "saving" ||
              persistence.status === "loading" ? (
              <LoaderCircle size={11} className="spin" />
            ) : (
              <span className="save-status-dot" />
            )}
            {persistence.status === "saved"
              ? "Saved to folder"
              : persistence.status === "saving"
                ? "Saving…"
                : persistence.status === "loading"
                  ? "Opening…"
                  : persistence.status === "error"
                    ? "Save failed"
                    : "Unsaved changes"}
          </span>
          {projectMenu && (
            <>
              <button
                className="project-menu-dismiss"
                aria-label="Close project list"
                onClick={() => setProjectMenu(false)}
              />
              <div
                className="project-menu"
                role="dialog"
                aria-label="Projects in this folder"
              >
                <div className="project-menu-heading">
                  <span>YOUR PROJECTS</span>
                  <button onClick={() => void createSavedProject()}>
                    <Plus size={12} />
                    New project
                  </button>
                </div>
                <div className="project-menu-list">
                  {persistence.projects.map((saved) => (
                    <button
                      key={saved.id}
                      disabled={saved.id === project.id}
                      className={saved.id === project.id ? "current" : ""}
                      onClick={() => void chooseProject(saved.id)}
                    >
                      <span>{saved.name || "Untitled sequence"}</span>
                      {saved.id === project.id ? (
                        <Check size={12} />
                      ) : (
                        <ArrowRight size={12} />
                      )}
                    </button>
                  ))}
                </div>
                <p>Projects travel with this program folder.</p>
              </div>
            </>
          )}
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="Check for updates"
            title="Check for updates"
            disabled={!persistence.ready}
            onClick={() => setUpdateOpen(true)}
          >
            <ArrowDownToLine size={17} />
          </button>
          <button
            className="icon-button"
            title="Open project"
            disabled={!!busy || !persistence.ready}
            onClick={() => projectInput.current?.click()}
          >
            <FolderOpen size={17} />
          </button>
          <button
            className="icon-button"
            title="Save project (Ctrl+S)"
            onClick={() => void saveBackup()}
          >
            <Save size={17} />
          </button>
          <button
            className="icon-button"
            title="Quick guide"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={18} />
          </button>
          <span className="divider" />
          <button
            className="button primary"
            onClick={() => setExportOpen(true)}
            disabled={!project.clips.length}
          >
            <ArrowDownToLine size={15} />
            Export film
            <ArrowRight size={14} />
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="media-panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">YOUR WORKSPACE</span>
              <PanelDragHandle resize={workspaceResize} panel="library" />
              <h2>
                Media library<span>{project.media.length}</span>
              </h2>
            </div>
            <button
              className="icon-button bordered"
              title="Import media"
              onClick={() => fileInput.current?.click()}
              disabled={!!busy}
            >
              <Plus size={17} />
            </button>
          </div>
          <button
            className="import-zone"
            onClick={() => fileInput.current?.click()}
            disabled={!!busy}
          >
            {busy ? (
              <LoaderCircle className="spin" size={24} />
            ) : (
              <Upload size={24} strokeWidth={1.5} />
            )}
            <strong>{busy || "Bring your story in"}</strong>
            <span>Drop files here or click to browse</span>
            <small>VIDEO · AUDIO · IMAGES</small>
          </button>
          <div className="library-tabs">
            {["all", "video", "audio", "image"].map((f) => (
              <button
                key={f}
                className={libraryFilter === f ? "active" : ""}
                onClick={() => setLibraryFilter(f)}
              >
                {f === "all"
                  ? "All files"
                  : f === "image"
                    ? "Images"
                    : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className="media-list">
            {project.media
              .filter(
                (m) => libraryFilter === "all" || m.kind === libraryFilter,
              )
              .map((m) => (
                <div
                  className={`media-card ${m.kind}`}
                  draggable
                  key={m.id}
                  onDragStart={(e) =>
                    e.dataTransfer.setData("pulse/media", m.id)
                  }
                  onDoubleClick={() => addMedia(m.id)}
                >
                  <div className="asset-art">
                    {m.thumbnailUrl ? (
                      <img src={m.thumbnailUrl} alt="" loading="lazy" />
                    ) : (
                      <AudioLines size={34} strokeWidth={1} />
                    )}
                    <span className="asset-kind">
                      {iconFor(m.kind, 11)}
                      {m.kind.toUpperCase()}
                    </span>
                    <span className="asset-length">
                      {formatTime(m.duration)}
                    </span>
                    <button
                      className="asset-add"
                      title={`Add ${m.name} to timeline`}
                      onClick={() => addMedia(m.id)}
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  <div className="asset-caption">
                    <span title={m.name}>{m.name}</span>
                    <small>
                      {m.kind === "audio"
                        ? m.beats?.length
                          ? `${m.beats.length} beats detected`
                          : "Ready for beat detection"
                        : m.width
                          ? `${m.width} × ${m.height}`
                          : "Original quality"}
                    </small>
                  </div>
                </div>
              ))}
            {!project.media.length && (
              <div className="library-empty">
                <Layers2 size={20} />
                <p>
                  A little footage.
                  <br />A great soundtrack.
                  <br />
                  <span>Start with either.</span>
                </p>
              </div>
            )}
          </div>
          <div className={`local-badge ${online ? "" : "offline"}`}>
            <span className="status-dot" />
            <div>
              <strong>
                {online
                  ? "Everything stays local"
                  : "Local engine disconnected"}
              </strong>
              <span>
                {online
                  ? "Your files. Your machine."
                  : "Open Pulse.exe or Start Pulse.cmd."}
              </span>
            </div>
            <LockIcon />
          </div>
        </aside>
        <main className="preview-panel">
          <div className="preview-heading">
            <div>
              <span className="panel-heading">PROGRAM MONITOR</span>
              <PanelDragHandle resize={workspaceResize} panel="preview" />
              <span className="subtle-tag">PREVIEW</span>
            </div>
            <PreviewSizeControl resize={workspaceResize} />
            <select
              aria-label="Canvas aspect ratio"
              value={project.aspect ?? "16:9"}
              onChange={(e) => {
                const aspect = e.target.value as Project["aspect"];
                commit({ ...project, aspect });
                setExportSettings((v) => ({
                  ...v,
                  width: aspect === "16:9" ? 1920 : 1080,
                  height: aspect === "9:16" ? 1920 : 1080,
                }));
              }}
            >
              <option value="16:9">16:9 · Landscape</option>
              <option value="9:16">9:16 · Portrait</option>
              <option value="1:1">1:1 · Square</option>
            </select>
          </div>
          <div className="preview-canvas">
            <Preview
              project={previewProject}
              currentTime={time}
              playing={playing}
              onTimeChange={setTime}
              onPlayingChange={setPlaying}
              aspectRatio={(project.aspect ?? "16:9").replace(":", " / ")}
            />
            <span className="monitor-corner top-left" />
            <span className="monitor-corner bottom-right" />
          </div>
          <div className="transport">
            <div className="transport-time">
              {formatTime(time)}
              <span> / {formatTime(duration)}</span>
            </div>
            <div className="playback-buttons">
              <button
                title="Previous beat"
                onClick={() => {
                  setPlaying(false);
                  setTime(
                    [...audioClips.flatMap((c) => visibleBeats(c, project))]
                      .sort((a, b) => b - a)
                      .find((b) => b < time - 0.04) ?? 0,
                  );
                }}
              >
                <SkipBack size={17} />
              </button>
              <button
                className="play-button"
                title="Play / pause (Space)"
                disabled={!duration}
                onClick={() => {
                  if (time >= duration) setTime(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? (
                  <Pause size={19} fill="currentColor" />
                ) : (
                  <Play size={19} fill="currentColor" />
                )}
              </button>
              <button
                title="Next beat"
                onClick={() => {
                  setPlaying(false);
                  setTime(
                    [...audioClips.flatMap((c) => visibleBeats(c, project))]
                      .sort((a, b) => a - b)
                      .find((b) => b > time + 0.04) ?? duration,
                  );
                }}
              >
                <SkipForward size={17} />
              </button>
            </div>
            <div className="preview-quality">
              <span className="status-dot" />
              PROXY PREVIEW
              <ChevronDown size={12} />
            </div>
          </div>
          <div className="editing-bar">
            <div className="toolbar-group">
              <button
                className="text-button"
                disabled={!history.length}
                onClick={undo}
                title="Undo (Ctrl+Z)"
              >
                <Undo2 size={15} />
              </button>
              <button
                className="text-button"
                disabled={!future.length}
                onClick={redo}
                title="Redo (Ctrl+Shift+Z)"
              >
                <Redo2 size={15} />
              </button>
              <span className="divider" />
              <button className="text-button" disabled={!clip} onClick={split}>
                <Scissors size={15} />
                Split<span className="keycap">S</span>
              </button>
              <button
                className="text-button"
                disabled={!clip}
                onClick={() =>
                  clip && updateClip(clip.id, { muted: !clip.muted })
                }
              >
                {clip?.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                Mute
              </button>
              <button
                className="text-button"
                disabled={!selected.length}
                onClick={removeSelected}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <span className="selection-label">
              {selected.length
                ? `${selected.length} clip${selected.length > 1 ? "s" : ""} selected`
                : "Select a clip to edit"}
            </span>
          </div>
        </main>
        <aside className="inspector">
          <div className="inspector-tabs">
            <PanelDragHandle resize={workspaceResize} panel="inspector" />
            <button
              className={tab === "clip" ? "active" : ""}
              onClick={() => setTab("clip")}
            >
              <SlidersHorizontal size={14} />
              Clip
            </button>
            <button
              className={tab === "beats" ? "active" : ""}
              onClick={() => setTab("beats")}
            >
              <AudioLines size={14} />
              Beats
            </button>
            <button
              className={tab === "sync" ? "active" : ""}
              onClick={() => setTab("sync")}
            >
              <Zap size={14} />
              Sync
            </button>
          </div>
          <div className="inspector-body">
            {tab === "clip" &&
              (clip ? (
                <>
                  <div className="section-intro clip-intro">
                    <span className="eyebrow">CLIP PROPERTIES</span>
                    <h2>
                      {clip.segments.length > 1
                        ? "Your sequence"
                        : "Make the cut"}
                      <span className="small-accent">.</span>
                    </h2>
                  </div>
                  {!(asset?.kind === "image" && clip.segments.length === 1) && (
                    <SourceRange
                      clip={clip}
                      media={project.media}
                      fps={exportSettings.fps}
                      time={time}
                      locked={!!clipTrack?.locked}
                      onChange={(next) => updateClip(clip.id, next)}
                      onPreview={showSourcePreview}
                      onSlipTool={() => setTool("slip")}
                    />
                  )}
                  <label className="field-label">
                    NAME
                    <input
                      value={clip.name}
                      onChange={(e) =>
                        updateClip(clip.id, { name: e.target.value })
                      }
                    />
                  </label>
                  <div className="field-pair">
                    <label className="field-label">
                      START · SEC
                      <input
                        type="number"
                        min="0"
                        step=".01"
                        value={+clip.start.toFixed(3)}
                        onChange={(e) => {
                          const value = +e.target.value;
                          if (Number.isFinite(value) && value >= 0)
                            updateClip(clip.id, { start: value });
                        }}
                      />
                    </label>
                    <label className="field-label">
                      DURATION · SEC
                      <input readOnly value={clipDuration(clip).toFixed(3)} />
                    </label>
                  </div>
                  {asset?.kind === "image" &&
                    clip.segments.length === 1 &&
                    !clip.warp && (
                      <div className="field-pair">
                        <label className="field-label">
                          SOURCE IN
                          <input
                            type="number"
                            min="0"
                            step=".01"
                            value={clip.segments[0].in}
                            onChange={(e) => {
                              const v = +e.target.value;
                              if (v >= 0 && v < clip.segments[0].out)
                                updateClip(clip.id, {
                                  segments: [{ ...clip.segments[0], in: v }],
                                  signals: [],
                                  beatEdits: undefined,
                                });
                            }}
                          />
                        </label>
                        <label className="field-label">
                          SOURCE OUT
                          <input
                            type="number"
                            step=".01"
                            min=".01"
                            max={
                              asset?.kind === "image"
                                ? undefined
                                : asset?.duration
                            }
                            value={clip.segments[0].out}
                            onChange={(e) => {
                              const v = +e.target.value;
                              if (
                                v > clip.segments[0].in &&
                                (asset?.kind === "image" ||
                                  v <= (asset?.duration ?? Infinity))
                              )
                                updateClip(clip.id, {
                                  segments: [{ ...clip.segments[0], out: v }],
                                  signals: [],
                                  beatEdits: undefined,
                                });
                            }}
                          />
                        </label>
                      </div>
                    )}
                  {clipTrack?.kind === "audio" && (
                    <button
                      className="button subtle full"
                      onClick={() => setTab("beats")}
                    >
                      <AudioLines size={14} />
                      Open beat detection
                      <ArrowRight size={14} />
                    </button>
                  )}
                  <div className="control-section">
                    <div className="section-label">
                      <span>AUDIO</span>
                      <button
                        className={
                          clip.muted ? "mini-button active" : "mini-button"
                        }
                        onClick={() =>
                          updateClip(clip.id, { muted: !clip.muted })
                        }
                      >
                        {clip.muted ? (
                          <VolumeX size={13} />
                        ) : (
                          <Volume2 size={13} />
                        )}{" "}
                        {clip.muted ? "Muted" : "On"}
                      </button>
                    </div>
                    <label className="range-label">
                      Volume<span>{Math.round(clip.volume * 100)}%</span>
                    </label>
                    <input
                      aria-label="Clip volume"
                      type="range"
                      min="0"
                      max="1"
                      step=".01"
                      value={clip.volume}
                      onChange={(e) =>
                        updateClip(clip.id, { volume: +e.target.value })
                      }
                    />
                  </div>
                  {clipTrack?.kind === "video" && (
                    <div className="control-section">
                      <div className="section-label">
                        <span>BEAT SIGNALS</span>
                        <span className="count-pill">
                          {clip.signals.length}
                        </span>
                      </div>
                      <p className="hint">
                        Place signals on the moments you want to hit the music.
                      </p>
                      <button
                        className="button outline full"
                        onClick={() => marker(clip.id, time - clip.start)}
                        disabled={
                          time < clip.start ||
                          time >= clip.start + clipDuration(clip)
                        }
                      >
                        <Flag size={14} />
                        Add signal at playhead<span className="keycap">M</span>
                      </button>
                      <div className="signal-list">
                        {clip.signals.map((s, i) => (
                          <div key={i}>
                            <span className="signal-dot" />
                            {String(i + 1).padStart(2, "0")}
                            <button
                              className="signal-time"
                              onClick={() => {
                                setPlaying(false);
                                setTime(clip.start + sourceToOutput(clip, s));
                              }}
                            >
                              {(clip.start + sourceToOutput(clip, s)).toFixed(
                                3,
                              )}
                              s
                            </button>
                            <button
                              title="Remove signal"
                              onClick={() => removeSignal(clip.id, i)}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        className="button subtle full"
                        onClick={() => setTab("sync")}
                      >
                        <Zap size={14} />
                        Open beat sync
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  {clip.warp && (
                    <div className="sync-success">
                      <Check size={15} />
                      <span>Dynamic speed applied</span>
                      <button
                        title="Remove speed mapping"
                        onClick={() => updateClip(clip.id, { warp: undefined })}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="inspector-empty">
                  <SlidersHorizontal size={30} strokeWidth={1} />
                  <h3>A place for the details.</h3>
                  <p>
                    Select a clip on the timeline to trim, mute, and mark your
                    moments.
                  </p>
                </div>
              ))}
            {tab === "beats" && (
              <>
                <div className="section-intro">
                  <span className="eyebrow">FEEL THE RHYTHM</span>
                  <h2>
                    Find your beat<span className="small-accent">.</span>
                  </h2>
                  <p>
                    Detect kick transients, then keep the beats that matter.
                  </p>
                </div>
                <label className="field-label">
                  SOUNDTRACK
                  <select
                    value={beatClip?.id ?? ""}
                    onChange={(e) => {
                      setSyncAudio(e.target.value);
                      setSelected([e.target.value]);
                    }}
                  >
                    <option value="" disabled>
                      Select an audio clip
                    </option>
                    {audioClips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="analysis-card">
                  <span className="analysis-icon">
                    <AudioLines size={20} />
                  </span>
                  <div>
                    <strong>
                      {selectedBpm
                        ? `${Math.round(selectedBpm)} BPM`
                        : "Kick / bass detection"}
                    </strong>
                    <span>
                      {beatMedia?.beats?.length
                        ? `${beatMedia.beats.length} detected · ${shownBeats.length} selected`
                        : "Ready when your music is"}
                    </span>
                  </div>
                </div>
                <label className="range-label">
                  Sensitivity<span>{sensitivity.toFixed(1)}×</span>
                </label>
                <input
                  aria-label="Beat detection sensitivity"
                  type="range"
                  min=".5"
                  max="2"
                  step=".1"
                  value={sensitivity}
                  onChange={(e) => setSensitivity(+e.target.value)}
                />
                <label className="field-label spaced">
                  MINIMUM GAP PER SOUND BAND · SEC
                  <input
                    type="number"
                    min=".08"
                    max="2"
                    step=".01"
                    value={minInterval}
                    onChange={(e) =>
                      setMinInterval(
                        Math.max(0.08, Math.min(2, +e.target.value)),
                      )
                    }
                  />
                </label>
                <button
                  className="button primary full"
                  onClick={() => void analyze()}
                  disabled={!beatClip || !!busy}
                >
                  {busy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                  Detect beats
                </button>
                {beatClip && <BeatWorkbench
                  key={beatClip.id}
                  clip={beatClip}
                  media={project.media}
                  selected={beatSelection.clipId === beatClip.id ? beatSelection.times : []}
                  disabled={!!busy || !!isLocked(beatClip.id)}
                  onSelection={times => setBeatSelection({ clipId: beatClip.id, times, anchor: times[0] })}
                  onChange={next => updateClip(beatClip.id, next)}
                  onPause={pauseForSample}
                  onSeek={setTime}
                  onError={message => notify(message, true)}
                  onPreview={showBeatRepeatPreview}
                />}
                <div className="control-section">
                  <div className="section-label">
                    <span>BEAT SELECTION</span>
                    <span className="count-pill">{shownBeats.length}</span>
                  </div>
                  <div className="segmented-control">
                    {[1, 2, 3, 4].map((n) => (
                      <button
                        disabled={!beatClip}
                        key={n}
                        className={
                          (beatConfig.every ?? 1) === n && !beatConfig.pattern
                            ? "active"
                            : ""
                        }
                        onClick={() =>
                          patchBeats({
                            every: n,
                            offset: 0,
                            pattern: undefined,
                          })
                        }
                      >
                        {n === 1 ? "All" : `1 / ${n}`}
                      </button>
                    ))}
                  </div>
                  <div className="field-pair spaced">
                    <label className="field-label">
                      EVERY N
                      <input
                        type="number"
                        min="1"
                        max="128"
                        disabled={!beatClip}
                        value={beatConfig.every ?? 1}
                        onChange={(e) =>
                          patchBeats({
                            every: Math.max(1, Math.round(+e.target.value)),
                            offset: 0,
                            pattern: undefined,
                          })
                        }
                      />
                    </label>
                    <label className="field-label">
                      OFFSET
                      <input
                        type="number"
                        min="0"
                        max={(beatConfig.every ?? 1) - 1}
                        disabled={!beatClip}
                        value={beatConfig.offset ?? 0}
                        onChange={(e) =>
                          patchBeats({
                            offset: Math.max(
                              0,
                              Math.min(
                                (beatConfig.every ?? 1) - 1,
                                Math.round(+e.target.value),
                              ),
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="field-label spaced">
                    REPEATING PATTERN
                    <input
                      placeholder="e.g. 1001  →  keep, skip, skip, keep"
                      disabled={!beatClip}
                      value={
                        typeof beatConfig.pattern === "string"
                          ? beatConfig.pattern
                          : ""
                      }
                      onChange={(e) => {
                        const value = e.target.value.replace(/[^01,\s]/g, "");
                        patchBeats({
                          pattern: value.includes("1") ? value : undefined,
                        });
                      }}
                    />
                  </label>
                  <p className="hint">
                    1 keeps a beat, 0 skips it. A pattern overrides “Every N”.
                    Offset is zero-based.
                  </p>
                </div>
                <div className="tip-card">
                  <Flag size={17} />
                  <p>
                    Fine-tune by hand. Press <kbd>B</kbd> and click the audio
                    clip to add or remove a beat.
                  </p>
                </div>
                {beatClip?.beatEdits && (
                  <button
                    className="text-button"
                    onClick={() =>
                      updateClip(beatClip.id, { beatEdits: undefined })
                    }
                  >
                    <RotateCcw size={13} />
                    Restore detected beats
                  </button>
                )}
              </>
            )}
            {tab === "sync" && (
              <>
                <div className="section-intro">
                  <span className="eyebrow">EVERY MOMENT. ON BEAT.</span>
                  <h2>
                    Make it click<span className="small-accent">.</span>
                  </h2>
                  <p>
                    Map your video signals to the selected music beats, in
                    order.
                  </p>
                </div>
                <div className="sync-flow">
                  <span>
                    <Music2 size={16} />
                  </span>
                  <div className="flow-dots" />
                  <ArrowLeftRight size={16} />
                  <div className="flow-dots" />
                  <span>
                    <Film size={16} />
                  </span>
                </div>
                <label className="field-label">
                  MUSIC · BEAT SOURCE
                  <select
                    value={activeAudio?.id ?? ""}
                    onChange={(e) => setSyncAudio(e.target.value)}
                  >
                    <option disabled value="">
                      Choose soundtrack
                    </option>
                    {audioClips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label spaced">
                  VIDEO · SIGNAL SOURCE
                  <select
                    value={activeVideo?.id ?? ""}
                    onChange={(e) => setSyncVideo(e.target.value)}
                  >
                    <option disabled value="">
                      Choose video sequence
                    </option>
                    {videoClips.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label spaced">
                  START AT SELECTED BEAT
                  <input
                    type="number"
                    min="1"
                    max={
                      activeAudio
                        ? visibleBeats(activeAudio, project).length
                        : 1
                    }
                    value={beatOffset + 1}
                    onChange={(e) =>
                      setBeatOffset(
                        Math.max(0, Math.round(+e.target.value) - 1),
                      )
                    }
                  />
                </label>
                <div className="sync-stats">
                  <div>
                    <strong>{syncBeats.length}</strong>
                    <span>music beats</span>
                  </div>
                  <span>↔</span>
                  <div>
                    <strong>{activeVideo?.signals.length ?? 0}</strong>
                    <span>video signals</span>
                  </div>
                </div>
                <button
                  className="button primary full"
                  disabled={
                    !activeVideo ||
                    !activeAudio ||
                    activeVideo.signals.length < 2 ||
                    syncBeats.length < activeVideo.signals.length
                  }
                  onClick={align}
                >
                  <Zap size={15} fill="currentColor" />
                  Sync to the beat
                  <ArrowRight size={15} />
                </button>
                <p className="hint">
                  Use at least 2 video signals. Each pair gets its own exact
                  speed. Extra music beats are ignored.
                </p>
                <div className="control-section">
                  <div className="section-label">
                    <span>THE SPEED MAP</span>
                    <span className="subtle-tag">LIVE</span>
                  </div>
                  {activeVideo?.warp ? (
                    <div className="speed-map">
                      {activeVideo.warp.slice(1).map((point, i) => {
                        const prev = activeVideo.warp![i];
                        const speed =
                          (point.source - prev.source) /
                          (point.target - prev.target);
                        return (
                          <div key={i}>
                            <span>
                              {String(i + 1).padStart(2, "0")}
                              <ArrowRight size={10} />
                              {String(i + 2).padStart(2, "0")}
                            </span>
                            <div className="speed-bar">
                              <i
                                style={{
                                  width: `${Math.min(100, speed * 30)}%`,
                                }}
                              />
                            </div>
                            <strong>{speed.toFixed(3)}×</strong>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="map-empty">
                      <Activity size={30} strokeWidth={1} />
                      <p>
                        Your interval speeds
                        <br />
                        will appear here.
                      </p>
                    </div>
                  )}
                </div>
                <div className="tip-card">
                  <Layers2 size={18} />
                  <p>
                    Multiple clips? Select the video track and use{" "}
                    <strong>Merge track</strong> first, then place your signals.
                  </p>
                </div>
              </>
            )}
          </div>
          <div className="inspector-footer">
            <span className="status-dot" />
            BUILT AROUND YOUR RHYTHM
          </div>
        </aside>
        <WorkspacePanelHandles resize={workspaceResize} />
      </div>
      <WorkspaceResizeHandle resize={workspaceResize} />
      <Timeline
        project={project}
        time={time}
        selected={selected}
        selectedTrack={selectedTrack}
        zoom={zoom}
        tool={tool}
        selectedBeats={beatSelection}
        repeatPreview={beatRepeatPreview}
        onBeatSelect={(clipId, at, additive, range) => {
          const target = project.clips.find(c => c.id === clipId);
          if (!target) return;
          setSelected([clipId]); setSyncAudio(clipId); setTab("beats"); setPlaying(false); setTime(target.start + at);
          setBeatSelection(previous => {
            const old = previous.clipId === clipId ? previous.times : [];
            const anchor = previous.clipId === clipId ? previous.anchor : undefined;
            const between = range && anchor !== undefined
              ? visibleBeats(target, project).map(t => t - target.start).filter(t => t >= Math.min(anchor, at) - 1e-5 && t <= Math.max(anchor, at) + 1e-5)
              : undefined;
            const times = between ?? (additive ? old.some(t => Math.abs(t - at) < .0001) ? old.filter(t => Math.abs(t - at) >= .0001) : [...old, at] : [at]);
            return { clipId, times: [...new Set(times)].sort((a,b) => a-b), anchor: range ? anchor ?? at : at };
          });
        }}
        onTime={(t) => {
          setPlaying(false);
          setTime(t);
        }}
        onSelect={select}
        onTrack={setSelectedTrack}
        onZoom={setZoom}
        onTool={setTool}
        onChange={commit}
        onAddTrack={addTrack}
        onDropMedia={addMedia}
        onMarker={marker}
        onMerge={merge}
        onEditPreview={showEditPreview}
      />
      {(!persistence.ready || persistence.switching) && (
        <div className="storage-overlay">
          <div className="storage-loading-card" role="status">
            {persistence.initializationError ? (
              <Activity size={25} />
            ) : (
              <LoaderCircle size={25} className="spin" />
            )}
            <h3>
              {persistence.initializationError
                ? "Could not open the project folder"
                : persistence.switching
                  ? "Opening project…"
                  : "Opening your workspace…"}
            </h3>
            <p>
              {persistence.initializationError ||
                "Reading saved projects from this program folder."}
            </p>
            {persistence.initializationError && (
              <button
                className="button primary"
                onClick={persistence.retryInitialization}
              >
                Try again
                <RotateCcw size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <Activity size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <div className="modal guide" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setHelp(false)}>
              <X size={18} />
            </button>
            <span className="eyebrow">A QUICK START / راهنمای سریع</span>
            <h2>From footage to feeling.</h2>
            <div className="guide-steps" dir="rtl">
              <p>
                <strong>۱. فایل‌ها را وارد کن</strong>
                <span>
                  موزیک، فیلم و عکس را درگ کن داخل برنامه. با + یا درگ روی
                  تایم‌لاین، به لاین دلخواه اضافه کن.
                </span>
              </p>
              <p>
                <strong>۲. بیت‌های موزیک را مشخص کن</strong>
                <span>
                  از تب Beats تشخیص را اجرا کن. همهٔ بیت‌ها، یکی‌درمیان، هر N بیت
                  یا الگوی ۰ و ۱ را انتخاب کن. با B و کلیک روی صدا، بیت‌ها را
                  دستی اصلاح کن.
                </span>
              </p>
              <p>
                <strong>۳. ویدیوها را آماده کن</strong>
                <span>
                  لبهٔ کلیپ را برای تریم بکش. تریم قابل برگشت است؛ لبه را دوباره
                  باز کن. با Y یا Alt و درگ، محتوا را داخل قاب ثابت جلو و عقب
                  کن. با S در محل نشانگر کات بزن. لاین ویدیو را انتخاب کن و
                  Merge track بزن؛ فاصله‌ها بسته می‌شوند.
                </span>
              </p>
              <p>
                <strong>۴. لحظه‌های ویدیو را علامت بزن</strong>
                <span>
                  روی کلیپ دوبار کلیک کن یا در محل نشانگر M بزن تا beat_signal
                  اضافه شود. علامت‌ها را درگ کن؛ با کلیک راست حذف کن.
                </span>
              </p>
              <p>
                <strong>۵. سینک و خروجی</strong>
                <span>
                  در Sync، موزیک و کلیپ مرج‌شده را انتخاب کن. علامت اول با بیت
                  انتخابی اول جفت می‌شود و سرعت هر فاصله مستقل تنظیم می‌شود.
                  Export از فایل‌های اصلی خروجی می‌گیرد.
                </span>
              </p>
            </div>
            <div className="guide-note" dir="rtl">
              پروژه‌ها و ادیت‌ها خودکار داخل پوشهٔ برنامه ذخیره می‌شوند. پیش از
              انتقال یا بستن برنامه، صبر کن Saved to folder نمایش داده شود. برای
              انتقال، کل پوشهٔ برنامه همراه data را ببر. با Ctrl+S هم می‌توانی
              فایل پروژهٔ پشتیبان بگیری. تشخیص خودکار بیت را با گوش بررسی کن. دقت
              خروجی ویدیو به فریم‌ریت محدود است.
            </div>
            <button
              className="button primary full"
              onClick={() => setHelp(false)}
            >
              Let's make something
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
      {exportOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (
              !job ||
              ["complete", "completed", "failed", "error"].includes(job.status)
            )
              setExportOpen(false);
          }}
        >
          <div
            className="modal export-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setExportOpen(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">THE FINAL CUT</span>
            <h2>
              Ready for the big screen<span className="small-accent">?</span>
            </h2>
            <p>Rendered locally from your original media.</p>
            <label className="field-label">
              RESOLUTION
              <select
                value={`${exportSettings.width}x${exportSettings.height}`}
                onChange={(e) => {
                  const [width, height] = e.target.value.split("x").map(Number);
                  setExportSettings({ ...exportSettings, width, height });
                }}
              >
                {[
                  [1920, 1080],
                  [3840, 2160],
                  [1080, 1920],
                  [2160, 3840],
                  [1080, 1080],
                  [1280, 720],
                ].map(([w, h]) => (
                  <option key={w + "x" + h} value={w + "x" + h}>
                    {w} × {h}
                    {w === 3840 || h === 3840 ? " · 4K" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="field-pair spaced">
              <label className="field-label">
                FRAME RATE
                <select
                  value={exportSettings.fps}
                  onChange={(e) =>
                    setExportSettings({
                      ...exportSettings,
                      fps: +e.target.value,
                    })
                  }
                >
                  {[24, 25, 30, 50, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                QUALITY
                <select
                  value={exportSettings.quality}
                  onChange={(e) =>
                    setExportSettings({
                      ...exportSettings,
                      quality: e.target.value as ExportSettings["quality"],
                      format: e.target.value === "master" ? "mov" : "mp4",
                    })
                  }
                >
                  <option value="high">High · H.264</option>
                  <option value="master">Master · ProRes</option>
                </select>
              </label>
            </div>
            <div className="export-summary">
              <Film size={17} />
              <span>
                {exportSettings.quality === "master"
                  ? "ProRes 422 HQ · SDR / MOV"
                  : "H.264 · CRF 16 · SDR / MP4"}
              </span>
              <span>{formatTime(duration)}</span>
            </div>
            <p className="hint">
              {exportSettings.quality === "master"
                ? "SDR / BT.709 editing master, 10-bit 4:2:2. HDR sources are tone-mapped."
                : "SDR / BT.709 with AAC audio. HDR sources are tone-mapped; sources fit inside the frame."}{" "}
              Timing is quantized to {Math.round(1000 / exportSettings.fps)} ms
              frames.
            </p>
            {job && (
              <div className="export-progress">
                <div>
                  <span>
                    {["complete", "completed"].includes(job.status)
                      ? "Your film is ready"
                      : job.status === "failed" || job.status === "error"
                        ? "Export failed"
                        : "Rendering your film…"}
                  </span>
                  <strong>
                    {Math.round(
                      job.progress > 1 ? job.progress : job.progress * 100,
                    )}
                    %
                  </strong>
                </div>
                <progress
                  max="100"
                  value={job.progress > 1 ? job.progress : job.progress * 100}
                />
                {job.error && <p className="error-text">{job.error}</p>}
              </div>
            )}
            {job && ["complete", "completed"].includes(job.status) ? (
              <a
                className="button primary full"
                href={job.url ?? `/api/export/${job.id}/download`}
                download
              >
                <Download size={16} />
                Download film
              </a>
            ) : (
              <button
                className="button primary full"
                onClick={() => void render()}
                disabled={
                  !!job &&
                  [
                    "pending",
                    "queued",
                    "processing",
                    "running",
                    "rendering",
                  ].includes(job.status)
                }
              >
                {job &&
                [
                  "pending",
                  "queued",
                  "processing",
                  "running",
                  "rendering",
                ].includes(job.status) ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Clapperboard size={16} />
                )}
                {job &&
                [
                  "pending",
                  "queued",
                  "processing",
                  "running",
                  "rendering",
                ].includes(job.status)
                  ? "Rendering locally"
                  : "Export film"}
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function LockIcon() {
  return (
    <svg width="13" height="15" viewBox="0 0 14 16" fill="none">
      <rect x="2" y="7" width="10" height="7" rx="2" stroke="currentColor" />
      <path d="M4 7V4a3 3 0 0 1 6 0v3" stroke="currentColor" />
    </svg>
  );
}
