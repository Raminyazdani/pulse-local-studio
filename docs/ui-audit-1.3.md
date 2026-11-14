# Pulse 1.3 editing and interface audit

This audit focuses on the editing problems reported against 1.2: recovering a trim, choosing another moment inside a fixed clip, reading the waveform accurately, and making a minimal desktop editor easier to use. The implementation shipped as [v1.3.0](https://github.com/Raminyazdani/pulse-local-studio/releases/tag/v1.3.0).

## Findings and changes

| Finding | Effect on editing | 1.3 behavior |
|---|---|---|
| Trimming discarded the only editable range. | Pulling an edge outward could not bring removed material back. | Retain the available source sequence separately from its selection; extend either edge or use **Restore full source**. |
| Moving a clip and changing its source selection were not distinct operations. | Choosing a different moment required disruptive timeline edits. | **Y**, **Alt + drag**, or the source overview slips content within the same timeline position and duration, bounded by available source. |
| Waveform geometry could change with the clip container. | A visible peak was an unreliable guide to the actual musical moment. | Draw the selected source interval at the timeline scale, including trim, slip and speed-map positions. |
| Thin trim handles and weak selection feedback hid the real boundaries. | Fine adjustments were hard to target and assess. | Larger handles, a visible source outline, and live source in/out and duration feedback during editing. |
| Source range lacked a direct numerical editor. | Exact adjustments depended on dragging at high zoom. | **Clip → Source selection** adds a full-source overview, numerical in/out controls, one-frame slip buttons and full-source restoration. |
| Snapping and zoom required extra pointer travel. | Fine placement was unnecessarily slow. | Hold **Shift** to bypass snapping; **Ctrl + mouse wheel** zooms the timeline around the pointer. |
| Green was used for surfaces, controls and content types, with many tiny labels. | Tracks, beats and selection competed visually and were difficult to read. | Neutral charcoal/slate surfaces; blue controls, cyan audio, lilac video, amber beats and pink video signals; larger labels and stronger contrast. |
| Compact layouts hid save status and crowded controls. | Users could not easily tell whether copying the portable folder was safe. | Keep save status visible, compact the header, scroll long side panels, and reserve usable space for the preview and timeline. |
| Shift-drag could deselect a clip and close its inspector. | Holding the snap override disrupted precise editing. | Keep selection during the gesture; Shift-click deselection occurs only after a click without movement. |
| Wide trim handles intercepted marker clicks near clip edges. | Early beats/signals could be missed. | Marker mode gives clip clicks priority over trim handles. |
| Beat reset retained hidden manual corrections; asynchronous analysis could restore an older project snapshot. | Old beats could reappear, or concurrent trims could be lost. | Clear retained corrections and merge detection results into the current project with a correct undo baseline. |

Trimming changes the visible duration. Slipping changes which source material is visible while keeping the timeline container fixed. Both preserve the original media files. Image clips have no moving source content to slip.

## Compatibility and local data

New source-selection metadata travels with project JSON in `data/projects`. Single-asset clips from older projects can use the original media's available range. A v1.2 merged sequence that already lost composition sections during an earlier trim cannot identify or reconstruct those missing sections automatically: the original media may remain in the library, but that project's deleted arrangement was not recorded. Rebuild those sections from their originals or use an earlier project backup.

No part of this editing work uploads footage, music or project JSON. Public source and release packages exclude personal `data`. Updates preserve the local data folder; moving work still requires copying the entire portable folder after saving and stopping Pulse.

## Review evidence and release checks

The interface was checked with synthetic image/audio assets in isolated browser contexts at **1280×720**, **1366×768**, **1600×1000** and **1024×768**. Preview transport, timeline status and save status remained inside the viewport without horizontal page overflow. Muted text on the main surface has approximately **6.85:1** contrast. The stylesheet and frontend build were checked after the palette change.

Release validation should also cover inward/outward trims on each edge, source limits, fixed-duration slips, split and merged clips, beat/signal positions after source edits, piecewise speed maps, Undo/Redo, save/reopen and actual exported media. Visual checks alone cannot establish frame-accurate rendering or portable-update reliability; those require the engine and package checks described in [development](development.md) and [updates](updates.md).

### Release validation — 15 November 2026

- **60 frontend tests and 44 backend tests passed**, including retained ranges, merged/retimed source restoration, validation and real source-only rendering.
- **Six source-browser scenarios passed**: four precision editing regressions plus original-media sync/export/playback and hidden-video audio handling. Numeric cancellation, frame nudges, live preview pixels, waveform peak position, save/reopen, Undo/Redo, manual-beat reset and concurrent detection edits are covered.
- The [Windows release workflow](https://github.com/Raminyazdani/pulse-local-studio/actions/runs/43654289755) passed the frozen app checks with no external Python, Node or FFmpeg on the application's PATH. It verified concurrent launch, MOV import, beat detection, piecewise export, mute, Unicode folder relocation, disk persistence and five browser scenarios.
- A separate local full-folder copy to a new Unicode path also passed playback, disk autosave, actual FFmpeg rendering and the four precision editing scenarios. Direct rename of two local disposable test folders was denied by this host despite normal ACLs and no remaining Pulse process; its cause was not established. The clean Windows CI rename passed.
- All **205 permanent local media/project/export files** matched their copied private portable counterparts byte for byte; the library retained all **39 media items**. Public repository/history path scans and release ZIP checks found no personal data. The published ZIP's SHA-256 is `02e22ff791606c0ecfa3980366b1a0559619339e6d36f4f868c071ee769e989b`.
- A real stock **1.2.0 → 1.3.0** GitHub update passed through **Update now**, checksum verification, standalone helper replacement, automatic restart and browser reload with the same saved project, three video signals and six selected music beats. All synthetic media and existing exports remained byte-identical, and an unrelated root file stayed intact. The first attempt encountered a transient Windows denial when moving `_internal`; rollback safely restored 1.2.0. The later full UI retry succeeded without source or installer changes. The lock's exact cause was not established; a bounded native-module probe ruled out the helper retaining DLLs from the old runtime.

## Suggested next steps

These are follow-up proposals, not features promised by 1.3:

1. Add an optional ripple-edit mode with explicit gap closing and clear feedback about which later clips move.
2. Add clip context menus and coordinated multi-clip movement so common actions are accessible without searching panels.
3. Add audio fades, crossfades and level meters; make soundtrack handoffs easier to judge before export.
4. Add crop, position and scale controls with guides, followed by a small set of restrained transitions.
5. Add source-time video thumbnail strips and broaden virtualization to entire timelines. Waveform drawing already uses the visible viewport; long-session testing with many tracks remains useful. Current video strips use representative posters, with the actual selected frame shown in the monitor.
6. Offer a keyboard shortcut reference and configurable workspace panels after the core drag/trim behavior is stable.
