# Bot tables (precomputed)

Checked at be97733e (2026-11-03).

Survey of `ivan/next-release` @ be97733e (tables of 81e247159, Tables run 41674181585). Line numbers drift; search by
name. Scope: `data/Bots/*.json`, `data/Bots/hunt/*.json`, `scripts/generate-spot-table.js`,
`scripts/generate-spot-reward-catalog.js`, `scripts/hunt-tables/*`, `scripts/fight-table/*`,
`scripts/hunt-cycle-check.js`, `.github/workflows/tables.yml`, reader `Bot/AI/SpotValueTable`.

**One idea first.** A table never decides what happens in a fight: cold hunting rounds are simulated live
(`BackgroundResolver.resolveSolo`), hot bots fight real NPCs. A table answers "what would an hour there give?" for
the decisions taken before a fight: which spot, what an hour of the bot's time is worth, whether shots or potions pay,
what to buy. A wrong table sends bots to the wrong place or makes them buy the wrong thing; it does not change what
they get once there.

## Families

| File | What it holds, in a sentence | Size | Built by | Read at runtime |
|---|---|---|---|---|
| `data/Bots/spot-table.json` | Per spot × class line × shots (on / off / Blessed): kills, exp, deaths, shots, potions, bag slots per hour of solo hunting, simulated with the real cold fight; per line and 2-level band a level curve; per line and band a kit surface | 23.3 MB; 1603 spots × 31 lines × 3 = 149079 cells, 97262 measured (the rest: the line cannot hunt there alone), 23 fields; 1147 curves; 1147 surface fits | `scripts/generate-spot-table.js` | `SpotValueTable`, main and cold worker |
| `data/Bots/spot-reward-npcs.json` | Per spot its NPC species with counts and the adena range: the spawn catalogue without fights | 98 KB, 1603 rows `[spotId, [[npc, count]], adenaMin, adenaMax]`, no revision | same generator (merge phase) or `scripts/generate-spot-reward-catalog.js` | `SpotValueTable` fallback only (a spot not in the live catalogue); hunt tables (input) |
| `data/Bots/hunt/*.json` (9) | The offline hunt model: mob cards, spot cards, class base cards, gear ladders, item sources, hennas, damage rotations, formula corrections, mob-level ceilings per kit | 2.4 MB | `scripts/hunt-tables/build.js` | **nothing** ("Offline only; the server does not read them yet", build.js header) |
| `tmp/fight-table/*.json.gz` | One bot vs one mob at every level, by offence / defence / M.Def points | not committed | `scripts/fight-table/{build,path}.js` | nothing (Python reports, one test) |

Not bot tables (datapack conversions, no simulation): `data/Npcs/aggro-ranges.json` (`NpcAggroRange`),
`data/KnowledgeBase` (the player's in-game knowledge pages, `npm run check:knowledge-base`), `data/Pets/*`. The live
spot catalogue (`SpotProfiles.ensure`, built at start from the spawns) is no file but is the key every table row hangs on.

## Spot table

**Shape.** `{ header, roles, shots, gaps, rowFields, curveFields, spots, rows, curves, kitSurface }`.
- `roles`: 31 class lines, each named by its second class id (`'2'` Gladiator line …); `header.inputs.roleLines` keeps
  the old role names as aliases (`dps` → `'2'`, `mage` → `'12'`, …). A line's bot at a level is its base / first / second
  class (below 20, 20-39, 40+), in the author's kit for the level (`BotGear`, `HuntCycle.referenceState`).
- `spots[i]` = `[id, level, density, cap of all its monsters, 1, loot response at drop rate 10, at 50, kills' mean
  accuracy, evasion]`.
- `rows[spot][line × 3 + shots]` = `[minGap, refGap, kph, busy, deaths, exp, sp, adena, loot, shots, potions, stacks,
  fight, rest, taken, spellTaken, hpLost, mpLost, pull, cap, mix, gate, gateShare]`, per mob killed, at rate x1, measured
  at the spot's level + 6 (`REF_GAP`) or the lowest gap the line finds a safe target at. `mix`: the kills by species
  (≤ 8), `gate`/`gateShare`: per curve gap what a bot of that level may fight alone there.
- `curves[line][band][field]`: per gap −4..10 (step 2) the value over its value at +6 (kph, busy, deaths, exp, adena,
  fight, rest, taken), from ≤ 3 spots of the band.
- `kitSurface.rows[line][band]`: least-squares slopes of log(fight), log(taken) per kill on 4 kit features
  (`HuntCycle.KIT_FEATURES`) against the author's kit.

**Build.** Three phases (`rows`, `curves` (+ kit points), `merge`), each split in 12 shards on CI (`--phase`,
`--shard=i/n`, a part refused if its `tasksHash` differs). Tasks run in a pool of child processes (`--jobs`, 4 on CI),
each loading the real game data (rate x1, TZ UTC); a task runs `hunt` → `huntOn`: the reference bot calls `BackgroundResolver.resolveSolo` round after
round for 2 h (rows) or 1 h (curves, kits), seeded per spot, class and level (`mulberry`; shots on/off share a seed).
That runs the real cold rules: the solo gate and admitted spawns (`BackgroundResolver.admittedShares`,
`admittedDensity`), walking between mobs (`soloWalkMs`), `resolveFight` (`HitRules`, `Formulas`, `C4SkillRules`,
`ColdMobAction`, `ColdCombatProfile`, summons, charges), rest (`ColdRest`, `RestPolicy`), potions
(`HealingPotionStock.purchasePotionFor`, `RestPotion`), shots (`ShotStock.planForState`), kill rewards
(`ColdKillRewards`), death and respawn time (`Formulas.respawnHp`), town outings (`TownVisitInterval.targetHours`).
Loot response: `GearAcquisitionPlanner.itemDropYield` at x1/x10/x50. The catalogue is the server's own
(`SpawnNpcs.catalogueSpawns` seeded 20261005, both periods, `SpotProfiles.ensure`) on the geodata
(`L2_TABLES_GEODATA=required` on CI; `header.inputs.geodata` names the profile).
- Patched in the child, so the table measures a slightly different world than live (on purpose, each with an
  ARCH-NOTE): `SurvivalFloor.forState` never returns `unload` (no town trip for a full bag; bag growth is the `stacks`
  column); `ShotStock.usePolicy` always uses shots (live it reads this very table); `MobExperience.rewards` without the
  C4 level-gap penalty (the reader applies `MobExperience.gapFactor` for the bot's own gap). The death exp loss is left
  out (charged at read, `EconomicValuation.deathHours`). Potions: a run without deaths is run again on one hour's
  potions per outing — a copy of the stock rule (`EconomyContext.foundation` buys the row's use).
- Header: `revision` = `git rev-parse --short=9 HEAD` at build time, `+local` when `git status` shows changes under
  `src`, `data/Npcs`, `data/Items`, `data/Skills`, `data/Templates` (not `scripts/`, not geodata), or `--revision=`.
  `inputs` (hours, seed, geodata, rate x1, maxLevel 78, refGap, bands, curve spots, line classes), `counts`
  (246937 simulated hours for this table).

**Staleness at runtime.** `SpotValueTable.checkCatalog` runs at the first read on each thread and when the catalogue
moves: one line `SpotTable  N of M catalogue spots missing; geodata: table X, server Y; table revision R`, a warning
when spots are missing or the geodata differs. It catches a spawn or geodata change (spot ids move). It never compares
`revision` with the running code: a table built before a combat change is used silently. Hunt-table `fingerprints`
(sha1 of the data dirs) are written and read by nobody.

**Readers (the decisions it serves).** All through `SpotValueTable` (`value`, `best`, `rankedIncome`,
`rankedSpotIds`, `cycle`, `production`, `huntShare`, `kitSurface`):
- Spot choice: `SpotEconomics.create` → `LevelingRoutes.scoreSpot` (worker leaf `BotRoute.choose`; hot
  `SpotService.findBestSpot`, AI-2; room filter in `SpotProfiles`). The row is cut by the live hunters on the spot
  (`huntShare` of the spawns' production) and scaled by the bot's own hunt samples, which win where they exist.
- Hour value (prices every trip, purchase and wish): `BotHuntEfficiency.huntIncome` / `huntHour` (own samples first,
  then the table), `EconomyContext.foundation`.
- Consumables: `ShotStock.usePolicy` and `ShotStock.blessedPays` (do shots / Blessed Spiritshots pay), potion use per hour
  (`foundation`), rest bottles `RestPotion.stockUse` over `SpotValueTable.cycle`, bag hours from `stacks` (town visit).
- Death price: deaths per kill into `EconomicValuation.deathHours`.
- Market and gear: `FirstPrice` (first board price from the hour it takes to farm an item), `EquipmentIncomeRoute`.
- Parties: `PartyIncomeComparison`, `CraftMaterialParty` (forecast known).
- Money is not from the table: adena and loot of a kill come live from the NPC reward groups at the bot's level and
  the server's rates (`SpotRewardExpectation.value`, over the row's `mix` and the live spot's species of the period).

**Cost.** Loaded lazily on each thread at its first lookup (not at boot): read 45 ms + `JSON.parse` 260 ms and ~100 MB
of transient heap on this laptop (measured 2026-11-03), then `packRows` packs rows into typed arrays outside the JS heap:
~36 MB per thread (numbers 17.9 MB Float64, 3 of their 23 columns NaN placeholders; gates 6.2, gate shares 6.2, mix
6.0). Two copies: main and the cold worker each read the file; the table does not cross `ColdTableChannel` (only the
spot catalogue does, `catalog_page`). Caches per thread: value memo ≤ 32768 rows (3.4 MB slab), income bases ≤ 524288
cells (~19 MiB), shortlists 128, spot caches 8192 (limits.md "Bot tables"). Per lookup: `value` memo hit = one Map
read by an integer key + one 13-field object; a miss adds the curve interpolation, gate, production and a reward read.
`best` scans every spot once per (line, level, shots, metric). Everything is keyed by line and level, not by bot: the
cost grows with distinct (line, level) pairs, not with the population. `rankedSpotIds` re-sorts its basis on every call.

**Unread.** Row `adena` and `loot` (money is live, above), curve `adena`, spot column 4 (always 1), and the kit surface:
`SpotValueTable.kitSurface` is called only by `HuntCycle.reader`, which nothing in `src/` calls (tests and scripts do).
The generator still pools loot (`poolRowLoot`), prices loot per kill and runs ~32k one-hour kit hunts (~60 % of the
curves phase) for them. The loader keeps branches for older table shapes (no `roleLines`, `gate`, `gateShare`, cycle
columns, `mix`, `stacks`; `spot[3] * spot[4]`) and the generator a `mergeStacks` path; none applies to the committed table.

## Reward catalogue (`data/Bots/spot-reward-npcs.json`)

The spawn catalogue's species per spot, for a reader without a live catalogue. At runtime `SpotValueTable.rewardSpot`
prefers the thread's live catalogue (`useSpots`: `SpotProfiles` on main, the worker's `planningSpots`); the file is
read lazily only for a spot id the live catalogue lacks (tests, offline tools). The hunt tables read it as their mob
and spot list. Written by the spot table's merge phase from the spots it measured — a `probe` run writes 12 spots.
No header, so a stale or probe copy cannot be told apart.

## Hunt tables (`data/Bots/hunt/`)

`node scripts/hunt-tables/build.js --tables=all`, in order; each file `{ header: { revision, fingerprints, inputs,
counts, buildSeconds }, ... }`. The model: a bot's strength = class base card + henna + worn items, a mob hour by
formula (`HuntModel.mobHour`), corrected against the real cold hunt. Built for "kit and party tables" (T128, cited
design doc `docs/game-decisions.md` is missing).

| Table | Holds | Built from (real code it calls) |
|---|---|---|
| `mobs` | 1289 spot mobs: combat card (1154 distinct), exp, SP, danger (magic / ranged / physical), drop and spoil groups | `ColdCombatProfile` npc stats, `NpcSkills` threat, DataCache rewards; mob list from `data/Bots/spot-reward-npcs.json` |
| `spots` | 1603 spot cards: levels, density, mobs with count and pull, nearest town, centre | the spot table's catalogue (`buildCatalogue`, geodata), `TownRespawn` |
| `classes` | 65 class keys (a split-kit first class once per future line, `7>9`) × 78 levels: naked numbers, regen, passives, allowed weapon / armour | `ColdCombatProfile.profileFor`, `ColdRest`, `BotEquipmentCompatibility`, `HennaRules` |
| `gear` | 781 items, per class the per-slot ladders without dominated pieces (12004 rows), weapon and armour tiers per grade | `GearAcquisitionPlanner.suitable`, `C4ArmorSets`, `ItemAcquisitionCatalog` |
| `sources` | 1822 items → NPC shops, luxury shop, drops, spoils, recipes | `NpcShopBuyLists`, `BotLuxuryExchange`, `C4RecipeItems`, `itemDropYield` |
| `henna` | 180 symbols, deltas, fee and dye price; class slots and symbols | `data/Henna`, `HennaRules`, shop offers |
| `rotation` | per class key × 2-level band: damage per P.Atk / sqrt(M.Atk), MP use, shot and area multipliers, opening burst | `BackgroundResolver.resolveFight` against a dummy, 6822 fights, ~1 min |
| `corrections` | formula vs real hunt multipliers per rotation kind × danger (kph, deaths), with the 1488-run sample | the spot generator's `hunt` (`resolveSolo`), 0.5 h each, 744 h, ~1 min |
| `ceilings` | per class × band × armour tier × weapon tier × danger: the highest mob level the kit takes (death chance < 0.5) | formula + corrections, binary search, ~6 min |

Readers: `scripts/generate-spot-table.js` (`data/Bots/hunt/gear.json` → kit points of the kit surface), `scripts/fight-table`,
`scripts/hunt-tables/verify.js` (against a world snapshot), 4 tests. Nothing in `src/`.

## Fight table and checks (offline)

`scripts/fight-table/build.js` / `path.js` (T128): per class line, offence points × mob (fight seconds with / without
shots, dry), defence points × mob (damage per action, spread), M.Def points; kits along a player's path. Gzipped JSON
to `tmp/fight-table`; read by `report.py`, `spot_index.py`, `steps.py` and `test_fight_table_points`. Not in CI, not
committed. `scripts/hunt-cycle-check.js`: `HuntCycle` against the generator's hunts on sample kits.

## Rebuild

- CI: `git push fork HEAD:refs/heads/tables/<what>/$sha` (CLAUDE.md "CI on the fork"); `what` = `all` (spot + hunt),
  `spot`, `hunt`, `probe`. Spot: 12 `spot-rows` shards → 12 `spot-curves` shards → `spot-merge` (each ≤ 150 min, 4
  children each); hunt: one job (≤ 240 min), in parallel with the spot jobs. Last `all` (81e247159): 24 min wall; a
  `hunt` run ~11 min. Laptop: hours, do not.
- Artifacts: `spot-table` (`data/Bots/spot-table.json` + `data/Bots/spot-reward-npcs.json`) and `hunt-tables` (the 9 files):
  `gh run download <run-id> -R posukhoff/L2Solo`, copy into `data/Bots/` and `data/Bots/hunt/`, commit "Rebuild the
  spot and hunt tables on <sha>" with the run id (be97733e). Tests that pin table numbers may move with it.
- `probe`: 12 spots, 0.25 h rows and curves, spot jobs only. For comparing a run on CI with the same run elsewhere
  (determinism, timing). Never copy its artifacts into `data/`: the server would warn 1591 of 1603 spots missing and
  value only 12, and the next hunt build would read a 12-spot reward catalogue.
- One `all` run reads the committed tables as inputs: the kit surface reads the old `data/Bots/hunt/gear.json`; hunt `mobs`/`spots`
  read the old `data/Bots/spot-reward-npcs.json`. After a catalogue or gear change, a second run is needed for them to agree.

**When to rebuild** (a change author applies this; changes only in a reader need none):

| A change in | Rebuild |
|---|---|
| Cold solo combat and what it calls: `Bot/Population/{BackgroundResolver,ColdCombatProfile,ColdMobAction,ColdRest,ColdKillRewards,ColdClassPolicy,ColdSummonProfile,ColdPveEncounter,SurvivalFloor,ColdTrip}`, `Combat/*`, `Formulas.js`, `Skills/*`, `Effects/*`, `Npc/{NpcCombatChoice,NpcHate,NpcSkills,NpcTraits}`, `Items/*` (enchant, sets, SA), `Progression/*`, `ProgressionRates.js` (deep-blue gap) | `spot` + `hunt` |
| The reference bot and its supplies: `Bot/AI/{BotGear,BotRoles,BotTargetMatchup,BotHuntingTargetPolicy,RestPolicy,RestPotion,HealingPotionStock,SoloSelfHeal,PetHealRule,PetTankRule,BotPullEstimate,GearGradeRule,DangerRule,HuntCycle}`, `Inventory/ShotStock.js` (`planForState`), `Bot/Economy/TownVisitInterval.js`, `ClassProgression.js` | `spot` + `hunt` |
| Spot catalogue: `World/Generics/SpawnNpcs.js`, `Bot/AI/{SpotService,SpotIndex}`, `Bot/Population/SpotProfiles.js`, spawns in `data/Npcs`, `scripts/geodata-release.json` | `all` (twice if the reward catalogue moves: hunt reads the old one) |
| Game data: `data/Npcs` (stats, exp, skills), `data/Items`, `data/Skills`, `data/Templates` | `all`. A drop-table-only change moves money without a rebuild (read live), but stacks need one |
| Gear ladders: `GearAcquisitionPlanner.suitable`, `BotEquipmentCompatibility`, `ItemAcquisitionCatalog`, `NpcShopBuyLists`, `data/Recipes`, `data/Henna` | `hunt` (then `spot` for the kit surface) |
| The generators (`scripts/generate-spot-table.js`, `scripts/hunt-tables/*`) | the table they write |
| Readers only: `SpotValueTable`, `SpotEconomics`, `SpotRewardExpectation`, `BotHuntEfficiency`, server rates | none |

## Assessment

**Spot table — keep; simplify; add a staleness check.**
- Serves: spot choice, the value of a bot's hour (every trip, purchase and wish is priced by it), shots / potions /
  bag decisions, death price, first board prices, party-vs-solo.
- Buys: performance above all. One ranking reads 300-600 spots for a line and level; simulating 2 h on each per decision
  is out of reach (the table is 247k simulated hours on 12 CI machines). Also determinism (seeded, same answer on
  every thread and every start) and one answer shared by every bot of a line and level. Trades realism for it.
- Accuracy lost: one reference bot of the line, alone, in the author's kit, at spot level +6 (curves from ≤ 3 spots
  give other levels); no party buffs, players, PvP or karma; walking by a density formula, not paths; no unload trips;
  a mix of at most 8 species. Corrected at read: crowding (live hunters share the spawns' production), money (live NPC
  reward groups and rates), the period's species, the bot's own samples once it hunted a spot. Not corrected: the gear
  the bot really wears (the kit surface meant to do it is read by nothing), market prices of loot (NPC values).
- Staleness is silent after a combat change: bots keep choosing by the old fight until someone rebuilds.
- For 5-10k bots: lookups do not grow with bots (keyed by line and level); rebuild time grows with spots × lines, not
  bots. What grows: a copy per thread (~36 MB packed + ~100 MB transient at parse) if the cold simulation is split over
  several workers. A Rust rewrite either ports the generator or keeps tables that encode the JS combat; the same seed
  giving the same table is then a free parity check of the port.
- Improvements, value vs cost: staleness fingerprint of the exercised src paths, checked by `npm run check` and at the
  first read (high value, small); drop unread columns and the compat branches (small value, small); Float32 without
  placeholder columns, one copy shared across threads (`SharedArrayBuffer`) or a binary pack instead of JSON (mid
  value now, high at 5-10k, mid cost); decide the kit surface (TBL-2).

**Reward catalogue — keep, or merge into the spot table.** Small, read live only as a fallback. Give it a header
(revision, spot count) or write its rows inside the spot table; low value, low cost.

**Hunt tables — decide: wire in or stop rebuilding.** Serve no runtime decision today. Meant for gear progression
(which kit takes which mobs, `ceilings`; what each piece adds, `rotation` + `classes` + `gear`) by a formula instead of
one reference kit per line. Cost now: ~11 min CI per `all` (parallel, little wall time), 2.4 MB of committed churn
per rebuild, 4 tests, and second copies of the catalogue, mob and henna data. Keeping them current costs little; their
value comes only when a runtime decision reads them, which is a large plan (replace the reference-kit scaling, then
the kit surface). Until then: `tables/hunt` on demand, not in `all`, and the spot table's kit points off.

**Fight table — offline research; keep out of `data/`.** No runtime reader; rebuild only when studying the model.

## Open questions

1. Kit surface and hunt tables: wire the hunt model into gear decisions (which plan?), or stop building them by
   default and drop `HuntCycle.reader`?
2. Is "never value a spot more than 9 levels below the bot" (deep-blue cut in `SpotValueTable` `combat`) the stated
   design? It is ours (user 10-29), not C4.
3. Where should a staleness fingerprint fail: `npm run check` (author), the first read (log), or both?
