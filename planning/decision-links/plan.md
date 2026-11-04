# Decision links: recompute only the link a change touches

Open plan (debt.md "Planned features": "Recompute only the link a change touches", "incremental decision").
Drafted 2026-11-04 from the cold-worker perf passes (diagnostic run `2db814359-cold-20261104-200335`, 1735 cold bots,
17 min; R2 profile `985e4b6af-cold-20261104-170450`).

## Principle

A bot's decision is a chain of links. Each link is a pure function of named inputs. A link is recomputed when one of
its inputs changes, and only then: an event raises the input, the link reads the input's version and rebuilds on read.
No time windows (AGENTS.md). An input that moves continuously (crowd, a money weight) is significant when it moves far
enough to change the link's answer: the money weight enters the income search linearly, so the search returns the
weights its answer stands over (`EquipmentIncomeRoute.search`); where no such range is computable, a significance rule
against the bot's own error (`incomeError`), the measure the observation event uses.

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
| Income search | held earning spot, row, hour | level/kit/matchup (E build, combat), loaded shot kind (–, beginner shots run out silently), origin spot/loc and samples/exclusions (E occupation), party (E relations), consumable prices (E market), `economicHunt` gate (E), money weight (the weights the answer stands over), crowd/room at candidate spots (–), risk exclusions there (–), spawn catalog period (–) | `holdRead`/`HOLD_MS` 30 game min, sections `COMPUTED.foundation` | window stands in for crowd/risk events; reads its own previous output (money[0], ECO-15) |
| Hunt / death / karma hours | hunt income, deathHours, karmaHours, riskWeight | income route + onSpotShare (E observation), exp/level (E), karma (E), lostGearHours (bag × prices, PK only) | `foundation` | rebuilt with the whole foundation |
| Kit and stock targets | shots/potions/scrolls targets, survival reserve, bag hours | live bag counts (E supply/bag), `visitEvery` (E town), slots and sale candidates (E bag), restCap = wallet (E money: not wired, kept foundation keeps a stale restCap) | `foundation` → `kitReader` | needs only the bag/money, rebuilt with the income search |
| Source facts | where to get each wished item | level/kill band/spoiler (E build), sourceRouteReader (exclusions, economicHunt, grouped), trips + hourAdena, spot values (crowd –, samples E, deathHours/riskWeight drift every round) | `WishProviders.sourcePath` → `GearAcquisitionPlanner.sourceFacts` per build, ~9 % | values move every round: hold gains < 0.5 % until crowd/risk are versioned |
| Wish projection | money queue, focus, plan | bag, kit, level, plan/focus, prices, foundation outputs, wallet/reserve, trip rows, board offers, spot values, sourceGround | `WishProviders.build` on every unserved build, 16.7 % | ~60 KB per bot, cannot be held whole; needs per-node rebuild |
| Workshop | best recipe, income/hour | money packet, wallet, recipes/craft level, maxMp, class/level, reservations, recipe bag items, board reads, route rows | planner `occupation`, `heldWorkshop` (route key, workshop mask) | party/karma members asked every step (fixed cb292781) |
| Action plan | buy/sell/craft plan | bag amounts, money/escrow, own board lines and read quotes, wish build, MP only through `floor(mp/mpCost)` and `mpCost ≥ mp` | planner `action` after `ColdEconomyPlan.edges` | bit 8 (rest→hunt) fires every cycle; exact MP refresh |
| Showcase | shop display | bag, prices, board | planner `showcase` per shopping step | small |

## Cross-cutting fixes the links need

1. Packet layouts with one owner (`StatsPacket`: money, stockTargets, dangerPrice), named readers (AGENTS.md).
2. State replaced, not edited in place (NpcRestockPlan's clone, cached-state repairs), so a link may key on identity.
3. Per-spot versions: a crowd/room revision in `SpotOccupancyIndex` and a risk-exclusion revision in `SpotRiskPolicy`,
   read by the links that read those spots (no dispatch to bots needed: the reader compares versions).
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
2. Per-bot input versions instead of section masks: bag, money, kit, level, occupation, relations, market. A link
   stores the versions it read; `DecisionSections.COMPUTED` becomes these per-link input sets.
3. Per-spot versions (crowd, risk); then `HOLD_MS` and other windows go.
4. Planner results keyed by input versions per mode (one slot per bot per mode, outside the 64-slot pool for finished
   cards); `edges` against a baseline of the facts the action reads (MP thresholds included).
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

None has a limits.md row or a debt line naming its missing event (except TownNavigation 120 s). Biggest work first
(src/GameServer/...): `EconomyContext` HOLD_MS 30 game min (missing: spot-risk change, occupancy, consumable price,
beginner-shot runout); `ColdSoloWindow` soft inputs at the window end (market watch has board writes but no wake);
party member goal review every 60 s (`PopulationService` ~476, `GoalPlanner` ~22, `GoalService` ~41: the inputHash
already names the inputs); `PartyRequestPlanner` reviewAt + partyWaitReplanMs 5 min; `PopulationService` phase policy
10 s (player cell change + walker schedule would do); party income review 5 min (`PartyGoalPolicy` ~62,
`CraftMaterialParty` ~202); REVIEW_MS 5-min holds (`CraftMaterialParty`, `PartyIncomeComparison`: keys miss kit,
spoiler, route permission); `PartySessionReview` 20/5 min; +10/30 s step polls in `BackgroundResolver`
(~2543-2699), `BackgroundPartyResolver` (~189-355), `ClanPartyDuty` waiting on outcomes that already fire;
`ColdMarketService` RETRY_DELAY_MS 15 min (the buyer wake is half-dead: `GoalExecutor` ~43 still refuses until the
stamp); `ColdMarketListingService` 30 min; `MarketDemandIndex` WANTED_TTL 30 min + a 15-min re-persist that exists to
beat it; 30-min holds in `ColdShotEconomyService`, `ItemDisposition` ~394, `WishProviders` ~663, `CombinedErrandPolicy`;
`CraftMarketReview` 15/2 min; `FirstPrice` CACHE_MS 1 h over static inputs; clan reviews (`ClanWarDirector`,
`ClanActionService`, `ClanEquipmentService`), `ClanGoalCandidateService` 30 s TTL, `ClanWarehouseService` 1 h keyed by
clan only, clan runtime 5 s DB re-reads; hot AI 0.15-2 s scans (`BotSupportPlanner`, `PartyAwareness`,
`HotBackgroundParty`, `PartyCompanionService`, `BotStatus`) missing a spatial-cell NPC revision; `HotActorLodPolicy`
8/10/3/15 s; `GearAcquisitionPlanner` 1-4 h cooldowns; ~15 small ones with an existing revision not in the key.
Unclear (time may be the real input): hunt evidence aging 6 h, "no progress over N" rules, LLM policy TTL, ColdPve
10 min, clan rescue duration. Also found: `MarketBuyerActivity.refresh` is never called (its score is dead). ~140
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
