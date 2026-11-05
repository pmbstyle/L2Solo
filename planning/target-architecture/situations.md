# Decision cadence: one situation mechanism

Design for the first item of the next release (planning/target-architecture/plan.md §4.2). Read-only survey of
`ivan/batch-5` at 7195d7f30 → 1247f9f2c (2026-11-05). Line numbers drift: search by name.

**Measurements.** Window deltas (10 min after the 5 min warm-up) of the worker counters in the perf timelines:
`0ff31aa96-hot-20261105-122723` (diagnostics on, 1735 cold + ~116 hot, 2 players), `29ae424cd-hot-20261105-012849`
(diagnostics on, before the release regression), and the cold runs `0ff31aa96-cold-20261105-115501` / `-121112`,
`29ae424cd-cold-20261105-011241` (diagnostics off: `incomeHold`, `buildDoors`, `raisedLinks`, `soloWindow` only).
"Per bot per hour" = window count × 6 / 1781 (all bots) unless it says per cold bot (÷ 1665-1735) or per hot bot
(÷ ~116). The script: `/private/tmp/claude-501/-Users-iposukhoff/ccdcd884-781f-4077-b3a8-6e40e7bac0d2/scratchpad/situations/deltas.py <run> <counter path>...`;
the 0ff hot run's worker diagnostic counts (window delta) are in `.../situations/hot0ff_counts.json`.
CPU shares are the census numbers (target-architecture §2, 29ae424cd cold, 35.7 s worker CPU per minute).

## 0. Summary

- The worker re-decides far more often than a player would. Per bot per hour today: **28.7 earning spot
  searches** (0ff; 18.4 in 29ae), **11.5 full economy builds** per cold bot (62 per hot bot), 100 held-plan verdicts
  and 44 soft points, 27.6 action-plan asks, 11.8 showcase asks, 16 workshop asks, 56 route-row asks, ~400 sale
  dispositions, and in a cold run 17.7 party-side reads of the earning spot of which 9.7 search for themselves.
- Most wakes come from inputs a player does not react to: the crowd at other spots (11.1 searches/bot/h), the bot's
  own arrival at a spot (4.2), prices (2.3), sampled spot ids (2.1), the money weight (0.9), money drift (1.6-2
  raises), hunt samples (2.4-2.8 raises), market crossings (0.4-1.2), new loot (9.2 action asks), the per-step
  route-row ask.
- C4 situations happen ~4-6 times per bot per hour on this save (level up ~1.4, town visit ~1.5-3, rest end is our
  choice, gear change, death 0.02-0.09, goal reached/failed, party, crowded/empty/dangerous own spot).
- Proposal: **one module, `Bot/Situations.js`** (grown out of `Economy/Reaction.js`), holding the catalogue (each
  situation's owner, payload and where it is heard) and the decisions' declarations (which situations wake each).
  A bot's woken decisions are bits in its stats, written only by `Situations.raise` (both threads), consumed only by
  the worker's decisions (`Situations.decided`). No input versions, intervals or replays for decisions; exact keys stay
  only for caches of pure calculations (matchup, damage, route rows, prices).
- Expected: worker **−13 to −14.5 s CPU per minute of 35.7 (−37-40 %)** on the 29ae census, −18-20 s on 0ff;
  worker heap −15-25 MB; main loses the per-tick wallet check and ~90 % of near rebuild traffic.

## 1. Decision inventory (today)

Rates: per bot per hour, 0ff hot diagnostic window unless noted.

| # | Decision | Owner (file) | What it decides | How it is held and woken today | Rate today |
|---|---|---|---|---|---|
| 1 | **Earning spot** (held income search) | `Economy/EconomyContext.js` `incomeRouteFor` ~990, `holdRead` ~1123, `holdCheck` ~1168, `incomeMoved` ~1068; `Economy/EquipmentIncomeRoute.js` `search` ~42, `standsMoved` ~337, `crowdKey` ~600, `crowdStands` ~738 | Where the bot earns: spot, income row, hour | Hold = the last search's answer + its key: 15 discrete input versions (`DecisionSections.LINK_INPUTS.incomeSearch` ~127, `VERSIONS` ~202), the money weight/hour inside the weights the answer stands over (`weightBounds` ~1538), the `observation` bit, and the answer's "stands": price hull, frustration range, crowd key replay. Read at every build, basics and served build (`holdCheck`); a moved hold sets `hold.moved` and the verdict refuses with `income_moved` (~318). | **28.7 searches** (8509 / 10 min, 53 s CPU in the diag run); by first moved input: crowd 11.1, spot 4.2, kit.level 2.7, prices 2.3, samples 2.1, kit.worn 1.9, weight 0.9, observation 0.5, economic 0.4, exclusions 0.2, recovery 0.14. Reads: kept 28, moved 31, renewed 10.6. 29ae hot: 18.4 |
| 1b | Party solo side (a second earning hold) | `Population/PartyIncomeComparison.js` `soloChoice` ~75 (`soloChoices`, `SOLO_SEARCH_LIMIT` 2048 ~18), read by `PartyGoalPolicy.verdictInputs` ~212 | The solo alternative a forming verdict compares | Reads the held earning spot (`heldIncomeRoute`, party read never searches); on a miss keeps its own search on the same key (`searchMoved`) + `observationChanged` | Cold run: 17.7 reads (partyKept 2351 + partyMissed 2892 / 10 min), the misses search. Hot run (player protected): ~0.2 |
| 2 | **Economy build**: wish projection, source facts, gear candidates | `EconomyContext.buildForState` ~1579 → `WishNetwork`/`WishProviders.build`; `GearAcquisitionPlanner.sourceFacts` via `WishProviders.sourcePath`; caches `KeptSourceFacts`, `KeptGearCandidates` | Focus, money queue, the leaf (hunt / shop / craft / sell / improve), what to buy where | The card path first (`ColdEconomyDecision.refreshAdvisory` ~686, called at `ColdSimulationWorker.js` ~1950): `heldBuildVerdict` (`EconomyContext.js` 255-452) refuses on raised bits (`wishDirty`), the decision echo, facts that moved and are heard here (`Sections.factEvents` + `Reaction.heard`), threat mask, crafter MP / hard money (`heldEventsQuiet` ~191), quantity bands (`bandsHold` ~167), own loss, bag quantity proofs, sale-list proof, the leaf's own check (`LEAF_CHECKS`), a moved earning hold. The held entry is also keyed on a hash of the facts (`inputName` ~164). Bits come from `DecisionEvents.raiseSections` ~185 over `DecisionSections.events` ~630 (hard facts), `softEvents` ~491 (money drift, goal, hunt samples, market watch) and `needsOpened` ~657, gated by place (`Reaction.LINKS` / `hears`). | **11.5 step builds per cold bot** (3400 / 10 min); **62 near builds per hot bot** (1202); 2682 served steps. First refusal: wish_dirty 65 %, check:filled 12 %, check:sale 7 %, quantity 5 %, income_moved 3 %, liquidation 2 %. Dirty bits: occupation 662, kit 560+, money 491, observation 383+. Verdicts computed: **100/bot/h**; soft points 44/bot/h. Source facts kept 5829 vs walked ~91k (moved ground 29k, hourAdena 26k, routes 18k) |
| 3 | **Gear acquisition plan** | `AI/GearAcquisitionPlanner.js` `replanContextFor` ~1516, `recoveryWake` ~207, `acquisitionCooldown` ~1454 (2-4 h craft stall), `PARTY_ROUTE_RETRY_MS` 1 h ~64; `AI/GearPlanSelection.selectAcquisitionPlan`; worker `nativePlanHolds` ~1291, `planSourceHolds` ~1278 | Target item, strategy (market / craft / drop / party), next source | Runs after every full build (`ColdSimulationWorker.js` ~2016). Between builds: the native facts (failure, invalid source, leveling recovery) each step; the plan's source re-judged when `spot:npc:level` moves (`plan_source` door); set-aside routes wake on [level, weapon grade, in party]; craft stall by time; party route by 1 h | = builds + `plan_source` 2.2/bot/h (first 401 + moved 265 / 10 min) |
| 4 | **Workshop** (occupation planner) | `EconomyContext.heldWorkshop` ~2481, `workshopKeyHolds` ~2445, `workshopKeyOf` ~2431; `Population/ColdOccupationPlanner.js` mode `occupation`; worker `stepWorkshop` ~841, `WORKSHOP_SERVE_MS` 30 game min ~241 / `servesUntil` ~339 | A crafter's best recipe and income per hour | Own key (`LINK_INPUTS.workshop`: route key, craft, class/level, recipes, max MP, the income answer, own lines, shot supply; money and observation bits); a card serves 30 game min; non-crafter without lines answered by `noCrafterWorkshop` | **16 planner asks/bot/h** + 3.4 no-crafter; link rebuilt 19.5/h, kept 3.3/h; rebuilt by route 10.3/h, maxMp 2.8, kit.level 2.2, income 1.9, money 1.4 |
| 5 | **Action plan** (field and town market moves) | `Population/ColdEconomyPlan.js` `prepare` ~125; wake `edges` ~30, `factEdges` ~40, `actionBaseline` ~73, `edgesSince` ~104; worker `askAction` ~804, `actionEdges` ~1258, `refreshCraftPacket` ~851 | Sell / list / withdraw / buy ads / shot craft / field take | Asked after the round when edge bits moved since the last committed ask: 1 new loot, 2 kit stock threshold, 4 money reached, 8 shop town reached, 16 level, 32 death, 64 craft MP band, 128 own line traded; plus every served step whose leaf is not hunting while the bot hunts (caller `card`, ~1995); plus the crafter MP band | **27.6 asks/bot/h** (8206): card 10.0, edges with new loot 9.2, town 6.1, level 2.1, stock threshold 1.2, craft MP 1.3, own trade 0.7, money 0.7 |
| 6 | Showcase | planner mode `showcase`, `ColdSimulationWorker.js` ~2064 | A shopping bot's display | Every shopping step | **11.8/bot/h** |
| 7 | Craft market (project bids, clan inputs) | `Population/CraftMarketReview.js` `personalBidDue` ~14, `clanInputDue` ~48; worker ~814, ~2071 | Bids for a craft project's inputs | Due when need rows, own bids, the best foreign ask/bid of each item differ from the last review; read every lifecycle step of a bot with a project | small (no counter) |
| 8 | Route rows (planner `wish`) | `EconomicTrip.key`/`routeInputs`; worker `occupationFor` mode `wish`, asked at **every step** ~1894 | Trip table per town (a pure calculation, not a decision) | Exact route key (activity class, region, loc, scroll, karma, return, travel) | **56 asks/bot/h**, 25 new builds (planner 7409, unchanged 4851, held 4519) |
| 9 | Sale listing / dispositions | `Economy/MarketListingPolicy.evaluate` (`rollFacts`, `holdKey`), worker `saleHold` | What to sell, list, NPC-sell, at what price | Inside the action/showcase plan; per item held on its key (bag units, board digest, deals, lot, exact money price, worth, own stock, route key) | **~400 item dispositions built/bot/h** (+72 kept): built 117900, kept 21268 / 10 min |
| 10 | **Party request** | `Population/PartyRequestPlanner.partyRequestForPlan` ~147 (`maxAgeMs` 5/15 min ~46, `cooldownMs` 5 min ~53, `expire` ~59) | Seek a party (objective, priority) | Re-computed on every full build; open request expires by age, rests by cooldown | = builds; 33 open requests at the end |
| 11 | **Party forming verdict** | `Population/PartyGoalPolicy.formingVerdict` ~268, `formingHold` ~155, `verdictInputs` ~212; asked by `PartyAssemblyEvents` → `PopulationService.runPartyAssemblyEvent` ~1746 | Which roster members accept | Held per roster on every member's level, class, kit, spot, effects, buffs sellable, summon MP, solo answer, wallet/onSpotShare within error (debt.md 23) | judged 22 / 10 min (hot run, protected); census 1.5 s/min in a cold run |
| 12 | Party session review | `Population/PartySessionReview.js` `assess` ~80, `due` ~211 (patience 8-22 min ~137, grace ~182, `PROGRESS_WINDOW_MS` 10 min ~7) | Stay or leave | Party resolve; deadlines from patience, grace and progress | committed 12 / 10 min |
| 13 | Party member goal review | `PopulationService.reconcileWorkerPartyGoals` ~476-500 → `GoalService.review`; `Goals/GoalPlanner.js` ~22 `nextReviewAt` = now + 60 s | A party member's market goal | 60 s window per member, or a cleanup need | small (few parties) |
| 14 | Clan duty | `Population/ClanPartyDuty.js` (`event_driven` wait, 30 s retry ~23); clan planners `ClanWarDirector` 60 s, `ClanGoalCandidateService` 30 s TTL, `ClanWarehouseService` 1 h; clan-level events `Clan/ClanReviewEvents.js` | Answer a clan call; the clan's own plans | Bot: waits for the row write; clan: its own event queue plus windows | — |
| 15 | Town errands, market visits | `Goals/NeedsEvaluator` → `GoalPlanner` → `GoalExecutor`; `GoalService.review` in commands (`PopulationService.js` ~3199, ~3522, ~3584); `ColdMarketService` buyer retry 15 min ~39; `MarketBuyerWaiters.recordChanged` ~88; `MarketDemandIndex` `WANTED_TTL_MS` 30 min ~10 | A far bot's trip goal, the purchase, the retry | At town commands and after recovery; retry stamp 15 min; buyer wake on a new or cheaper offer | — |
| 16 | Sale trip | `ItemDisposition.saleSeen` ~298 / `saleRetryHolds` ~304 / `inventoryCleanupNeed` ~318; `SurvivalFloor.forState`/`forActor`; hot `HuntingState.sellTripDue` ~102 | Go to town to sell | Bag full / overweight, held by the goods and buyers the last visit tried (no clock) | `need_bag` 0.04/bot/h; window end `supplies` 0.4 |
| 17 | **Kit and stock** | `EconomyContext.foundation` ~1236 (`restCapOf` ~1329, `foundationFromPlan` ~1334), `kitReader` ~912, `stockTargets` ~2230, `shotDemand` ~2247; `needsOpened` ~657; `bandsHold` | How much to buy; when stock forces a trip | Foundation rebuilt with the build; far field rebuild when an item hits 0 or potions fall below the survival line (`need_supply`); near bots on every band refusal | need_supply 0.17, supply 0.15 raises/bot/h; window end `supplies` 0.4 |
| 18 | Rest / regen | `AI/RestPolicy` (hot `RestingState`, cold `BackgroundResolver.resolveRest`) | Sit / stand | A per-round rule on HP/MP: a system, not a held decision | rest ends 3.2/bot/h, 6.4 per hunting bot-hour (soloWindow `rest` 945-998) |
| 19 | Retreat | fight rules: `BotEncounterReadiness`, `HuntingState` PK flee ~790, unsafe ground evacuation, `death_pressure_replan` (`DecisionSections.FORCED_TRIPS` ~704), `SpotRiskPolicy` marks | Leave a fight or a spot now | Per fight / per tick (systems); the leave-the-spot part reaches the decisions as `riskDeaths`, `recovery`, `occupation` facts | riskDeaths ~0.02, recovery 0.5 raises/bot/h |
| 20 | Dialogue | `BotManager.handlePlayerSpeak` → `BotDialogueArbiter`/regex; ambient `BotAmbientDirector` under `BotChatterBudget`; `HotBotPolicyOverlay` TTL 30 min | Answer a player; ambient lines | Player speech is an event; ambient has its own budget | out of scope (no economy decision) |

Also on the hot path, per tick: `HuntingState.tick` calls `DecisionEvents.checkWallet` (~712, every tick of a solo
hunter) and `ColdMarketService.canTravelForPurchase` for a shopping leaf (~777). Tactical hot rules (target choice,
`BotSupportPlanner` 0.25-1 s, `HotBackgroundParty` 2 s, party threat projection 150 ms AI-14, `botStatus` AI-15) are
systems, not held decisions: outside this pass.

What already works the right way and stays: the solo hunt window (`ColdSoloWindow.endOf` ~83) ends at real moments
(rest 3.2/h, level 1.3/h, supplies 0.4/h, event, death); the room check at arrival (`ColdSimulationWorker.soloArrival`
~1409, `partyArrival` ~1440; 8.9 arrivals/bot/h, 13 full in 10 min); event waits (`lifecycleKind` `event_driven`);
`PartyAssemblyEvents`; `MarketBuyerWaiters`; `ClanReviewEvents`; the sale retry on goods and buyers.

## 2. When a C4 player takes each decision

"C4" = a fact of how a C4 player plays (L2J Lisvus / Mobius have no bot planner; this is player behaviour, so every
row is ultimately a design choice, marked "ours" where it is a modelling choice beyond plain play).

| Decision | Wakes it (C4) | Wakes it (ours) | Read when it decides, never wakes it |
|---|---|---|---|
| Earning spot | level up; new gear worn (weapon/armour/enchant, class change, new skills); death (and its exp loss / recovery cap); own spot crowded (no free mobs), empty (nothing it can kill), dangerous (deaths there, a PK); joined / left a party; moved by the world (fled, pushed out, called by the party); shots or the planned shot kind ran out | hunt disappoints (own income far below the expectation after a stay, Q2); death recovery lifted (clean wins) | prices of shots/potions, crowd at other spots, money and the money weight, sample ids of other spots, risk marks on other spots, frustration, spawn table revision, adventurer flag |
| Economy build (wish, gear plan, party request) | arrived in town (the shopping moment); level up (a new grade or level gear opens); gear acquired or lost; goal affordable (the wallet reached the focused goal's price); goal done (own order filled, material count reached); goal failed (offer gone, too short, refused at the act, source unkillable); died; stock below its line (§5); bag full; clan call (clan asks for a material or a duty); party joined / left | own spot empty (its leaf cannot stand) | prices and board offers, bag counts above the stock line, money drift, own samples, the earning spot's new hour (Q10), friend/enemy bonds (Q13), threat mask |
| Gear acquisition plan | with the build; plus its source failed (died there / cannot kill it / party route impossible) | no progress after N kills of the source (Q9, instead of 2-4 h) | — |
| Workshop (crafter) | arrived in town; recipe learned; level up / craft level up (MP cap); own product sold (line traded) | — | route rows, wallet, income, MP within a band, demand forecasts, board quotes |
| Town plan (action, showcase, listing, buy ads, kit amounts) | arrived in town; own line traded while there; a step of the visit's agenda done or failed (execution) | — | everything (it is taken once per visit on what it reads) |
| Field trade | another's trade request (a meeting) | — | new loot, own lines (Q6) |
| Party request | goal needs a party; no solo ground; clan call; party ended; died | patience out (a wait's known end, Q9) | others' wallets, crowd |
| Party forming (roster) | a member's level up, gear change, death, leaving; the objective moved | — | wallets, time on spot (debt.md 23 goes) |
| Party stay | party goal done; no exp / progress; a member left or died; clan call; bag full / stock low | patience / grace out (known ends, Q9) | relation decay |
| Kit and stock (§5) | in town: amounts from rates + bag + wallet; in the field: the live count crossing the return line (one hour of use) | — | prices outside town |
| Rest, retreat in a fight | per round (systems) | — | — |

## 3. The situation catalogue

Contexts: **C** combat, **E** economy/market, **P** population/life, **G** party & clan, **W** world/travel.
Heard: **now** (every place), **stop** (a far bot hears it at its next rest end or town arrival: today's
`Reaction` WORK/VISIT waits), **town** (on arrival in town). Own = the bot's own output (must not wake the decision
that produced it).

| Situation | Ctx | Raised today (file:line) or missing | Payload | Hot raiser | Cold raiser | Heard | Wakes |
|---|---|---|---|---|---|---|---|
| `level_up` | P | inside the `build` fact (`DecisionSections.factEvents` ~727, kit hash); window end `level` (`ColdSoloWindow.endOf` ~85); hot post `level` (`Actor/Generics/LevelUp.js` ~48) | level | LevelUp post | prepareResolve detect | stop | earning spot, build, workshop, party request, forming |
| `gear_changed` | P | inside `build` (worn, hennas, skills, class, capture); hot post `equip` (`Actor/Backpack.js` ~49); training review | parts that moved | Backpack post | detect | stop | earning spot, build, workshop, forming |
| `recipe_learned` | P | `recipes` fact (~728) | recipe id | post | detect | stop | workshop, build |
| `died` | C | `dead` fact (~726); hot `Die.js` ~89 | spot, killer kind | Die post | detect | now | earning spot, build, party stay, forming |
| `revived` | P | `DecisionEvents` reason `revived` (`BotAI.js` ~628); `Revive.js` ~28 | town | BotAI | respawn = `arrived_town` | now | (as arrived_town) |
| `recovered` | C | `recovery` fact down (~739; `SpotRiskPolicy.recordRecovery`) | level cap | detect | detect | stop | earning spot |
| `spot_crowded` | W | arrival only: `soloArrival` ~1409 / `partyArrival` ~1440 (`ROOM_SECTIONS` = `Reaction.LINKS.crowded`); **missing while hunting** (Q3) | spot, hunters, room | `SpotService` crowd look (missing) | arrival check; occupancy crossing (missing) | now | earning spot |
| `spot_empty` | C | `unhuntable`: `BackgroundResolver.resolveSolo` → `events` ~651; hot `BotDecisionService.js` ~71 | spot | BotDecisionService | resolver round | now | earning spot, build |
| `spot_dangerous` | C | `riskDeaths` (~735), exclusion marks `SpotRiskPolicy` | spot, deaths | detect | detect | now | earning spot |
| `moved_by_world` | W | `occupation` fact when not planned (~734, `occupationPlanned` ~685, `FORCED_TRIPS` ~704) | reason, spot | detect | detect | now | earning spot |
| `arrived_spot` | W | **own** (leaf's own trip); today moves the search's `spot` version (4.2 searches/bot/h) | spot | `SpotService.js` ~625 `near_spot` | resolveTravel | — | nothing but the arrival room check |
| `arrived_town` | W | hot `ShoppingState` `raiseDecision('town')` (~390-1227, 10 sites), `BotMerchantStoreService.js` ~122; cold `Reaction.place` OPEN on the arrival step (~26), action edge 8 | town | ShoppingState | detect (activity → shopping) | now | build, town plan, workshop, craft market |
| `stock_low` | E | `need_supply` (`needsOpened` ~657: an item ran out or potions below the survival line); §5 moves it to the one-hour return line | kind, item, count, line | post `bag` → detect | detect | now | build (supply root, mandatory for survival items) |
| `bag_full` | E | `need_bag` (~665) | slots, weight level | post `bag` → detect | detect | now | build (sale trip), party stay |
| `goal_affordable` | E | soft `goal` (`goalReached` ~355, `softEvents` ~505) | goal key, price | wallet change on main (missing as a named raise) | detect (wallet vs `goalBudget`) | now | build |
| `out_of_money` | E | hard `funding` (`moneyChanged` hard part ~338, `fundingMark` ~316) | — | detect | detect | now | build |
| `goal_done` | E | leaf checks `filled`, `material_done` (`EconomyContext.LEAF_CHECKS`, refusals ~438), own line fills (action edge 128) | item, units | ShoppingState / executor | `executePlan` result, board settlement | now (in town), stop (field) | build, town plan, workshop (own product) |
| `goal_failed` | E | `rejected` (`DecisionEvents.rejectedState` ~77, `rejectSession` ~112; `BotAI.js` ~134, `BotImprovementService.js` ~132, `HotWealthCraftService.js` ~61/73); leaf checks `offer_gone`, `short`, `offer_price`; gear plan failures (`replanContextFor` ~1532) | item, why | executors on main | executors / worker replan | now | build, gear plan |
| `trade_request` | E | door `meeting_prepare` (`Reaction.DOORS` ~136) | deal | — | meeting | now | field trade (reads the held plan) |
| `party_joined` / `party_left` | G | `party` fact (~730); `HotPartyLifecycle.js` ~386 `relations` | party id, role | HotPartyLifecycle | BackgroundPartyState row | now | earning spot, build, party request |
| `invited` | G | `BotAvailability.evaluate`/`evaluateState` at the ask | inviter, objective | player invite | `PartyAssemblyEvents` | now | party request (accept), reads the held plan |
| `clan_call` | G | `stores` fact (~744: clan demand/supply identity) and `ClanPartyDuty.objective` | goal key, item | — | row write on main | stop (now for a required duty) | party request, build |
| `clan_changed` | G | `relations` fact (clan part, ~729) | clan id | — | detect | stop | build |
| `patience_out` | G | `PartyRequestPlanner.expire` (age), `PartySessionReview.due` deadlines, `PartyAssemblyRecovery` | wait kind | — | kernel due at the known end | now | party request / party stay |
| `goal_moved` | E | `Reaction` `goal_moved` from main's `GoalState` (`Reaction.goalMoment` ~156) | — | — | goals table | stop | build (until AI-5 is paid) |

**Removed as wakes (read when deciding):** money drift (`softEvents` money, `meaningfulMoney` ~362), hunt samples
(`observation`, unless Q2 b), market watch (`marketCrossed` ~517), threat mask, `bands`, `quantity`, `liquidation`,
`own_loss` (covered by `died`), `crafter_mp` (an execution check of the craft, not a decision), funded-row crossings
of the money mark beyond the focus, `relations` friend/enemy targets and bond (Q13), `supply` presence flips (become
`stock_low`), crowd and prices at other spots, the search's own `spot`/`samples`/`weight`/`hour`, new loot in the field
(action edge 1).

**Own outputs (raise nothing for the decision that made them):** `arrived_spot` on the leaf's trip, `income_moved` /
`income_later` (a search's own answer), `own_move`, `own_preparation` (`DecisionEvents.applyOwnRaise` ~42; callers
`ColdShotEconomyService.js` ~198/~366, `ColdWealthCraftService.js` ~98), `warehouse` (own deposits), the money weight
(ECO-15), a party request, the bot's own board lines (a crafter's), its own purchase arriving.

**Situations with no event yet (debt lines with the reason):** crowding while the bot hunts (Q3; today only the search's
crowd replay hears it); a far bot's own pull to another spot (ECO-10); a recruit pool that could now form a set-aside
party route (`PARTY_ROUTE_RETRY_MS`, existing debt line); main's goal leaving an item (ECO-16, `WANTED_TTL_MS`).
Paid by this catalogue: debt 21 (beginner shots: `stock_low` per §5), debt 24 (buyer wallet: `goal_affordable`),
debt 23 forming wallet drift, debt 25 (workshop decays: workshop not woken by time).

## 4. The one mechanism

### 4.1 Survey of the pieces

| Piece | What it is | Fate |
|---|---|---|
| `Reaction.LINKS` (~50-129), `place`/`hears`/`heard`/`raise`/`woke` (~21-183), `DOORS` (~136) | Already a catalogue: name → sections woken + places it waits at; doors say who may make a bot decide | **Becomes the catalogue** (`Bot/Situations.js`): rows renamed to situations, sections replaced by the decisions they wake, places kept, doors kept (a reader reads the held answer, only a situation decides) |
| `DecisionSections.SECTIONS` + `stats.wishDirty` + `decisionSeq` (~68), `COMPUTED` (~100) | Per-bot dirty bits over pieces of one build | Bits become **decisions** (`stats.woken`); `COMPUTED` masks become each decision's own piece |
| `DecisionEvents.raiseDecision` (~52), `nearRaise` / `takePostedRaise` (~96) / `applyPendingRaise` (~106) / `applyRaise` (~35) | The hot raise path to the worker, the far row raise | **Kept as the transport**, reasons = situation names (`reasons` ~13, `reasonBits` ~21 go) |
| `DecisionSections.events` (~630) / `factEvents` (~723) / `needsOpened` (~657) / `stateView` (~566) | One diff of a step's facts against the decision's baseline, both threads | **Kept as `Situations.detect(before, after, round)`**: same function hot (posted row) and cold (prepareResolve), emits situation names for state facts only; no money mark, no sample |
| `DecisionSections.softEvents` (~491), `observationChanged` (~437), `marketCrossed` (~517), `moneyChanged` soft (~341), `snapshot` sample/marketWatch/bond/bagValue (~467) | The soft point at every far step (44/bot/h) | **Deleted** (Q2 may keep one `spot_disappoints` check at a stop) |
| `LINK_INPUTS` / `VERSIONS` / `inputVersions` / `movedInput` (~124-288), `EconomyContext.incomeMoved`, `holdRead` key path, `holdCheck`, `weightBounds`, `incomeShadow`, `linkCount` (~1508-1572); `EquipmentIncomeRoute.standsMoved`/`crowdKey`/`crowdStands`/`countCrowd` | The "recompute when any input moves" rule (rejected 2026-11-05) | **Deleted** for decisions. `routeVersions` survives only if the route-row cache wants it (its key is `EconomicTrip.key`) |
| `EconomyContext.heldBuildVerdict` (255-452), `heldEventsQuiet`, `bandsHold`, `inputName` | The per-step verdict (100/bot/h) | **Shrinks to**: proof identity (owner, generation, leaf), woken bits; the leaf checks move to the executors that act (they raise `goal_done`/`goal_failed`); quantity/liquidation proofs only drive the town agenda (`Agenda.advance`) |
| `workshopKeyHolds`/`workshopKeyOf`/`workshopMoved`/`keptWorkshop` (~2431-2480), `WORKSHOP_SERVE_MS` | Workshop's own wake | **Deleted**: `woken(workshop)` |
| `ColdEconomyPlan.edges`/`factEdges`/`actionBaseline`/`edgesSince` (~30-117), worker `actionEdges`, kernel `actionBaseline` at commit ack | Action plan's own wake | **Deleted**: `woken(town_plan)` / `trade_request` |
| `ColdOccupationPlanner` `inputKey`/`valueKey`/`servesUntil` | Cache keys of a planner job | **Kept as a cache** of a pure calculation (exact key, rule 5); no longer asked unless a decision is taken; `servesUntil` goes |
| `PartyGoalPolicy.formingHold` (~155) drift | Forming's own hold | Key = roster + each member's `situationSeq` (a member's situation re-judges it); drift deleted |
| `PartyIncomeComparison.soloChoice` own hold | A second earning hold | **Deleted**: reads the held answer; a bot with none has its earning spot woken (`activated`) |
| `GearAcquisitionPlanner.recoveryWake` (~207) | Gear plan's own wake | Set-aside entries live until `level_up` / `gear_changed` / `party_joined` (the same three facts, raised by the catalogue) |
| `CraftMarketReview` due (~14, ~48) | Craft bids' own wake | Taken at `arrived_town` and `goal_done` of a project input; foreign quotes read then |
| `GoalPlanner` `nextReviewAt` 60 s; `PartyRequestPlanner` age/cooldown; `PartySessionReview` deadlines; `ClanPartyDuty` 30 s retry | Windows | Known ends become `patience_out` (Q9); the 60 s and 30 s retries go |
| `Reaction.raisedCounts`, `incomeHold`, `link:*`, `doors` | Counters | One `situations=` line (below); `incomeHold` and `links=` go |
| `ClanReviewEvents` | The clan context's own event queue | Stays the clan's (Q15); a bot hears the clan through `clan_call` |
| `MarketBuyerWaiters`, `PartyAssemblyEvents`, `ColdSoloWindow.endOf`, `lifecycleKind` `event_driven` | Event-driven already | Stay; they raise catalogue situations where they wake a bot decision |

### 4.2 Owner and API

`src/GameServer/Bot/Situations.js` (from `Economy/Reaction.js` by `git mv`; pure, plain data, no clock, both threads):

```js
// The decisions a bot holds (one bit each, stats.woken). Each declares its waking situations here, once.
const DECISIONS = Object.freeze({
    earning_spot:  ['level_up', 'gear_changed', 'died', 'recovered', 'spot_crowded', 'spot_empty', 'spot_dangerous',
                    'moved_by_world', 'party_joined', 'party_left', 'stock_low:shots', 'activated'],
    build:         ['arrived_town', 'level_up', 'gear_changed', 'goal_affordable', 'out_of_money', 'goal_done',
                    'goal_failed', 'died', 'stock_low', 'bag_full', 'clan_call', 'clan_changed', 'party_joined',
                    'party_left', 'spot_empty', 'goal_moved', 'recipe_learned', 'activated'],
    workshop:      ['arrived_town', 'recipe_learned', 'level_up', 'gear_changed', 'goal_done'],
    town_plan:     ['arrived_town', 'goal_done', 'goal_failed'],
    craft_market:  ['arrived_town', 'goal_done'],
    party_request: ['level_up', 'died', 'clan_call', 'party_left', 'patience_out', 'invited'],
    party_stay:    ['died', 'bag_full', 'stock_low', 'clan_call', 'patience_out', 'goal_done']
});
// The situations: owner context, payload fields, where a far bot hears it (NOW | STOP | TOWN).
const SITUATIONS = Object.freeze({ level_up: { owner: 'population', heard: STOP, payload: ['level'] }, ... });

raise(stats, name, payload = null, where)  // -> new stats: woken |= bits of the decisions it wakes heard here,
                                           //    waiting |= the rest; situationSeq + 1; last situations (≤ 4) [name, payload]
stop(stats, where)                         // -> new stats: waiting bits heard at this stop join woken
woken(stats, decision)                     // -> boolean
decided(stats, decision)                   // -> new stats, its bit cleared (its own outputs raise nothing for it)
place(state, before)                       // today's Reaction.place
detect(before, after, round)               // the shared fact diff (today's events/factEvents/needsOpened), names only
counts()                                   // { raised: name@place, woke: decision<name, decided: decision:taken|served }
```

Store (one owner of the layout: `Situations`; worker-owned mind keys in `SavedStats.MIND_KEYS`): `stats.woken`
(int), `stats.waiting` (int), `stats.situationSeq` (int), `stats.situations` (≤ 4 `[name, payload]`). They replace
`stats.wishDirty`, the money/observation/market parts of `stats.wishSections` and `actionBaseline`. +~40 B per bot,
−~10-15 KB per bot of held keys (hold versions/stands/crowd keys, solo choices, baselines, action baselines).

**Raising (one rule, both threads; owners raise, decisions only declare):**
- Worker, far bot: `BotLifeState.prepareResolve` (~2945-2958) calls `Situations.detect` and `raise` in place of
  `DecisionSections.events` + `softEvents` + `raiseSections`; the round's own facts (`unhuntable`, room at arrival)
  are named raises from the resolver/arrival check; a rest end or town arrival calls `stop`.
- Main, hot body: `DecisionEvents.raiseDecision(session, name, payload)` keeps the near transport
  (`nearRaise` → post → `takePostedRaise`); the posts by reason (`level`, `equip`, `death`, `revive`, `bag`,
  `near_spot`, `activated`) are the hot raisers; the worker's `nearEvents` (~956) runs the same `detect`.
- Main, cold rows it writes (town commands, party rows, clan objectives, executors' refusals): `raise` on the row's
  stats before the write (today's `applyRaise`), reaching the worker with the row.
- Kernel: a wait's known end (party request age, session patience) raises `patience_out` from the due heap.

**Deciding (worker only; main never rebuilds a worker decision, it reads the card):** `planLifecycle` (~1877) reads
`stats.woken`. None woken: serve the held card (proof identity only; no verdict walk, no route-row ask, no action ask).
Woken: take only the woken decisions (earning spot → one search; build → projection + gear plan + party request;
town plan → action/showcase/listing; workshop → planner ask), each calls `decided`. A reader (party comparison,
meeting, main's refresh, the hot body) reads held answers (`DOORS`); a reader with no answer raises `activated`.

**Rules kept:** deterministic (no clock read for waking; seeded rolls unchanged); payloads plain; no time window
(only Q9's known ends, each with a limits.md row); a situation with no event is a debt line, not a timer.

**Counters:** `situations=raised:<name@place>…;woke:<decision><name>…;decided:<decision>:<taken>/<served>` on the
worker status line (diagnostics off too, as `incomeHold` today), and per-bot-hour in `node scripts/perf.js report`.

### 4.3 Per-decision wake logic deleted (by the step that moves the decision)

- Earning spot: `EconomyContext` `incomeVersions` ~1052, `incomeMoved` ~1068, `searchInputs`/`searchMoved`
  ~1081-1086, `holdDueWhy` ~1103, `holdRead` key path ~1123-1146, `holdCheck` ~1168, `movedHold`/`heldSpotMoved`
  ~1195, the `income_moved` refusal ~318, `weightBounds`/`incomeShadow`/`linkCount`/`linkStats` ~1508-1572;
  `newHold` keeps only `{ route, at }`; `EquipmentIncomeRoute` `standsMoved` ~337, `crowdKey` ~600, `crowdStands` ~738,
  `countCrowd` ~807, `stands`/`weights` returned by `search`; `SpotValueTable.cutStands` ~1016 if nothing else reads it;
  `DecisionSections.LINK_INPUTS.incomeSearch` ~127; `PartyIncomeComparison` `soloChoices`, `SOLO_SEARCH_LIMIT`,
  `observed` ~18/~75-116; limits.md "Earning spot crowd key" and the `RETAIN_LIMIT`-bound hold costs.
- Build: `DecisionSections.softEvents` ~491, `marketCrossed`/`MARKET_WATCH` ~516, `observationChanged`/`learnedChange`/
  `bondChanged` ~417-451, `moneyChanged` soft branch ~341, `meaningfulMoney` ~362, `carrySectionBaseline` ~385,
  `snapshot`'s soft fields ~467; `heldBuildVerdict`'s fact/threat/quantity/liquidation/bands/own-loss/leaf blocks
  ~299-451, `heldEventsQuiet` ~191, `inputName` ~164; `EconomyContext.marketWatchRows` ~756; `DecisionEvents.checkWallet`
  ~170 and its call `HuntingState.js` ~712; `Reaction` links `money`, `observation`, `market`, `bands`, `quantity`,
  `liquidation`, `own_loss`, `crafter_mp`, `threat`, `income_moved`, `income_later`, `own_move`, `own_preparation`,
  `warehouse`, `supply`; `applyOwnRaise` ~42 and its three callers.
- Gear plan: `recoveryWake` comparisons ~207-218 (entries live until the three situations), `acquisitionCooldown`
  ~1454/~1499 (Q9), `planSourceHolds` door ~1278.
- Workshop: `EconomyContext` ~2431-2495 (`workshopKeyOf`, `workshopMoved`, `workshopKeyHolds`, `heldWorkshopOf`,
  `keptWorkshop`), `LINK_INPUTS.workshop` ~157, `WORKSHOP_SERVE_MS` ~241 and `servesUntil` ~339, `askedWorkshop`;
  limits.md "Occupation planner" window clause; debt 25.
- Town plan: `ColdEconomyPlan` `edges`/`factEdges`/`actionBaseline`/`pairsOf`/`pairValue`/`edgesSince` ~30-117; worker
  `actionEdges` ~1258, `askAction` baseline ~804, the card ask ~1995, `refreshCraftPacket`'s MP ask ~851, kernel
  `actionBaseline` on commit ack; `ColdSoloWindow.endOf` `edges`/`market` readers ~88-90; showcase per step ~2064;
  `CraftMarketReview` per-step dues ~814-830; `CLOCK_MODES` ~278.
- Route rows: the per-step `wish` ask ~1894 (asked only by a decision that reads rows).
- Party: `formingHold` drift ~165-169 and `verdictInputs`' wallet/onSpotShare drift ~254 (debt 23); `GoalPlanner.js`
  ~22 default 60 s and `reconcileWorkerPartyGoals`' `due` ~493; `PartyRequestPlanner` `expire`/`cooldownMs` turn
  into a `patience_out` end; `ClanPartyDuty.js` ~23 30 s retry.
- Windows folded into situations: `ColdMarketService.RETRY_DELAY_MS` ~39 (by `goal_affordable` + buyer wake), the
  30-min preparation holds (`GearPlanSelection.js` ~25, `ColdShotEconomyService.js` ~363, `ItemDisposition.js` ~452,
  `WishProviders.js` ~734, `CombinedErrandPolicy.js` ~3) end at the preparation's `goal_done`/`goal_failed`, each
  checked in its own step or left as a debt line.

## 5. Expected effect

Today: 0ff hot diagnostic window (29ae in brackets where it differs). Expected: from the situation rates above
(level ~1.4, town ~1.5-3, gear ≤ 0.5 if Q12 holds, goal done/failed ~1-1.7, affordable ~0.4, death ≤ 0.1, spot
crowded/empty/dangerous ≤ 0.1, party ≤ 0.1; several fall on one stop). CPU: census ms of worker per minute.

| Decision | Today /bot/h | Expected /bot/h | CPU today (ms/min) | Freed (ms/min) |
|---|---|---|---|---|
| Earning spot searches | 28.7 (18.4) | 2-3 (Q1 b), 3.5-5 (Q1 a) | 2 691 (0ff ~5 300) | −2 300 (0ff −4 600) |
| Party solo side searches | 9.7 of 17.7 reads (cold run) | 0 (reads the hold) | in party forming 1 530 | −700 to −1 000 |
| Economy build (projection, source facts, gear candidates, gear plan, party request) | 11.5 per cold bot; 62 per hot bot | 4-5; ~5 per hot bot | 2 434 + 2 942 + 758 = 6 134 | −3 400 to −3 700 |
| Held verdict + soft point | 100 + 44 | bit test per step | 990 | −900 |
| Action plan asks | 27.6 | ~3 | action/showcase/craft 2 195 | −1 900 |
| Showcase asks | 11.8 | ~2 | (in the line above) | |
| Sale dispositions | ~400 item evaluations | ~60-80 | 1 443 | −1 100 |
| Workshop asks | 16 + 3.4 no-crafter | ~3 per crafter, 0 others | 1 982 | −1 700 |
| Route rows (planner `wish`) | 56 asks, 25 builds | ~5 | planner bookkeeping 1 534 | −800 |
| GC / VM (fewer builds and keys) | | | 1 957 + 2 206 | −800 to −1 200 |
| **Total** | | | 35 700 busy | **−13 000 to −14 500 (−37-40 %)**; 0ff −18 000 to −20 000 |

Worker ~59.5 % of a core → ~36 % on the 1735-bot save (20.6 → ~12.7 ms per bot per minute; 5k bots ≈ 1.4 cores
instead of 2.2). Memory: −10-15 KB per bot of held keys (−17-26 MB worker heap), `SOLO_SEARCH_LIMIT` and part of the
2048-bot `RETAIN_LIMIT` pressure gone. Main: no `checkWallet` per hot tick, near cards 62 → ~5 per hot bot per hour
(fewer `economy_decided` messages and `nearView` builds). Behaviour (realism for exactness, our choice): a bot no
longer switches spot because a rival spot emptied or a price moved, does not re-plan purchases on money drift or field
loot, and hears level and gear at its next rest or town (as a C4 player does).

## 6. Migration order

Each step: one commit per problem (squash, no fixups shared), its tests, its map update (bot-ai.md, economy.md,
population.md, limits.md, debt.md), and the measurement on the 1731-bot save. Steps 1-3 can share one integration
branch with one full CI and one perf batch (bisect only on failure). Compare runs that follow a run of the same
code (the first run of new code rebuilds every bot once).

0. **Counters (no behaviour change, optional, folds into step 1 if preferred).** `Situations.counts` mapped from
   today's raise sites (`Reaction.raise`, `ShoppingState` town, `soloArrival`, `LevelUp`/`Backpack`/`Die` posts) and
   a shadow per decision ("would a situation wake it now"). Also split today's `kit.worn` moves by cause (Q12) and
   count town arrivals. Measure: situations per bot per hour by name; the shadow's would-decide vs today's rebuilds.
1. **The catalogue, the store, the earning spot.** `Reaction.js` → `Bot/Situations.js` with `DECISIONS`/`SITUATIONS`,
   `raise`/`stop`/`woken`/`decided`/`detect`; `raiseSections` and `raiseDecision`'s bits write `stats.woken`; the
   sections stay only as the build's derived pieces until step 4 (one writer: `raise`). The earning spot searches
   iff `woken(earning_spot)` (and for a bot with no held answer); its key machinery and the party solo hold go (§4.3).
   Tests: rewrite `test_held_earning_spot.js` to pin: a price move, a crowd move at another spot, a money weight move,
   the bot's own arrival keep the spot; level up, gear change, death, own spot full / empty / dangerous, party join
   search; `test_party_income_comparison.js` (the solo side reads the held answer); `test_player_moment.js` (places);
   `test_detour_own_trip.js` (own trip raises nothing). Measure: `situations=`, searches per bot per hour
   (expect 2-5), income search ms/min.
2. **Kit and stock (§5).** `stock_low` at the one-hour return line, hot and cold one function; town amounts at
   `arrived_town` through `kitReader`; foundation publishes rates; `bandsHold`/`quantityBands`, `restCapOf`, frozen
   counts, `shotCurrentAtBuild`, card `stock()` (debt 20) go. Fix the 0.5 h sale-visit outing first (test first).
   Tests: `test_stock_interval_and_death_price.js`, `test_hot_restock_retry.js`, `test_wish_focus_supply.js`,
   `test_shot_stock_restock.js`, `test_scroll_stock_economy.js` updated to the new targets. Measure: `stock_low`
   rate, near rebuilds, main `basics()` gone.
3. **The economy build on situations.** The build runs iff `woken(build)`; `softEvents`, the soft baseline, the
   verdict's fact/quantity/liquidation/threat blocks, `checkWallet`, `applyOwnRaise` go; leaf checks become executor
   raises (`goal_done`/`goal_failed`); the town agenda keeps its execution checks. `COMPUTED`/`SECTIONS` become per
   decision; `wishDirty` gone. Tests: `test_economy_context.js` (verdict), `test_cold_worker_one_decision.js`,
   `test_near_decision_order.js`, `test_near_fact_post.js`, `test_hot_hunting_continuation.js`, plus one behaviour
   test: money drift / field loot / a market crossing do not rebuild, arrival in town / goal affordable / goal failed do.
   Measure: builds per bot per hour (expect 4-5), held verdict ms, source facts and projection ms.
4. **Town plan.** Action/showcase/listing/craft market asked at `arrived_town` and the visit's `goal_done`/`goal_failed`;
   field trade only on `trade_request`; `edgesSince` and the per-step route-row ask go. Tests:
   `test_cold_worker_one_decision.js`, `test_bot_cold_market_listing.js`, `test_cold_overweight_sale_retry.js`,
   `test_cold_planner_board.js`. Measure: action/showcase asks, sale dispositions, planner bookkeeping.
5. **Workshop.** `woken(workshop)` for crafters, `noCrafterWorkshop` for the rest; workshop key and serve window go
   (debt 25 paid). Tests: `test_station_workshop.js`, `test_cold_occupation_planner.js`. Measure: workshop asks.
6. **Party.** Party request on its situations and a `patience_out` end; forming keyed on members' `situationSeq`
   (debt 23 forming paid); party member goal review at its situations (GoalPlanner 60 s gone); `ClanPartyDuty` retry
   gone. Tests: `test_party_income_comparison.js`, `test_remote_party_invite_decision.js`, the party session and
   craft material party tests. Measure: party forming ms, party asks.
7. **Remaining windows and hot alignment.** Buyer retry by `goal_affordable`; the 30-min preparation holds; near bots
   hear by the same places as far ones (Q8); debt lines for the events still missing; `incomeHold`/`links=`/`doors`
   counters replaced by `situations=`. Measure: the full census (target-architecture §2 re-run).

## 7. Open questions for the maintainer

Each: what the code does today in plain words, options, what changes in the game, recommendation.

**Q1. Does a town visit also re-pick the hunting spot?** Today the earning spot is re-searched on any of its 15
inputs, a town visit among them indirectly (the origin point moves). (a) Town wakes the spot too: +1.5-3 searches per
bot per hour (~0.3-0.5 s/min); a bot may come back from town to another spot. (b) Town wakes the purchases only;
the spot is re-picked only on level, gear, death and its own spot's state: after shopping the bot returns to its
ground, as `GoalExecutor.finishVisit` already does. **Recommend (b)**: it is the C4 habit (players go back to their
spot) and cheaper; a purchase that changes the kit raises `gear_changed` anyway.

**Q2. The bot's own hunt results (today's `observation`).** Today every far step compares the bot's hunt samples
with the decision's baseline; beyond its error it re-weighs (2.4-2.8 raises per bot per hour, and searches). (a) Drop:
samples are read when a decision is taken; a bad spot is left at the next level, gear or death. (b) One situation
`spot_disappoints`: at a rest end, once per stay, after N kills, when its own income is below the table's
expectation by more than its error. (c) Keep today's rule. **Recommend (b)**: a player notices a poor spot after a
while, but once; (a) could keep a bot on a poor spot for an hour, (c) keeps a per-step soft point.

**Q3. Crowding while hunting.** Today a spot found full on arrival marks the bot and re-routes it; while hunting,
rivals arriving are heard only through the search's crowd replay (11 searches per bot per hour). (a) Only at arrival:
a bot can stay on an over-crowded spot until its next situation. (b) The occupancy index raises `spot_crowded` to the
standing hunters when the count crosses the spot's room (one fan-out per crossing, bounded by the room). (c) Read
the own spot's count at each rest end (one read per rest). **Recommend (b)**: it is the real event, rare, exact, and
pays the missing-event debt; (c) is the fallback if (b) costs more than measured.

**Q4. Money.** Today money is heard three ways: a soft drift beyond the error, crossing the next funded wish of the
queue, and the hard funding mark. (a) Keep only `goal_affordable` (the wallet reached the focused goal's price) and
`out_of_money` (below what the held plan needs). (b) Also wake on each funded row crossing. **Recommend (a)**: a player
thinks about the next purchase when he can afford what he is saving for; other rows are weighed in town. Consequence:
a cheaper second wish waits for the next town or goal.

**Q5. The market in the field.** Today a far bot watching up to 20 board heads hears a crossing anywhere
(`market@work` 0.4-1.2 per bot per hour). C4 has no remote market: stores are physical in town. (a) Drop the watch;
offers are read on arrival; `MarketBuyerWaiters` wakes only a bot in town or waiting there. (b) Keep it. **Recommend
(a)**. Consequence: a bot does not rush back for a cheap offer; it finds it at its next visit.

**Q6. Field loot and field deals.** Today new loot in the bag asks a market action plan after the round (9.2 asks per
bot per hour). (a) No ask in the field; loot is planned in town or at `bag_full`; field trades only when another bot
asks (a meeting). (b) Keep. **Recommend (a)**.

**Q7. Level up: every level or band edges.** Today every level moves the kit fact and searches. (a) Every level,
heard at the next stop. (b) Only when the spot band or the grade changes. **Recommend (a)**: ~1.4 per bot per hour is
cheap under situations and C4 players do reconsider at each level in this range (mobs turn grey, new skills).

**Q8. Where situations are heard, hot vs far.** Today a far bot defers kit and money facts to its rest or town
(`Reaction` places), a body near a player hears everything at once (62 builds per hot bot per hour). (a) One rule for
both: a near bot defers like a far one; player-facing ones (party with the player, commands) stay immediate. (b) Keep
near bots open. **Recommend (a)**: the same behaviour wherever the player stands, one rule hot and cold; the player
sees no difference except fewer mid-fight replans.

**Q9. Waiting with patience (known ends).** Party request age (5/15 min) and cooldown (5 min), the session's patience
(8-22 min by persona) and grace, the craft stall (2-4 h), risk marks' expiry. (a) Allow a deadline the decision sets
once when it starts waiting (`patience_out`, raised by the kernel's due heap), each with a limits.md row; the craft
stall counted in kills of the source, not hours. (b) Events only, no deadlines. **Recommend (a)**: giving up a wait
is real player behaviour and a known end is not a periodic re-check; (b) leaves bots waiting forever.

**Q10. Does a decision's new answer wake the decisions that read it?** E.g. the earning spot moves; the wish's money
queue reads the hour. (a) No: dependants read it at their next situation. (b) Yes, as a situation for them.
**Recommend (a)**: a player who changes spot does not re-plan purchases; one rebuild less per spot change.

**Q11. Detect by diff or raise at every writer.** Today one function compares a step's facts with the decision's
baseline (`DecisionSections.events`), both threads. (a) Keep the diff for the bot's own state facts (level, kit,
death, party, stock line, bag full) and add explicit raises for world facts (crowding, invites, refusals at the act,
clan calls). (b) Explicit raises everywhere. **Recommend (a)**: the diff cannot miss a writer and is one rule hot and
cold; its cost drops once the soft parts go.

**Q12. What counts as `gear_changed`.** The kit fact moves ~1.9 times per bot per hour on worn gear alone, more than a
player changes gear. Probable causes: field `equipInventoryUpgrades` swaps, enchant attempts, equipped consumables.
(a) Count worn moves by cause in step 0 and treat swaps that keep the same item ids and grades (arrows, shots,
re-equips) as no change. (b) Accept today's definition. **Recommend (a)** before step 1 is measured.

**Q13. Relations.** Today a new friend or enemy target in memory raises `relations`. (a) Only clan join/leave and party
are situations; friend/enemy are read at decision time. (b) Keep. **Recommend (a)**: no C4 player re-plans his
shopping because a friend's trust moved.

**Q14. Main's goal moves (AI-5).** Main's `GoalState` keeps a second copy of the goal; when it moves, the worker hears
`goal_moved`. (a) Keep the raise until AI-5 is decided, with its debt line. (b) Decide AI-5 now (goals as a view over
the card). **Recommend (a)**: AI-5 is its own rework.

**Q15. Clan decisions in the same mechanism now?** The clan's planners run on windows (`ClanWarDirector` 60 s, 30 s
TTLs) beside their own event queue (`ClanReviewEvents`). (a) Later pass: same `Situations` shape with the clan as
subject, `ClanReviewEvents` as its raiser. (b) Now. **Recommend (a)**: it is main-thread and clan-planner work, small
in the census; the bot hears the clan through `clan_call` now.
