# L2Solo desktop launcher

Pushes to `develop` build and publish a separate Preview application and matching server prereleases after CI passes. Preview uses its own profile, server folder and update feed; stable releases require a tag whose source is in `main`. Release descriptions come from the reviewed `release-notes/server.md` and `release-notes/launcher.md` files. See [release operations](docs/releases.md) for the preview-to-stable workflow and installed update checks.

Electron desktop application for installing, updating, configuring and running a local L2Solo server. The interface is English and follows World Observer's dark green and gold palette. The supplied L2Solo emblem is bundled locally.

The compact desktop shell puts server status, uptime, start/stop, World Observer, the latest backup and recent activity on Home. Server operations use the green and gold surface; there are no promotional banners or placeholder news on Home. Navigation, buttons, dialogs and running states have subtle animations that respect the system's reduced-motion setting.

Home shows the login address with the AuthServer port. `GameServer.advertisedHostname` takes precedence; otherwise the launcher uses a concrete AuthServer listen address or a local IPv4 address. While running, a population bar receives counts from the server every two seconds, independently of World Observer and developer diagnostics. The bar shows dynamic bots against their configured target across hot/warm/cold states once, excluding static services. Online players have a separate counter and do not affect the bar or its target. Missing or stale reports are shown as unavailable rather than as zero population.

Every visible bundled setting has a section-specific explanation below its label. Time and byte fields also show readable equivalents next to the raw value, and settings search includes the explanations. The global notice describes when saved changes take effect. Settings added by another server version can use their default-INI comments as help; undocumented custom keys are identified as such rather than given invented behavior.

The settings presentation groups related fields and orders sections from gameplay and simulation to provider, network and database settings. Low-level bot scheduling, diagnostics, raid admission, activation, database maintenance, protocol and selected clan/enchanting internals are hidden from the desktop controls, Quick setup and search. Database exposes only the world database path. This is a presentation filter: the server continues reading all values from `default.ini` and `local.ini`, and saving visible fields preserves hidden overrides and comments.

Server settings expose one generic **AI** section for any OpenAI-compatible URL, including OpenRouter. Existing OpenRouter settings are displayed there until the first AI edit migrates the complete configuration to `[AI]`, preserving credentials, models and routing options. Reading settings or saving unrelated fields does not migrate them. Langfuse developer settings stay in the configuration file and are not exposed in the launcher.

## Development

From the repository root:

```sh
npm ci
npm --prefix launcher ci
npm --prefix launcher run runtime
npm run launcher
```

`runtime` downloads official Node.js 22.23.0 for the current OS/architecture, verifies it against Node.js's HTTPS checksum list, includes its license, and proves that `node:sqlite` loads. The installed app includes this runtime: users need neither Git, npm nor a separate Node.js installation. Server code runs under its selected private Node runtime, outside Electron's Node ABI.

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

For a desktop UI smoke test, set `L2SOLO_SMOKE_DIR` to an **empty temporary directory** and run the development launcher. The test uses an isolated profile and a disposable server fixture, exercises navigation, backup creation/restoration/deletion, wipe confirmation and cancellation, INI editing, start/stop and console streaming, writes screenshots plus `result.json`, then exits. Development-only screenshot capture is also available through `L2SOLO_SCREENSHOT` (absolute PNG path). Neither hook runs in a packaged application.

## Installation and updates

The installed application needs no Git, npm or global Node.js. It seeds a private runtime cache from its bundled Node.js, then selects the exact version required by the server manifest. Missing or damaged runtimes are downloaded from nodejs.org and verified against its HTTPS checksum list. Cached binaries are checked by hash and by loading `node:sqlite`; existing versions survive application updates. No runtime is replaced inside a running server or the application bundle.

Choose an empty folder to install, or attach an existing server without automatically replacing its code. A folder containing `.git` is a developer checkout: starting, settings and world tools remain available, while archive updates are disabled. Use a separate folder for a managed installation.

Server releases use `server-vX.Y.Z`; launcher releases use `launcher-vA.B.C`. Discovery filters published stable releases by component and compares their versions independently. Legacy server tags `vX.Y.Z` and schema-1 manifests remain readable. The repository-wide Latest pointer is not used for component discovery. An installation pins its selected release, compatibility requirement and runtime for the whole operation; background checks may discover a newer release without changing that selection. Checks share a four-hour cached release list, run in the background on startup and periodically, and can be refreshed manually. Offline checks never block an already installed server from starting.

The server archive includes production dependencies, defaults and static content. If installed file hashes match, no archive is downloaded. Otherwise the full ZIP is downloaded and every archive entry and payload is verified. Downloads can run while the server is playing; applying an update requires a stopped server. Completed downloads are cached in the application profile and reused during installation. Geodata is verified and distributed separately.

An imported world with a newer migration version than the target release is rejected before code changes. A schema-2 update snapshots the stopped world and matching history databases, saves replaced code and writes a recovery journal before changing release files. Obsolete files are removed only when unchanged from their previous release. Local settings, databases, manual saves, geodata, user additions and `.git` are excluded from release ownership.

Before the first start, the launcher rechecks both database paths and physical file identities against the snapshot. Manual INI path changes or replaced database files leave the update pending and refuse startup until the original pair is restored. The server repeats the check under the access lock, uses the verified physical pair and records migration authorization before opening either database. A refusal or crash before this authorization restores only code and leaves world data unchanged, including after a launcher restart. The first start after an update is a trial. Database migrations and world initialization run and both login/game ports must bind. Player connections are rejected until the launcher commits the update. A crash, timeout or interrupted trial after migration authorization restores the previous files and both databases. An installed update that has not started yet survives an application restart and remains pending. Once the launcher commits and admits players, it never automatically restores an older world. Restoring manual backups, wiping data and changing database paths are blocked while verification is pending. Legacy pending updates stop recovery if their database identity cannot be verified; keep the journal and snapshots when this happens. Old schema-1 releases retain their original file-only recovery behavior.

The operation journal and snapshots are in `.l2solo/`; pending recovery always holds the per-world access lock. Snapshot files in `.l2solo/backups/<operation>/databases` are service recovery copies, separate from manual `tmp/saves` backups. Treat them as private world data. If recovery reports an error, retain that folder and resolve the error before starting the server directly. A direct start of an unverified managed release is rejected by the server wrapper.

The Updates view has separate launcher and server controls. Launcher updates use `electron-updater` with architecture-specific metadata from a canonical launcher release. Downloads do not stop the world and closing the application does not automatically install them. **Update & restart** becomes available after current file/database operations finish. It gracefully stops the server, waits for its database drain, then invokes the native updater. macOS uses free ad-hoc signing and the manual DMG route: the update button downloads the matching DMG; quit the launcher and replace the app to finish. Development builds, Windows portable builds and Linux DEB installations also use the matching manual installer route. Installed Windows NSIS and Linux AppImage builds retain in-app updates.

The main process owns network, process and file operations. The sandboxed renderer has a narrow preload API. Server helpers run outside Electron's Node ABI. Closing the application during file/database operations is blocked; closing with an active server first drains it. Logs appear in Console and `tmp/logs/desktop-server.log`. Uninstalling the launcher does not remove the server directory or application profile.

## World backups and wipe

**Backups & data** uses the existing server's saved-game implementation, shown as backups in the desktop app. Backups live in the selected server's `tmp/saves`, so existing browser-launcher saves are available there too. A backup includes the world database and its matching history database, including custom `Database.path` and `Database.historyPath` settings. It does not include server configuration or geodata.

Creating, restoring and deleting backups requires a stopped server. Restore replaces the current world and history; restore and delete show confirmation dialogs. Backups are manual: the app does not create an extra snapshot automatically before restore or wipe. Create one first if you want to keep the current world.

The collapsed wipe panel supports **bots**, **players**, and **entire world**. The user must type the matching `WIPE BOTS`, `WIPE PLAYERS`, or `WIPE ALL` phrase and confirm the action. A wipe keeps saved backups. Main-process checks and the server's database access lock reject world operations while this launcher, another launcher, or a participating server holds the world. All database operations run under the bundled server Node.js. An older installation without the world-management scripts must be updated before these controls become available.

## Component release workflow

See [the release runbook](docs/releases.md) for bootstrap order, tags, artifacts, signing and verification.

Server and launcher versions are independent. A server tag builds/tests the server and attaches the exact installers from the newest published compatible launcher release. It never rebuilds or re-signs an unchanged launcher. A launcher tag builds native installers, architecture-specific updater feeds and blockmaps. One launcher version always identifies one immutable set of binaries.

The publish job assembles and verifies all assets in a draft, then makes the complete release public. Failed or incomplete jobs do not publish it. An existing published version cannot be overwritten. Only server releases move GitHub's public Latest pointer; both component catalogs are independent of that pointer.

Releases require no paid certificates or signing secrets. Windows installers are unsigned; macOS builds use free ad-hoc signing without Apple notarization. macOS launcher updates use DMG replacement while server updates stay in the application. Windows and macOS may show operating-system trust prompts when installing or opening downloaded builds. A successful local build does not prove native Windows/Linux installer behavior or completion of GitHub CI.

## Website news API

The launcher requests `GET https://l2solo.com/api/launcher/news`. The response contract is shown in [docs/news.example.json](docs/news.example.json): a versioned JSON object containing article IDs, category, title, excerpt, timestamp and HTTPS URL. No HTML or executable content is consumed. Return the latest articles first; Updates displays the first three.

Real articles appear in the Updates view. Until that endpoint exists, or when it is unavailable, the news section stays hidden rather than displaying bundled example stories. Server update information comes from real GitHub Releases; no server version or update is invented. The website endpoint itself is outside this repository's implementation.
