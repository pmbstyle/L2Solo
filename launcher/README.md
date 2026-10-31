# L2Solo desktop launcher

Electron desktop application for installing, updating, configuring and running a local L2Solo server. The interface is English and follows World Observer's dark green and gold palette. The supplied L2Solo emblem is bundled locally.

## Development

From the repository root:

```sh
npm ci
npm --prefix launcher ci
npm --prefix launcher run runtime
npm run launcher
```

`runtime` downloads official Node.js 22.23.0 for the current OS/architecture, verifies it against Node.js's HTTPS checksum list, includes its license, and proves that `node:sqlite` loads. The installed app includes this runtime: users need neither Git, npm nor a separate Node.js installation. Server code runs under the bundled Node, outside Electron's Node ABI.

The original browser launcher remains available through `npm start`.

```sh
npm run test:launcher
npm --prefix launcher run test:ui
npm run check
npm --prefix launcher run release:server
npm --prefix launcher run pack
npm --prefix launcher run test:packaged
npm --prefix launcher run dist
```

`pack` creates an application directory. `dist` creates installers for the host platform. Build on each target OS rather than trying to cross-compile macOS installers.

`test:packaged` loads the actual built ASAR and uses its bundled Node.js plus unpacked helpers to check database locks, geodata verification and graceful start/stop against a temporary server fixture. Both desktop workflows run this check after packaging.

For a desktop UI smoke test, set `L2SOLO_SMOKE_DIR` to an **empty temporary directory** and run the development launcher. The test uses an isolated profile and a disposable server fixture, exercises navigation, INI editing, start/stop and console streaming, writes screenshots plus `result.json`, then exits. Development-only screenshot capture is also available through `L2SOLO_SCREENSHOT` (absolute PNG path). Neither hook runs in a packaged application.

## Installation and updates

1. Choose an empty folder or an existing L2Solo server.
2. Resolve the latest **published, stable GitHub Release**, tagged `vX.Y.Z`.
3. Read `l2solo-release.json`; verify compatibility with the launcher and the release's archive metadata.
4. Compare installed file checksums. If everything matches, skip the server download. Otherwise download the release archive, verify its SHA-256, extract to staging, and verify every file's size and SHA-256.
5. Back up replaced files, persist a rollback journal, then update only changed release files. Remove obsolete files only if they still match the previous release. Preserve untracked additions.
6. Verify/install the release's C4 geodata using the existing manifest, archive checksum, per-region hashes, usage leases and whole-directory rollback mechanism.

Closing the window while preparation is active is blocked. Closing it with the server running first requests a graceful shutdown, including the existing database drain. A lost launcher IPC connection also stops its server wrapper. A forced process kill is the last fallback after the normal shutdown timeout.

The main process owns file, network and process operations. The sandboxed renderer receives a narrow preload API; news is rendered as text, with external links restricted to the project, GitHub and community domains.

No published release is required to attach and start an existing server. Update discovery reports the absence of a release explicitly. The installation remains attached and geodata can still be repaired. Automatic reconciliation runs when the user selects a folder; reopening the launcher verifies the attached installation without automatically replacing its server code.

Startup also checks for updates in the background. A failed background check leaves the installed server usable; the manual check shows the error when requested.

## Files owned by the user

The launcher preserves `config/local.ini`, the database (including a custom configured path), `tmp/`, saved games, geodata, `.git`, and files outside the release manifest. Local settings are updated in place with comments and unrelated overrides retained. New API keys are written with private file permissions. Settings are saved while the launcher-managed server is stopped and apply on its next start.

Release files come only from Git's tracked `src`, `scripts`, `database`, static `data`, configuration defaults, package metadata and documentation. Production dependencies are installed into the archive at build time. Archives cannot include local configuration, SQLite databases, geodata, symlinks or files outside those roots. Existing symlinks along release destinations must be moved before an update.

Per-installation and per-world SQLite access locks prevent conflicting launchers and updates to a running world, including one started outside this app. OS locks release after a crash. The update journal is recovered before the next update/start. File backups stay in `.l2solo/backups/`; the current installation manifest is `.l2solo/installation.json`. These are server-file backups, **not a replacement for world/database backups**. The server's own schema migrations remain responsible for database compatibility.

Logs are visible in Console (last 250 messages) and appended to `tmp/logs/desktop-server.log`. The application profile remembers the selected folder. Uninstalling the launcher does not remove the selected server or the application profile.

## Tagged release workflow

The server and launcher currently share version `0.1.0`. For each release, update both package versions and lockfiles, merge the changes, then create and push the matching tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` runs the existing server test suite in 12 shards, runs launcher tests, builds the server archive, and builds installers on native runners:

| Platform | Architecture | Artifacts |
| --- | --- | --- |
| Windows | x64 | NSIS installer, portable executable |
| Linux | x64 | AppImage, Debian package |
| macOS | Intel x64, Apple Silicon arm64 | DMG, ZIP |

The final job publishes one complete GitHub Release only after all builds and tests pass. A failed job leaves the tag unpublished; rerun the workflow after addressing the failure. The manifest rejects a mismatch between the tag and package versions. Branch pushes do not publish releases.

The server archive is `L2Solo-Server-vX.Y.Z.zip`, accompanied by `l2solo-release.json` with `schemaVersion`, `tag`, `minimumLauncherVersion`, archive name/size/SHA-256, and every installed file's path/size/SHA-256. Keep schema version 1 compatible with older launchers or raise the minimum launcher version. A launcher that is too old directs the user to the release installer.

CI also runs desktop packaging checks for launcher PRs. Local tests do not prove Windows/Linux installer behavior; the corresponding CI jobs provide that check.

### Signing

Without signing secrets, CI produces unsigned Windows builds and ad-hoc macOS builds without notarization. Public distribution can therefore show OS trust prompts. Configure certificates before a public launch:

- `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`: macOS Developer ID certificate and password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: notarization credentials.
- `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`: Windows signing certificate and password.

Linux does not use those signing credentials. Launcher updates currently use the matching downloaded installer; background self-update is not implemented.

## Website news API

The launcher requests `GET https://l2solo.com/api/launcher/news`. The response contract is shown in [docs/news.example.json](docs/news.example.json): a versioned JSON object containing article IDs, category, title, excerpt, timestamp and HTTPS URL. No HTML or executable content is consumed. Return the latest articles first; Overview displays the first three.

Until that endpoint exists, or when it is unavailable, the launcher displays bundled example stories with a visible **PREVIEW** label. Server update information comes from real GitHub Releases; no server version or update is invented. The website endpoint itself is outside this repository's implementation.
