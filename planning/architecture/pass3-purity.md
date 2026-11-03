# Third pass: rules that are not pure or not deterministic (2026-11-03, t106dev @ be5c09f7)

Checked at 5771494a (2026-11-03).

Goal (CLAUDE.md): rules are pure functions of plain data, deterministic, owned once — hot and cold agree, a Rust port
is mechanical. **Good already:** HitRules, Formulas, ProgressionRates, BackgroundDropResolver, ColdKillRewards,
NpcCombatChoice, ColdMobAction, PartyAgreement.allocate take an `rng`; the kernel passes a seeded one
(`deterministicRandom(state)`) at all four resolve sites; worker economy/competition uses `TendencyRoll`.

## Top fixes

| # | Fix | Why | Size |
|---|---|---|---|
| R1 | Hot revenge / mob competition / PvP defense / conflict participation (BotRevenge, BotMobCompetition, BotPvpDefense, BotConflictParticipation) roll with the cold `TendencyRoll` key + bucketed time | **hot/cold drift**: cold said "no" to a pair, hot re-rolls "yes" right after activation | M |
| R2 | Party cohesion, risk, first `nextResolveAt` (PopulationService.createBackgroundParty ~938) seeded by partyId | cohesion scales party fight windows and income: same roster, different yield | S |
| R3 | `BotTargetMatchup.profileBonus`, `ColdCombatProfile.attackReach/profileReach`: take `at`, key caches by it | `Date.now()` in a cache keyed only by profile: cold mob choice and fights per round follow wall time | S |
| R4 | Craft success: one seeded roll in `CraftProfitPolicy.succeeds` for ColdCraftingService, CraftWorkshopService, ManufactureShop, RecipeCrafting | unseeded; a requeued cold retry re-rolls | S |
| R5 | `ColdSimulationKernel.lifecycleKind` reads `this.now`/step time, not `Date.now()` (`mammonRetryAt`) | fake-clock tests route differently | S |
| R6 | Worker economy/occupation/meeting/competition timestamps → step timestamp (Worker ~795, ~852, ~2004, ~2111) | decisions stamped with wall time | S |
| R7 | PriceBelief/PriceDecision get a counters view in `ctx` (not MarketCounters module maps + worker mirror) | main and worker price from different rows while the mirror lags | M |
| R8 | `SpotProfiles.spotHunters` takes hunters in (not the `useOccupancy` per-thread switch) | hot and cold see different crowds | M |
| R9 | Cold-entry `nextResolveAt` jitter (BotLifeState.writeColdRow ~2150, upsertState ~3773) seeded | it is part of the kernel's seed: first cold step not reproducible | S |
| R10 | Replace kernel `deterministicRandom` (a copy of `TendencyRoll.seeded`) with TendencyRoll; later per-decision keys | parallel mechanism; one stream per step, a new `rng()` call shifts every later roll | M-L |
| R11 | Make `timestamp` required in shared rules (BackgroundResolver, ColdCombatProfile, EconomyContext, WishProviders, PartyGoalPolicy); `HitRules.melee` defaults `spreadRng` to `rng` | 445 `= Date.now()` defaults + 99 `\|\| Date.now()`; a forgotten argument reads the wall clock; `spreadRng` missing falls back to `Math.random` | M |
| R12 | Hot party loot through `PartyAgreement.allocate` (PartyCompanionService.randomMember is a second implementation); seed clan-party drops (ClanActionService ~528) | two loot rules; unseeded drops | M |

## Other findings

- `Math.random` (minor): `PartyAgreement.propose` first call unseeded (PopulationService ~951); `resolveSolo` without
  rng in BackgroundPartyResolver ~138, PopulationService ~118, ColdVisit ~93; PkProfiles.materializeBots; SpawnNpcs
  swaps the **global** `Math.random` around `random-point-in-shape` (~97, ~113).
- Clock: `GameTime.isNight` uses host timezone (`setHours`) — CI, laptop and a Rust port can disagree;
  `Uptime.SERVER_STARTED_AT` per thread drives MarketCounters decay; OpportunisticRaidPolicy.attack ~385;
  DecisionSections.stateView passes a misleading `Date.now()`; PetRules, ClanAllianceService timers.
- Hidden lookups in rules: PartyAdmission defaults reach BotLifeState/World; PartyHuntingTarget `stateOf` default =
  main cache; PersonaPartyPolicy/PartyGoalPolicy → BotPersona.of (missing persona → `accept: 'no_persona'`, threads can
  disagree); BotPersona.ensure depends on creation order; DeathExperience mixes the pure rule with DB I/O;
  BuffServicePolicy, PartyArcherCombatPolicy, PartyCombatLootPolicy read World/LifeState; ColdKarmaPolicy imports
  SpotService in worker code (works, breaks the rule).
- Module state: ColdCombatProfile attackerView/defenderView cached regardless of time (party/raid targets may keep
  stale buffs — guess); per-thread switches `EconomyContext.configure`, `ShotMarketIndex.configure`,
  `SpotValueTable.useSpots`, `MarketCounters.useSpots/useTable`, `RecomputeGeneration.configure` mirror main into the
  worker and can drift.
- Input mutation: `ColdEconomyDecision.advisory` writes `state.stats.wishAdvisory`; `SpotRiskPolicy.marksInSteps`,
  `PartySpotRiskPolicy.marksInSteps` (one-time migration); HotActorLodPolicy, TownTransitPolicy write session state.

Harmless randomness (cosmetic chat, wander, tick jitter, ids) and live hot combat rolls (Attack, Npc, SummonControl,
CubicControl, EffectRestrictions, C4WeaponSA: C4 live behaviour, only untestable) are left as they are.
