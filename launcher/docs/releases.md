# Releases and updates

## Versions and first publication

Keep server `package.json`/root lockfile and launcher `launcher/package.json`/its lockfile independent. Root `l2soloRelease.minimumLauncherVersion` describes the updater protocol actually needed by the server; do not automatically raise it on every server release. Root `l2soloRelease.runtimeVersion` is the exact tested server Node.js version. Launcher `serverRuntimeVersion` is its bundled bootstrap runtime. Release CI derives its build/test Node version from the component policy, so the runtime declared by a server release is the one its server tests exercise.

The current launcher is `0.2.0`, the server is `0.1.0`, and schema-2 server packages require launcher `0.2.0` or newer. Publish the launcher first. After its native jobs pass and the complete release is public, publish the server. The server publisher refuses to proceed without compatible published installers for every supported target.

```sh
# After review, commit and integration of the intended release source:
git tag launcher-v0.2.0
git push origin launcher-v0.2.0

# Wait for the launcher release workflow and all platform artifacts.
git tag server-v0.1.0
git push origin server-v0.1.0
```

Both stable tags may reference the same commit. Each GitHub release has exactly one tag. Stable release CI requires the tagged commit to be in `main`. Future server-only releases reuse the same launcher binaries until a new launcher version is published. PRs never publish releases. Tags in the old `vX.Y.Z` form remain discoverable as legacy server releases, but no longer trigger new publications.

## Preview builds from develop

Every push to `develop` runs `.github/workflows/preview.yml`. It can also be dispatched against `develop` once the workflow is available for manual dispatch. No merge into `main` is needed. The workflow runs all twelve server test shards, launcher tests and packaged checks on Windows x64, Linux x64 and both macOS architectures before publishing.

Each run stamps disposable build copies with `server-v<base>-preview.<run number>` and `launcher-v<base>-preview.<run number>`. Source package versions in `develop` stay numeric. Both manifests carry the same source commit; the preview server requires the exact launcher build from that commit. Preview publication creates complete GitHub prereleases, never changes Latest, and never replaces an already published version. Retrying an incomplete draft retains its source commit; an already published preview is verified and reused without replacing files. A new build needs a new workflow run number.

Configure the repository Actions secret `PREVIEW_RELEASE_TOKEN` before automatic publication. Use a fine-grained token restricted to this repository with **Contents: write** and **Workflows: write**, or an equivalent GitHub App token. GitHub requires workflow authorization when a release target changes `.github/workflows/` relative to the default branch; the built-in `GITHUB_TOKEN` cannot provide it. See [GitHub's release API requirements](https://docs.github.com/en/rest/releases/releases#create-a-release). Without the secret, build/test jobs still produce downloadable Actions artifacts and the publication job stops with a setup message. After adding the secret, rerun the failed publication job for the same run. Never put tokens in source files or release assets.

Download a **L2Solo Launcher Preview** installer from the preview server or launcher release. It has a separate application identity and user profile. Choose an empty test server folder. Managed stable and preview server folders cannot be opened through the other channel, including folders reserved before installation. The preview client only discovers preview tags marked as prereleases; stable clients only discover stable tags. Preview updater metadata uses `preview-<arch>` channels and stable metadata uses `latest-<arch>`. macOS still uses manual DMG replacement within its channel.

To exercise the entire update path, install preview N, create a test world and backup, then use a later develop build N+1. Check server migration/rollback, world/history preservation, offline start and interrupted downloads. On Windows NSIS and Linux AppImage, check the application update and restart too; on macOS, replace the closed Preview app using its next DMG. CI package tests do not substitute for an installed previous-to-next application walkthrough. After validation, merge the reviewed source into `main` and publish stable component tags.

## Release notes

Write player-facing changes in `release-notes/server.md` and `release-notes/launcher.md` as part of the update PR. The publisher uses these reviewed files for both preview and stable release bodies, adds component versions/download guidance, and labels previews with their source commit. Empty notes prevent publication. GitHub-generated PR lists are no longer the user-facing description. The launcher reads each release body from GitHub and displays server and launcher notes as plain text; external HTML is never rendered.

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

A server release contains `L2Solo-Server-vX.Y.Z.zip`, `l2solo-release.json`, the original compatible installers, and a copy of their canonical `launcher-release.json`. The server manifest includes schema version 2, startup protocol version 2, component/version/tag, minimum launcher version, exact Node.js requirement, maximum database migration version, archive/file hashes and the selected launcher version/tag. Original installer bytes, including the macOS ad-hoc signature, are preserved. Updater feeds and blockmaps remain on their canonical launcher release; attaching installers to a server release does not create an application update.

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

The server directory owns `config/local.ini`, world/history databases, `tmp/saves`, logs and separate geodata. A running world is protected by the same database access lock used by backups and the server. Applying code requires a stopped world. Before file replacement a service snapshot checkpoints and checks both databases, then a journal binds old code and old data to the same update operation.

The selected release object is fixed for the entire installation even when an informational check discovers a newer release. After installation, update availability is compared against the actual installed version.

Before trial startup the launcher revalidates the configured world/history paths, canonical paths and file identities against the pending snapshot. Changes before or during preparation refuse startup without changing either world; restore the original paths/files to continue. The server checks the same pair before opening databases and again under the access lock, then pins the physical paths for its process. Startup protocol 2 distinguishes `starting` from `migrating`: the server durably records `migrating` under that lock before opening either database. A refusal is recorded as `rejected`. Recovery before migration authorization rolls back only code, even if the process crashed before it could record a rejection.

A trial remains pending until initialization and both TCP listeners report readiness. The launcher commits its journal before telling the server to admit players. A failed/interrupted trial after migration authorization restores both data files and previous code; a crash after commit does not restore old gameplay data. Recovery records `recovering` before replacement so it can resume its own interrupted database restore. Legacy journals without this startup protocol must pass a file identity check (or a hash check when no identity was recorded) before recovery changes code or data. If that check or a recovery copy's integrity verification fails, or a copy cannot be restored, the journal remains for a later recovery attempt. Do not delete `.l2solo/backups` or start the pending installation through another entry point.

Manual world backups remain separate. The updater snapshot is not an autosave schedule and does not change the existing restore/wipe confirmation behavior. Pending verification blocks restore/wipe and database path changes so a failed update cannot undo a later user operation. Source checkouts containing `.git` are explicitly excluded from archive replacement.

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
