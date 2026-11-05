# Decision links: recompute only the link a change touches

Open plan (debt.md "Planned features": "Recompute only the link a change touches", "incremental decision").
Drafted 2026-11-04 from the cold-worker perf passes (diagnostic run `2db814359-cold-20261104-200335`, 1735 cold bots,
17 min; R2 profile `985e4b6af-cold-20261104-170450`).

## Principle

A bot decides rarely and by situation, as a C4 player does (AGENTS.md, maintainer 2026-11-05). A bot's decision is a
chain of links; each link is a pure function of named inputs. A decision link is taken again only at a waking
situation (arrived at a spot or in town, level up, new gear, death, a crowded own spot, invited, a stock run low) and
held until the next; its other inputs (prices, crowd at candidate spots, money, bag counts) are read when it decides
and do not wake it. One situation mechanism serves every decision (maintainer): situations named and raised in one
place by their owners, each decision declares its waking situations, holding and waking are shared (today's
`DecisionSections` sections/events and `DecisionEvents.raiseDecision` are the base; the cadence pass picks the owner
and folds the per-decision hold logic into it). No time windows. Pure-calculation links under a decision (prices, route rows, matchup, damage)
are cached on their exact inputs.

Correction 2026-11-05: steps 1-4 below were built on "a link is recomputed when any of its inputs changes"; that made
every input (a price belief, a hunter count at any candidate spot) a trigger, and the held earning spot searched more
often than with the 30-min window it replaced (heap/CPU release perf: worker 59 → 84 %). The exact intervals and replays added since
(prices, crowd) remain correct but are the wrong lever: the next step is the decision-cadence pass (per decision, its
waking situations vs today's trigger counts; planning/target-architecture/plan.md).

## Why (measured)

Cold worker, inclusive share of busy time: `planLifecycle` 39.6 % (forState 27 %, of it wish projection 16.7 %,
income search 10.6 %, matchup verdicts ~9 %), occupation planner ~19 %, the simulation itself (resolveSolo/Fight)
~7.5 %. The worker spends most of its time rebuilding decisions, not simulating.

- ~5.7k forState step builds in 17 min, ~30 ms each; 4178 of 4755 held-build rebuilds rebuilt the whole foundation
  because one section (often `supply`) moved, while the income search reads from the bag only the loaded shot.
- 9k income searches: 4006 after a section event, 2122 after a goal change (the hold compared the focus string; the
  search reads the goal only through `economicHunt` and the money weight), 1763 with no hold, 1137 by the 30-min window.
- Planner: action 11.6k builds / 46.5 s, wish 21k / 20.5 s, occupation 9.4k / 24.5 s. A finished result almost never
  survives a step: `sameInput` keys on `updatedAt` and object identity; the route key on the raw activity and the exact
  scroll count; crafters on exact MP.
- Main thread rebuilt the worker's decision (town errands' `basics`, 14.6k searches): fixed by reading the published
  targets (7a86e9c6), main busy −18-20 %.

## The links

Inputs marked (E) have an event today, (–) have none, (S) need a significance rule. "Output" is what the next link reads.

| Link | Output | Inputs | Today's owner and invalidation | Problem |
|---|---|---|---|---|
| Pricing | price(id), persona | board beliefs per item (E market watch), persona traits (E), frustration (E observation) | `EconomyContext.pricing`, `PriceBelief.prior` per build | rebuilt per build; board reads not keyed on item revision |
| Route rows | trip table per town | activity class (shopping / shop trip / other), region while shopping, loc where read, marketReturn, karma flip, scroll present (E state) | `EconomicTrip.key` = `routeInputs` (cb292781) | was keyed on raw activity + scroll count |
| Matchup profiles | profile array + verdict caches | kit profile object (E build), shot kind loaded, servitor (mp, summon, cooldowns), timestamp | `BotTargetMatchup.stateProfiles` ring of 8 (c2d035d2) | ring misses basics→forState across an await; verdicts die with the array |
| Income search | held earning spot, row, hour | level/kit/matchup (E build, combat), recovery level cap (E recovery), loaded shot kind (–, beginner shots run out silently), origin spot/loc and samples/exclusions (E occupation), party (E relations), consumable prices (the reader's, inside the hull its answer is replayed over), `economicHunt` gate (E), money weight (the weights the answer stands over), frustration (its range), crowd/room at candidate spots (the crowd key's replay), risk exclusions (`exclusionVersion`), spawn catalog period (table revision) | `holdRead` on `incomeMoved`, no window | reads its own previous output (money[0], ECO-15) |
| Hunt / death / karma hours | hunt income, deathHours, karmaHours, riskWeight | income route + onSpotShare (E observation), exp/level (E), karma (E), lostGearHours (bag × prices, PK only) | `foundation` | rebuilt with the whole foundation |
| Kit and stock targets | shots/potions/scrolls targets, survival reserve, bag hours | live bag counts (E supply/bag), `visitEvery` (E town), slots and sale candidates (E bag), restCap = wallet (E money: not wired, kept foundation keeps a stale restCap) | `foundation` → `kitReader` | needs only the bag/money, rebuilt with the income search |
| Source facts | where to get each wished item | level/kill band/spoiler (E build), sourceRouteReader (exclusions, economicHunt, grouped), trips + hourAdena, spot values (crowd –, samples E, deathHours/riskWeight drift every round) | `WishProviders.sourcePath` → `GearAcquisitionPlanner.sourceFacts` per build, ~9 % | values move every round: hold gains < 0.5 % until crowd/risk are versioned |
| Wish projection | money queue, focus, plan | bag, kit, level, plan/focus, prices, foundation outputs, wallet/reserve, trip rows, board offers, spot values, sourceGround | `WishProviders.build` on every unserved build, 16.7 % | ~60 KB per bot, cannot be held whole; needs per-node rebuild |
| Workshop | best recipe, income/hour | money packet, wallet, recipes/craft level, maxMp, class/level, reservations, recipe bag items, board reads, route rows | planner `occupation`, `heldWorkshop` (route key, workshop mask) | party/karma members asked every step (fixed cb292781) |
| Action plan | buy/sell/craft plan | bag amounts, money/escrow, own board lines and read quotes, wish build, MP only through `floor(mp/mpCost)` and `mpCost ≥ mp`, the clock (SurvivalFloor cooldowns and sale retry, errand expiry, price beliefs) | planner `action` after `ColdEconomyPlan.edgesSince` (the last ask's facts, `actionBaseline`), key with the step clock | others' quotes and the clock: heard at the next edge or decision (no significance rule) |
| Showcase | shop display | bag, prices, board | planner `showcase` per shopping step | small |
| Forming verdict | a roster's accepted ids (+ material reviews) | per member: level, class, kit fact, spot, position, request, gear plan, focus and its cash, survival reserve, workshop quote, planned shot and potion, roster samples (E state); alive, running effects, buffs each seller would sell it, a summoner's MP, summon and cooldowns, the night (read results, exact); solo side's search (E hold version); wallet and onSpotShare (S incomeError, debt.md 23) | `PartyGoalPolicy.formingVerdict` held per roster (`formingHold`); main's ask held on the members' sources (`PopulationService.formingVerdict`) | main's held ask hears worker-only inputs (crowd, the hold's renewal) at a member's next change |

## Cross-cutting fixes the links need

1. Packet layouts with one owner (`StatsPacket`: money, stockTargets, dangerPrice), named readers (AGENTS.md).
2. State replaced, not edited in place (NpcRestockPlan's clone, cached-state repairs), so a link may key on identity.
3. Per-spot versions: a crowd/room revision in `SpotOccupancyIndex` and a risk-exclusion revision in `SpotRiskPolicy`,
   read by the links that read those spots (no dispatch to bots needed: the reader compares versions). Done
   (`spotVersion`, `exclusionVersion`). The income search reads `exclusionVersion`; for the crowd it compares the
   counts themselves through its crowd key (a replay of its comparisons), not `spotVersion` (left for source facts).
4. The money weight: decide ECO-15 (search at the band hour, not the bot's own last hour) so the income search does not
   depend on its own previous answer.
5. Counters per link: built/kept by reason (extend the `doors` row and `incomeHold`), so every step below is measured.

## Steps (each one measured on the 1731-bot save)

0. Done 2026-11-04: main reads the worker's kit targets (7a86e9c6); one matchup array per step and no moved-hold
   recheck (c2d035d2); skill/model keys (6cccd76d); route key on what rows read, member workshop hold, feasibility
   from the current state (b2de9c9c). In review (branch ivan/worker-source-hold): the hold searches when the economic
   gate flips or the money weight leaves the weights the held answer stands over; the income search only on the
   sections it reads (`COMPUTED.incomeSearch` + the loaded shot), a supply build rebuilds the rest of the foundation
   on the held route; restCap follows money.
1. Declare inputs in code: each link's key lists its inputs (comment + one test that changing each input rebuilds and
   changing anything else does not). Start with income search, kit, route rows, workshop.
   Stage A done (no behaviour change): `DecisionSections.LINK_INPUTS` (incomeSearch, workshop, routeRows) and
   `inputVersions` (value digests over the verdict's `stateView`); a shadow under developerDiagnostics counts what the
   key would decide against the mask (`link:<link>:<rebuilt|kept>:<input|mask-only|key-only:input>`, `verify:*`,
   `link:income:search`, the worker's `links=` line). Key-only by reading (no event today): a risk mark on a spot that
   is not the held leaf's, and a mark's expiry (exclusions); the held leaf's own arrival moves the search's origin
   (spot, own output: decide); the workshop's packet hour/price are the previous build's (one build behind) and its
   wallet, maxMp and own board lines carry no fact; beginner shots running out (bagShot).
   Stage B done: the earning spot search decides on its key (`EconomyContext.incomeMoved`: the incomeSearch
   versions, `mode` the party/duo gate, the weight interval, the new `observation` section bit raised by the
   observation link only); `COMPUTED.incomeSearch`, `goalMoved`/`weightMoved`/`bagMoved` gone; `incomeHold` counts
   searches by input (`event:<input>`). Behaviour: a section raise that moves no input keeps the held spot (clan,
   friend, recipe, the income_moved echo, unhuntable on the same spot); a risk mark or its expiry on any candidate
   searches at the next build; inputs with no event refreshed only by `HOLD_MS` and observation (step 3: gone).
   Stage D done: the workshop decides on its key (`EconomyContext.workshopKeyHolds` over `plan.workshopKey`: route,
   craft, class/level, recipes, maxMp, the earning answer the build published (`plan.incomeOutput`), crafter, own lines (a crafter's sell lines,
   else presence), a shot crafter's supply presence; the money and observation bits); `COMPUTED.workshop` gone; one
   `ColdEconomyDecision.noCrafterWorkshop` for the planner's branch and the step (member, lifecycle: no planner job
   for a non-crafter without lines; an ask on a served step stays on the entry, `askedWorkshop`). Behaviour: an MP cap, own sell line or income answer move asks; a combat,
   relations, occupation or supply raise that moves no input keeps (the bag only through the money bit, in town).
   Left on the shadow: routeRows.
2. Per-bot input versions instead of section masks: bag, money, kit, level, occupation, relations, market. A link
   stores the versions it read; `DecisionSections.COMPUTED` becomes these per-link input sets.
3. Per-spot versions (crowd, risk); then `HOLD_MS` and other windows go.
   Income search done: `HOLD_MS` deleted. `EquipmentIncomeRoute.search` returns with its answer what it stands on
   (`stands`): the shot and potion prices with the range of each its answer is replayed over (a row's costs are a
   line in each price; the band's first-64 cut, read over rows the search never scores, keeps its place for the spots
   that move the candidates: `SpotValueTable.cutStands`; linear in both prices, so the hull of the two ranges); a
   range of frustration (a line in each score, as the weight); the crowd key: the candidates that could change the
   answer anywhere in the box (weight range × frustration range × the prices' hull × any crowd, the pick's own
   hunters up to the count where it loses), with the score of each as a function of its hunters (huntShare scales a
   table row, an observed row's deaths) and the prices, replayed at each check against the counts and prices now
   (`crowdStands`). The catalog period is the
   spot table's revision. Samples stay on the observation rule (not linear: rates, calibration inside the crowd cut,
   deathHours over the hunt's exp). The death recovery's target level cap is a version (`recovery`) and a fact
   raised both ways. The solo hunt window lost the hold's deadline: its bound is the kernel's own look-ahead
   (`WINDOW_LEAD_MS` 300 s: the burst reads the world as it stands at the step), and each round reads the market
   watch (the money drift, the samples and income_moved wait at work, Reaction). Counted: `incomeHold`
   event:<input>, `income_crowd:kept|searched`, `windowEnd` lead/market. Left: the other windows of the census
   below.
4. Done (branch ivan/links-step4-planner): planner answers per mode on the values they read
   (`ColdSimulationWorker.plannerInputKey`; finished cards outside the 64 working contexts; a state that reads the same
   keeps the job, in flight too); a crafter's MP as the band of its craft checks (`WealthCraftPolicy.craftMpBand`:
   the card's craft refresh, the planner keys, `crafter_mp`); the after-round action on the facts of the last action
   ask (`ColdEconomyPlan.edgesSince`, the bot's baseline at the step's commit). Open: near, refresh and meeting stay on
   the state object (their economy reads memory rows, crowd and goals: step 2); the action's key holds the step clock
   (it reads the clock); a workshop card serves 30 game min (`WORKSHOP_SERVE_MS`: the demand forecasts age with no event, debt.md 25).
5. Wish projection by node: rebuild only the item nodes whose inputs moved (price of that item, its source facts, the
   wallet cut), keep the rest.
6. (Dropped, see below: one rebuild per bot after an update is the honest cost.)

## Open questions

- Memory per bot for held links (budget: say per link; today ~2-5 KB for source facts, ~60 KB for a whole projection).
- Hot bots on main: the same links (one rule) or only the published outputs.
- Significance thresholds: one rule (`incomeError`) for all continuous inputs, or per input.
- The supply fact tracks only the paid shot; beginner shots running out changes the matchup without an event.

## Steps 1-2 staged (design 2026-11-04, at cba9319f)

Two layers: layer 1 (should the bot decide now: Reaction, `wishDirty` bits, `heldBuildVerdict`, the advisory card)
stays; layer 2 (inside a build, which link rebuilds) is new. A link keeps a key beside its output: versions for
discrete inputs (digests of the input's value on the state, computed the same on both threads; no counters, no
identity caches), intervals `[low, high]` for continuous inputs (`DecisionSections.bounds` generalised; the money
weight is the first row), event bits for event-only inputs (one new bit: `observation`). ~0.4 KB per bot.

- A: `DecisionSections.LINK_INPUTS` + `inputVersions(view, state, timestamp)`; shadow counters
  `link:<name>:<rebuilt|kept>:<first input | mask-only | key-only>` and a 1-in-16 verify mode. No behaviour change.
- B: income search on its key (after the weight interval); `COMPUTED.incomeSearch` goes. Inputs with no event refresh
  only by `HOLD_MS` and observation (less often than today; same worst case).
- C: one foundation path (delete `keptBase`/`foundationFromPlan`): the kit always from the live bag and prices on the
  held route. Behaviour change (fixes stale counts and prices): maintainer's call.
- D: workshop on its key; one `noCrafterWorkshop`; `COMPUTED.workshop` goes.

Expected: −12-17 s per 15-min window (2-3 % of the worker). The large costs are elsewhere: the wish projection
(~90 s) and source facts (~48 s) rebuilt on every unserved build (3.2k per window), i.e. layer 1's refusals and step 5.

## Step 3 list: time windows standing in for events (census 2026-11-04)

None has a limits.md row or a debt line naming its missing event (except TownNavigation 120 s and the gear party route). Biggest work first
(src/GameServer/...): party member goal review every 60 s (`PopulationService` ~476, `GoalPlanner` ~22, `GoalService` ~41: the inputHash
already names the inputs); `PartyRequestPlanner` reviewAt + partyWaitReplanMs 5 min; `PopulationService` phase policy
10 s (POP-24: 0.003 % of main, kept); +10/30 s step polls in `BackgroundResolver`
(~2543-2699), `BackgroundPartyResolver` (~189-355), `ClanPartyDuty` waiting on outcomes that already fire;
`ColdMarketService` RETRY_DELAY_MS 15 min (the buyer wake is half-dead: `GoalExecutor` ~43 still refuses until the
stamp); 30-min holds in `ColdShotEconomyService`, `ItemDisposition` ~394, `WishProviders` ~663 (its preparing and
wealth craft rows; the recipe investment is event-driven), `CombinedErrandPolicy`; `FirstPrice` CACHE_MS 1 h over static inputs; clan reviews (`ClanWarDirector`,
`ClanActionService`, `ClanEquipmentService`), `ClanGoalCandidateService` 30 s TTL, `ClanWarehouseService` 1 h keyed by
clan only, clan runtime 5 s DB re-reads; hot AI scans: the 150 ms party threat projection (AI-14; the loot scan now reads only a
party's own drops, the threat scan only NPCs targeting a member), `BotSupportPlanner` 0.25-1 s, `HotBackgroundParty`
2 s (≤ 0.01 % of main, 2026-11-04 hot run); `HotActorLodPolicy` status 3/15 s (AI-15; its 8/10 s holds are hysteresis, visible combat ends with its stance); `GearAcquisitionPlanner` party route set aside 1 h (`PARTY_ROUTE_RETRY_MS`, limits row and debt line: who could join has no event; the other set-aside routes wake on level, weapon grade and party); ~15 small ones with an existing revision not in the key.
Done 2026-11-05 (branch ivan/market-roll-windows): the sale retry (`ColdMarketListingService` 30 min) is the goods
and buyers the last visit tried; `MarketDemandIndex` WANTED_TTL and its 15-min re-persist gave way to clear events
(only a wish-only want keeps the window, ECO-16); `CraftMarketReview` 15/2 min reviews on its facts; the listing roll
stands on item facts with held dispositions.
Unclear (time may be the real input): hunt evidence aging 6 h, "no progress over N" rules (`PartySessionReview`
grace, patience and 10-min recent progress; `GearAcquisitionPlanner` craft stall 2-4 h, `acquisitionCooldown`), LLM policy TTL, ColdPve 10 min, clan rescue duration. `PartySessionReview`
hears relation decay only at the members' next memory, war or social revision. Also found: `MarketBuyerActivity.refresh` is never called (its score is dead). ~140
scheduling/budget limits (B) have no limits.md row.

## Step 5 staged and a measurement note (design 2026-11-04)

Measurement: the first run of a new code identity rebuilds every bot once (`not_retained` ~1746 builds, ~42 % of build
time in a 17-min run: the save's restart proof belongs to another identity). Compare runs that follow a run of the
same code, or count the boot rebuilds out. For players it happens once per update: step 6 (keep links across a restart).

Layer 1 cannot be widened safely (almost every refusal can move the focus or the step); the waste is layer 2:
`Providers.build` rebuilds every node though most refusals move a few items. Stages: S0 counters (every refusal's
reasons, provider laps, shadow fact keys); S1 keep source facts per item, exact (global digest + crowd reads; ≤2.5 KB
per bot; −1.3-2 %); S2 spot values on the decision's observation baseline (behaviour change, maintainer's call;
−4 % with S1); S3 item descriptor closures in an LRU (exact, −1-2 %); S4 gear candidates keyed on kit/level/
progression/prices/budget interval (exact, −0.6-1 %). Each with a 1-in-16 verify build.
Step 6 dropped (2026-11-05): a per-module identity is not exact — the economy decision's require graph reaches 1012 of
1297 src files with 106 computed requires, and every release since preview.4 touched Bot/Economy or Bot/Population.
After an update the rules did change, so one rebuild per bot (~1746 × ~30 ms of worker time, once) is the honest cost.
Perf runs: compare runs that follow a run of the same code.
