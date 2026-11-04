# Third pass: per-step cost hotspots (2026-11-03, t106dev @ be5c09f7, static read + small probes)

Checked at 39e43408 (2026-11-04).

H = hot bots near players (100-300 in a crowd). Cold commits ~25/s idle (limits.md). "est." = reasoned, not measured.
Measured: 22,348 NPC spawns; NPCs in a 3×3 grid window median 100, max 749; `EffectStore.list` with 25 effects
8.3 µs; a `bot_life_state` row ≈ statsJson 6.4 KB + mindJson 1 KB + inventorySummary 2.9 KB. Confirm #2-#4 with a
hot-crowd perf run before fixing.

| # | Where | How often × size | Why costly | Same behaviour, cheaper | 1700 / 10k |
|---|---|---|---|---|---|
| C1 | Cold commit: `ColdSimulationOwner.commitBatch` → `persistencePatch` + `SavedStats.statsColumns`; `Database.writeColdCommitUnsafe`; triggers `bot_party_candidate_stats/_metadata` | every cold commit × ~10 KB | main stringifies whole stats/mind/inventory even when only clock/vitals changed; SQLite json_patch + json_extract + 7 trigger json_extracts; rewrites ~10 KB row (~12-16 KB WAL, est. ~1.2 GB/h) — the WAL growth | send changed top-level stats keys (`json_set` per key, as `writeHeldOnRevision`); skip inventorySummary when `bagChanged === false`; later move per-step fields out of statsJson | Med / **High** |
| C2 | `Actor.statusUpdateVitals(self)` → full `calculateStats` | every hit received, cast, 3 s regen per hot actor | ~55 EffectStats calls + 6 `EffectStore.list` (8.3 µs each), skills spread, passives walk; est. ≥ 0.5 ms; est. 50-200 ms/s of main at 100 fighting bots; HP changes no stat | vitals only; `calculateStats` only on effect/gear/level change (revision); one aggregate pass inside it | **High** / High |
| C3 | `Npc/Generics/BroadcastVitals` | every NPC HP change × all sessions | linear filter, 2 SpeckMath per session, packets built for bots and dropped; est. 20-50 ms/s at H=300 | `World.realPlayerSessionsNear(loc, 3500)`, owner via `ActorQueries.byId` | Med / High |
| C4 | `World.visibleUserSessions` realOnly (every `BotSession.dataSendToOthers`), `botVisibleRealPlayers` | every bot packet × bots nearby | queries `kind: 'all'`, filters bots by name, sorts: O(H²) | query `kind: 'player'`; return before building a packet when nobody sees | Med / Med-High |
| C5 | `BotAfkMarketService.executePlan` → `MarketPricing.lineState` → `beliefFor` → `PriceBelief.prior` → `FirstPrice.priceOf` | every listed line in a cold review, on main | recomputes the belief only for `sigma` the worker already had; the 350-500 ms main turns perf-tooling measured | carry `sigma` in the plan line (`lineState` skips the belief when `sigma > 0`); mind the 768 B plan cap | Med-High (long turns) |
| C6 | `MoveTo` bot branch | every visible hot bot move | all-session filter per move; non-companion routes run **sync** A* (2000 nodes) on main, up to twice | presence sessions; send visible routes to the path pool (WOR-2) | Med / Med-High |
| C7 | `World.npc.spawns` reassigned by `filter` (SpoilSweep, NpcDied summon, NpcDecay.decayMany) | every sweep / summon death × ~22k | new array breaks `RaidEntityIndex` source → full rebuild over ~22k on the next add/remove | remove in place; never reassign `spawns` | Low-Med / Med |
| C8 | NPC grid 6000-unit cells (`fetchNpcsInRadius`) | aggro sweep 1/s per session incl. bots; BotStatus 3 s; hunting scans; ~25 callers | radius 300-2500 queries scan 18k×18k (100-749 NPCs), 9 key strings per call | 2000-unit cells, radius-sized rings | Low-Med / Med |
| C9 | Linear `World.user.sessions` finds: `ClanService.onlineSessionByActorId` per commit (`syncColdMember`), NpcDied per kill (owner, participants, auto-sweep), Attack clan buff/NPC AoE, EffectRestrictions fear, PartyAwareness | every commit / kill × (H + players) | O(H) per event | `World.registeredActorById`, `ActorQueries.near/humans` | Low / Med |
| C10 | `HuntingState.claimedTargetIds` | every hot target scan × all sessions | O(H²) across hunters | one claimed set per dispatcher turn (function accepts `claimedIds`) | Low-Med / Med |
| C11 | Worker `flush` → `proposalSizes` → `JSON.stringify`; postMessage clone; main stringifies again (C1) | every proposal × 10 KB+ | each state serialized ~3× on two threads; worker throughput is the binding limit | estimate size from known parts; send stats/mind/inventory strings once | Low-Med / Med |
| C12 | Worker `EconomyContext` LRU 2048 (limits.md) | every step above 2048 bots | each step becomes a full build (140-670 ms longest turns measured) | size the LRU from the population or share by cohort; watch the 512 MB heap | Low / **High** |
| C13 | Packets for `BotSession` recipients dropped (statusUpdate per hit/regen, `userInfo` per EXP gain, `ConsoleText.transmit`) | every hit / kill / regen per hot bot | buffer allocation for a no-op send | guard with `session.botSession` or a lazy builder | Low-Med / Med |
| C14 | Per-actor timers: NPC combat `setInterval(100)`, `replenishVitals` `setInterval(3000)`, EffectTicker per effect, MoveTo chains | 10 Hz × fighting NPCs | thousands of callbacks/closures per second | one shared combat ticker, one regen ticker | Low / Low-Med |
| C15 | `Npc` getters via `effectAdjusted` | every move step and combat tick | 2 full `statValues` passes per getter | cache per NPC until EffectStore revision changes | Low / Low-Med |
| C16 | `Skillset.populate` → `fetchSkillFromSelfId` structuredClone | every activation × skills | clones all levels, then deletes them | clone base + used level | Low / Low |
| C17 | `LifeStateCache.set` → `removeOrder/insertOrder` | every state write × N | two O(N) splices | fine at 1700; bucketed list at 10k | Low / Low |

Fine (no action): `invoke()` cached; NpcAggro and NpcWander one shared ticker each; status summaries every 30 s;
ClanSocial revisioned; history wakes coalesced; background jobs event-driven; `syncInventorySummaryUnsafe` writes
only changed rows (reads all item rows of the bot per bag-changing commit, low).
