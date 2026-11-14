import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  RotateCcw,
  Scissors,
} from "lucide-react";
import type { Clip, Media } from "../lib/types";
import {
  clipWaveform,
  editRange,
  editSourceClip,
  formatTime,
  resolveClipTime,
  restoreClipSource,
  setSourceWindow,
  slipClip,
} from "../lib/engine";
import "./SourceRange.css";

interface Props {
  clip: Clip;
  media: Media[];
  fps: number;
  time: number;
  locked: boolean;
  onChange: (clip: Clip) => void;
  onPreview: (clip: Clip | null, time?: number) => void;
  onSlipTool: () => void;
}

type Gesture = {
  kind: "in" | "out" | "slip";
  x: number;
  width: number;
  original: Clip;
  preview: Clip;
  in: number;
  out: number;
  total: number;
  time: number;
  pointer: number;
};

function TimeField({
  label,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(value.toFixed(3));
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing.current) setText(value.toFixed(3));
  }, [value]);
  function commit() {
    editing.current = false;
    if (cancelled.current) {
      cancelled.current = false;
      setText(value.toFixed(3));
      return;
    }
    const number = Number(text);
    if (text.trim() && Number.isFinite(number))
      onCommit(Math.max(min, Math.min(max, number)));
    setText(value.toFixed(3));
  }
  return (
    <label className="field-label">
      {label}
      <input
        aria-label={label}
        type="number"
        inputMode="decimal"
        step="0.001"
        min={min}
        max={max}
        value={text}
        disabled={disabled}
        onFocus={() => {
          editing.current = true;
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setText(value.toFixed(3));
            editing.current = false;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

export function SourceRange(p: Props) {
  const [draft, setDraft] = useState<Clip | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const overview = useRef<HTMLDivElement>(null);
  const displayed = draft ?? p.clip;
  const range = editRange(displayed, p.media);
  const full = useMemo(
    () => editSourceClip(p.clip, p.media),
    [p.clip, p.media],
  );
  const waveform = useMemo(
    () => clipWaveform(full, p.media, 240),
    [full, p.media],
  );
  const first = resolveClipTime(full, Math.max(0, range.in));
  const last = resolveClipTime(full, Math.max(0, range.out - 1e-6));
  const sameFile = first && last && first.mediaId === last.mediaId;
  const isAudio =
    p.media.find((m) => m.id === p.clip.segments[0]?.mediaId)?.kind === "audio";
  const fractionIn = range.total ? (range.in / range.total) * 100 : 0;
  const fractionOut = range.total ? (range.out / range.total) * 100 : 100;
  function preview(next: Clip, at?: number) {
    setDraft(next);
    p.onPreview(next, at);
  }
  function cancel() {
    const old = gesture.current;
    gesture.current = null;
    setDraft(null);
    p.onPreview(null, old?.time);
  }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gesture.current) {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      if (gesture.current) p.onPreview(null);
    };
  }, [p.onPreview]);
  function begin(e: ReactPointerEvent, kind: Gesture["kind"]) {
    if (p.locked || e.button !== 0 || !overview.current) return;
    e.preventDefault();
    e.stopPropagation();
    const original = p.clip,
      bounds = editRange(original, p.media);
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      kind,
      x: e.clientX,
      width: overview.current.clientWidth,
      original,
      preview: original,
      in: bounds.in,
      out: bounds.out,
      total: bounds.total,
      time: p.time,
      pointer: e.pointerId,
    };
  }
  function move(e: ReactPointerEvent) {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointer) return;
    const delta = ((e.clientX - g.x) / Math.max(1, g.width)) * g.total;
    const frame = 1 / p.fps;
    const quantize = (v: number) =>
      e.shiftKey ? v : Math.round(v * p.fps) / p.fps;
    let next: Clip;
    if (g.kind === "slip")
      next = slipClip(g.original, quantize(delta), p.media);
    else if (g.kind === "in")
      next = setSourceWindow(
        g.original,
        Math.max(0, Math.min(g.out - frame, quantize(g.in + delta))),
        g.out,
        p.media,
      );
    else
      next = setSourceWindow(
        g.original,
        g.in,
        Math.max(g.in + frame, Math.min(g.total, quantize(g.out + delta))),
        p.media,
      );
    g.preview = next;
    const bounds = editRange(next, p.media);
    preview(
      next,
      next.start +
        (g.kind === "out" ? Math.max(0, bounds.duration - 0.001) : 0),
    );
  }
  function finish(e: ReactPointerEvent) {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointer) return;
    gesture.current = null;
    if (JSON.stringify(g.preview) !== JSON.stringify(g.original))
      p.onChange(g.preview);
    setDraft(null);
    p.onPreview(null);
  }
  function commitClip(next: Clip, at?: number) {
    p.onChange(next);
    const nextRange = editRange(next, p.media);
    p.onPreview(
      null,
      at ??
        Math.max(
          next.start,
          Math.min(p.time, next.start + nextRange.duration - 0.001),
        ),
    );
  }
  function changeRange(a: number, b: number) {
    if (!p.locked) {
      const next = setSourceWindow(p.clip, a, b, p.media);
      commitClip(
        next,
        next.start +
          (Math.abs(b - range.out) > 1e-7 ? Math.max(0, b - a - 0.001) : 0),
      );
    }
  }
  const fullSourceSelected =
    range.in < 1e-6 && Math.abs(range.out - range.total) < 1e-6;
  return (
    <section
      className={`source-range ${isAudio ? "audio" : "video"}`}
      aria-label="Source selection"
    >
      <div className="section-label">
        <span>
          <Scissors size={13} />
          SOURCE SELECTION
        </span>
        <span className="source-available">
          {range.total.toFixed(2)}s available
        </span>
      </div>
      <div
        className="source-overview"
        ref={overview}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
      >
        <svg
          className="source-overview-wave"
          viewBox="0 0 240 44"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {waveform.map((v, i) => (
            <line
              key={i}
              x1={i}
              x2={i}
              y1={22 - Math.max(0.04, v) * 19}
              y2={22 + Math.max(0.04, v) * 19}
            />
          ))}
        </svg>
        <div
          className="source-outside left"
          style={{ width: `${fractionIn}%` }}
        />
        <div
          className="source-outside right"
          style={{ left: `${fractionOut}%` }}
        />
        <div
          className="source-overview-selection"
          data-testid="source-window"
          style={{
            left: `${fractionIn}%`,
            width: `${fractionOut - fractionIn}%`,
          }}
          onPointerDown={(e) => begin(e, "slip")}
          title="Drag the selection to slip the source; timeline position stays fixed"
        >
          <button
            className="source-range-handle in"
            disabled={p.locked}
            title="Source in point"
            aria-label="Drag source in"
            onPointerDown={(e) => begin(e, "in")}
          />
          <span className="source-selection-grip">
            <ArrowLeftRight size={12} />
          </span>
          <button
            className="source-range-handle out"
            disabled={p.locked}
            title="Source out point"
            aria-label="Drag source out"
            onPointerDown={(e) => begin(e, "out")}
          />
        </div>
      </div>
      <div className="source-overview-scale">
        <span>0:00</span>
        <span>Full source sequence</span>
        <span>{formatTime(range.total)}</span>
      </div>
      <div className="field-pair source-range-fields">
        <TimeField
          label="Source selection in"
          value={range.in}
          min={0}
          max={Math.max(0, range.out - 1 / p.fps)}
          disabled={p.locked}
          onCommit={(v) => changeRange(v, range.out)}
        />
        <TimeField
          label="Source selection out"
          value={range.out}
          min={range.in + 1 / p.fps}
          max={range.total}
          disabled={p.locked}
          onCommit={(v) => changeRange(range.in, v)}
        />
      </div>
      <div className="source-range-details">
        <span>
          Selected <strong>{range.duration.toFixed(3)}s</strong>
        </span>
        {sameFile && (
          <span>
            Media {first.time.toFixed(3)} →{" "}
            {(last.time + 1e-6 * last.speed).toFixed(3)}s
          </span>
        )}
      </div>
      <div className="source-slip-row">
        <span>Slip source</span>
        <button
          title="Slip one frame earlier"
          aria-label="Slip one frame earlier"
          disabled={p.locked || range.in < 1e-6}
          onClick={() => commitClip(slipClip(p.clip, -1 / p.fps, p.media))}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          title="Slip one frame later"
          aria-label="Slip one frame later"
          disabled={p.locked || range.out >= range.total - 1e-6}
          onClick={() => commitClip(slipClip(p.clip, 1 / p.fps, p.media))}
        >
          <ArrowRight size={13} />
        </button>
        <button
          className="source-slip-tool"
          disabled={p.locked}
          onClick={p.onSlipTool}
        >
          Tool <kbd>Y</kbd>
        </button>
      </div>
      <button
        className="button subtle full source-restore"
        disabled={p.locked || fullSourceSelected}
        onClick={() => commitClip(restoreClipSource(p.clip, p.media))}
      >
        <RotateCcw size={13} />
        Restore full source
      </button>
      <p className="source-range-hint">
        Drag the window to choose another moment. Trimmed material stays
        available. Hold Shift for free timing.
      </p>
    </section>
  );
}
