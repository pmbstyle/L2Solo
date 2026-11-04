# Hidden limits

Checked at 199c3b19 (2026-11-04).

Caps, budgets, size bounds, rates and top-K cuts, and what happens at each as the world grows. Survey 2026-11-03,
kept current with the code. Line numbers are approximate — search by name. Paths relative to `src/GameServer/` unless they start with `src/`. Key in backticks = overridable in `config/default.ini` (`[BotPopulation]` also via `BOT_*` env).

Observable: **log** (a log line), **reason** (returned to the caller), **status** (always-on population status),
**dD** (counter only with `developerDiagnostics=true`), **none**. "Binds at" is an estimate for ~1700 bots on one laptop.

Rule (CLAUDE.md): a new or changed limit gets a row here, and hitting it must be observable.

**Measured capacity (2026-11-04, 2015 laptop, x50, 1731 bots, detached checkout):** cold worker busy 0.57-0.62,
overdue max 1-4 (before this release saturated from ~1430-1580 bots). See POP-23.

## Top risks (silent when hit, likely at ~1700 bots)

1. Background governor allows a DB queue of **0** while a player is online: any queued write defers safety sweep,
   cold snapshot continuation pages, early commits, clan actions/founders, hot market review (dD only).
2. State retention and the WAL truncate never run during play (gated on `activity.protected`: a player online + 30 s
   grace): AI memory/audit/activity tables and the WAL (≥ 256 MB) grow all session. History retention is not gated.
3. `PriceDecision` reads only the first 40 sell lines of an item (all towns): on the most-traded items the forecast is
   unknown, new asks fall back to NPC buyback (accepted lines keep their price), no counter.
4. Activation takes the 100 nearest cold states before filtering busy/`pk_hunting`/party duplicates: in crowded towns,
   few or zero activations near the player, unrecorded (travellers are shown by `showWalkersNear` instead).
5. Board scan windows: 20 lines (`ReadyTradeChoice`, `BidPurchaseAlternative`, `MarketPricing`, `WishPurchaseEvidence`),
   quote depth 5, top-5 buy exits; own/rejected/custody lines use the window, ready trades quietly fail.
6. `ColdBuffService`: 6 cold buff sales per minute for the whole world; extra refused as `sale_limit`, which the
   Coordinator discards (only an unsplit dD `dropped` total).
7. Worker: 64 pending wish route requests; past that `[]`, reviews run without trip data in catch-up bursts.
8. Hot interaction event queue drops events above 1024 pending, drains ~64/s: social memory lost in crowded fights.
9. Path pool (≤ 2 workers, queue 128) pre-empts/rejects (dD); NPC chases lose first: an empty path, a stale one or a
   pool error (rejected, timed out, a crashed worker) backs the chase off (`noPath`, dD npcHate), so under a busy pool
   mobs without line of sight stand and keep hating until the 2 min attack timeout, as in C4.
10. Sockets: no write backpressure, no broadcast fan-out cap; write buffer grows without bound for a slow client in a
    dense zone.
11. Sale candidates cut to top N by unit price (8; StaticBuyer 20 then materials only; town choice 8): cheap stacks
    never sold, bags fill.
12. `EconomyContext` LRU: 2048 plans in the worker vs 1700 bots, 64 on main; above ~2000 bots or > 64 hot bots,
    full rebuild every time (dD).
13. `PersonalWarehouseIndex` keeps 64 kinds per owner, cut on every publish (lowest selfIds at init, table order on
    refresh): long-lived bots lose sight of the rest of their stock.
14. An incremental snapshot row over 256 KB blocks every row queued behind it (Coordinator
    `sendIncrementalEntries`): later hot→cold snapshots stall until that state shrinks (dD `send_failed`).

Next in line: InteractionMemory evicting relations at 32/8/8 (real players exempt); group pair events cut at 64
(9-member raids); clan goal candidates top 8, ClanPartyHelp 64 pending (refused silently); spot-room clamp 9-36
sending bots off-band; oversized proposals requeued every 5 s forever; oversized states dropped once via
`postCollections` (`state:null`, the 10 s retry is never read). Not silent but binding: cold-step throughput with a
player online (8 in flight, status `coldDue`).

## Cold worker and scheduling

| Limit | Value (key) | Where | When hit | Observable | Binds at |
|---|---|---|---|---|---|
| Worker heap | old gen 512 MB, min 128 (`coldWorkerHeapMb`); young gen 192 MB, min 48 (`coldWorkerYoungMb`) | `ColdSimulationCoordinator` ~378 | OOM → restart with backoff 1/2/5/10/30 s (resets after 30 s healthy, forever); steady state above = crash loop | log | ~3000 bots (estimate) |
| Steps in flight | 32 idle (1..128) / 8 with player / halved over `schedulerLagThrottleMs`, 2 at `schedulerLagAbortMs` (`coldWorkerMaxInFlight`, `…PlayerMaxInFlight`, `…LagMaxInFlight`) | Coordinator `desiredWorkerPressure` ~2180, Kernel ~671 | due bots wait | status `coldDue` | ~25 steps/s observed idle (≈ 70 s per cycle over 1700, not re-measured); with a player ~2-4 steps/s (estimate) |
| IPC batch | 64 proposals (`coldWorkerBatchSize`); message 256 KB | Kernel ~666, Protocol ~7 | batch: next flush; message > 256 KB **dropped**: worker→main logged as `fault … message_too_large`, main→worker counted only in dD `ipcRejects` | log / dD | — |
| Solo hunt window | 32 rounds (`MAX_WINDOW_ROUNDS`); a round that does not move the clock ends it; always on (no switch) | Kernel ~16, `huntWindow` ~2306 | window ends `round_cap` / `stalled` | status `windowEnd` | never at normal play (3-10 rounds per 300 s hold) |
| Proposal payload | 240 KB per flush | Kernel ~11, flush ~2370-2415 | resent as delta; still too big → abandoned, requeued +5 s, forever | dD `workerPayload` | rare huge state |
| Commit queue | 1024 entries / 4 MB (`coldWorkerQueueMaxEntries`, `…MaxBytes`); pause at 75 % of entries or full bytes, resume ≤ 50 % entries and ≤ 2 MB; > 256 KB rejected `proposal_too_large` | `ColdCommitQueue` ~69, `enqueue` ~214 | worker paused `commit_queue_high_water` | dD (`workerState=paused`; not in the always-on status) | main DB stalls |
| Commit rows | 32 per flush (P0/P1 lanes 16); 2 s / 5 s; critical 100 ms | ColdCommitQueue ~64, ~343 | next flush | dD | sets ack latency |
| SQLITE_BUSY | 5 retries (6 tries), 10/25/50/100/200 ms + jitter | ColdCommitQueue `retryBusy` ~368 | whole batch acked ok:false, worker requeues | dD `commitRefused`/`commitBusy`, no log | WAL truncate |
| `STEP_STALL_MS` | 30 s | Kernel ~14, `recoverStalled` ~1620 | requeue +1 s (a party via its leader); a *sent* proposal has no ack timeout | dD | hung resolve |
| Bot fault backoff / quarantine | a bot whose solo step or lifecycle command throws (in the worker, or on main by the command itself; a database or pending-write error is a plain 5 s retry, status `commandDbErrors`, first one logged), or a party run (keyed by party id, whoever leads it): retry after 1 s, 5 s, 30 s, 2 min per fault in a row, from the 5th quarantined 10 min at a time (`BotFaultHold`); the hold wins over every other wake (compared with the start, a round's lead included); only a committed step or an ok command clears it; up to 4 distinct messages per bot logged. Hot: an AI state that throws is held off by the same schedule (the rest of the tick runs), at the 5th fault in a row the bot leaves that plan for its own and its held decision is re-taken; a state tick that returns clears it | `BotFaultHold`; Kernel `fault` / `schedule`; `BotAI` `stateFaulted` | bot held off (a hunt or command paused for that bot; hot: its state idles); one log line with the stack per message, one on entering quarantine; repeats counted | log + status `botFaults=<backing off>/<quarantined>/<faults>`; hot `swallowed=` `ai.state.<plan>`, `ai.state_left` | a deterministic bug in one bot's state or a rule (0 when healthy) |
| Watchdog | unhealthy 5 s, dead 10 s, boot 60 s (`coldWorkerUnhealthyMs`, `…DeadMs`, `…BootMs`) | Coordinator ~2150 | pause (`heartbeat_stale`, not logged), kill, restart | log (kills) | GC near heap cap, heap snapshot |
| Snapshot pages | 48 rows (32..64), 32 with a player or lag ≥ 40 ms; under lag ≥ 120 ms held up to 5 s (`coldWorkerSnapshotMaxDeferralMs`) | Coordinator ~192, `ColdSnapshotQueue.takeNormal` ~70 | next page; continuation pages need governor admission (`cold_snapshots`) | dD | mass hot/cold |
| State page | 240 KB (only the `postCollections` path: economy refresh, acks) | `ColdMessagePages` ~3, Coordinator ~525, ~627 | row becomes `state:null`, worker drops it; `retryAfterMs` 10 s never read: nothing until the next snapshot | dD `out_snapshot_page_single_item_too_large` | rare |
| Occupation planner | 64 contexts, 8 owners × 4 units, 4 ms | `ColdOccupationPlanner` ~7 | waiting queue (unbounded) | dD | boot catch-up |
| Wish route requests | 64 pending | `ColdSimulationWorker` `occupationFor` ~690 | `[]` | none | catch-up |
| Planner error log | first 32 distinct | ColdOccupationPlanner ~201 | later errors silent; meeting errors never logged | log (32) | long uptime |
| Governor | 250 / 50 ms per 1 s; DB queue 8 / **0** with player; lag 120 ms | `BackgroundWorkGovernor` ~141 | defer | dD (mode not in the always-on status) | with a player |
| Activation pool | 100 nearest within 9000 | PopulationService `activateNearPlayers` ~1971 → `BotLifeState.coldNear` ~2246 | busy/`pk_hunting`/party duplicates filtered after the cut | none | Giran, Aden |
| Activations | 6 per 10 s scan, world-wide (crafters outside; one party may exceed it) | `PopulationService` ~2020 | `activation_budget` returned, recorded by nobody | none | ~36/min |
| Floor checks | 24 LOS per player per scan; cache 2048 / 30 s | `FloorAwareActivationPolicy` ~75 | `geodata_budget` | dD | multilevel areas |
| Placement / cooldown | 8 tries in 1400, then the anchor itself; 20 cooled per pass (`cooldownBatchSize`) | `ActivationPlacement` ~114, `HotActivation` ~137, PopulationService ~2108 | anchor fails → activation refused `no_safe_activation_placement`; next pass | none | crowds |
| Hot AI dispatch | 1 decision per macrotask (≤ ~1000/s), no hot cap; queue coalesced per key (bounded by actors) | `HotAiDispatcher` ~44 | latency grows | dD | 300+ hot bots |
| Hunt line-of-sight batch | 4 checks per idle tick (`CHECKS_PER_SCAN`); resume within 128 units (`RESUME_RANGE`), else restart at the first | `BotHuntingVisibility.batch`, `select` | scan stays pending, next tick reads on | dD `visibility:batch_blocked:<key>` | idle bots behind walls |
| Solo fight margin | the fight must end above the potion line with its expected length × (1 + length / 60 s) + 3 s of the mob's damage (`FIGHT_MARGIN_SECONDS`, `SPARE_SECONDS`; our choice, calibrated on the table's sample spots) | `BotEncounterReadiness.covers` (hot `HuntingState`, cold `resolveFight`, route `soloCanHunt`) | mob refused: the bot sits or takes another; the route refuses the spot | reason `no_reserve` | every solo fight |
| Potion line | melee 0.35, ranged / healer / casters 0.25 of max HP (`MELEE_USE_HP_RATIO`, `RANGED_USE_HP_RATIO`): the fight drinks there, the gate counts only the HP above it | `HealingPotionStock.useThreshold`, `BotEncounterReadiness.atVitals` | at or below the line: no fight (survival `potion_line`) | reason `no_reserve` | every solo fight |
| Empty ground | hot: a look after 3 empty scans (`EMPTY_HUNT_SCANS`), one per empty streak; a second summon or wait on the stay that changed nothing raises (`session.groundReadying`); hot and cold: one raise per stay (`stats.emptyGround`, cleared by prey) | `BotDecisionService.groundLook`, `BackgroundResolver.resolveSolo` / `getReady` | `unhuntable` raised, the occupation rebuild picks another spot | reason (hot `ground_unhuntable`, cold `debug.unhuntable`, `lastReason no_safe_solo_target`) | gear or level loss, kept routes |
| Population | 1700, clamp 2000 (`maxPlayingPopulation`) | PopulationConfig ~105, ~330 | silently clamped | none | > 2000 |
| Seeding | waves of 5 regions × `starterBotsPerRace` 30 = 150, one batch per wave (`seedBatchSize` = max(50, cohort)); next wave when the last cohort averages level 5 (10 at ×50+); checked every 45 s (`generatedColdSeedDelayMs`) | `PopulationSeedPlanner` ~87, ~121, PopulationService ~1252, `GeneratedColdSeeder` | ramp follows levelling (~12 waves to 1700), not time | dD (wave log behind `developerDiagnostics`) | fresh world |
| Decision deadlines | 64 per scheduler tick | Kernel `tick` ~1700, `dueCandidates` ~1217 | rest wait for the next 20 ms tick | none | boot catch-up |
| Incremental snapshot row | 256 KB message | Coordinator `sendIncrementalEntries` ~1129 | page refused, job ok:false, oldest-first queue stops at that row each run | dD `send_failed` | rare huge state |
| Cold competition gate | DB queue 0 and lag < 40 ms | Coordinator `canRun` ~181 | cold PvP competition work waits behind any DB write | none | with a busy DB |

## Economy and board

| Limit | Value | Where | When hit | Observable | Binds at |
|---|---|---|---|---|---|
| `ColdEconomyPlan.MAX_BYTES` | 768 B; shot 128 | ColdEconomyPlan ~5, ~192, `fit` ~232 | oversize buy batch dropped first; then `fit` drops sells, withdraw, travel, shot, buy batch; then throws `economy_plan_payload_overflow` | dD (`economy_plan deferred bytes_*`) | rich bot, 8+8 lines |
| Decision card | 800 B | ColdEconomyDecision ~59, ~524 | card dropped (null), rebuilt | dD `card drop oversize_card` | per bot |
| Restart decision | 1 KB deflated / 16 KB | EconomyRestartDecision ~6, ColdEconomyDecision ~538 | not saved; rebuilt at restart | dD `card restart oversize` | each restart |
| `EconomyCommit.MAX_ACTIVE` | 64 | EconomyCommit ~8, ~65 | throws `economy_admission_pressure`; `NpcPurchaseBasket` turns it into a refusal reason, others catch generically | reason; log / dD per caller | DB stall |
| EconomyContext retain | 2048 worker / 64 main (`RETAIN_LIMIT`) | EconomyContext ~59, ~1654 | evict → full rebuild | dD `context eviction capacity` | > 2000 / > 64 hot |
| Group / proof | 256 groups (`GROUP_LIMIT`) / 64 KB (`PROOF_RAW_BYTES`) | EconomyContext ~54, ~76 | evict; proof → null | dD `context proof` | > 256 parties |
| WishNetwork | 12 roots / 40 nodes / depth 6; proof 1024 rows 8 KB; 64 actors | WishNetwork ~10, ~25, ~396 | pending / null; rebuild | dD | crafters |
| WishProviders top-K | 8 gear finalists per slot; 12 roots (`WISH_ROOTS`, also caps producer pricing); 4 gear roots × 4 rounds, 3 producer roots; 5 public + 5 fixed bids/offers per item; 4 paths per node | WishProviders ~30, ~35, ~726, ~750, ~794 | tail invisible | dD / none | items with > 5 buy lines |
| Sale candidates | 8 (max 20), highest unit price first; StaticBuyer 20 then materials only; town choice 8 | `ItemDisposition.saleCandidates` ~601, StaticBuyerService ~35, MarketTownPolicy ~219 | cheapest stacks never sold | none | > 8-20 stacks |
| Rival window | 20 rivals out of the first 40 sell lines of one item, all towns (`RIVALS_SEEN`) | PriceDecision ~29, `marketFor` ~203, `chooseAsk` ~287 | forecast unknown → new ask at NPC buyback (accepted lines keep price); stock quote price null (MarketPricing ~193) | none | > 40 lines per item |
| Scan windows | quote depth 5; 20 inspected (`ReadyTradeChoice`, `BidPurchaseAlternative` ~30, `MarketPricing` ~124, `WishPurchaseEvidence` ~21) | PriceDecision ~126, ReadyTradeChoice ~7, `BoardIndex.heads` ~528 | no or worse ready trade; own/rejected lines count against the window | none | busy items |
| Market watch | 20 rows (`MARKET_WATCH`) | DecisionSections ~332 | moves past 20 missed | none | per bot |
| `Hunt.MAX_SPOTS` | 8 | BotHuntEfficiency ~8, ~100 | oldest dropped | none | 8 spot/kit changes |
| Warehouse index | 64 kinds; 8 owners per pass | PersonalWarehouseIndex ~11, ~41 | cut on every publish: lowest selfIds at init, table order (no ORDER BY) on refresh; the rest invisible to the economy | none | long-lived bots |
| Board per bot | 3 shop lines, 5 sell, 5 buy ads, 1 order | BoardRules ~16, Database ~3695, ~4039 | `board_cap_reached` | reason; dD | per bot |
| Plaza | 40-unit grid; Giran ≈ 1.8k, Gludio ≈ 280 (square sizes; after geodata filter not verified) | ShopPlaces ~20, ~509 | `plaza_full:<town>` | reason | Gludio |
| Cold buffs | 6 sales / 60 s world | ColdBuffService ~6, ~70 | `sale_limit`, discarded by the Coordinator (~2072) | dD (`dropped`, reasons not split) | ~10 providers |
| NPC basket | 12 lines (NpcPurchaseBasket); restock 12 (NpcRestockPlan); funding 8 rows (PurchaseFunding `PACKET_ROWS`) | NpcPurchaseBasket ~6, NpcRestockPlan ~9, PurchaseFunding ~219 | throw `invalid npc basket` / extra lines skipped / tail merged into last row | throw / none | many consumables |
| Arrow stock (bots) | one grade, ≤ 2000 and below the first weight penalty (`ArrowStock.MAX_AMOUNT`, `ceil(maxLoad / 2) − 1`); 500 kept however heavy the bag (`KEEP_FLOOR`) | Inventory/ArrowStock ~12, ~15, ~51 | a purchase above it: planners size it down (`admitted`: wish evidence, NPC basket `no_units` dD, bid) or none; the cold gate and writers refuse with `arrow_stock_limit` (reason; a field take returns it as `tradeDeferred`); the surplus is sold to the NPC | reason / dD | archers |
| Companion unload retry | 5 min (`CompanionInventoryCleanup.RETRY_MS`) | AI/CompanionInventoryCleanup ~9 | an overweight companion with no arrows the NPC sale takes and nothing to store, no town target, a visit that sold or stored nothing, or a bag still heavy after it waits 5 min | none | overweight companions |
| Trade chat | global 100 s (`marketTradeChatGlobalMinIntervalMs`), per bot 8 min (`marketTradeChatIntervalMs`) | PopulationConfig ~187 | suppressed | none | always |

## Trades and meetings

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| `MAX_COMMITMENTS` | 8 per actor | TradeMeeting ~6, ~104 | `trade_meeting_backpressure` | reason |
| Meeting staging | 64 pages / 48 KiB world (bytes checked only when transport pages change) | TradeMeetingService ~204, ~239, ~273 | backpressure: ≈ 16 max-size preparations (4 pages each), more when small | reason; player "merchant busy"; cold buyer log |
| Boot marker rewrite page | 64 bots per read, all pages read | Database `refreshTradeMeetingMarkers`, TradeMeetingService `init` | never drops: paging only (one boot pass over marked bots) | none needed |
| One preparation per actor | 1 | TradeMeetingService ~205 | `trade_meeting_preparation_busy` (cold buyers treat it as pending, no cooldown, ColdMarketService ~183) | reason |
| Preparation timeout | 15 s | Coordinator ~509 | `trade_meeting_preparation_timeout`, staging discarded; player sees "merchant busy" | reason (no log) |
| Meeting codec | 768 B × 4 pages, 8 KB raw, 40 incoming rows | TradeMeetingCodec ~25, ~45 | throw backpressure | reason |
| Player↔bot window | 8 lines, 10000/line, 5000 gift, 80 items, TTL 120 s | BotTradeService ~10, ~333, ~352 | reason; amount **silently clamped** | reason / none |
| Negotiation | 3 rounds, qty 100, 90 s | BotNegotiationService ~11, ~359, ~417 | `round_limit`; qty > 100 → 100 silently | reason / none |
| Board window | HTML 8192 B; page 6, search 8, towns 25; cursor history 32 | PlayerBoardWindow ~9, ~114, ~202 | paged / throw / cut; oldest cursor dropped | error / none |

## Parties and social memory

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| InteractionMemory | 32 character / 8 clan / 8 alliance; protected 16; relations with real players never evicted (uncapped) | InteractionMemoryPolicy ~9, `bound` ~153 | weakest evicted silently | none |
| Replay journal | 128 events; 7 days | InteractionMemoryPolicy ~11, ~188 | evictions raise the replay floor; older events `expired_event` | dD |
| Hot event queue | 1024 pending; one page of 64 per flush, next 1 s later (~64/s); 3 s drain at shutdown | InteractionEventQueue ~24, ~80 | event **dropped** | dD busy counter (pending count in snapshot) |
| Group pair events | 64 (9 members = 72 pairs) | SharedHuntMemory ~20 | last members lose `hunted_together` | none |
| `maxBackgroundParties` | 72 (no default.ini key) | PopulationConfig ~142, PartyAdmission ~27 | party not formed (required clan objectives can reclaim a slot, PopulationService ~881) | none |
| Assembly recovery | 12 attempts or 6 + 5 min | PartyAssemblyRecovery ~1, ~22 | `party_assembly_timeout` | party history |
| Party affinity | 16 peers (strong 8) | BackgroundPartyAffinity ~1 | forgotten | none |
| ClanPartyHelp | 64 pending; 8 parties per request; TTL 10 min, retry 30 s | ClanPartyHelp ~25, ~90 | request refused silently | none |
| Opportunistic raids | 2 parties, 15 min, search 60 s; per search 8 rosters, 72 bots, 12 forecasts, 12 ms CPU in 2 ms slices (`RaidSearchCounters`) | PopulationConfig ~14, OpportunisticRaidDirector ~105, RaidSearchCounters ~3 | skipped / retry 10 s | status |
| Supply errand return | 4 hot writes (`SUPPLY_RETURN_ATTEMPTS`) 5 s apart (`SUPPLY_RETURN_RETRY_MS`), each from the latest cached row, while the return is still `returning` with the same actor; timers cleared at shutdown | BotTownTravel `returnSupplyHot` | the companion stays parked up to ~15 s, then resumes with its row cold (the old behaviour) | status `swallowed=` (`population.mark_hot`, `population.supply_return_cold`), first logged |
| Clans | 40 bot clans (`CLAN_SIMULATION_MAX_BOT_CLANS`); 70 % members; 10/15/20/30/40 per clan by level | Database `createAutonomousClan` ~9478, ClanSimulationConfig ~5, ClanRules `memberLimit` ~19 | `founder_clan_limit` / clan limits | reason; dD |
| Clan action pass | 8 actions, 80 ms / 20 ms with a player, 60 s | ClanSimulationConfig ~35, ClanActionService ~714 | next pass | dD |
| Founder pass | 16 per 60 s; 20 ms, 5 ms with a player | ClanSimulationConfig ~36, ClanSimulationService ~351 | deferred | dD |
| Clan goals | top 8 (max 12); candidate cache 128 FIFO | ClanGoalCandidateService ~8, ~83 | rest ignored | none |
| Orders / wars | 8 deliveries; 4 operations, roster 3-9 | ClanOrderService ~14, ClanWarConfig ~5, ClanWarDirector ~263 | deferred / `operation_capacity` | reason |
| Action result | 16 KiB; depth 3, 32 keys, 512-char strings, 32 array items | Database ~185 | over 16 KiB `{truncated:true}`; the depth/key/string/array cuts are silent | flag / none |

## World, movement, pathfinding

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| Path pool | min(2, cores − 1) workers; queue 128; priority NPC 0 < bot 50 < companion 100 | PathfindingWorkerPool ~16, MoveTo ~633, Npc ~640 | lowest-priority queued task pre-empted (`PATH_PREEMPTED`) or new one rejected (`QUEUE_FULL`) | dD |
| Path timeout | 2 s (`COMPANION_PATH_TIMEOUT_MS`); NPC 10 s per request (`NPC_PATH_REQUEST_TIMEOUT_MS`) | PathfindingWorkerPool ~108, MoveTo ~15, Npc ~41, `pathFailed` ~335 | retry (NPC: 0.5, 1, 2, 4 s per empty, stale or failed request in a row, `noPath`); the NPC drops the target only at its 2 min attack timeout (`ATTACK_TIMEOUT_MS`, `attackTimeout`) | dD (npcHate) |
| Corridor budget | 80 ms per 1 s for non-priority town-corridor tasks; 150 ms per request | PathfindingWorkerPool ~162, PathfindingWorker ~26 | over budget: wait for the next second; > 150 ms: `PATH_BUDGET` error (companion recovery retries) | dD `budgetDeferrals` |
| Pool restarts | none: a crashed slot respawns forever, at once on its first crash in a row, then after the shared worker backoff 1/2/5/10/30 s (resets after 30 s up; `RestartBackoff.AT_ONCE_FIRST_MS`) | PathfindingWorkerPool `onWorkerFailure` ~214, `src/WorkerRestartBackoff.js` | the slot is down until its respawn; its running task fails with the crash; the queue is kept, each task waits for a worker or its own timeout (`PATH_TIMEOUT`) | log (each crash with its reason, the stack once per reason); status `pathPool=<up>/<size> pathCrashes=<crashes>/<respawns>` |
| Sync A* | 2000 nodes (`findPath` default) | GeodataEngine ~501, MoveTo ~728 | null → `TownPathfinder` waypoint → straight line if LOS → empty | `lastPathfinding` |
| Worker A* | companion 4000; errand 30000 → 120000 on recovery; NPC 8000 | MoveTo ~16, `CompanionNavigationRecovery` ~8, Npc ~35 | recovery; after 3 route failures `exhausted` | reason / none |
| Town route caches | 256 entries / 32768 points, TTL 120 s; corridor 128 points (`TownPathCorridor.MAX_POINTS`) | TownNavigation ~5, ~79, TownPathCorridor ~4 | LRU evict; route > 32768 points never cached; corridor > 128 → raw path, no lanes | dD |
| Hunt targets | 96 / 32; radius 2500 → 8486 (ceil(6000·√2)) | HuntingState ~56, ~1112, `limitTargetCandidates` | nearest N | dD `target_scan:capped:<tier>` |
| NPC grid | 3×3 cells of 6000 (`NPC_GRID_SIZE`) | WorldConstants ~24, `World.fetchNpcsInRadius` ~1174 | radius > ~6000 clipped silently (the 8486 hunt search is; mostly harmless, bounded by the spot cell) | none |
| Hot LOD | full ≤ 3500, exit 4000; ticks 3/7/30 s; far-visible tick budget 6 ms | HotActorLodPolicy ~5 | lower detail | dD |
| Spot room | explicit `spot.capacity` (only raid sources: 999; raid boss spots ∞), else clamp(round(density × 0.75), 9, 36); own spot always has room | LevelingRoutes `capacityForSpot` ~259, `roomForSpot` ~271, SpotProfiles ~162 | full spots skipped, bots go off-band | dD (`spot_list skip full`, `farmCapacity` in the dD summary) |
| Effects | 20 buffs + 10 debuffs (extra debuffs take buff slots); skill cache 20000 | EffectStore ~2, C4SkillRules ~1326 | oldest buff removed; skill cache cleared when full | none / dD (cache clear) |

## Persistence and DB

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| Main DB queue | unbounded | `src/Database.js` `enqueue` ~274 | latency grows; governor reads `pending()` | dD (`dbQueue` in the dD summary) |
| Busy timeout | 5 s (PRAGMA); checkpoint 250 / 50 ms | Database ~4452, `src/DatabaseCheckpointWorker.js` ~10 | transaction rejected | log |
| Final checkpoint at shutdown | 3 s (timer cleared when the checkpoint answers) | `src/DatabaseCheckpointCoordinator.js` `stop` | `checkpoint_shutdown_timeout`, the worker is terminated | result only |
| Passive checkpoint | WAL ≥ 4 MB, 5 s | DatabaseCheckpointCoordinator ~7 | skipped | dD |
| WAL truncate | 256 MB, +64 MB, 60 s (`[Database] checkpointReset*`), tried when a passive checkpoint finishes (`armWalReset`, 5 s); **only without a player** (+30 s grace), empty DB queue, no checkpoint/resolve/retention/party formation running | `PopulationService.runAdaptiveWalReset` ~2743 | silently skipped | success dD; failure log |
| State retention | 64 rows, 1 s, 12 ms; 60 s pause after a pass, 6 h idle pause | PopulationConfig ~116 | deferred the whole session while a player is online (`player_protected`) | dD |
| Retention caps | activity 100k; tool 50k; LLM 50k; conversation 512; 30 days; 128 rows per pair (PopulationConfig keys, e.g. `activityJournalMaxRows`) | PersistentStateRetention ~4 | only when retention runs | dD |
| Safety sweep | 64 rows/page, 30 min, 240 KB repair | LifecycleSafetySweep ~6, ~109, ~216 | cycle stretches; oversized repair edge skipped, retried after 30 min | dD `deferred` |
| Party history purge | 1000 (max 5000) / h (`partyHistoryCleanupIntervalMs`), 24 h | ColdSimulationCoordinator ~345, BackgroundPartyState ~335 | backlog grows | log |
| History transfer | 1000 / batch every 200 ms, loops until a short batch; failed row skipped forever | `src/HistoryWorker.js` ~19, `src/HistoryDatabase.js` ~162 | — | log (first 5 errors per batch) |
| History retention | 5000 / table / min (`RETENTION_BATCH`, history worker) | `src/HistoryStore.js` ~26 | next minute | none |
| Statement cache | 256 LRU; SQL > 16 KB uncached | `src/DatabaseStatements.js` ~4 | re-prepare | none |
| Char write-behind | 750 ms, batch unbounded | CharacterWriteQueue ~3 | patch put back, retried forever | log |
| Shutdown budget | drains 10 s (`DRAIN_BUDGET_MS`), then flush (`FINAL_FLUSH_ROUNDS` 3) + close; exit at 16 s (`EXIT_DEADLINE_MS`); launcher SIGKILL at 18 s (run-server) / 20 s (start); each cold coordinator stop wait ≤ 10 s, its timer cleared | `src/NodeL2.js` `shutdown` | later drain steps skipped, the DB is still flushed and closed | log (step named; unsaved character count) |
| Survived failure sites | per thread: 128 named sites (`MAX_SITES`, `area.what`) and apart 32 unnamed backstop sites (`MAX_UNNAMED_SITES`: kind + error name + first frame, or the message with digits masked) | `src/FailureLog.js` `note` / `noteUnnamed` (main, cold worker) | later sites share one "other sites" / "other unnamed sites" count (only its first is logged) | status `swallowed=<failures>/<sites>` (main + worker), log (first of each with stack; counts at exit) |
| PvP journal | 5000 rows (`MAX_PENDING`), flushed every 60 s (`ECONOMY_JOURNAL_FLUSH_MS`) | `src/PvpJournal.js` ~6, Database ~378 | buffer kept on a failed flush; over the cap rows **dropped silently** | none |

## Network and packets

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| Inbound frame | unsigned 2..65535 B (`Packet/Frame.body`, game and login); a string field must end in its terminator (`Packet/Receive.readS`) | `src/Server.js` `packetReceiver` ~10, `src/Packet/Frame.js` | size < 2 in the stream: buffer reset + log, connection closed; a length past its frame or a string without a terminator fails the packet (the connection is dropped, "dropped a packet") | log; status `packetRefused=<in>/<out>/<unterminated>` |
| Outbound frame | unsigned ≤ 65535 B (`Packet/Frame.pack`: Session, BotSession, login Session) | `src/Packet/Frame.js` | packet not sent, the connection stays (the first per opcode logged) | log + status `packetRefused` |
| Warehouse slots | players `[GameServer] playerWarehouseSlots` 300 (1..1000); bots 100 (dwarf 120) + 6 per Expand Warehouse level, up to 8 | PersonalWarehouseLimits ~9 | out of range → 300 silently | none |
| HTML | 8192 chars | NpcHtml ~6 | "Page is too large" | log |
| Socket backpressure | none (no `writableLength`/drain check in src) | Session ~222 | buffer grows | none |
| Broadcast fan-out | none (real players within 6000) | Session ~231 | — | none |
| `maxOnline` | 1000, display only | `src/AuthenticationServer/Network/Response/ServerList.js` ~20 | not enforced | — |
| Observer | snapshot uncapped; pages 100; body 16 KB | `src/WorldObserver/WorldObserverServer.js` ~2609, ~3090 | rebuild; 413 | HTTP |

## LLM and chat (only with LLM on, except chatter)

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| In flight | 32 (`OpenRouter.maxConcurrentRequests`) | BotInferenceBudget ~46 | reject / queue | reason |
| Waiters | 256, 5 min | BotInferenceBudget ~13 | `inference_budget_queue_full` / `_queue_timeout`, canned reply | reason / reply |
| Windows | per bot 6 req, 12k prompt, 2.4k completion tokens / 60 s; global 240 req, 300k prompt, 64k completion | BotInferenceBudget ~3 | `inference_budget_requests` / `_prompt_tokens` / `_completion_tokens` (or global), fallback | reason |
| Gateway | 320 tokens, 3500 ms; circuit 3 fails → 30 s | OpenRouterGateway ~27 | canned reply | dD |
| Context | bot 1200/1800; clan 2200/2500, 8 candidates | BotContextAssembler ~7, `Clan/ClanContextAssembler` ~5 | fragments dropped | dD |
| Chat text | 120 chars × 3; stored 360 (`MAX_TEXT_CHARS`) | BotChatText ~1, BotConversationStore ~4 | truncated | visible / none |
| Brain turn queue | unbounded (`session.pendingBrainTurns`) | BotBrain ~1053 | grows | debug |
| Chatter budget | 256 entries; area 45 s, speaker 120 s, topic 300 s, range 2000 | BotChatterBudget ~3 | cooldowns forgotten, repeats | none |
| Global / clan chat | global: 18 s world-wide (×1-1.75, `globalChatMinIntervalMs`), topic 120 s (death 15 min), speaker 10 min; clan: 10 min per event, 12 pending per clan, 64 clans, TTL 2 min | `Bot/Population/BotGlobalChat` ~9, ~50, BotClanChat ~8 | suppressed | none |

## Bot tables ([tables.md](tables.md))

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| Table levels | lines measured up to 78 (`MAX_LEVEL`, generator and `scripts/hunt-tables/common.js`); a bot of 79-80 reads 78 | `generate-spot-table.js`, `SpotValueTable` `combat` (`header.inputs.maxLevel`) | clamped | none |
| Deep-blue cut | a spot more than 9 levels below the bot has no value (`ProgressionRates.DEEP_BLUE_LEVEL_GAP`); curves stop at gap 10 | `SpotValueTable` `combat`, generator `GAPS` | never ranked, never chosen by table readers (our choice, not C4: past C4's deep-blue drop gap such mobs drop little) | none |
| Missing spot | a live catalogue spot without a table row has no value | `SpotValueTable.checkCatalog` | never chosen by table readers | log (one line per catalogue) |
| Stale table | a table whose fingerprint differs from its input files (`TableFingerprint`); the message names the first 8 changed files (`list`) | `scripts/check-tables.js` (`npm run check`), `SpotValueTable` `checkFingerprint` (main, first read) | check fails; the server keeps the table and logs; a table without a fingerprint only warns | the line, with the count of changed files |
| Income ranking | spots from 15 below to 8 above the bot (`BASIS_MIN_GAP`), first 64 by held income | `SpotValueTable` `rankIncome` | the rest never offered | none |
| Shortlists | 128 (`incomeRows`), oldest out | `SpotValueTable.rankedIncome` | re-sorted from the basis | dD `incomeEvictions` |
| Value memo | 32768 rows (`MAX_VALUE_MEMO`), ring | `SpotValueTable` `memoValue` | oldest row recomputed | dD `memoEvictions` |
| Income bases | 524288 cells, ~19 MiB per thread (`MAX_INCOME_BASE_CELLS`) | `SpotValueTable` `rankIncome` | oldest basis dropped, rescanned | dD `baseEvictions` |
| Spot caches | 8192 entries (`SPOT_CACHE_LIMIT`), drop 1/8 at once | `SpotValueTable` `killSpot`, `productionCap` | recomputed | none |
| Reward caches | 16384 NPC values, 32768 spot values (`MAX_NPC_VALUES`, `MAX_SPOT_VALUES`) | `SpotRewardExpectation` | oldest dropped | none |
| Kill mix | 8 species per row (`MIX_SPECIES`; the gate mask is 8 bits) | generator `killMix`, `gapGate` | a spot's 9th and later species neither priced nor gated | none |
| Level curves | ≤ 3 spots per line and 2-level band (`CURVE_SPOTS`), gaps −4..10 step 2; reference at +6 (`REF_GAP`) | generator | a band without spots takes the nearest band's curve, a gap without points its neighbour's | header `inputs` |
| Hunt hours | rows 2 h, curves and kit points 1 h (`--hours`, `--curve-hours`); probe 0.25 h, 12 spots; pick 0.25 h, its spots (the ids fit one branch name, ~250 bytes) | generator, `tables.yml` | noise of rare deaths and drops | header `inputs` |
| CI jobs | 12 shards × 4 children; 150 min per spot shard, 30 min merge, 240 min hunt | `.github/workflows/tables.yml` | run fails | CI |
| Picked tests | 8 files a shard, at most 12 shards (more files: more a shard); 180 s per file, 30 min per shard (as PR checks) | `.github/workflows/tests.yml`, `run-tests.js --only` | the file fails / the shard fails | CI log `TIMEOUT` |
| Hunt model | ceilings: mob level ≤ 85, death chance < 0.5; corrections: 17 classes, gaps −2/2/5/8, 0.5 h; rotation: MP phase ≤ 180 s, dry 60 s, 12 s slices | `scripts/hunt-tables/{ceilings,corrections,rotation}.js` | offline only | header `inputs` |

## Measurement (perf tool, `[Perf]` in `config/default.ini`)

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| Recorder retention | `keepProfilesPerDay` 100 raw CPU chunks a day (longest run first, captures always kept), `keepHeapProfiles` 100 per thread (first and newest stay), `keepDays` 14; pruned hourly | `src/Perf/LiveRecorder.js` | older files deleted | files on disk |
| Recorder thresholds | busy run ≥ `longTurnMs` 50 → spikes file; ≥ `keepProfileMs` 200 → chunk kept; chunk `cpuChunkSeconds` 60; heap every `heapEveryMinutes` 60, `heapSampleKb` 128 | LiveRecorder | shorter runs only in the timeline totals | timeline / spikes |
| Scripted client read-back | 20000 server packets per player (`KEEP`) | `src/Perf/PlayerClient.js` | oldest packets dropped; a step's wait reads back only the kept ones | none (a crowd writes thousands a minute) |
| Transition samples | `resolveSampleLimit` 200 per summary interval (activation / cooldown ms) | `PopulationMetrics.pushTransition` | oldest sample dropped | summary `transitions` |
| Player-feel bounds | schedule p95 40 / p99 120 / max 150 ms, handler p95 25 / p99 75 ms (`PLAYER_LIMITS`) | `scripts/perf/report.js` | run marked over | report `over` |
