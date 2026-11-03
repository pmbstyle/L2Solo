# Population, hot/cold, cold worker

Checked at 5771494a (2026-11-03).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `Bot/Population`, `Bot/Travel`, `BotManager`, `BotSession`, worker protocol.

## Mechanisms

| Mechanism | What | Entry |
|---|---|---|
| `BotManager` | Hot sessions: spawn actors, chat, status | `init`, `loadAndSpawnBot` |
| `BotSession` | Fake socket of a hot bot | — |
| `PopulationService` | Main owner of the population: coordinator start, hot/cold phase policy, parties, seeding, and **worker lifecycle commands** (town work that needs World/DB) | `start`, `tickPhasePolicy`, `executeWorkerLifecycleCommand` |
| `BotLifeState` (4.2k lines) | Main cache and DB writer of the cold row — **the cold truth**; `prepareResolve` also runs in the worker; at boot rebuilds rows left hot by a restart from the character record (`recoverStaleHotStates` → `staleHotRowFromRecord`, one transaction `Database.recoverStaleHotLifeStates`) | `upsertState`, `markHot`, `markCold`/`writeColdRow` |
| `ColdSimulationCoordinator` | Main side of the worker: spawn, page snapshots/tables, commit proposals, commands, fences, watchdog, restart | `start` |
| `ColdSimulationWorker` | Worker entry; replaces `invoke` with a forbidden-module guard + stubs; holds `planLifecycle` and `projectResolve` inline | `handle` |
| `ColdSimulationKernel` | Worker scheduler: due heap, `lifecycleKind` (module function), `resolveStep` (+ solo hunt window `huntWindow` / `ColdSoloWindow`), `resolvePartyStep`, `proposal_batch`, stall recovery `recoverStalled`, per-bot fault backoff/quarantine `fault` | `tick` |
| `BackgroundResolver` / `BackgroundPartyResolver` | Pure cold fight/rest/travel round, solo / party; the spot table measures `resolveSolo` offline ([tables.md](tables.md): a change here needs a rebuild) | `resolveSolo`, `resolve` |
| `ColdSimulationProtocol` | Message whitelists, envelope validation | `validateEnvelope` |
| `ColdTableChannel` / `TableMirror` | Versioned main → worker table replication (13 tables) | `TableChannel.register` |
| `ColdSimulationOwner` + `ColdCommitQueue` | Commit of worker proposals: CAS on `simulation.revision`; `handoffToMain` for activation | `flushBatch` |
| `HotActivation` / `Cooldown` | Solo cold → hot / hot → cold (both hand a party or PvP bot to the group lifecycles) | `activate`, `cooldown` |
| `HotPartyLifecycle` / `PvpEncounterLifecycle` | Same for a party / PvP group | `activate`, `cooldown` |
| `LifecycleSafetySweep` | Every 30 min: rows not covered by the worker get repaired | `startLifecycleSafetySweep` |
| Seeding | `GeneratedColdSeeder` + `PopulationSeedPlanner` | `scheduleGeneratedColdSeed` |
| `Travel/` | `TravelRoutes`, `TripPayment`, `ScrollStock` — shared by hot and cold, done right | — |
| `ColdTrip` | Cold trip time, honest: scroll cast, 5 s per hop, run at 120 u/s, walkers; a traveller answers an invite | `townPlan`, `spotPlan`, `toSpot` |

## Lifecycle

1. Seed → `LifeState.upsertState` writes cold rows. Merchants are the only static bots.
2. Start: `LifeState.init`, `BackgroundPartyState.init`, worker; pages `init` → `catalog_page` → `table_page` →
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
| Spot route | `BotRoute` |
| Travel route and fare | `Travel/TravelRoutes`, `TripPayment` |
| Cold trip time | `ColdTrip` |
| A throwing step or command: hold off, quarantine | `ColdSimulationKernel.fault`, one tracker per bot (per party run): backoff 1 s/5 s/30 s/2 min, quarantine 10 min after 5 faults in a row, first occurrence logged with the stack, `botFaults=` on the health line (`FAULT_*`, limits.md); a command's DB error is no bot fault (`commandDbErrors`) |
| Failure counts (status line, perf report, e2e players) | `ColdSimulationCoordinator.failureSnapshot` (one record: worker faults by stage, backoff/quarantine, protocol faults, `commandDbErrors`); afterCommit errors in `ColdCommitQueue` `failures` |
| Boot recovery of a stale hot row | `BotLifeState.staleHotRowFromRecord` (the record wins, PER-7) |
| Transition cost (cold ↔ hot time per bot) | `PopulationMetrics.recordActivation`/`recordCooldown` (`transitions` in the summary) |

## Debt

- **POP-2 `afterCommit` errors partly invisible.** Each named step of the coordinator's `afterCommit`
  (`step`/`timedStep`) catches, logs `postcommit <step> failed` and counts `afterCommitStepErrors` (diagnostics only).
  A throw outside a step (the diagnostics publish, the cache reads between steps) reaches `ColdCommitQueue.flushBatch`:
  it is counted always (`failures.afterCommitErrors`, last reason kept; read by the perf report and the e2e scripts),
  not logged and not on the status line.
- **POP-3 silent null routes.** `BotRoute.js` wraps `SpotService.findCurrentSpot`/`arrivalPointForState` in
  `catch → null` — exactly the worker-boundary trap.
- **POP-4 three hot/cold transition implementations** (solo `HotActivation`/`Cooldown`, party `HotPartyLifecycle`,
  PvP `PvpEncounterLifecycle`), each with its own fence, CAS, spawn, restore. Unification: a solo bot is a group of 1.
- **POP-5 hot → cold row builder has three branches** in `writeColdRow`; the fallback writes
  `Database.updateCharacter*` directly, bypassing `upsertState`. `BotSupplyErrand` calls `markCold` outside `Cooldown`,
  with no `acceptColdState` and `.catch(() => {})`.
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
  keep them hot until a perf run measures that cost (roadmap R2).
- **POP-22 a hot row is not kept current during the session** (main item moves skip non-cold rows); boot rebuilds it
  from the record (`staleHotRowFromRecord`). Not rebuilt at boot: `stats.classId` / `classProgression*` after a class
  change while hot, `stats.pk`, PvP/encounter memory, captured cold-combat base stats/effects/cooldowns.

## Open questions

1. One mechanism for solo, party and PvP transitions? Which DB primitive stays?
2. Which cold resolves on main are allowed (karma, raid-supply hold, walker appearance)? Remove the fallbacks?
3. `LifecycleSafetySweep`: permanent, or a backstop until ownership is proven?
4. Canonical entry for ordinary background parties: main `formBackgroundParties` or the worker proposal?
5. Is the class-progression migration done in every live DB?
