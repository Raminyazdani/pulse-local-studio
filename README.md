# Pulse · Local Studio

**Cut to the rhythm. Keep your footage local.**

Pulse is a minimal video editor for making music-driven edits. Import a soundtrack, choose its kick beats, mark important moments in your footage, and give each interval its own playback speed so those moments land on the music.

[Download for Windows](https://github.com/Raminyazdani/pulse-local-studio/releases/latest) · [راهنمای فارسی](README.fa.md) · [Development](docs/development.md) · [Updates and releases](docs/updates.md)

## Start editing

1. Download **Pulse-Portable-Windows-x64.zip** from a [release](https://github.com/Raminyazdani/pulse-local-studio/releases).
2. Extract the entire `Pulse` folder to a writable location.
3. Open **Pulse.exe** or **Start Pulse.cmd**. Your browser opens the local editor.

The portable package includes its Python runtime and FFmpeg. No Python, Node.js, FFmpeg installation or account is required on the destination PC. Editing works offline; checking for an update uses the internet. The package targets **Windows 10/11 x64**, using a normal browser such as Edge.

Keep `_internal`, `bin`, `dist` and `data` together. Running the EXE inside the ZIP or moving the EXE alone is insufficient. Use **Stop Pulse.cmd** to close the background engine after exports finish.

## Features

- Multiple video, image and audio tracks with moving, trimming, splitting and audio controls.
- Non-destructive track merging while retaining original media.
- Bass/body/bright transient detection, acoustic groups with audible samples, and manual corrections.
- Individual or multiple beat selection, deletion, and interval/pattern repetition that replaces other markers.
- Every-beat, every-Nth-beat, offset and repeating-mask selections such as `1001`.
- Adjustable preview/timeline size, panel widths and workspace arrangement.
- Ordered video signals mapped to music beats with an independent speed per interval.
- Layered previews and final rendering from original media.
- H.264/AAC MP4 and 10-bit ProRes 422 HQ/PCM MOV exports.
- Projects saved inside the app folder, a project picker, JSON backups and Undo/Redo.
- User-requested GitHub release checks and in-app installation of newer portable versions.

## Beat workbench and layout in 1.4

Resize the preview and timeline by dragging their divider or using the preview size controls. Open **Arrange workspace** to set panel positions, widths and timeline placement, or drag panel header grips and width dividers. The timeline can sit above or below the workspace. These layout preferences are browser settings, separate from the saved edit.

After **Detect beats**, listen to the **Sound groups** samples and use their checkboxes to keep the attacks you want. Groups compare spectral content and attack shape: **Bass-heavy** means a larger measured low-frequency proportion, not guaranteed separation of one instrument. The detector searches frequency bands independently so a loud bright attack does not suppress a nearby quieter bass attack.

Click a numbered timeline beat to pick it, **Ctrl-click** to toggle additional beats, or **Shift-click** to pick a range. The paginated **Individual beats** list provides the same selection through checkboxes. **Delete selected beats** or **Delete** removes picked markers while retaining the audio clip.

In **Filter & repeat**, pick beats and choose a regular interval or a repeating selected pattern. Two picks suggest an interval; a single pick can use an explicit value such as **0.5 seconds**. Preview the resulting count and ghost markers before applying. The tool replaces other beat markers, preserves the music, and supports **Ctrl+Z**. **Use detected groups again** returns from edited/generated markers to the detection groups. See the [1.4 workbench guide](docs/beat-workbench-1.4.md) for timing examples.

## More precise editing in 1.3

Trimming retains the available source. Drag either clip edge inward to shorten it, then outward to recover material. The waveform follows the actual source position and scale while you move, trim or slip a clip; it does not stretch to fill the container. Larger handles, a source outline and live in/out feedback make the selected range easier to see.

Select a clip and open **Clip → Source selection** for a full-source overview, numeric **Source selection in/out** fields, one-frame slip buttons and **Restore full source**. Drag the selected window, hold **Alt** while dragging a timeline clip, or press **Y** for the slip tool to choose another part of the source while keeping the clip's timeline position and duration. Hold **Shift** during a drag to bypass snapping; use **Ctrl + mouse wheel** over the timeline to zoom around the pointer.

The interface uses charcoal panels with blue selection controls, cyan audio, lilac video, amber music beats and pink video signals. Save status remains visible in compact desktop layouts. See the [1.3 usability audit and follow-up suggestions](docs/ui-audit-1.3.md).

Older projects remain readable. A single-asset trim can recover its available original media. A sequence already merged and destructively shortened by v1.2 cannot recover composition sections that were never saved in that project; recreate those sections from the original clips or restore an earlier project backup. New source-selection metadata preserves the available sequence for later edits. All media and project data stay local.

## From music to a finished edit

1. **Import** music, footage and images. Use a file's `+` button or drag it onto a compatible track.
2. Select the soundtrack and open **Beats**. Adjust sensitivity/minimum gap, run detection, audition sound groups, then select the groups or individual beats to keep. Use the sampling pattern or **Filter & repeat** when needed.
3. Trim and arrange footage. Select its track and use **Merge track** if its clips should become one sequence; gaps are closed.
4. Double-click a moment on the video clip, or place the playhead and press **M**, to add a beat signal. Drag signals to refine them; right-click to remove them.
5. Open **Sync**, select the soundtrack and video sequence, choose the first destination beat, and sync. At least two signals and enough selected music beats are required.
6. Review the preview and use **Export film** to render.

Beat detection is an aid, not a guarantee of musical interpretation. Press **B** and click an audio clip to add or remove beats by hand. The `?` button includes a Persian quick guide.

## How interval matching works

For source signals `s1`, `s2` matched to music beats `b1`, `b2`:

```text
playback speed = (s2 - s1) / (b2 - b1)
```

A two-second video interval fitted between beats half a second apart plays at **4×**. The next interval can use a different speed. Before the first and after the last signal, the nearest interval's speed continues. If this would move the video prefix before timeline zero, trim the prefix or choose a later first music beat.

The time map is continuous; exported video is sampled at the chosen frame rate. A 60 fps output has approximately 16.7 ms frames. Slow motion currently repeats frames and fast motion drops frames; optical flow is not implemented.

## Projects travel with the folder

| Folder | Contents |
|---|---|
| `data/projects` | Timelines, beat markers, speed maps and active-project selection |
| `data/media` | Original imports, browser proxies, thumbnails and metadata |
| `data/exports` | Rendered films and export records |
| `data/runtime` | Current-machine runtime records and logs |

Wait for **Saved to folder** before copying. To move your work, finish exports, stop Pulse, and copy or ZIP the **entire app folder including `data`**. `Ctrl+S` also downloads a `.pulse.json` backup containing the edit graph; keep the corresponding media folder with it.

The public repository and public releases contain application files, not personal footage, music or projects. Import media through the UI; dropping loose files into the internal `data/media` directory does not register them in the library.

## Updates

Click **Check for updates** in the toolbar. If a newer release exists, choose **Update now**. Pulse saves the open project, downloads the application-only release, checks its SHA-256, and restarts after replacing application files. The `data` directory is preserved. A failed application restart triggers rollback to the previous app files.

Checks happen when requested. If you are offline or GitHub is unavailable, continue editing and retry later. See [the update design and release procedure](docs/updates.md).

## Media and quality

- MOV/HEVC footage is supported when the bundled FFmpeg can decode it. Preview uses browser-compatible files; export reads originals.
- HLG/PQ sources, including supported iPhone HDR footage, are tone-mapped to **SDR / BT.709** for current previews and exports. Original HDR files are retained. HDR output and Dolby Vision metadata preservation are not implemented.
- ProRes output is 10-bit 4:2:2 SDR. A higher-bit-depth container cannot recover detail absent from the source.
- Sources fit inside the export frame; choose its aspect ratio and resolution for the intended film.

## Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| V / B / Y | Select / beat-marker / slip-source tool |
| Alt + drag clip | Slip source inside a fixed timeline clip |
| Shift during drag | Bypass snapping |
| Ctrl + mouse wheel | Zoom timeline around pointer |
| Click beat number / Ctrl-click / Shift-click | Pick one beat / toggle a beat / pick a range |
| S | Split selected clip at playhead |
| M | Add a video signal at playhead |
| Delete | Remove picked beats; otherwise remove selected clips |
| ← / → | Move one output frame |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S | Save to folder and download a JSON backup |

## Development and validation

React/TypeScript and Vite provide the frontend. A local FastAPI engine processes media, and FFmpeg renders the film. The Windows portable runtime is built with PyInstaller.

See [development instructions](docs/development.md). Validation covers real FFmpeg outputs, detected beat timing, piecewise speed boundaries, mute, HDR-to-SDR rendering, atomic project recovery, concurrent launch, and relocation to paths containing spaces and Persian characters. The portable verifier starts the app with only Windows system directories on `PATH`; a separate clean Windows VM has not been validated.

## Licensing

The repository is publicly readable; no project-wide source-code license has been assigned yet. Bundled third-party software retains its own licenses. Release packages include Python, FFmpeg and dependency notices under `licenses/`.
