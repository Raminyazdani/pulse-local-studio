# Label a merged timeline clip

The large video beat labeler can also open a video clip on the timeline, including a merged sequence made from several files. This mode edits the selected timeline clip's sync signals and previews its complete visible composition.

## Open the clip

Select one unlocked video clip, then choose **Label beats** in the timeline toolbar. You can also open the **Clip** inspector and choose **Label in large window** under **Beat signals**, or use **Label video in large window** from the **Sync** panel. These actions work for a single-source clip and a merged clip. Audio clips and locked tracks cannot be edited through this action.

Main-editor playback pauses when the labeler opens. The labeler's position starts from the main playhead's position inside the clip, or the nearest valid position when the playhead is outside it.

## Inspect the combined sequence

The time field and ruler use seconds from the **beginning of the selected clip**, independent of where it sits on the main timeline. Source trims, segment speeds and an existing Sync speed map are included in the preview. Seeking across a cut opens the correct source file at its retained source position; repeated occurrences of one file remain separate moments in this composition.

Use image zoom and pan to inspect a detail, and the independent timeline zoom to separate nearby markers. The source files remain unchanged. **Space** plays or pauses; **←/→** steps by the inspection frame interval, and **Shift+←/→** steps ten intervals. The inspection interval follows the editor's export frame-rate setting. Mixed-rate or variable-frame-rate sources still depend on the browser's decoder and proxy timestamps; these controls do not promise native next-frame indexing for every original format.

Choose **Compatible preview** for browser-friendly proxies, or **Original resolution** when the source codecs are supported. Changing the inspection quality, zoom or slow-playback rate does not alter the project's crop, timing or output quality.

## Save the clip's signals

Seek to a visual moment and press **M / Add signal**. Select, drag, edit or delete the numbered markers, and use the labeler's Undo/Redo to revise the draft. **Cancel** discards the unsaved draft. Closing with unsaved work displays a reminder.

**Save labels** commits one timeline edit and waits for the project-folder save before closing. A failed project save leaves the draft open for retry. Once saved, the marks appear on the main timeline and in the clip's Beat signals list. Main-editor Undo/Redo can revert and restore this clip edit.

Saving labels for a timeline clip does not update the source files' reusable library labels, other clips using those files, or a locked copy of the composition. The library's **Label beats** action continues to edit reusable source-file annotations separately.

An unchanged save preserves the existing speed map. When signals change on an already synced clip, the current speed map is baked into its source spans to preserve the displayed frames, audio timing, duration and start position. Retained material hidden by reversible trimming keeps its own marks. Run **Sync** again when you want to pair the revised signal sequence with music beats.

Signals already placed exactly at the clip's end remain valid. New marks placed through the frame viewer use a displayed frame before the end, so seeking cannot accidentally request a frame beyond the composition.

## Verification

All **seven isolated source-browser scenarios** in `tests/timeline-labeler.spec.ts` passed against the 1.6.0 source build. They check actual decoded frames from trimmed 30 fps and 24 fps MOV sources, source positions and playback across their sped-up cut, original/proxy switching, zoom/pan, local-only saves, Undo/Redo, save/reopen, existing warp/end markers, Cancel, locked/audio exclusions and recovery from a failed project save. Further scenarios verify half-speed output-frame stepping and label placement while native frames repeat, separate occurrences of the same source file, still-image labeling, playback from a still into video, and the Sync-panel entry.

The precision regressions observe actual browser compositor timestamps for fractional source trims: a valid frame can begin just before the selected source-in point. A generated variable-frame-rate MOV also omits 45 consecutive native frames, leaving a long held-frame interval. Compatible and original quality both become ready after a verified completed seek, keep the requested logical output position for a paused label, and resume playback across that interval without requiring a newly decoded timestamp inside the trim. These checks do not imply exact native-frame indexing for arbitrary VFR sources.

The suite refuses to write without both an explicit test flag and the expected disposable workspace key. Frozen-package and live-update results are validated separately by the portable release workflow.
