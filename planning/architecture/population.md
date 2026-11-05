# Population, hot/cold, cold worker

Checked at 39e43408 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `Bot/Population`, `Bot/Travel`, `BotManager`, `BotSession`, worker protocol.

## Mechanisms

| Mechanism | What | Entry |
|---|---|---|
| `BotManager` | Hot sessions: spawn actors, chat, status | `init`, `loadAndSpawnBot` |
| `BotSession` | Fake socket of a hot bot | — |
| `PopulationService` | Main owner of the population: coordinator start, hot/cold phase policy, parties, seeding, DB maintenance (state retention, WAL truncate: governor-admitted during play too, refusals in `Database.stats().maintenance`), and **worker lifecycle commands** (town work that needs World/DB) | `start`, `tickPhasePolicy`, `executeWorkerLifecycleCommand` |
| `BotLifeState` (4.2k lines) | Main cache and DB writer of the cold row — **the cold truth**; `prepareResolve` also runs in the worker; at boot rebuilds rows left hot by a restart from the character record (`recoverStaleHotStates` → `staleHotRowFromRecord`, one transaction `Database.recoverStaleHotLifeStates`) | `upsertState`, `markHot`, `markCold`/`writeColdRow` |
| `ColdSimulationCoordinator` | Main side of the worker: spawn, page snapshots/tables, commit proposals, commands, fences, watchdog, restart | `start` |
| `ColdSimulationWorker` | Worker entry; replaces `invoke` with a forbidden-module guard + stubs; holds `planLifecycle` and `projectResolve` inline | `handle` |
| `ColdSimulationKernel` | Worker scheduler: due heap, `lifecycleKind` (module function), `resolveStep` (+ solo hunt window `huntWindow` / `ColdSoloWindow`), `resolvePartyStep`, `proposal_batch`, stall recovery `recoverStalled`, per-bot fault backoff/quarantine `fault` | `tick` |
| `BackgroundResolver` / `BackgroundPartyResolver` | Pure cold fight/rest/travel round, solo / party; the spot table measures `resolveSolo` offline ([tables.md](tables.md): a change here needs a rebuild) | `resolveSolo`, `resolve` |
| `ColdSimulationProtocol` | Message whitelists, envelope validation; the one JSON byte count every page and message limit reads (`byteLength`: exact UTF-8 size of the JSON, counted without building it) | `validateEnvelope`, `byteLength` |
| `ColdTableChannel` / `TableMirror` | Versioned main → worker table replication (13 tables) | `TableChannel.register` |
| `ColdSimulationOwner` + `ColdCommitQueue` | Commit of worker proposals: CAS on `simulation.revision`; `handoffToMain` for activation | `flushBatch` |
| `HotActivation` / `Cooldown` | Solo cold → hot / hot → cold (both hand a party or PvP bot to the group lifecycles) | `activate`, `cooldown` |
| `HotPartyLifecycle` / `PvpEncounterLifecycle` | Same for a party / PvP group | `activate`, `cooldown` |
| `LifecycleSafetySweep` | Every 30 min: rows not covered by the worker get repaired | `startLifecycleSafetySweep` |
| Seeding | `GeneratedColdSeeder` + `PopulationSeedPlanner` | `scheduleGeneratedColdSeed` |
| `Travel/` | `TravelRoutes`, `TripPayment`, `ScrollStock` — shared by hot and cold, done right | — |
| `ColdTrip` | Cold trip time, honest: scroll cast, 5 s per hop, run at 120 u/s, walkers (a walker near a player leaves its trip in `HotActivation` at an endpoint of its run within the activation radius of the player, the arrival first, else the teleport point (`walkerAppearance`, on the resolver's arrival, read after the fence); neither in reach: it stays cold, `walker_endpoint_far`; refusals are counted by reason, `activationRefusals`); a traveller answers an invite | `townPlan`, `spotPlan`, `toSpot` |

## Lifecycle

1. Seed → `LifeState.upsertState` writes cold rows. Merchants are the only static bots.
2. Start: `LifeState.init` (NodeL2 `startServer`, before `AfkTrade.init`: the board migrations and the meeting
   marker rewrite and recovery write life rows into its cache; a stale hot copy there failed the init's repair saves),
   `BackgroundPartyState.init`, worker; pages `init` → `catalog_page` → `table_page` →
   `snapshot_page`; geodata shared through `workerData`.
3. Worker step: `lifecycleKind` → `resolver` | `command` | `party` | `party_member` | `event_driven` | `inactive`.
   Resolver: `planLifecycle` → `resolveSolo` (a hunting step always runs on round by round in `huntWindow`, each round
   projected by `prepareResolve`, until `ColdSoloWindow.endOf`, 32 rounds or a stalled clock; a kernel built without
   the worker's window readers, in tests of other rules, runs one round a step) → `projectResolve` →
   `prepareResolve` → `proposal_batch`.
4. Main commit: `handleProposalBatch` → `ColdCommitQueue` → `Owner.commitBatch` (DB CAS) → `afterCommit` (caches,
   economy decision, board, equipment, clan events, party; each a named `step`) → `commit_ack`; the bot's plan, buff and
   training run in the review command the worker sends on that ack.
5. Command: worker `command_request` with `precomputedResult` → `executeWorkerLifecycleCommand` →
   `resolveColdState` (shopping, crafting, market, halls, `GoalService.review`) → `command_ack`.
6. Cold → hot: `activateNearPlayers` (or invite, remote chat) → `fenceBot` (advisory) → `handoffToMain` (**the real
   guard**, DB revision CAS) → `loadAndSpawnBot({coldLifeState, …})` → `markHot`. A party / PvP group goes through
   its own `transition` (`Database.transitionBackgroundParty` / `transitionPvpEncounter`), POP-4. The perf tool's players
   (`HotCrowd`, real `Session`s, not `bot_*`) heat crowds by this same path; `tests/e2e/cold-hot-cold.js` checks it end to end.
7. Hot → cold: `cooldownEligibleHot` → `Cooldown.cooldown` (`canCooldown`) → `markCold`/`writeColdRow` →
   `transitionToColdState`: `upsertState({phase:'cold'})` → `acceptColdState`; worker refusal marks the bot hot again.

A far bot hears a change only at its player's moment (`Economy/Reaction`, places WORK/REST/VISIT/STAND), on every
thread: our rule, so a far bot does not re-decide on every event ([bot-ai.md](bot-ai.md)).

## Worker boundary

- **May run:** pure modules that get lookups as arguments, stubbed modules (`Database` proxy that rejects every call,
  EffectStore, ChargeLifecycle, BotRaidSafety, MarketOpportunity, NpcShopBuyLists, SummonControl, WorldAreaCatalog,
  TownRespawn, GameTime, WorldConstants), table mirrors.
- **May not:** `Database`, `GameServer/World/*`, `BotManager`, `Network`, `Server`, anything reaching the DB,
  `SpotService.findById`/`ensureIndexed`.
- **Guard gaps:** the guard only wraps `invoke()`; relative `require()` passes (used on purpose for
  `CharacterLocationRuntime`, `CharacterStateSources`); the `require.cache` scan runs once, so a lazy invoke throws only
  when reached. ~50 `isMainThread` uses in ~30 files choose behaviour per thread (EconomyContext 19, ClanSupplyPolicy,
  TableMirror, BotLifeState, PersonalWarehouseIndex, BotPersona, ColdEconomyDecision, ShotCraftPolicy, …).

## Canonical owners

| Rule | Owner |
|---|---|
| Cold row | `BotLifeState`, written only through the revision CAS (`ColdSimulationOwner`) |
| Who steps a cold bot | Worker kernel (main has no scheduler) |
| Step kind | `ColdSimulationKernel.lifecycleKind` |
| Solo / party round | `BackgroundResolver.resolveSolo` / `BackgroundPartyResolver.resolve` |
| Round → state | `BotLifeState.prepareResolve` |
| Cold → hot gate | `handoffToMain` (solo); party / PvP: their own DB `transition` (POP-4) |
| Main → worker data | `ColdTableChannel` (tables), `snapshot_page` (bots); clan social bypasses it (POP-9) |
| Spot route | `BotRoute` (the solo trip's kept route and spot verdicts live on the worker's kernel record) |
| When a far step asks the action plan after its round | `ColdEconomyPlan.edgesSince` over the facts of the bot's last action ask (`askAction`: bag amounts, money reached, shopping town, level, death, the craft MP band, own lines' fills): the step's own ask before the round, else the kernel record's `actionBaseline`, set when main commits the step that asked (`onCommitAck`, a lifecycle command's ack), so a dropped step asks again; a new worker compares against the step's start. Not in it, heard at the next edge or decision: the clock the plan reads directly, others' quotes, a mana bot's MP, an own line sold out. The hunt window's end reads `edges` between its rounds |
| A planner answer (workshop, route rows, action plan) kept for a bot | `ColdOccupationPlanner`, one job per bot per mode, held on the value of what the mode reads (`ColdSimulationWorker.plannerInputKey`: the route key for rows; the state's values but its commit stamps for the workshop; plus the step clock and economy for the action plans; the asked state object and the inputs asked beside it (warehouse and clan supply versions, escrow, recipes, whole copies, pending pages) for near, refresh and meeting, which read worker inputs beside the state) and its read board tokens; a new state that reads the same keeps it, in flight too (its publication names the new state); a workshop card serves 30 game min (`WORKSHOP_SERVE_MS`, limits.md) |
| Versions of a spot's inputs for held results (readers compare, nothing is dispatched) | crowd: `SpotOccupancyIndex.spotVersion` (moves when a bot joins or leaves the spot; this thread's: `SpotProfiles.spotVersion`); a holder's exclusions: `SpotRiskPolicy.exclusionVersion` (revision = the excluded set, untilStep = its first mark's end) |
| Travel route and fare | `Travel/TravelRoutes`, `TripPayment` |
| Cold trip time | `ColdTrip` |
| A throwing step or command: hold off, quarantine | `ColdSimulationKernel.fault`, one tracker per bot (per party run): backoff 1 s/5 s/30 s/2 min, quarantine 10 min after 5 faults in a row (`BotFaultHold`, the hot AI state's rule too: `BotAI` `stateFaulted`), first occurrence logged with the stack, `botFaults=` on the health line (limits.md); a command's DB error is no bot fault (`commandDbErrors`) |
| Failure counts (status line, perf report, e2e players) | `ColdSimulationCoordinator.failureSnapshot` (one record: worker faults by stage, backoff/quarantine, protocol faults, `commandDbErrors`, `swallowed` = main's and the worker's `FailureLog` counts by site, the worker's from its heartbeat `failures.swallowed`); afterCommit errors in `ColdCommitQueue` `failures`. A post-commit step (`step`/`timedStep`) that throws is skipped: a refusal code is logged with the bot, any other throw counts as `cold.postcommit.<step>`; a throw outside a step as `cold.after_commit` (and `afterCommitErrors` for the perf report and e2e); a row merge throw as `cold.owner_row_merge`; `BotRoute` search throws as `route.*` (a bot that never travels is no longer read as "no spot"); a command request the worker built wrong as `cold.request_dropped:<why>` (still no ack) |
| A wait for an event | no step until a writer changes the row: `lifecycleKind` `event_driven` (meeting, craft shop, held clan wait: the change that ends it steps it at once, `ColdSimulationKernel.upsert`), or the wait's known end as its due (raid supply, a raid roster's native activation, a parked supply errand); the wait is lived, not hunted (`stats.eventWait` set by `prepareResolve` from `result.eventWait`, read by `ColdSoloWindow.livedClock`, solo and party) |
| Boot recovery of a stale hot row | `BotLifeState.staleHotRowFromRecord` (the record wins, PER-7) |
| Transition cost (cold ↔ hot time per bot) | `PopulationMetrics.recordActivation`/`recordCooldown` (`transitions` in the summary) |

## Debt

- **POP-4 three hot/cold transition implementations** (solo `HotActivation`/`Cooldown`, party `HotPartyLifecycle`,
  PvP `PvpEncounterLifecycle`), each with its own fence, CAS, spawn, restore. Unification: a solo bot is a group of 1.
- **POP-5 hot → cold row builder has three branches** in `writeColdRow`; the fallback writes
  `Database.updateCharacter*` directly, bypassing `upsertState`. `BotSupplyErrand` calls `markCold` outside `Cooldown`,
  with no `acceptColdState` (its failure is counted, `population.mark_cold`). Its return (`BotTownTravel.returnSupplyHot`)
  writes the row hot before the AI runs; while that write fails it keeps the bot parked
  (limits.md "Supply errand return"), and `Cooldown.canCooldown` refuses a returning bot.
- **POP-6 cold rules also run on main.** `PopulationService.resolveColdState` / `resolveColdEntryBranch`: karma
  (`ColdKarmaPolicy` + `resolveSolo`) duplicates the worker's `planLifecycle` (and is hardly reached: `lifecycleKind`
  sends a karma bot to the resolver before any command); `precomputedResult || resolveSolo(...)` fallbacks (raid-supply
  hold, the main round, `resolveColdTransition`) are unreachable in game (`executeWorkerLifecycleCommand` refuses without `precomputedResult`), only tests
  call `resolveColdState` without it; `walkerAppearance` resolves on main.
- **POP-7 monkey-patched resolvers.** `BackgroundResolver.js` end and `BackgroundPartyResolver.js` (wrapped twice)
  reassign exports to add competition wait and encounter cleanup. Belongs inside the resolver.
- **POP-8 worker stubs re-implement rules.** EffectStore stub `DEBUFF_RESERVED_SLOTS: 4` vs real 10;
  `BotRaidSafety`, `MarketOpportunity.bestOffer` re-implemented.
- **POP-9 clan social bypasses `ColdTableChannel`** (`Clan/ClanSocialRuntime` posts `clan_social_page` directly).
- **POP-10 cold trip time gaps.** `ColdTrip.FALLBACK_TRIP_MS` (25 s) stands in for a town trip or a party route whose
  time comes out 0 (the kernel's party record then waits 25 s while its members, with no shared time, arrive in 1 s);
  `ColdTrip.runMs` ignores Z, so a surface/dungeon position repair is a 1 s trip; a solo route's `travelMs` (BotRoute)
  is computed but not read.
- **POP-11 many party-formation entries:** `formBackgroundParties` (main, "legacy projection"),
  `formProtectedRequiredParty` (worker or main), clan war, competition, recruit, CraftMaterialParty, ClanPartyHelp,
  OpportunisticRaidDirector. Main's `runPartyAssemblyEvent` picks between the first two. Canonical unclear.
- **POP-17 dormant feature: PK-encounter bots.** Nothing creates a bot with plan `pk_hunting` since 2026-07-23
  (only `test_pk_profiles` calls `PkProfiles.materializeBots`); `AI/PkProfiles`, `States/PkHuntingState`,
  `PkFleeingState`, `BotPkLock` and ~36 `pk_hunting` checks in 25 files remain (`lifecycleKind`, `canCooldown`,
  `cooldownEligibleHot`, `HotActivation`, …). **Decided 2026-11-03: delete the scripted PK role entirely**; not carried
  out yet. PK from PvP karma (`Karma`, `PvpRules`, `ColdPvpResolver`, `ColdKarmaPolicy`, `PkDropPolicy`) stays.
- **POP-13 small copies.** `SIMPLE_ACTIVITIES` three times (Kernel, Owner, `Database.SIMPLE_COLD_ACTIVITIES` with
  `coldSimulationPartition` mirroring `Owner.eligibility`); karma test in `lifecycleKind` and `ColdKarmaPolicy.active`;
  cooldown eligibility filtered twice (`cooldownEligibleHot` repeats merchant/PK/companion tests of `canCooldown`).
- **POP-14 legacy migration.** `migrateLegacyClassProgression` (timer while `pendingClassProgressionMigration`).
  `LEGACY_PLAN_STRATEGIES` is no migration: see POP-20.
- **POP-15 backstops that may hide ownership bugs:** `LifecycleSafetySweep`, `reconcileOrphanedBackgroundParties`,
  kernel `recoverStalled`. Their repair counters are the signal.
- **POP-16 the cold decision lives inline** in `ColdSimulationWorker` (`planLifecycle`/`projectResolve`/`soloWindow`,
  ~350 lines of closures), while main also calls `GoalService.review` in commands.
- **POP-19 not pinned:** the hunt window's `round_cap` / `stalled` guards (limits.md "Solo hunt window") have no test
  case (checked: no test names them).
- **POP-20 `ColdSimulationOwner.eligibility` mostly dead in game.** Every proposal (kernel solo,
  party and raid steps, `ColdCompetitionActions`, `ColdPartyConflict`, `ColdCompetitionRetreat`) passes
  `allowLifecycle: true`, which returns before the solo checks (`SIMPLE_ACTIVITIES`, warehouse, mammon, errand claim,
  `LEGACY_PLAN_STRATEGIES` market/craft plan, travel reason). Only tests reach them.
- **POP-21 static merchants are hot without a session** for ~5 s after boot (until `BotManager.init` spawns them).
  The 46 static merchants and service bots stay hot all the time (a store must be an actor in the World to be seen
  and clicked); `MerchantState.tick` is empty, the cost is the actor's own timers and sweeps. Decided 2026-11-03:
  keep them hot until a perf run measures that cost.
- **POP-22 a hot row is not kept current during the session** (main item moves skip non-cold rows); boot rebuilds it
  from the record (`staleHotRowFromRecord`). Not rebuilt at boot: `stats.classId` / `classProgression*` after a class
  change while hot, `stats.pk`, PvP/encounter memory, captured cold-combat base stats/effects/cooldowns.

- **POP-23 cold worker capacity** (measured 2026-11-04, 1731-bot x50 world, avg level 25, 2015 laptop, detached
  checkouts): before this release the worker was saturated from ~1430 bots (busy 0.93 at 1431, 1.00 from ~1580,
  163-252 far bots overdue up to 67 s). After (c9712816): busy 0.57-0.62 cold / 0.61 hot, overdue max 1-4, worker
  long turns −52-58 %, process cores 1.88 → 1.27-1.42. A server with no code identity (every launcher install before
  c3fdb8c3) rebuilt every held build and ran the worker at 0.93 on the same world. Growth while seeding: about +6
  points of worker and +2.5 of main per 100 bots; worker heap ~0.08 MB per bot. 5-10k bots still need the cold
  simulation split over several workers (per-thread table copies, TBL-7).
- **POP-24 the hot/cold phase policy is a 10 s scan** (`PopulationService.tickPhasePolicy`, limits.md "Activations"):
  per player the 100 nearest cold rows, ≤ 24 floor LOS, the walker list, then every hot bot's distance to the
  players. It stands in for events that exist only in part: a player's cell change and login (`World`), a cold commit
  near a player (`LifeStateCache` publications), a walker's place on its run (`travel.run` times); and for some that
  do not: a hot bot walking out of the cooldown radius, the cooldown grace ending, a refused activation or cooldown
  becoming possible. A missed one leaves a bot hot or cold until the next scan, and the scan is also the activation
  pace (6 per 10 s). Measured 2026-11-04 hot run (2 players, ~120 hot): 0.003 % of main, so kept until it shows.

- **POP-24 step polls standing in for events** (limits.md "Wait polls"). Missing events: a board fill for a shopping
  bot (buyer wakes cover hunting/party_wait only), so the raid supply purchase and the town command retry; the
  planner's sale or spot choice for survival unload and a refused ground (their inputs crowd/risk have no versions,
  decision-links plan step 3); main's refusal of a posted occupation plan (the review completion could wake it; one
  step either way, latency only); a member's arrival or join moving its leader's due (party assembling), whose
  timeout counts poll attempts and must become time-based first. A restart releases no orphaned cold supply errand
  (its hot session is gone; the row waits for its downtime-shifted deadline).

## Open questions

1. One mechanism for solo, party and PvP transitions? Which DB primitive stays?
2. Which cold resolves on main are allowed (karma, raid-supply hold, walker appearance)? Remove the fallbacks?
3. `LifecycleSafetySweep`: permanent, or a backstop until ownership is proven?
4. Canonical entry for ordinary background parties: main `formBackgroundParties` or the worker proposal?
5. Is the class-progression migration done in every live DB?
