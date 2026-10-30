# Client-generated C4 geodata

The 2026-10-26 pack comes from the local C4 client and `m49n/l2mapconv-public` revision `bcc0bd22dbad8f444979718f38a4c7cb67d7ee1e`, with the generator fixes retained in the pack's `tools/` directory. Settings: actor height 48, radius 16, slope 45.5°, climb 2–16, cell size 16, cell height 1. Source packages were hashed before and after generation.

The client has 142 numbered maps. Map `15_21` places its terrain in `15_20` and is excluded. The resulting **141 regions total 714,003,094 bytes**. The retired server pack had 203 regions. Its 61 regions absent from this client had no dependencies in the audited spawns, available teleports, live actors or saved coordinates. The old `15_21` is also excluded from the new installation.

## Installation

Start normally in the launcher, or run `npm run geodata` to prepare the files. The starter compares the installed manifest and every region against `scripts/geodata-release.json`. An old pack is outdated even when its own manifest is internally consistent. Missing files, extra regions and same-size corruption also trigger replacement.

The release ZIP is downloaded and checked by SHA-256, then extracted into a separate directory and checked against the pinned manifest. Only then is the previous directory renamed to `Geodata.backup-*` and the new directory installed. Failed downloads or verification leave the old pack untouched. A failed installation restores it; an interrupted swap is recovered on the next start. Concurrent starts serialize installation. Directory aliases resolve to one physical path, including dangling links during a swap. The wrapper transfers its lease to the actual NodeL2 process before permitting game initialization; the game process keeps it until exit, even if the wrapper dies. A different release cannot replace those files while NodeL2 is alive. The lease directory remains present across concurrent stops and starts.

Current valid installations start without network access. `npm run test:geodata` exercises the installed geometry.

`L2NODE_GEODATA_DIR` selects an external directory. `L2NODE_GEODATA_URL` and `L2NODE_GEODATA_SHA256` override the archive mirror; the contents must still match the selected release. `L2NODE_GEODATA_RELEASE` selects an explicit trusted JSON descriptor with `schemaVersion: 1`, `manifest`, and optional `url`/`sha256`. This supports deliberate rollback and custom packs. Without an archive source, only an already complete matching installation can start.

The manifest uses `schemaVersion: 1`, `format: "L2J"`, an optional `profile`, and a `regions` array of `{region, bytes, sha256}`. Use the supplied manifest; do not regenerate it to accept damaged or mixed files.

## Rollback

The local cutover preserves all 203 old regions in `~/L2Solo-geodata-rollback-2026-10-26/Geodata`, with a verified manifest and the previous bootstrap source alongside it. The matching `geodata-release.json` beside that directory selects the rollback explicitly.

Stop the server, move the active `data/Geodata` aside, and copy the rollback `Geodata` directory into `data/Geodata`, including its hidden manifest. Set `L2NODE_GEODATA_RELEASE` to the absolute path of that backup’s `geodata-release.json` before running `npm run geodata` and starting with the same progression preset. Keep this override while using the old pack; the default release would otherwise upgrade it again.

## Behavior and checks

Navigation enforces reciprocal NSWE, wall clearance, layer changes and virtual obstacles. Shop conversation can cross a low counter on the same floor only when a short 3D ray is clear against matching client collision triangles. The pinned `npc-interaction-geometry.json` covers 165 service NPCs in 16 regions; its bytes and SHA-256 are part of the release manifest, and each region is checked against the source SHA before using its triangles. Packs without this verified geometry retain strict NSWE visibility. Movement still cannot cross the counter. Approach points require a street side connected to a counter arrival cell; narrow corridors retain independently checked alternative routes.

Integration tests exercise the installed geometry. Protocol conversion, counter-edge tolerance, queues, opaque walls and cross-floor rejection also have deterministic fixtures. Source spawn populations and coordinates are unchanged. Tests retain bounded coverage requirements for historical spawn heights rather than requiring the retired pack's exact values.

The 2026-10-27 release retains all 141 region files byte for byte and adds 23,414,427 bytes of collision-triangle data. The starter verifies this companion file along with the regions. It is preloaded before the world starts; only the recorded stationary NPC positions can use its conversation rays. The native export helper and input targets are retained with the downloadable full pack for reproducibility.
