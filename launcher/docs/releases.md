# Releases and updates

## Versions and publication

Keep server `package.json`/root lockfile and launcher `launcher/package.json`/its lockfile independent. Root `l2soloRelease.minimumLauncherVersion` describes the updater protocol actually needed by the server; do not automatically raise it on every server release. Root `l2soloRelease.runtimeVersion` is the exact tested server Node.js version. Launcher `serverRuntimeVersion` is its bundled bootstrap runtime. Release CI derives its build/test Node version from the component policy, so the runtime declared by a server release is the one its server tests exercise.

The next stable server version is `0.1.3`, reusing the published launcher `0.2.3` installers. Schema-2 server packages still require launcher `0.2.0` or newer. Integrate the reviewed changes into `develop` to build and validate a preview, then merge the release source into `main`. If a release also updates the launcher, publish it first and wait for its native jobs and complete public release before publishing the server. The server publisher refuses to proceed without compatible published installers for every supported target.

```sh
# After review, commit and integration of the intended release source:
git tag server-v0.1.3
git push origin server-v0.1.3
```

Both stable tags may reference the same commit. Each GitHub release has exactly one tag. Stable release CI requires the tagged commit to be in `main`. Future server-only releases reuse the same launcher binaries until a new launcher version is published. PRs never publish releases. Tags in the old `vX.Y.Z` form remain discoverable as legacy server releases, but no longer trigger new publications.

## Preview builds from develop

Every push to `develop` runs `.github/workflows/preview.yml`. It can also be dispatched against `develop` once the workflow is available for manual dispatch. No merge into `main` is needed. The workflow runs all twelve server test shards, launcher tests and packaged checks on Windows x64, Linux x64 and both macOS architectures before publishing.

Each run stamps disposable build copies with `server-v<base>-preview.<run number>` and `launcher-v<base>-preview.<run number>`. Source package versions in `develop` stay numeric. Both manifests carry the same source commit; the preview server requires the exact launcher build from that commit. Preview publication creates complete GitHub prereleases, never changes Latest, and never replaces an already published version. Retrying an incomplete draft retains its source commit; an already published preview is verified and reused without replacing files. A new build needs a new workflow run number.

Configure the repository Actions secret `PREVIEW_RELEASE_TOKEN` before automatic publication. Use a fine-grained token restricted to this repository with **Contents: write** and **Workflows: write**, or an equivalent GitHub App token. GitHub requires workflow authorization when a release target changes `.github/workflows/` relative to the default branch; the built-in `GITHUB_TOKEN` cannot provide it. See [GitHub's release API requirements](https://docs.github.com/en/rest/releases/releases#create-a-release). Without the secret, build/test jobs still produce downloadable Actions artifacts and the publication job stops with a setup message. After adding the secret, rerun the failed publication job for the same run. Never put tokens in source files or release assets.

Download a **L2Solo Launcher Preview** installer from the preview server or launcher release. It has a separate application identity and user profile. Choose an empty test server folder. Managed stable and preview server folders cannot be opened through the other channel, including folders reserved before installation. The preview client only discovers preview tags marked as prereleases; stable clients only discover stable tags. Preview updater metadata uses `preview-<arch>` channels and stable metadata uses `latest-<arch>`. macOS still uses manual DMG replacement within its channel.

To exercise the entire update path, install preview N, create a test world and backup, then use a later develop build N+1. Check server migration/rollback, world/history preservation, offline start and interrupted downloads. On Windows NSIS and Linux AppImage, check the application update and restart too; on macOS, replace the closed Preview app using its next DMG. CI package tests do not substitute for an installed previous-to-next application walkthrough. After validation, merge the reviewed source into `main` and publish stable component tags.

The preview publisher resolves known component tags through the authenticated exact-tag API, including the server's companion launcher and an already published preview being retried. It does not discover them through the anonymous release list, whose cached response can lag publication. Drafts and mismatched tags are rejected; the normal version, source commit, installer and checksum checks still apply.

## Release notes

Write player-facing changes in `release-notes/server.md` and `release-notes/launcher.md` as part of the update PR. The publisher uses these reviewed files for both preview and stable release bodies, adds component versions/download guidance, and labels previews with their source commit. Empty notes prevent publication. GitHub-generated PR lists are no longer the user-facing description. Updates has one Markdown notes panel: server release notes take priority, with launcher notes as a fallback when server notes are unavailable. Headings, lists, emphasis, code and tables are formatted locally. Raw HTML is escaped, images remain text, and links use the existing main-process URL checks before opening externally.

## CI and artifacts

`.github/workflows/release.yml` validates the component tag before building. Server releases run all twelve server test shards plus launcher updater/rollback tests and package a ready-to-run ZIP with production dependencies. Launcher releases run launcher tests, prepare the pinned runtime, build on native runners and run packaged application smoke checks.

| Target | Installer/download | Update metadata |
| --- | --- | --- |
| Windows x64 | NSIS Setup, portable EXE | `latest-x64.yml`, blockmaps |
| macOS x64 | DMG and ZIP | `latest-x64-mac.yml`, blockmaps |
| macOS arm64 | DMG and ZIP | `latest-arm64-mac.yml`, blockmaps |
| Linux x64 | AppImage and DEB | `latest-x64-linux.yml` |

The logical Linux target is `linux-x64`, but Electron Builder uses `linux-x86_64.AppImage` and `linux-amd64.deb` in artifact names. The publisher retains these names and feed URLs; older `linux-x64` filenames remain accepted as aliases. Each native release job verifies its actual installers and feed hashes before uploading artifacts. Missing installers, duplicate candidates for one format and feeds pointing at another platform stop the native job before aggregation.

`launcher-release.json` records the canonical launcher tag/version, per-platform installer names and updater feeds, and the size/SHA-256/SHA-512 of every published artifact. Feeds are checked against the manifest before publishing and before invoking the application updater. Architecture-specific names prevent Intel and Apple Silicon metadata from overwriting each other when CI artifacts are merged. Previous blockmaps resolve to the installed version's canonical launcher release. Differential application downloads may fall back to full downloads; server ZIP downloads are currently full downloads.

A server release contains `L2Solo-Server-vX.Y.Z.zip`, `l2solo-release.json`, the original compatible installers, and a copy of their canonical `launcher-release.json`. The server manifest includes schema version 2, startup protocol version 2, component/version/tag, minimum launcher version, exact Node.js requirement, database schema (`databaseSchemaVersion`, the last numbered migration, and `databaseMigrationNames`, every named migration the release knows), archive/file hashes and the selected launcher version/tag. Before an update replaces any file, the launcher refuses a world that "requires a newer server": one whose `schema_migrations` holds a version above `databaseSchemaVersion`, or whose `named_migrations` holds a name missing from `databaseMigrationNames` (a manifest without the list predates named migrations and knows none). The packager reads both from `src/Database.js` (`migrations.push([N, …])` and the `['name', () => …]` entries of `namedMigrations`). Worlds from early builds that recorded the first named migration as numbered 84 lose that row when it runs, so they read as 83. Original installer bytes, including the macOS ad-hoc signature, are preserved. Updater feeds and blockmaps remain on their canonical launcher release; attaching installers to a server release does not create an application update.

The publisher checks archive hashes, finds a compatible published launcher, verifies copied installer hashes, creates/resumes a draft, uploads all files and only then publishes it. Re-running a failed workflow can replace assets on its draft. Published versions cannot be overwritten; fix a released problem with a new version. Launcher releases are not marked Latest; server releases are.

## Distribution without paid certificates

No Apple Developer membership, Authenticode certificate, signing service or signing secrets are required by the release workflow. It builds unsigned Windows installers and ad-hoc signed macOS applications. Certificate auto-discovery is disabled in release CI. macOS `identity` is `-`, `notarize` is false and no signing timestamp is requested. The free ad-hoc signature supplies executable integrity, including for Apple Silicon; it does not identify an Apple-verified developer or provide notarization.

Windows NSIS and Linux AppImage installations retain in-app updates. The updater validates release metadata and artifact hashes from the canonical HTTPS GitHub release; unsigned Windows builds do not have a trusted publisher certificate to validate. Windows portable and Linux DEB users receive links to the matching portable executable or package.

macOS application updates use the DMG route rather than the signed-app native updater. The Updates button downloads the DMG matching the installed architecture. After downloading it, quit the launcher (which saves and stops the running server), open the DMG and replace the application. The server installation, world/history databases, settings and private runtimes stay outside the replaced bundle. Server updates remain available inside the launcher on every platform.

Downloaded macOS/Windows builds may trigger Gatekeeper or SmartScreen prompts. Device management or Windows application-control policy can prevent running unsigned/unnotarized builds. macOS users who trust the release may need the per-application approval described in [Apple's opening instructions](https://support.apple.com/en-us/102445); Windows behavior is described in [Microsoft's signing guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options). These builds do not change system-wide security settings.

Local packaging uses the same certificate-free policy:

```sh
npm --prefix launcher ci
npm --prefix launcher run runtime
npm --prefix launcher run pack
npm --prefix launcher run test:packaged
```

For an offline macOS development build with an existing Electron distribution, `pack` also accepts `--config.electronDist=node_modules/electron/dist`. The package configuration already selects ad-hoc signing and disables notarization and timestamps. No certificate provisioning step is needed before publishing. GitHub's workflow token is used only in CI to upload and publish; end users need no GitHub account or token.

## Runtime, data and recovery

Runtime binaries are private, versioned application-profile files, not global Node.js installations. A new application seeds its tested runtime from the installer. A server requiring another supported version causes a verified official Node.js download into a separate cache entry. Existing versions are retained for other installations and rollback; application replacement never deletes them. The server ZIP carries its dependencies, so no Git checkout or npm installation is performed on the user's machine. If native dependencies are introduced, replace the portable server ZIP with platform/architecture-specific artifacts and native package tests before shipping them.

Windows Setup checks create/write/delete access to the destination and any previous installation directories before running the old uninstaller. Access denied requests UAC elevation; the elevated installer rechecks access and retains the chosen folder and installation scope. Cancelling elevation, a locked or read-only file, and persistent access denial stop installation before removing the old version and report the affected path. A per-user installation rejects elevation using a different Windows account, which would otherwise register the update under that account's profile.

`npm --prefix launcher run test:installer` compiles a disposable NSIS installer, its uninstaller and an access-check driver. On Windows it also tests denied directory/file ACLs, file locks, preservation of the installed version on failure and a successful retry. The fixture has a separate application ID, package name and installation folder. Other platforms perform compilation only; setting `L2SOLO_NSIS_WINE` to a Wine executable additionally exercises file operations in an isolated temporary prefix. Wine does not validate Windows ACLs or UAC. Interactive consent, cancellation and same-account elevation remain part of the native Windows release walkthrough.

Installer includes use NSIS's include directory search so Windows and POSIX compilers resolve paths with their native separators. Installer check failures retain a nonzero exit status after Electron Builder's asynchronous cleanup. A launcher unit test injects a build failure with that cleanup hook active, preventing a failed compilation from producing a green CI result.

The server directory owns `config/local.ini`, world/history databases, `tmp/saves`, logs and separate geodata. A running world is protected by the same database access lock used by backups and the server. Applying code requires a stopped world. Before file replacement a service snapshot checkpoints and checks both databases, then a journal binds old code and old data to the same update operation.

The selected release object is fixed for the entire installation even when an informational check discovers a newer release. After installation, update availability is compared against the actual installed version.

Trial startup uses the configured world/history pair without comparing it to the update snapshot. Copying, moving or replacing database files does not produce warnings or require reinstalling the update. The server pins the physical paths for its process and records those destinations in the update journal under the world access lock. Startup protocol 2 distinguishes `starting` from `migrating`: the server durably records `migrating` before opening either database. Recovery before migration authorization rolls back only code and leaves current data unchanged.

A trial remains pending until initialization and both TCP listeners report readiness. The launcher commits its journal before telling the server to admit players. Only a failed/interrupted trial that may have modified databases offers to restore the pre-update world/history backup. **Yes, restore backup** replaces both databases at the failed startup's recorded destinations; **No, keep current data** leaves both files unchanged. Closing the dialog also keeps current data. Previous server files are restored in either case. There is no database restore prompt when no database backup exists, during ordinary startup, or after a successful trial.

The answer is persisted before recovery changes code or data. An interrupted recovery resumes the saved choice without asking again. Older journals also pin recovery destinations before the question, so later configuration changes or partial code recovery cannot redirect a confirmed restore. A confirmed restore records `recovering` before replacement and verifies backup checksums and database integrity before replacing either member of the pair. Legacy interrupted startups follow the same explicit choice. A crash after commit does not restore old gameplay data. If code or database recovery fails, the journal remains for a later recovery attempt. Old snapshots remain in `.l2solo/backups`; do not delete that directory or start an unverified installation through another entry point.

Manual world backups remain separate. The updater snapshot is not an autosave schedule and does not change the existing restore/wipe confirmation behavior. Pending verification blocks restore/wipe and database path changes through the settings UI. Archive updates also apply to existing Git working copies, independently of the current branch.

Manual saves checkpoint and check both stopped databases, then close both SQLite connections before copying either file. The separate world access lock covers preparation, copying, validation and publication. Keeping an exclusive SQLite transaction open during `copyFileSync` makes Windows reject the copy with `EBUSY`; retrying the copy cannot release that lock. The history database contains finished events and analytics and belongs to the world/history pair; it is not a disposable temporary file.

## Validation before public rollout

Dependency checks must include advisory comments, not only a passing CI badge. The launcher pins `tar` 7.5.22 and `js-yaml` 4.3.2. `extract-zip` 2.0.1 still has unpatched [symlink traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) and [duplicate-entry overwrite](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) advisories, so `npm audit` continues to report it. Both launcher extraction paths reject symlink entries before the library creates them and use private staging directories. Regression tests cover a symlink followed by a regular file with the same name and verify that an outside sentinel remains unchanged. Keep these guards unless the extraction library is replaced with equivalent protection.

Local automated checks:

```sh
npm --prefix launcher test
npm --prefix launcher run test:ui
npm run check
npm --prefix launcher run pack
npm --prefix launcher run test:packaged
```

The tests cover release selection/cache, component compatibility, exact installer reuse, feed/hash validation, private runtime repair, background downloads, graceful application update ordering, successful startup acceptance, migration failure, timeout and interrupted world/history rollback. Native CI covers packaging on each supported platform. The complete old-to-new application update still needs a release-candidate walkthrough on installed Windows NSIS and Linux AppImage builds; the macOS walkthrough must cover downloading a DMG and replacing the closed app. Unit tests and a local macOS package do not prove all native installer paths. Exercise offline launch, interrupted download, installer restart, world preservation and an actual previous-to-next server release before broad rollout.
