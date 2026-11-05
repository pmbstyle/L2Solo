# Hidden limits

Checked at 39e43408 (2026-11-04).

Caps, budgets, size bounds, rates and top-K cuts, and what happens at each as the world grows. Survey 2026-11-03,
kept current with the code. Line numbers are approximate — search by name. Paths relative to `src/GameServer/` unless they start with `src/`. Key in backticks = overridable in `config/default.ini` (`[BotPopulation]` also via `BOT_*` env).

Observable: **log** (a log line), **reason** (returned to the caller), **status** (always-on population status),
**dD** (counter only with `developerDiagnostics=true`), **none**. "Binds at" is an estimate for ~1700 bots on one laptop.

Rule (CLAUDE.md): a new or changed limit gets a row here, and hitting it must be observable.

**Measured capacity (2026-11-04, 2015 laptop, x50, 1731 bots, detached checkout):** cold worker busy 0.57-0.62,
overdue max 1-4 (before this release saturated from ~1430-1580 bots). See POP-23.

## Top risks (silent when hit, likely at ~1700 bots)

1. Background governor allows a DB queue of **8** while a player is online (the queue drains in 12 ms slices, so a
   timer between two sees the drain's backlog): a longer backlog defers safety sweep, cold snapshot continuation
   pages, early commits, clan actions/founders, hot market review (dD only).
2. State retention and the WAL truncate share the governor's 50 ms/s with a player (and its DB queue 8, risk 1): under a
   steady write queue they still defer (counted: `maintenance.refusals`, perf report), and the WAL can grow past
   256 MB until a quiet second; a truncate measured over 50 ms is skipped with a player (`estimate_over_budget`),
   tried again every 10 min and forced past a 512 MB WAL (`estimate_retry`, `forced_over_ceiling`): a pause over 50 ms
   (hot run 2026-11-04: 81 ms; at ~55 MB/min about one per 9 min).
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
| Solo hunt window | look-ahead 300 s past the step's clock (`WINDOW_LEAD_MS`: the rounds run in one burst against the world as it stands at the step, and a hot session, party or command interrupting the window lives that time again; a simulation look-ahead, no event could carry future world state); 32 rounds (`MAX_WINDOW_ROUNDS`); a round that does not move the clock ends it; always on (no switch). Inside it each round reads its events (`ColdSoloWindow.endOf`) | Kernel ~26-34, `huntWindow` ~2357 | window ends `lead` (huntedThrough < step clock + 300 s) / `round_cap` / `stalled` | status `windowEnd` | `lead`: a quiet hunt (~28 % of windows in 29ae424cd-cold ended on the old 300 s deadline); `round_cap` rare (3-10 rounds per 300 s) |
| Proposal payload | 240 KB per flush | Kernel ~11, flush ~2370-2415 | resent as delta; still too big → abandoned, requeued +5 s, forever | dD `workerPayload` | rare huge state |
| Commit queue | 1024 entries / 4 MB (`coldWorkerQueueMaxEntries`, `…MaxBytes`); pause at 75 % of entries or full bytes, resume ≤ 50 % entries and ≤ 2 MB; > 256 KB rejected `proposal_too_large` | `ColdCommitQueue` ~69, `enqueue` ~214 | worker paused `commit_queue_high_water` | dD (`workerState=paused`; not in the always-on status) | main DB stalls |
| Commit rows | 32 per flush (P0/P1 lanes 16); 2 s / 5 s; critical 100 ms | ColdCommitQueue ~64, ~343 | next flush | dD | sets ack latency |
| SQLITE_BUSY | 5 retries (6 tries), 10/25/50/100/200 ms + jitter | ColdCommitQueue `retryBusy` ~368 | whole batch acked ok:false, worker requeues | dD `commitRefused`/`commitBusy`, no log | WAL truncate |
| `STEP_STALL_MS` | 30 s | Kernel ~14, `recoverStalled` ~1620 | requeue +1 s (a party via its leader); a *sent* proposal has no ack timeout | dD | hung resolve |
| Bot fault backoff / quarantine | a bot whose solo step or lifecycle command throws (in the worker, or on main by the command itself; a database or pending-write error is a plain 5 s retry, status `commandDbErrors`, first one logged), or a party run (keyed by party id, whoever leads it): retry after 1 s, 5 s, 30 s, 2 min per fault in a row, from the 5th quarantined 10 min at a time (`BotFaultHold`); the hold wins over every other wake (compared with the start, a round's lead included); only a committed step or an ok command clears it; up to 4 distinct messages per bot logged. Hot: an AI state that throws is held off by the same schedule (the rest of the tick runs), at the 5th fault in a row the bot leaves that plan for its own and its held decision is re-taken; a state tick that returns clears it | `BotFaultHold`; Kernel `fault` / `schedule`; `BotAI` `stateFaulted` | bot held off (a hunt or command paused for that bot; hot: its state idles); one log line with the stack per message, one on entering quarantine; repeats counted | log + status `botFaults=<backing off>/<quarantined>/<faults>`; hot `swallowed=` `ai.state.<plan>`, `ai.state_left` | a deterministic bug in one bot's state or a rule (0 when healthy) |
| Watchdog | unhealthy 5 s, dead 10 s, boot 60 s (`coldWorkerUnhealthyMs`, `…DeadMs`, `…BootMs`) | Coordinator ~2150 | pause (`heartbeat_stale`, not logged), kill, restart | log (kills) | GC near heap cap, heap snapshot |
| Snapshot pages | 48 rows (32..64), 32 with a player or lag ≥ 40 ms; under lag ≥ 120 ms held up to 5 s (`coldWorkerSnapshotMaxDeferralMs`) | Coordinator ~192, `ColdSnapshotQueue.takeNormal` ~70 | next page; continuation pages need governor admission (`cold_snapshots`) | dD | mass hot/cold |
| State page | 240 KB (only the `postCollections` path: economy refresh, acks) | `ColdMessagePages` ~3, Coordinator ~525, ~627 | row becomes `state:null`, worker drops it; `retryAfterMs` 10 s never read: nothing until the next snapshot | dD `out_snapshot_page_single_item_too_large` | rare |
| Occupation planner | 64 working contexts (unfinished jobs), 8 owners × 4 units, 4 ms; a finished job leaves the pool as a card, one per bot per mode (8 modes), dropped when the bot's next state reads otherwise (an action, showcase or craft-market card at its next state: its key holds the step clock; a near, refresh or meeting job at any new state), at an ask of that mode with another key, or with the bot; a workshop card serves an ask of its key for 30 game min from the ask that built it (`WORKSHOP_SERVE_MS`, `servesUntil`): its sale exits read the demand forecasts' decay by the clock, which has no event (debt.md 25) | `ColdOccupationPlanner` ~7, `ColdSimulationWorker` `servesUntil` | waiting queue (unbounded); cards: no cap (bots × modes); past the window the next ask builds again | dD (`occupationPlanning` contexts, cards) | boot catch-up; a crafter whose state reads the same for longer than the window |
| Wish route requests | 64 in flight (a bot's rows on its route key, finished or in flight, answer outside it) | `ColdSimulationWorker` `occupationFor` ~720 | `[]` | dD `occupation:ask:wish\|<caller>\|capped` | catch-up |
| Planner error log | first 32 distinct | ColdOccupationPlanner ~201 | later errors silent; meeting errors never logged | log (32) | long uptime |
| Governor | 250 / 50 ms per 1 s; DB queue 8 idle and with a player (`backgroundGovernor*DbQueueMax`: about one or two 12 ms drain slices of jobs, the tail of a drain is admitted; the forced WAL truncate, `force`, is never deferred); lag 120 ms | `BackgroundWorkGovernor` ~141 | defer | dD (mode not in the always-on status); state retention and WAL truncate deferrals always (`maintenance.refusals`) | with a player |
| Activation pool | 100 nearest within 9000 | PopulationService `activateNearPlayers` ~1971 → `BotLifeState.coldNear` ~2246 | busy/`pk_hunting`/party duplicates filtered after the cut | none | Giran, Aden |
| Activations | 6 per 10 s scan, world-wide (crafters outside; one party may exceed it); the 10 s scan is also a window for the moves and ends it has no event for (`phasePolicyIntervalMs`, debt POP-24) | `PopulationService` ~2020 | `activation_budget` returned, recorded by nobody | none | ~36/min |
| Floor checks | 24 LOS per player per scan; cache 2048 / 30 s | `FloorAwareActivationPolicy` ~75 | `geodata_budget` | dD | multilevel areas |
| Placement / cooldown | 8 tries in 1400, then the anchor itself; 20 cooled per pass (`cooldownBatchSize`) | `ActivationPlacement` ~114, `HotActivation` ~137, PopulationService ~2108 | anchor fails → activation refused `no_safe_activation_placement`; next pass | none | crowds |
| Walker appearance | an endpoint of its run within 9000 of the player: the arrival, else the teleport point | `PopulationService.walkerAppearance` ~128, `HotActivation` ~140 | neither in reach (a run over 18000, the player by its middle) → refused `walker_endpoint_far`, stays cold; next scan | `activationRefusals` / `refusalReasons` (status line, perf report) | long walks on foot |
| Hot AI dispatch | 1 decision per macrotask (≤ ~1000/s), no hot cap; queue coalesced per key (bounded by actors) | `HotAiDispatcher` ~44 | latency grows | dD | 300+ hot bots |
| Hunt line-of-sight batch | 4 checks per idle tick (`CHECKS_PER_SCAN`); resume within 128 units (`RESUME_RANGE`), else restart at the first | `BotHuntingVisibility.batch`, `select` | scan stays pending, next tick reads on | dD `visibility:batch_blocked:<key>` | idle bots behind walls |
| Solo fight margin | the fight must end above the potion line with its expected length × (1 + length / 60 s) + 3 s of the mob's damage (`FIGHT_MARGIN_SECONDS`, `SPARE_SECONDS`; our choice, calibrated on the table's sample spots) | `BotEncounterReadiness.covers` (hot `HuntingState`, cold `resolveFight`, route `soloCanHunt`) | mob refused: the bot sits or takes another; the route refuses the spot | reason `no_reserve` | every solo fight |
| Held matchup profiles | 8 solo kit arrays per thread (`HELD_PROFILES`), the latest readers': one bot's array at one timestamp serves while its stored kit profile, survivalKnown, shot supply and servitor read the same (else a reader builds its own) | `BotTargetMatchup.stateProfiles` → `heldSolo` | oldest dropped with its verdicts; the next reader of that bot builds a new array (the cost before the hold) | dD `matchup_profiles:held:hit` / `built` | more than 8 arrays between two readers of one bot's moment (a step reads a few) |
| Held round profiles | 8 solo round arrays per thread (`ROUND_PROFILES`), the latest rounds': one serves the next rounds (with its verdicts) while the fight profile (by value, the stored kit's parts by identity), the bag, the shot kind and the servitor read the same, from its build until the first of its effects' expiry or the day's turn (the readers' views read the clock) | `BackgroundResolver.roundProfiles` | oldest dropped with its verdicts; that bot's next round builds again (the cost before) | dD `round_profiles:held:hit` / `built` | more than 8 rounds of other bots between two rounds of one (a hunt window runs its rounds in a row) |
| Equip answers | 16 per thread (`EQUIP_ANSWERS`), the latest equips': one serves while the role, class, grade of the level, the bag's gear entries (by value, in order) and, with a shield in the bag, the state's worn two-hander read the same; the other entries pass through as copies; a new catalogue drops them | `GearAcquisitionPlanner.equipInventoryUpgrades` | oldest dropped; the next equip of that gear computes again (the cost before) | dD `equip_upgrades:answers:hit` / `built` | more than 16 gear sets between two equips of one bag (a hunt window equips one twice a round) |
| Held sale dispositions | per cold bot's worker record (`saleHold`): the dispositions of its last sale only, at most 2 per sale candidate (a lot and its rest), each a ~20-character digest of the sale's shared inputs plus its own ~100-character key and the four read fields (action, gain, answer, the ask's price / stock quote / NPC flag, the buy-back); ~0.4 KB per entry, ~13 entries a seller, at most ~35 (~4.6 MB over ~1000 sellers on the 1731-bot save) | `MarketListingPolicy.evaluate` (`holdKey`, `heldDisposition`), `ColdSimulationWorker` `saleHold` | none: an evaluate drops the entries its sale did not ask; the record goes with the bot | dD `sale_hold:built` / `kept` | a bag of many sale candidates (the walk is unlimited for the listing) |
| Kept sale lists | 4 lists per bag object (`SALE_WALKS`), the latest: one per exact walk input (reserves, kept stock, arrows, personal shot, the state fields and options the walk reads, its tables); a list dies with its bag | `ItemDisposition.saleCandidates` | oldest dropped; its next reader walks the bag again (the cost before the hold) | dD `sale_walk:held:hit` / `built` | more than 4 reserve/option sets asked of one bag (a step asks 1-3) |
| Potion line | melee 0.35, ranged / healer / casters 0.25 of max HP (`MELEE_USE_HP_RATIO`, `RANGED_USE_HP_RATIO`): the fight drinks there, the gate counts only the HP above it | `HealingPotionStock.useThreshold`, `BotEncounterReadiness.atVitals` | at or below the line: no fight (survival `potion_line`) | reason `no_reserve` | every solo fight |
| Empty ground | hot: a look after 3 empty scans (`EMPTY_HUNT_SCANS`), one per empty streak; a second summon or wait on the stay that changed nothing raises (`session.groundReadying`); hot and cold: one raise per stay (`stats.emptyGround`, cleared by prey) | `BotDecisionService.groundLook`, `BackgroundResolver.resolveSolo` / `getReady` | `unhuntable` raised, the occupation rebuild picks another spot | reason (hot `ground_unhuntable`, cold `debug.unhuntable`, `lastReason no_safe_solo_target`) | gear or level loss, kept routes |
| Population | 1700, clamp 2000 (`maxPlayingPopulation`) | PopulationConfig ~105, ~330 | silently clamped | none | > 2000 |
| Seeding | waves of 5 regions × `starterBotsPerRace` 30 = 150, one batch per wave (`seedBatchSize` = max(50, cohort)); next wave when the last cohort averages level 5 (10 at ×50+); checked every 45 s (`generatedColdSeedDelayMs`) | `PopulationSeedPlanner` ~87, ~121, PopulationService ~1252, `GeneratedColdSeeder` | ramp follows levelling (~12 waves to 1700), not time | dD (wave log behind `developerDiagnostics`) | fresh world |
| Event waits | a waiter takes no step until a writer changes its row (main's party, cancel, errand trip, objective end; after a restart its snapshot) or its known end: raid supply reservation to its expiry (≤ 10 min, `RaidSupplyPreparation.TIMEOUT_MS`); an opportunistic raid roster waiting for its native activation to the expedition's expiry (main activates or dissolves it every 4 s); a parked supply errand row to the errand's deadline (10 min; its return writes the row hot; after a restart the orphaned row, its due shifted by the downtime, ends up to 10 min after boot, POP-24); clan party wait none, `event_driven` after its first hold (`ClanPartyDuty.held`; the write that ends it steps it at once, Kernel `upsert`; its 30 s due serves only a command that holds the bot first); no safety timeout (every cold write reaches the worker, `notifyColdSnapshot`; a restart re-reads the row) | `BackgroundResolver.resolveSolo`, `BackgroundPartyResolver.resolve`, `ClanPartyDuty`, Kernel `lifecycleKind` | the wait ends at the change; the step after it hunts from its own start (`stats.eventWait`, `ColdSoloWindow.livedClock`) | status `coldDue` | — |
| Wait polls (no event yet) | 30 s: raid supply purchase in town (the command's retry), survival unload, refused hunting ground, chosen occupation (`occupationRound`), party assembling / roster not opened / understaffed (`BackgroundPartyResolver`); town command: shopping 120 s, merchant 60 s (crafting's 60 s is unused: `resolveColdCraft` writes its own due) | `BackgroundResolver.resolveSolo`, Kernel `occupationRound`, `BackgroundPartyResolver.resolve` | a step every 30 s while the outcome lacks an event (POP-24); the assembly timeout counts these steps (`PartyAssemblyRecovery`, 12 attempts) | none | parties assembling, full bags |
| Decision deadlines | 64 per scheduler tick | Kernel `tick` ~1700, `dueCandidates` ~1217 | rest wait for the next 20 ms tick | none | boot catch-up |
| Incremental snapshot row | 256 KB message | Coordinator `sendIncrementalEntries` ~1129 | page refused, job ok:false, oldest-first queue stops at that row each run | dD `send_failed` | rare huge state |
| Cold competition gate | DB queue 0 and lag < 40 ms | Coordinator `canRun` ~204 | cold PvP competition work waits behind any DB write, a drain between its slices too | none | with a busy DB |

## Economy and board

| Limit | Value | Where | When hit | Observable | Binds at |
|---|---|---|---|---|---|
| `ColdEconomyPlan.MAX_BYTES` | 768 B; shot 128 | ColdEconomyPlan ~5, ~192, `fit` ~232 | oversize buy batch dropped first; then `fit` drops sells, withdraw, travel, shot, buy batch; then throws `economy_plan_payload_overflow` | dD (`economy_plan deferred bytes_*`) | rich bot, 8+8 lines |
| Decision card | 800 B | ColdEconomyDecision ~59, ~524 | card dropped (null), rebuilt | dD `card drop oversize_card` | per bot |
| Restart decision | 1 KB deflated / 16 KB | EconomyRestartDecision ~6, ColdEconomyDecision ~538 | not saved; rebuilt at restart | dD `card restart oversize` | each restart |
| `EconomyCommit.MAX_ACTIVE` | 64 | EconomyCommit ~8, ~65 | throws `economy_admission_pressure`; `NpcPurchaseBasket` turns it into a refusal reason, others catch generically | reason; log / dD per caller | DB stall |
| EconomyContext retain | 2048 worker / 64 main (`RETAIN_LIMIT`) | EconomyContext ~59, ~1654 | evict → full rebuild | dD `context eviction capacity` | > 2000 / > 64 hot |
| Group / proof | 256 groups (`GROUP_LIMIT`) / 64 KB (`PROOF_RAW_BYTES`) | EconomyContext ~54, ~76 | evict; proof → null | dD `context proof` | > 256 parties |
| Kept gear candidates | 1024 numbers (8 KB) per list (`KeptGearCandidates.RECORD_SLOTS`), 2 lists per held build (full review, quiet build); a full review takes ~230-730, a quiet build ~20-70, plus 3 refs per offer asked (≤ 2 seen); held on the worker: 2048 builds (`RETAIN_LIMIT`) ≈ 5-14 MB typical (~0.3 KB headers per list), 32 MB of numbers worst (main: 64, ≤ 1 MB) | KeptGearCandidates ~42 | the list is weighed again at every build | dD `projection gear_unkept size` | bots weighing > ~90 candidates or pricing > ~300 kit items |
| Kept source facts | 24 facts in 288 numbers per bot (`KeptSourceFacts.LIMIT`, `RECORD_SLOTS`, ~2.3 KB; a fact with its answer and n crowd reads takes 9 + n); a fact that read > 32 spots (`MAX_CROWD`) is not kept | KeptSourceFacts ~36 | facts past it are walked again at the next build | dD `projection unkept cap`, `unkept crowd_size` | bots asking > 24 source facts (high-level crafters) |
| WishNetwork | 12 roots / 40 nodes / depth 6; proof 1024 rows 8 KB; 64 actors | WishNetwork ~10, ~25, ~396 | pending / null; rebuild | dD | crafters |
| WishProviders top-K | 8 gear finalists per slot; 12 roots (`WISH_ROOTS`, also caps producer pricing); 4 gear roots × 4 rounds, 3 producer roots; 5 public + 5 fixed bids/offers per item; 4 paths per node | WishProviders ~30, ~35, ~726, ~750, ~794 | tail invisible | dD / none | items with > 5 buy lines |
| Sale candidates | 8 (max 20), highest unit price first; StaticBuyer 20 then materials only; town choice 8 | `ItemDisposition.saleCandidates` ~601, StaticBuyerService ~35, MarketTownPolicy ~219 | cheapest stacks never sold | none | > 8-20 stacks |
| Rival window | 20 rivals out of the first 40 sell lines of one item, all towns (`RIVALS_SEEN`) | PriceDecision ~29, `marketFor` ~203, `chooseAsk` ~287 | forecast unknown → new ask at NPC buyback (accepted lines keep price); stock quote price null (MarketPricing ~193) | none | > 40 lines per item |
| Scan windows | quote depth 5; 20 inspected (`ReadyTradeChoice`, `BidPurchaseAlternative` ~30, `MarketPricing` ~124, `WishPurchaseEvidence` ~21) | PriceDecision ~126, ReadyTradeChoice ~7, `BoardIndex.heads` ~528 | no or worse ready trade; own/rejected lines count against the window | none | busy items |
| Earning spot crowd key, own spot | the pick's own hunters bounded up to 64 past the search's count (`crowdKey`'s halving search for `most`) | EquipmentIncomeRoute `crowdKey` | past it the pick's own crowd is unbounded: the key keeps every candidate that could score above zero (a larger key, the same answers: at most the search's pool, 2 × (64 listed + sampled) models; 1-7 measured on the real catalogue, levels 20-40) | dD `income_crowd:unbounded` | a held spot no competitor can take with 64 more bots on it |
| Market watch | 20 rows (`MARKET_WATCH`) | DecisionSections ~332 | moves past 20 missed | none | per bot |
| `Hunt.MAX_SPOTS` | 8 | BotHuntEfficiency ~8, ~100 | oldest dropped | none | 8 spot/kit changes |
| Warehouse index | 64 kinds; 8 owners per pass | PersonalWarehouseIndex ~11, ~41 | cut on every publish: lowest selfIds at init, table order (no ORDER BY) on refresh; the rest invisible to the economy | none | long-lived bots |
| Board per bot | 3 shop lines, 5 sell, 5 buy ads, 1 order | BoardRules ~16, Database ~3695, ~4039 | `board_cap_reached` | reason; dD | per bot |
| Plaza | 40-unit grid; Giran ≈ 1.8k, Gludio ≈ 280 (square sizes; after geodata filter not verified) | ShopPlaces ~20, ~509 | `plaza_full:<town>` | reason | Gludio |
| Cold buffs | 6 sales / 60 s world | ColdBuffService ~6, ~70 | `sale_limit`, discarded by the Coordinator (~2072) | dD (`dropped`, reasons not split) | ~10 providers |
| NPC basket | 12 lines (NpcPurchaseBasket); restock 12 (NpcRestockPlan); funding 8 rows (PurchaseFunding `PACKET_ROWS`) | NpcPurchaseBasket ~6, NpcRestockPlan ~9, PurchaseFunding ~219 | throw `invalid npc basket` / extra lines skipped / tail merged into last row | throw / none | many consumables |
| Arrow stock (bots) | one grade, ≤ 2000 and below the first weight penalty (`ArrowStock.MAX_AMOUNT`, `ceil(maxLoad / 2) − 1`); 500 kept however heavy the bag (`KEEP_FLOOR`) | Inventory/ArrowStock ~12, ~15, ~51 | a purchase above it: planners size it down (`admitted`: wish evidence, NPC basket `no_units` dD, bid) or none; the cold gate and writers refuse with `arrow_stock_limit` (reason; a field take returns it as `tradeDeferred`); the surplus is sold to the NPC | reason / dD | archers |
| Companion unload retry | 5 min (`CompanionInventoryCleanup.RETRY_MS`) | AI/CompanionInventoryCleanup ~9 | an overweight companion with no arrows the NPC sale takes and nothing to store, no town target, a visit that sold or stored nothing, or a bag still heavy after it waits 5 min | none | overweight companions |
| Buyer retry | 15 min after a visit found no affordable offer, or the offer changed or the purchase failed (`ColdMarketService.RETRY_DELAY_MS`, stamp `marketRetryAfter`) | ColdMarketService ~39, GoalExecutor `beginMarketTravel` ~43 | no buy trip for that item; a new offer of the plan's target within the bot's budget wakes it and lifts the stamp (`MarketBuyerWaiters` → the lifecycle command's `marketWakeup`, the offers that woke it; `PopulationService` `wakeLiftsMarketRetry`), a wake for another wanted item (shots, a recipe) leaves it; a wallet that grows past an offer already listed has no event and waits the 15 min | MarketTelemetry `noOffer` / `offerChanged` / `purchaseFailed` | every failed visit |
| Wish-only market want | 30 min (`MarketDemandIndex.WANTED_TTL_MS`); a want the equipment plan backs, a shot stack and a shot recipe live until their clear events (arrival, plan drop, stock reached, recipe learned or dropped) | MarketDemandIndex ~9 | the want leaves the bot's own/group demand and its buyer wake, though the wish may still want the item (missing event: ECO-16) | dD `market_want:expired_read:wish_only` (per read) | wish purchases waiting > 30 min for a seller |
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
| Held forming verdicts | 256 rosters per hold (`FORMING_HOLD_LIMIT`): main's asks (keyed on the members' sources) and each thread's verdicts (keyed on what the comparison reads) | PartyGoalPolicy `formingHold`, PopulationService `formingVerdict` | oldest roster dropped; asked or judged again on its next attempt | dD `forming_verdict:evicted` (`held` / `judged` beside it) |
| Party route set aside | 1 h (`PARTY_ROUTE_RETRY_MS`), beside its wake (level, weapon grade, party): who could join has no event | GearAcquisitionPlanner ~60, `replanContextFor` | the target's `party_route_unavailable` entry ends, the route is planned again | none |
| Party solo searches | 2048 bots (`SOLO_SEARCH_LIMIT`), the least recently read out; each kept while its inputs stand (the earning hold's rule: versions, prices, frustration range, crowd key), its route trimmed as the hold's (`EconomyContext.searchInputs`: spot, row, earning): ~5 KB a bot, ~11 MB full (save 312ebb2e) | PartyIncomeComparison `soloChoice` | searched again at the next read | dD `party_solo_search:evicted` |
| Party affinity | 16 peers (strong 8) | BackgroundPartyAffinity ~1 | forgotten | none |
| ClanPartyHelp | 64 pending; 8 parties per request; TTL 10 min, retry 30 s | ClanPartyHelp ~25, ~90 | request refused silently | none |
| Opportunistic raids | 2 parties, 15 min, search 60 s; per search 8 rosters, 72 bots, 12 forecasts, 12 ms CPU in 2 ms slices (`RaidSearchCounters`) | PopulationConfig ~14, OpportunisticRaidDirector ~105, RaidSearchCounters ~3 | skipped / retry 10 s | status |
| Party ground loot retry | 500 ms per party (`GROUND_LOOT_SCAN_INTERVAL_MS`), only while the party has drops of its own on the ground (`GroundItems.ownedBy`) or a pickup queued; a new drop is queued at spawn and a finished pickup reconciles, not on this clock. A window: what frees a waiting drop (combat end, a picker walking back into the leash) has no one event | PartyCompanionService `reconcileGroundLoot` | the drop waits for the next try | none |
| Party threat projection | 150 ms per leader (`THREAT_PROJECTION_MAX_AGE_MS`), also dropped on a hit, an NPC target change (`World.npc.threatRevision`, world-wide), a login/logout, the threat's death or retarget. A window: member, NPC and player moves have no event (debt AI-14) | `PartyAwareness.findThreatTargetingPartyProjected` | a party reads a threat up to 150 ms old | dD `partyThreatScan` / `partyThreatCacheHit` |
| Supply errand return | 4 hot writes (`SUPPLY_RETURN_ATTEMPTS`) 5 s apart (`SUPPLY_RETURN_RETRY_MS`), each from the latest cached row, while the return is still `returning` with the same actor; timers cleared at shutdown | BotTownTravel `returnSupplyHot` | the companion stays parked up to ~15 s, then resumes with its row cold (the old behaviour) | status `swallowed=` (`population.mark_hot`, `population.supply_return_cold`), first logged |
| Clans | 40 bot clans (`CLAN_SIMULATION_MAX_BOT_CLANS`); 70 % of the generated bots in clans, counted from `bot_party_candidate_projection.ordinaryEligible` (a bot under a player party takeover counts in neither number); 10/15/20/30/40 per clan by level | Database `createAutonomousClan` / `joinAutonomousClan` (`botPopulationUnsafe`), ClanSimulationConfig ~5, ClanRules `memberLimit` ~19 | `founder_clan_limit` / `founder_population_limit` / `join_population_limit` / clan limits | reason; dD |
| Clan action pass | 8 actions, 80 ms / 20 ms with a player, 60 s | ClanSimulationConfig ~35, ClanActionService ~714 | next pass | dD |
| Founder pass | 16 per 60 s; 20 ms, 5 ms with a player | ClanSimulationConfig ~36, ClanSimulationService ~351 | deferred | dD |
| Source index overlays | the selected source index of the catalogue rows, once per row list; 8 raid overlays on it (`MAX_OVERLAYS`) | Knowledge/SourceCatalog `overlayIndexFor` | the oldest overlay is rebuilt (a few raid rows) | none |
| Clan spot decorations | 4 restored decorations per catalogue row (`MAX_DECORATIONS_PER_ROW`) | Clan/ClanSpotCatalog `decorated` | the oldest dropped: a repeat is a new row and its source overlay is rebuilt | none |
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
| Hot LOD | full ≤ 3500, exit 4000; ticks 3/7/30 s; far-visible tick budget 6 ms; visible combat full while its stance lasts (15 s after the last blow, `CombatStance`), no hold after it; a player interaction holds full 8 s after it ends (`PROMOTION_HOLD_MS`, our hysteresis: a wake-only promotion such as a selection or a party PvP hit has no end event); player damage counts as recent for 10 s (`PLAYER_THREAT_HOLD_MS`: the victim gets no stance of its own, so no end event); `session.botStatus` rebuilt every 3 s full / 15 s visible (a window: its inputs have no revision, debt AI-15) | HotActorLodPolicy ~5 | lower detail | dD |
| Spot room | explicit `spot.capacity` (only raid sources: 999; raid boss spots ∞), else clamp(round(density × 0.75), 9, 36); own spot always has room | LevelingRoutes `capacityForSpot` ~259, `roomForSpot` ~271, SpotProfiles ~162 | full spots skipped, bots go off-band | dD (`spot_list skip full`, `farmCapacity` in the dD summary) |
| Effects | 20 buffs + 10 debuffs (extra debuffs take buff slots); skill cache 20000 keys (`RESOLVED_LIMIT`) and its field index 20000 entries (`resolveCached`) | EffectStore ~2, C4SkillRules ~1326 | oldest buff removed; skill cache full: both cleared; index full: the index alone cleared (the next calls rebuild it from the cache) | none / dD (`skill_rules:cache:clear`, `skill_rules:field_index:clear`) |

## Persistence and DB

| Limit | Value | Where | When hit | Observable |
|---|---|---|---|---|
| Main DB queue | unbounded; the drain yields with setImmediate after 12 ms of jobs in one turn, an awaited chain too (`DB_QUEUE_SLICE_MS`, also the `cooperatively` default; a slice ends at the next event-loop boundary); a job is never split | `src/Database.js` `enqueue` ~318, `afterQueueJob` ~192 | latency grows; between slices `pending()` shows the backlog (governor bound 8; party formation, clan help, clan wars, raids and the native raid opening wait for it, `database_busy`); a single job past 12 ms holds the event loop for all of it (perf runs 29ae424cd: the cold commit batch up to 46 ms, ~120 per 10 min without a player; the clan join/found population count ~100 ms) | dD (`dbQueue` in the dD summary); `stats().queueYields` always; a job past the slice always: `stats().overBudgetJobs` (op: count, max, total ms), status `dbOverBudget`, perf report |
| Busy timeout | 5 s (PRAGMA); checkpoint 250 / 50 ms (WAL truncate 20 ms with a player) | Database ~4452, `src/DatabaseCheckpointWorker.js` ~10 | transaction rejected | log |
| Final checkpoint at shutdown | 3 s (timer cleared when the checkpoint answers) | `src/DatabaseCheckpointCoordinator.js` `stop` | `checkpoint_shutdown_timeout`, the worker is terminated | result only |
| Passive checkpoint | WAL ≥ 4 MB, 5 s | DatabaseCheckpointCoordinator ~7 | skipped | dD |
| WAL truncate | 256 MB, +64 MB, 60 s cooldown, 5 s retry (`[Database] checkpointReset*`), tried when a passive checkpoint finishes (`armWalReset`, 5 s) that checkpointed every frame, none in flight; governor job `wal_truncate` (resource `db_maintenance`) asks the last completed truncate's hold on main's DB queue (queued to resolved; a busy or failed try keeps it; at least the busy timeout; 40 ms before any); busy timeout 20 ms with a player, 50 idle; with a player an estimate over the 50 ms player budget is skipped, but tried once every 10 min (`WAL_TRUNCATE_ESTIMATE_RETRY_MS`; the new measurement replaces the estimate) and run regardless past a 512 MB WAL (`WAL_TRUNCATE_FORCE_WAL_BYTES`; admitted past the governor's budget, queue and the cooldown, charging what it takes; only a checkpoint in flight or an incomplete passive one holds it; the size bounds the file whatever the write rate, the 10 min period alone would let ~550 MB grow at ~55 MB/min); with a player and the governor off, refused | `PopulationService.runAdaptiveWalReset` ~2784 | skipped, retried at the next passive checkpoint | status `maintenance.refusals` `wal_truncate:<reason>` (`estimate_over_budget`, `estimate_retry`, `forced_over_ceiling`, `governor_off`, `governor_<reason>`, WAL gates), `checkpoint.lastResetAttempt` (perf report); failure `db.wal_truncate` (FailureLog) |
| State retention | 1 s, one policy step per run (≤ 2 statements, each bounded: ≤ 64 deletes, ≤ 2048 rows walked or 1024 index entries ranked); governor job `state_retention` (resource `db_maintenance`) asks 12 ms, at least 4, the slice is the grant; waits at lag ≥ `schedulerLagThrottleMs` (40 ms); with a player and the governor off, refused; 60 s pause after a pass that removed rows, 10 min after one that removed nothing (`stateRetentionIdlePauseMs`; not a wait for a server without players: nothing here waits for one) | PopulationConfig ~116, `PopulationService.runStateRetention` ~2866, `PersistentStateRetention` (`WALK_ROWS`, `GROUP_WINDOW_ROWS`) | deferred to the next 1 s alarm | status `maintenance.refusals` `state_retention:<reason>` (perf report); failure `db.state_retention` (FailureLog) |
| Retention caps | activity 100k; tool 50k; LLM 50k; conversation 512; 30 days; 128 rows per pair (PopulationConfig keys, e.g. `activityJournalMaxRows`); a table cap walks 2048 rows per step before it deletes (100k rows: ~50 steps, one per policy round of ~10 s) | PersistentStateRetention ~21 | only when retention runs | dD |
| Safety sweep | 64 rows/page, 30 min, 240 KB repair | LifecycleSafetySweep ~6, ~109, ~216 | cycle stretches; oversized repair edge skipped, retried after 30 min | dD `deferred` |
| Party history purge | 1000 (max 5000) / h (`partyHistoryCleanupIntervalMs`), 24 h | ColdSimulationCoordinator ~345, BackgroundPartyState ~335 | backlog grows | log |
| History transfer | 1000 / batch every 200 ms, loops until a short batch; failed row skipped forever | `src/HistoryWorker.js` ~19, `src/HistoryDatabase.js` ~162 | — | log (first 5 errors per batch) |
| History retention | 5000 / table / min (`RETENTION_BATCH`, history worker) | `src/HistoryStore.js` ~26 | next minute | none |
| Statement cache | 256 statements per connection (a text's native-number and BigInt statements share one LRU entry); SQL > 16 KB uncached and clears the connection's cache (debt.md) | `src/DatabaseStatements.js` ~9 | re-prepare | none |
| Lifecycle save texts | 64 (2^5 held column sets × native/plain RETURNING), ~9 KB each (~0.6 MB), of the one BotLifeState save text; another base text clears them (only tests alternate) | `src/Database.js` `heldRowSaveSql` | — (bounded by construction) | none |
| Knowledge base detail caches | game dialogs: `listItems` 64, `itemDetail` 64, `npcDetail` 256 results (LRU, all cleared when the rate profile changes); the observer has none | `World/Generics/NativeKnowledgeBase` `cachedService` | evict: the next `npcDetail` reads the mob record and its spawns from disk again (~0.1-0.4 ms); `itemDetail` reads no record (adena ~10 ms of reward math) | none |
| Knowledge base file handles | 3 per data directory (items, mobs, spawns JSON), open for the process | `src/WorldObserver/KnowledgeBaseRecords.js` `openRecordFile` | — (a failed record read, e.g. an id that differs from the one scanned at load because the file changed in place, throws to the caller, which answers unavailable) | FailureLog `knowledge.record_read`; a failed load closes its descriptors |
| Char write-behind | 750 ms, batch unbounded | CharacterWriteQueue ~4 | a failed batch is written again per character (good ones commit); a bad value (TypeError, SQLITE_CONSTRAINT) drops that character's patch, any other fault puts it back for the next tick (retried while the fault lasts) | log + `swallowed=` (`db.buffered_character_dropped` / `_retry`, timer `db.buffered_character_flush`) |
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
