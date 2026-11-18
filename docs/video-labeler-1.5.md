# Video beat labeler · 1.5.2

The video labeler provides a large, focused view for marking the visual moments that should later align with music. It edits reusable source-file beat signals; it does not encode the video or burn labels into its frames.

## Open a source from the library

Choose **Label beats** on a video card in **Media library**. The editor opens the original source timeline with its saved labels, even if the video has not yet been added to a track. Main-editor playback pauses while the labeler is in use. Audio and still-image library cards do not have this action.

The large window contains video inspection, source seeking and signal controls. **Fullscreen video labeler** can use the browser's fullscreen mode when available.

## Inspect the image and choose a moment

- **Image zoom** enlarges the displayed image from 100% to 800%. Use its slider/buttons, the wheel over the video, or `+`/`-`; drag a zoomed image to pan. **Fit** resets zoom and pan. Double-click toggles a closer view and Fit.
- **Timeline zoom** separately enlarges the source ruler. Scroll it to inspect closely spaced signals; it does not magnify the picture.
- Use the source scrubber or click the source ruler to seek. The time and zero-based frame fields allow numerical positioning.
- **Previous/Next frame** or **←/→** step by one reported frame interval. **Shift+←/→** or the ten-frame buttons move ten intervals.
- **Space** plays/pauses; inspection speeds are **0.25×**, **0.5×** and **1×**. These speeds change only the inspection player.

Image zoom, pan, inspection speed and ruler zoom do not change the edit's crop, output resolution, source file or existing timeline playback rates.

### Compatible preview and original resolution

**Compatible preview** uses the browser-friendly proxy. **Original resolution** requests the untouched source file for closer pixel inspection, if its codec is supported by the browser. Some MOV codecs, including some camera/master formats, cannot play directly in a browser. Use **Use compatible preview** if original decoding fails; the source file stays intact.

The frame controls use the imported average frame rate, with a 30 fps fallback when no usable rate is available. Variable-frame-rate files do not have uniformly spaced original frames, so stepping by `1 / average fps` is an inspection interval rather than a guaranteed native next-frame index. Where supported, labeling a playing video records the browser's presented-frame media timestamp. Decoder/proxy timing and the chosen export frame rate still bound the practical precision; the editor does not promise exact native-frame indexing for every codec/VFR source.

## Add and refine signals

1. Seek or play to the desired visual moment.
2. Press **M** or **Add signal**. Double-clicking the source ruler can also add a signal there.
3. Click a signal in the list or ruler to select and seek to it. Drag its ruler marker or edit its time to refine the position.
4. Use its delete button, **Delete selected signal**, or **Delete/Backspace** to remove the selected marker.
5. Use the labeler's **Undo/Redo** or **Ctrl+Z / Ctrl+Shift+Z** to revise the draft. **Ctrl+S** saves the labels.

Signals are ordered original-source seconds before the source duration's end. Normal frame-based edits snap to the reported frame grid; existing exact timestamps are retained until edited. The source originals and proxies are never rewritten by label edits.

## Save, cancel and reuse

**Save labels** stores the source annotation in the library metadata and the active project's media snapshot, then closes after the project copy reaches its folder. New timeline clips made from that library video automatically receive those signals, mapped through their source ranges and speeds. A saved label can therefore be reused each time the source is added.

Existing timeline clips keep their manually edited signals by default. Check **Also apply to existing unlocked video clips** only when you want to replace signals belonging to this file in the current project. Other source files in a merged composition retain their own signals; locked clips are left alone. Hidden retained ranges are updated too, so later extension remains consistent.

Applying to an existing retimed clip preserves the current displayed frames, audio timing and duration by baking its present speed map into its source spans. It clears the previous signal-to-music association: run **Sync** again to align the revised signal sequence with music. Main-timeline Undo can undo this instance edit; the saved library annotation remains current.

**Cancel** discards an unsaved label draft. Closing with unsaved changes displays a reminder to save or use Cancel. A successful source save is durable: if a later project-folder save fails, the error says so and **Save labels** can be retried safely. The server accepts an identical retry without overwriting a newer different result.

If another session changes the same source labels, a stale different save is rejected instead of silently replacing that work. Reopen the labeler to load and review the current source labels.

## Persistence and privacy

Source labels use `Media.sourceSignals` in original-file seconds. They live in the video's metadata under **data/media** and in the saved project's media snapshot. To transfer the complete work, keep the whole portable **data** folder with the application, including media metadata, originals and projects.

All video inspection, source-label storage and sync mapping stay local. Labels are Pulse edit metadata, not a general-purpose MOV/MP4 metadata track or visible overlay in exported frames. Public repository and release packages exclude personal media, projects and their saved labels.

## 1.5.2 startup fix and validation coverage

Version **1.5.2** retains the focused labeler introduced in 1.5.0 and improves a slow portable cold start. If a second launch arrives while the first instance is importing its runtime, it waits up to **45 seconds** for the healthy server belonging to the same workspace instead of timing out after about 15 seconds. The workspace mutex still permits only one server writer; unrelated or unready runtime records are not accepted as a successful launch.

Source validation passed **89 frontend tests** and **76 backend tests**, including five launcher regressions. Browser coverage includes **16 source-browser scenarios**: four labeler scenarios plus twelve existing editing, beat-workbench and layout scenarios.

The [1.5.2 Windows release workflow](https://github.com/Raminyazdani/pulse-local-studio/actions/runs/44396760065) passed the frozen executable and browser suites before publishing. It checks a Windows-only PATH without installed Python, Node or FFmpeg; simultaneous double launch; MOV import; source/proxy delivery; folder relocation with spaces and Persian characters; saved-project recovery; piecewise video/audio export; and the editing, beat, layout and video-labeler flows. The [source checks](https://github.com/Raminyazdani/pulse-local-studio/actions/runs/44396761381) also passed.

A separate live-update check ran a genuine frozen **1.4.0** installation against the public GitHub **1.5.2** release. One UI install request downloaded and verified the package, replaced the runtime through the standalone helper, restarted the app and reloaded the saved warped edit. Synthetic originals, proxies, metadata, prior exports and an unrelated root file remained byte-identical; the project graph and its sync signals remained intact. The isolated test app was stopped afterwards.

The [published app-only ZIP](https://github.com/Raminyazdani/pulse-local-studio/releases/tag/v1.5.2) has SHA-256 `68bfe52f126dd54796b45350373955b538597674086045fd889507bd891b1382`. Release validation checks its CRC, paths, manifest and checksum and rejects personal data/project directories. Local builds may have a different digest because they use a different Python distribution; use the release manifest for the published package.
