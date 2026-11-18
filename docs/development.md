# Development

React/TypeScript and Vite provide the frontend. Python/FastAPI imports media, generates previews, detects bass transients, persists edit graphs and renders original media with FFmpeg. The portable runtime opens a loopback server and the user's browser.

## Source setup on Windows

Use Python 3.12, Node.js 24, and FFmpeg/FFprobe on `PATH`. Tested build versions are in `requirements-build.txt`; `package-lock.json` records frontend dependencies.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt -r backend/requirements-test.txt
npm ci
npm run build
.\start.ps1
```

For frontend development, run the engine in one terminal and Vite in another:

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8765
# Another terminal:
npm run dev
```

Vite forwards `/api` to port 8765. The local API reference is at `http://127.0.0.1:8765/api/docs`.

## Tests

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest backend.test_backend backend.test_hdr backend.test_projects backend.test_edit_source backend.test_beat_groups backend.test_beat_tools backend.test_video_signals backend.test_video_signals_core backend.test_portable_runtime backend.test_updates -v
```

Backend integration tests generate their own media and run FFmpeg. The backend test module is listed first because it initializes isolated media storage before other tests import shared path constants.

Browser tests need isolated folder data; clearing localStorage no longer overrides an existing folder project. The portable verifier manages isolated data itself:

```powershell
npx playwright install chromium
.\.venv\Scripts\python.exe scripts/verify_portable.py --bundle release/Pulse --expected-media 0 --browser
```

The count above describes a clean public release. For a local private bundle, pass its actual media count or omit that assertion. The verifier reads the packaged library, copies application files into a test workspace, and generates synthetic fixtures there.

With `--browser`, the verifier also runs precision-editing regressions against its disposable workspace: stable waveform peaks, reversible trim edges, fixed-container source slips, decoded preview frames, retained merged speed maps, manual-beat reset and edits made during asynchronous detection. Beat-workbench tests cover quiet-bass grouping, actual sample playback, selected-marker deletion, phase-preserving repetition and persistence. Workspace tests cover real panel resizing/reordering, timeline placement, cancellation and saved layout. Video-labeler tests cover source-frame seeking, image zoom/pan, source-label persistence, explicit instance application, locked clips, conflicts, partial-save recovery and library reuse. These suites require an explicit matching workspace hash before they can write.

## Portable builds

```powershell
npm run build
.\.venv\Scripts\python.exe scripts/build_portable.py --without-data
```

Public application-only output goes to **`release/`**. It contains the app ZIP, its SHA-256 and `pulse-update.json`. The package includes the frozen Python runtime, FFmpeg/FFprobe, updater helper, built frontend and license notices.

Private local migration packages remain under **`portable/`** and may contain personal media. Do not publish them. The release workflow always uses `--without-data` and inspects the ZIP for forbidden data paths before upload.

Keep the release tag synchronized with `backend/version.py`. See [release instructions](updates.md).

## Structure

To exercise an actual published GitHub update, first run the portable verifier
above to generate its isolated synthetic media and project. Then prepare an
older frozen fixture and run its real update UI:

```powershell
.\.venv\Scripts\python.exe scripts/verify_live_update.py --prepare-only --old-version 1.1.9
# Use the prepared.json path printed by preparation, after the target release exists:
.\.venv\Scripts\python.exe scripts/verify_live_update.py --prepared <prepared.json>
```

This test builds an isolated source copy with an older runtime version. It never
changes the source version or the personal library. It downloads the public
release through the real application, observes replacement and restart, and
checks that the edit graph, media, existing exports and unrelated root file
survive. Real 1.1.9 → 1.2.0, stock published 1.2.0 → 1.3.0 and stock published 1.3.0 → 1.4.0 updates have passed with a Windows-only PATH. The 1.2 → 1.3 check also exercised safe rollback after a transient local directory lock before a successful full UI retry; see the [1.3 audit](ui-audit-1.3.md) and [1.4 validation](beat-workbench-1.4.md).

| Path | Responsibility |
|---|---|
| `src/components` | Timeline, preview player and update dialog |
| `src/lib` | Edit graph, beat selection, time warping and persistence |
| `backend/media.py` | Originals, previews, waveform and detection |
| `backend/render.py` | FFmpeg render graph and exports |
| `backend/projects.py` | Atomic folder-based saves and recovery |
| `backend/updates.py` | Release checks and update staging |
| `portable_runtime.py` | Launcher and single-instance workspace control |
| `updater_runtime.py` | App-file replacement and failed-start rollback |
| `scripts` | Packaging, verified FFmpeg fetch and portability checks |

## Technical references

- [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html)
- [PyInstaller operating mode](https://pyinstaller.org/en/stable/operating-mode.html)
- [PyInstaller runtime paths](https://pyinstaller.org/en/stable/runtime-information.html)
- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub CLI releases](https://cli.github.com/manual/gh_release_create)
