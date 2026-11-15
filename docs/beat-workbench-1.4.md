# Pulse 1.4 · Beat workbench and workspace layout

This guide describes [Pulse v1.4.0](https://github.com/Raminyazdani/pulse-local-studio/releases/tag/v1.4.0).

## Resize and arrange the workspace

- Drag the divider between the preview workspace and timeline, or use the preview size controls, to give the monitor more or less room.
- Open **Arrange workspace** for panel-position selectors, width sliders, workspace/timeline height controls and **Timeline position → Above/Below**.
- Drag panel header grips to reorder the media library, preview and inspector; drag their vertical dividers to adjust widths.
- Layout preferences are stored in this browser. They do not alter export size, source media, beat timing or the saved project graph.
- Use **Reset workspace layout** to restore the default arrangement. Escape cancels an active resize gesture.

## Listen to sound groups

Run **Beats → Detect beats**, then audition the samples under **Sound groups**. Each group contains detected attacks with similar normalized spectrum and attack shape. A sample plays a representative hit from the original soundtrack through its browser proxy. Check the groups you want to keep; uncheck the others.

Labels such as **Bass-heavy**, **Low body** and **Bright attack** describe acoustic features. They do not guarantee isolation of a kick, snare or other instrument: overlapping sounds and changing timbre can share a group or split one instrument between groups. Listen before choosing, then correct individual markers when necessary.

The detector searches bass, body and bright frequency streams independently. Minimum spacing applies within each stream, so two different attacks can remain close together. Coincident candidates within approximately 45 ms merge into one marker. Detection uses actual attacks; it does not invent a regular rhythm grid.

## Pick and delete individual beats

| Action | Result |
|---|---|
| Click a numbered timeline beat | Pick that beat |
| Ctrl-click a beat | Add it to or remove it from the current selection |
| Shift-click a beat | Pick a range from the selection anchor |
| Check **Individual beats** rows | Pick specific beats without precise timeline clicking |
| **Delete selected beats** or **Delete** | Remove the picked beat markers while retaining the clip |
| **Clear selection** | Unpick markers without deleting them |

The individual list is paginated for long soundtracks. Picking markers is separate from changing the rhythm. Deleting or repeating creates edited beats for this clip; **Use detected groups again** returns to the original detection groups. Undo/Redo covers marker edits.

## Filter and repeat

1. Pick one or more beats in the clip.
2. Choose **Regular interval** or **Repeat selected pattern**.
3. Set **Interval** or **Pattern cycle** in seconds. Multiple picks provide a suggestion; review or change it. A single pick needs a chosen interval, for example `0.5`.
4. Choose whether to fill the whole clip or start at the first picked beat. Filling earlier keeps the selected rhythm's phase; it does not force a marker to time zero.
5. Check the resulting count and enable **Preview pattern on timeline** to see ghost markers.
6. Apply **Filter & repeat**. This replaces the clip's other beat markers, including ones not picked. **Ctrl+Z** restores them.

### Regular half-second pulses

With picks at `1.0` and `1.5` seconds, use a `0.5`-second interval. Starting from the first pick produces `1.0, 1.5, 2.0, 2.5…` until the clip ends. Filling the whole clip also adds the same phase before the first pick: `0.0, 0.5…` in this example.

For a single pick at `0.2` seconds and a `0.5`-second interval, the phase is `0.2, 0.7, 1.2…`. The interval is an explicit editing choice; one timestamp alone cannot reveal a repetition period.

### A nonuniform repeating pattern

Pick `1.0, 1.25, 1.75` seconds, choose **Repeat selected pattern**, and set the cycle to `1.0` second. Starting from the first pick, the offsets `0, 0.25, 0.75` repeat every second: `1.0, 1.25, 1.75, 2.0, 2.25, 2.75…`. The cycle must be longer than the selected pattern's span. This preserves the selected unequal gaps rather than replacing them with evenly spaced pulses.

The preview count and marker positions are authoritative for the chosen interval and range. Generated markers remain inside the visible clip. The operation changes timing markers only: it does not cut, duplicate, stretch or otherwise rewrite the soundtrack. Video speed changes happen only when those beats are subsequently used in **Sync**.

## Persistence and privacy

Detection groups are stored with media metadata; clip group choices and edited beat markers travel with the project and `data` folder. Existing projects without groups remain readable and can be analyzed again. All detection, grouping, sample playback and rhythm generation run locally. Public source and portable releases exclude personal media and project data.

## Release validation — 15 November 2026

- **79 frontend tests and 56 backend tests passed**, including quiet bass under louder percussion, deterministic group membership, representative sample timestamps, group/project validation, phase-preserving repetition, source timing and layout bounds.
- **12 source-browser scenarios passed**: audible group samples and immediate stop on leaving the panel, checkbox filtering, individual/multiple/range selection, beat deletion, exact repeat preview/application, selection invalidation after source edits, persistence, reversible trimming, original-media export and panel layout operations.
- The [successful Windows release workflow](https://github.com/Raminyazdani/pulse-local-studio/actions/runs/43664626959) independently built and tested the frozen executable, including **11 browser scenarios**, MOV import, bass detection, original-media rendering, mute, concurrent launch and relocation to a path containing spaces and Persian text. The same complete portable verifier passed locally with a Windows-only runtime PATH containing no Python, Node or FFmpeg.
- All **205 permanent local media, project and export files** matched the private portable copies byte for byte; all **39 media items** remained present. Public ZIP privacy, CRC and manifest checksum checks passed. The published ZIP SHA-256 is `02f335dbf33abe285e32c3dad4e21bd7e8e44ffc368d83ef581e2bbc887e38a1`.
- A genuine published **1.3.0 → 1.4.0** installation passed through **Update now**, real GitHub download/hash verification, standalone helper replacement, automatic restart and browser reload. The saved graph, three video signals and six selected music beats remained unchanged; synthetic originals/proxies, existing exports and an unrelated root file stayed byte-identical. No browser JavaScript errors occurred, and the isolated updated app was stopped after verification.
