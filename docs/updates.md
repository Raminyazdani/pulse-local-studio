# Updates and releases

The release source is [Raminyazdani/pulse-local-studio](https://github.com/Raminyazdani/pulse-local-studio). Editing remains local and offline. Opening the update dialog requests a release check; installation requires the user's **Update now** action.

## Update flow

1. The UI flushes the open project to `data/projects`.
2. The engine downloads the application-only ZIP associated with the GitHub release manifest and verifies its byte size and SHA-256.
3. A helper outside the running app folder waits for the engine to stop, backs up replaced app files, and installs the new version.
4. Pulse restarts with the same data directory and port. If the expected version does not start successfully, the helper restores the previous app files and restarts them.

The updater must not replace `data/media`, `data/projects` or `data/exports`. Entries targeting data or escaping the app directory are rejected. Failed checks or downloads leave the current installation available. Installation is refused during an active export.

GitHub access uses HTTPS and the configured repository/release locations. SHA-256 verifies that bytes match the manifest; it is not a separate publisher code-signing certificate or a defense against compromised repository publishing access.

## Public release assets

| Asset | Purpose |
|---|---|
| `Pulse-Portable-Windows-x64.zip` | Application files for a fresh install or replacement |
| `Pulse-Portable-Windows-x64.zip.sha256` | ZIP checksum |
| `pulse-update.json` | Version, repository, asset URL, byte size and SHA-256 |

They are generated under **`release/`**, separately from private local packages under `portable/`. The public ZIP contains no personal media, project files, export history or current-machine runtime records.

## Publish a version

1. Set `VERSION` and `GITHUB_REPOSITORY` in `backend/version.py`.
2. Run the frontend, backend and portable checks in [development](development.md).
3. Commit, create a matching tag such as `v1.2.0`, and push the tag.
4. **Windows portable release** checks out the tag, obtains the pinned FFmpeg build, builds with `--without-data`, tests the frozen app with isolated data and validates ZIP contents/checksums.
5. The workflow publishes the ZIP, checksum and manifest as a GitHub Release.

The workflow can also be started manually for an existing version tag. Existing release assets are not silently overwritten; publish a new version/tag for a changed build.

The build uses the pinned [FFmpeg 8.1.1 full build](https://github.com/GyanD/codexffmpeg/releases/tag/8.1.1), with its SHA-256 verified by `scripts/fetch_ffmpeg.ps1`. The URL/hash were checked against the [Microsoft WinGet package manifest](https://github.com/microsoft/winget-pkgs/blob/master/manifests/g/Gyan/FFmpeg/8.1.1/Gyan.FFmpeg.installer.yaml). Third-party notices remain in the package.

## Manual recovery

Keep the local `data` folder intact. Stop Pulse, get a complete public application ZIP from Releases, and place its app files alongside that existing directory. Do not delete the old app folder and its data as a way to update. Logs and rollback records stay under local `data` for diagnosis.

The app does not disable operating-system protections. The portable verifier checks frozen execution with Windows-only `PATH`, persistent data and relocation; this does not certify every Windows installation.
