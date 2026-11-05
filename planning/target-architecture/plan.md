# Target architecture: bots that decide like players, on a data core that scales

Open plan, gathered 2026-11-05 from the maintainer's directions in one place (replaces the session notes on the
worker census and kit targets). Goal: ~1700 bots today on modest hardware, 5-10k later (possibly after a Rust rewrite).
Focus now: the cold worker. Detailed earlier plan for the links: planning/decision-links/plan.md (its principle is
corrected by this one).

## 1. Principles

1. **A bot decides the way a C4 player does: rarely and by situation** (AGENTS.md). A decision (where to hunt, what to
   wish for or buy, a workshop, a party, an action plan) is taken at a situation a player takes it at (arrived at a
   spot or in town, level up, new gear, death, a crowded own spot, invited, a stock below its line) and held until the
   next one; between them the bot carries out the plan. Prices, crowd at other spots, money and bag counts are read
   when it decides and do not wake it. No time windows. A realism-for-exactness trade that is also the main CPU lever.
2. **One situation mechanism for every decision.** Situations are named and raised in one place by their owners;
   each decision only declares which situations wake it; holding and waking are shared. Base today:
   `DecisionSections` sections/events and `DecisionEvents.raiseDecision`. No decision keeps its own wake logic.
3. **Strategic DDD for the system's shape.** Bounded contexts with one owner each: combat, economy (market, kit,
   wishes), population (life, occupation), party and clan, world, persistence. The context map is
   planning/architecture/. Situations are the domain events between contexts. A bot state is an aggregate replaced,
   not edited, by its owner. One language: C4 terms in code, map and talk. Not tactical OO DDD (entity classes with
   behaviour, repositories, service layers): it fights pure rules on plain data, worker messages, memory and a Rust
   port.
4. **An ECS-like data core for the cold simulation.** Entity = bot id; components = flat data per kind with one
   owner each (position, vitals, bag, kit, occupation, plan); systems = the per-step pure functions (rounds, travel,
   regen, effects). Decisions are not systems: they run on situations above the components, never a per-tick scan of
   all bots. The hot path (NodeL2 classes, packets, tens of bots) stays as it is.
5. **Pure calculations cached on exact inputs** (damage, prices, routes, table reads, matchup): the key is exactly
   what the result reads (AGENTS.md).
6. **Scale out, not only cheaper.** One worker cannot carry 5k bots; data by id makes sharding bots over several
   workers possible.

## 2. Where the worker's time goes (census 2026-11-05, 29ae424cd cold, 1735 bots)

Busy 35.7 s CPU/min (59.5 % of a core) = 20.6 ms per bot per minute (0ff31aa96 with the heap/CPU release regression: 45.9 s).

| Bucket | ms/min | % |
|---|---|---|
| Decision building: source facts 2 942, income search 2 691, wish projection 2 434, sale/listing 1 443, hold checks 990, gear plan 758 | 13 992 | 39 |
| Planners: action/showcase/craft 2 195, workshop search 1 982, bookkeeping 1 534 | 7 060 | 20 |
| Simulation: solo rounds 3 017, step prep 1 423 | 5 049 | 14 |
| VM 2 206, GC 1 957, messaging 1 845, party forming 1 530, commit prep 1 199 | | 24 |

Cross-cutting: matchup 5.9 s inclusive (17 %), monster damage memo 2.05 s. The worker spends most of its time
deciding again, not simulating: builds 358/min (0.21 per bot per minute) at 20.5 ms, the wish focus unchanged in
57 %; planner asks 1.76 per bot per minute, always fresh; card reuse 1 107/min rebuilds basics every time.

## 3. Scaling blockers

- CPU: ~31 s/min linear in bots, ~5 s faster than linear (market-driven refusals, board-depth reads, planner
  invalidations, party candidates). 5k bots ≈ 2.2 cores, 10k ≈ 6, with today's code.
- Caches sized for 2048 bots: `RETAIN_LIMIT` held builds (EconomyContext ~60; past it served steps become 20 ms full
  builds), `SOLO_SEARCH_LIMIT` (PartyIncomeComparison ~18), spot value memo 32 768 (already evicting).
- Memory: worker old generation 512 MB (ColdSimulationCoordinator ~398) vs ~111 KB per bot + 45 MB fixed → OOM near
  ~3000 bots (limits.md). Biggest per bot: state copies from main ~25 KB, held income candidates ~12 KB, wish
  projection ~9 KB, gear planner ~7 KB.

## 4. Order of work

1. **Heap/CPU release (now, `ivan/batch-5`):** finish the worker regression fixes (held-spot crowd replay, planner key + listing hold; done: price
   interval, forming key, solo-search trim, assess once), the monster damage memo (exact, −1.0-1.3 s), final CI and
   perf. The exact-key fixes stay useful under the new principle.
2. **Decision cadence pass (next release, first; design: situations.md):** per decision (earning spot, wish/gear, source facts, workshop,
   party forming, action/showcase plan), list the situations a C4 player decides at; compare with today's trigger
   counts (counters exist: `incomeHold` event:*, `raisedLinks`, held refusals, planner asks per mode); build the one
   situation catalogue (owner, raiser, the decisions it wakes); move each decision onto it and delete its own wake
   logic. Expected: most of the 39 % decision building and much of the 20 % planners.
3. **Kit and stock targets** (the first instance of 1.1, designed and decided, §5).
4. **ECO-10:** a far bot's own spot move as a situation (every reader).
5. **Scaling limits:** size the 2048-bot caches by population with limits.md rows; worker heap per bot down
   (components instead of whole-state copies, trimmed held results).
6. **Components:** split the cold bot state into owned components; commits and worker messages carry the touched
   components only (today ~2.4 ms per commit, whole ~20 KB rows).
7. **Typed arrays** for the simulation core's numbers by id.
8. **Sharding** bots over several workers.

Smaller exact targets that remain after the cadence pass are re-ranked then: per-step checks (reviewMarket/lookOwn,
forcedCleanupNeed, equipInventoryUpgrades: hold on bag + own-line revisions, −1-1.5 s), per-spot ground verdict
after each level/gear change (GearAcquisitionPlanner ~2265-2294, 2.0 s, real work: re-judge only cells that can flip),
messaging (size only messages near the cap, skills by id+rank, `ColdClassPolicy` ~47 stringify key). Recheck after the
regression fixes: TableMirror.apply 0.43 → 0.80 s (planner invalidations 97k → 303k/min), workshop search, listing
disposition/holdKey, GC, cards +8.3 MB (df5e10f7e).

## 5. Kit and stock targets (decided 2026-11-05)

A player decides how much to buy at the merchant and watches only what is left in the field.

- **Today:** `EconomyContext.foundation` builds rates, frozen counts, outing hours and `restCap`; a kept foundation
  keeps stale counts. No explicit "below X, go back" rule: the trip is the wish network's `stock:<kind>` root priced by
  `roadCarried`; far bots rebuild in the field only when an item hits 0 or potions fall below the survival line; near
  bots rebuild whenever quantity bands refuse (hot and cold differ). In town all purchases use targets from the build
  before the sale. Probable bug: a bot arriving with a full bag of sellables gets a 0.5 h outing and buys ~1 h.
- **Design:** the foundation publishes rates (shots/h, potions/h by spot danger, rest bottles, benefit per unit,
  outing hours, survival lines), not frozen targets. At the town event `kitReader` computes targets and amounts from
  rates + live bag + wallet after the sale + local quote. In the field one function, hot and cold: return line = one
  hour of use per kind (potions by spot danger, scroll 1); the live count crossing below it is the `need_supply`
  situation for near and far bots alike. Deleted: `restCapOf` in the foundation, frozen `current`, the published-target
  branch, `shotCurrentAtBuild`, card `stock()` → `basics()` (debt 20), kit bands above the line.
- **Decisions:** below the line a trip for survival items (healing potions, escape scroll) is mandatory, no road
  payoff check; shots are not survival: they ask at the line (one hour of firing left) and go only if `roadCarried`
  pays. Above the line the field money queue holds a constant outing refill (usual purchase × price), so gear does not
  take the next kit's money. A far bot's own spot move keeps the old potion line until ECO-10. Claude's defaults: fix
  the 0.5 h sale-visit outing (test first); `stats.shotDemand` only below the line and in town; `gapHorizonHours`
  stays in the kit row. Later idea: a safer spot instead of a trip.
- **Readers to move** (T town, F field): `ShotStock` / `HealingPotionStock` / `ScrollStock.restockPlan` via
  `NpcRestockPlan` (T), `ColdMarketService.purchaseMoney/Terms/planPurchase` (T), `ItemDisposition.keptStock`,
  `ShotMarketIndex`, `RestPotion.spareBottles` (F, already line + live count), `DecisionSections.needsOpened`,
  `quantityBands` + `bandsHold`, `ColdEconomyPlan.factEdges`, `nearFields.shotRestock` → companion errand,
  `EconomyContext.shotDemand`, wish stock roots, `HuntingState` / `NeedsEvaluator` → `canTravelForPurchase`,
  `PartyMarketBreak.shotRestock`, card view, `PriceDecision.waitRate`, `ShotCraftPolicy`, money packet survival reserve
  readers.
- **Cost:** worker ~3 bag reads per build, no `basics(projected)` per round; near bots far fewer ~30 ms rebuilds;
  main loses the debt-20 `basics()`; +40-60 B per `StatsPacket` row; no DB writes.
- **Risks:** a bot that never visits town (as today); party members (`PartyMarketBreak` gates departure); shot
  crafter reserve at craft time; beginner shots (debt 21) become a situation; many tests pin today's targets.
