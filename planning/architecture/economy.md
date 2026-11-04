# Economy and trade

Checked at 39e43408 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift (~); search by name.
Scope: `Bot/Economy` (~26k lines), `AfkTrade`, `PrivateStore*`, `Bot/{TradeService,BotTradeService,
MerchantStoreConfigs}`, `src/Market*`, `src/Economy*`, `Population/ColdEconomy{Plan,Decision}`.

**Names mislead:** a `Cold*` module in Economy is usually a main-thread service both hot and cold call
(`ColdMarketService` is used by `HuntingState`, `GoalExecutor`, `ClanMarketService`). The worker-side planner is
`Population/ColdEconomyPlan.js`.

## Mechanisms

- **Wish engine:** `EconomyContext.forState` (2.1k lines, the most rewritten file) + `WishNetwork`/`WishProviders`/
  `DecisionSections`/`Reaction` (T189). Runs in the worker. Main reads it via `ColdEconomyDecision.economyFor` (far
  bot → card, near bot → held decision). Main builds only `EconomyContext.basics`; the restocks (ShotStock,
  HealingPotionStock, ScrollStock, NpcRestockPlan, `ColdMarketService` funding) and the sale read the plan's kit
  instead (`keptKit` / `keptTargets`, see the owners).
- **Worker market plan:** `ColdEconomyPlan.prepare/decide` → `{take, sell, withdraw, buyAds, shot, bidLimits}` (byte
  capped), from `MarketListingPolicy`, `BuyAdPolicy`, `MarketTownPolicy`, `ReadyTradeChoice`. Main runs it with
  `BotAfkMarketService.executePlan`.
- **Main reconcile:** `BotAfkMarketService.reconcile` → `reconcileBuyAds`/`reconcileSellShop` recomputes lines on main;
  the sell shop only when its bag key moved (`stockSignature`: fired personal and beginner shots stay out while the
  published kit holds and no arrows are held).
- **Cold town visit:** `ColdMarketListingService.open`: enchant → NPC cleanup → `saleDecision` →
  `ColdMarketBuyStoreService.sellToBestBuyer` → `StaticBuyerService.sell` → NPC liquidation → `depositCold` →
  `listOnBoard`. The board writer's "no" to a bot's sell listing (a unit held for its gear, craft or clan,
  `economy_material_protected`; a moved stack; a cap) is a refusal its shop and ad publishers return with the reason
  (`BotAfkMarketService.listingRefusal`, counted `market:listing_refused:<reason>`): the visit is deferred, never a
  command fault.
- **Hot board review:** `HotBoardReviewService` reprices a hot owner's lines. Hot bots never open shops/ads themselves.
- **Hot shopping:** `AI/States/ShoppingState` with `TradeService`, `AfkTradeService.buyFromShop/sellToShop`,
  `NpcRestockPlan.purchaseForActor`, `MarketOpportunity`.
- **Cold purchase:** `ColdMarketService.acquire` ("the one purchase path"); NPC baskets `NpcRestockPlan` →
  `NpcPurchaseBasket`.
- **Board:** `AfkTrade/AfkTradeService` (records, projections, settlement), `BoardIndex` (shared with the worker),
  `TradeMeetingService` (field deals), `PlayerBoardService` (player UI).
- **Store transactions:** `Bot/TradeService` (configured merchants, NPC packets; live player stores via
  `PrivateStoreTrade`), `PrivateStore`, `BotTradeService` (player ↔ bot window), `BotNegotiationService`.
- **Board price chain:** `MarketPricing` → `PriceDecision` (one module for main and worker) → `PriceBelief` →
  `MarketCounters.firstPrice` → `FirstPrice`.
- **Offer search:** `OfferQuery` + `OfferOrder`, trip cost `OfferOrder.tripCost` → `EconomicTrip`; main through
  `MarketOpportunity.bestOffer`.
- **Wallet:** `PurchaseFunding` ("one wallet rule for hot/cold purchases").
- **Required kit and survival stock:** a step of a funded required root (a `power:<item>:<slot>` kit piece, not a clan
  supply, or a `stock:` survival root; not an earning craft, crystal preparation or any other `progressionPriority`
  holder) is marked `required` by `WishNetwork` (kept in `Agenda` STEP_FIELDS). `EconomicValuation.roadCarried`, read
  by `visitPays` and `tripPays` (cold build and agenda, hot `HuntingState`), decides whether its road pays: already
  paid on a full fill; a part fill carries it iff share × benefit > (1 − share) × road; never a road dearer than the
  goods it brings (moneyPrice × fees + hours ≤ moneyPrice × cost). Leaf values stay the wish's benefit.
  `Agenda.nextSeller` lets a required step go up to its funded unit price, not beyond. Required stock whose road its
  goods do not carry (at the bot's hour) holds no tier, as unsupplied stock (T178): the kit tier goes on, the stock
  rides along in the agenda of a visit or is bought in town. The hot `canTravelForPurchase` request passes `wanted`
  (the whole need still to buy), so `tripPays` reads the same share as a visit's step. The visit, the trip and the
  tier read one step shape (`roadCarried`: unit price × units the seller fills, their share of the need). Our choice:
  a far bot with no potions keeps hunting without them until a town visit (a kit trip, a full-bag sale, a death's
  respawn), so a missing potion never costs a trip of its own.
- **Warehouse:** hot `BotWarehouseService.depositActorAtWarehouse` (each write rechecks the actor at the NPC in its
  transaction; a party companion's overweight errand, `AI/CompanionInventoryCleanup` → `ShoppingState`, passes
  `unload`: free stock past the candidates, heaviest first, until below the first weight penalty; its arrows go to
  the NPC through `SellJunk`), cold `depositCold`, worker mirror
  `PersonalWarehouseIndex`, craft staging `CraftWarehousePolicy`.
- **Crafting for trade:** decisions in the worker (`WealthCraftDecision`, `ShotCraftPolicy`, `CraftProfitPolicy`,
  `ProductionSalePolicy`); execution on main (`ColdWealthCraftService`, `ColdShotEconomyService`,
  `HotWealthCraftService`, `ColdCraftingService`); `CraftShopService`, `CraftWorkshopService`.
- **Hour value and spot income:** `BotHuntEfficiency.huntIncome`/`huntHour` (the bot's own hunt samples, else the
  precomputed spot table through `SpotValueTable`), `SpotEconomics.create` (crowding, calibration) — what every trip,
  purchase and wish prices an hour with; shots / potions pay (`ShotStock.usePolicy`, `EconomyContext.foundation`).
  Money of a kill is live (`SpotRewardExpectation.value`). See [tables.md](tables.md).
- **Observability:** `EconomyDiagnostics`, `MarketTelemetry`, `CraftTelemetry`, `MarketSnapshot`, `src/EconomyJournal`,
  `src/MarketTradeOverview*`, `src/MarketEconomyOverview`. The decision links' shadow (developerDiagnostics only):
  `EconomyContext` compares a key on `DecisionSections.LINK_INPUTS` with today's masks (`link:*` counts, the worker's
  `links=` status line; planning/decision-links).

## Data flow

**Cold:** worker step → `ColdEconomyPlan.edges` flags a decision point (loot, stock threshold, money, arrival, level,
death) → `EconomyContext.forState` → `ColdEconomyPlan.prepare` → main `executePlan` writes board records. Field deal:
`ReadyTradeChoice` → `TradeMeetingService` → `AfkTradeService.finalizeTrade`. Physical buys: `GoalExecutor.beginMarketTravel`
sends the bot; in town `PopulationService` → `ColdMarketService.tryPurchase` (goal) or `acquire` (craft inputs, clan,
raid supply) → board / NPC / configured merchant (`buyNpcStack`, direct `Database.purchaseNpcInventoryItem`).

**Hot:** goal from the held decision → `ShoppingState` target order: workshop, equipment stop, live buyer (board vs
merchant bots), warehouse, buyer again, NPC sell-junk. Shots/potions/scrolls through `ShotStock`, `HealingPotionStock`,
`ScrollStock` with their own offer lists.

## Canonical owners

| Rule | Owner |
|---|---|
| Board ask/bid | `MarketPricing` over `PriceDecision`/`PriceBelief` |
| First price | `FirstPrice` via `MarketCounters.firstPrice` |
| Configured merchant price | `StaticMerchantPricing` |
| What a bot may buy where, and the price it pays | `ProductionPolicy` (`allowsNpcShot`, `allowsFixedShot`: a city store sells a bot only shots), read by `MarketOpportunity.botCanBuy` and `StaticMerchantPricing.cheapestPurchase(forBot)` (`botPurchasePrice`, `botBuyPrice`: the hunt model, potion and shot restock) |
| An item's NPC price (valuation, first price, a bot's NPC purchase price, the survival reserve, scrap-craft inputs), main and workers | `BotMarketPricing.npcPrice`/`npcPriceOf` over `NpcShopBuyLists.townPrices` (town sellers, cheapest row; read by `StaticMerchantPricing` and `ShotMarketIndex` through `npcPriceRows`, a worker's snapshot rows there). The workers get the table as rows (`npcPriceRows`, ~600 rows ≤ ~18 KB, once per worker start or clan context revision): cold in the `npc_offers` catalogue, clan in its planning context; a crafted shot's cost reads its inputs' price there |
| Adena rate scaling | `BotEconomyPricing.scalePrice/economyRate` |
| Which offer to buy | `OfferQuery.bestSellOffer` + `OfferOrder` |
| Trip cost | `OfferOrder.tripCost` → `EconomicTrip`; the worker's town route table is held by `EconomicTrip.key`, only what its rows read (a visit or a trip to one, the bot's point where no trip end or return point stands for it, a Scroll of Escape present, the karma flip): a rest, a hunt or a scroll used while one is left keeps the table and the held workshop |
| Spendable money | `PurchaseFunding` |
| Layout of the stats packet arrays (`stats.money`, `stats.stockTargets`, `stats.dangerPrice`: saved in `mindJson`, sent worker → main), hot and cold | `StatsPacket`: named writers (`money` + `addFunded`, `stockTargets`, `dangerPrice`) and readers (`hourAdena`, `moneyPrice`, `survivalReserve`, `firstUnfundedPrice`, the funded rows, `kitRow`, `deathHours`, `riskWeight`); slots and the unpriced scroll's -1 live only there. The values (rounding, the funded queue) stay with `PurchaseFunding.packetFor` and `EconomyContext.stockTargets` |
| Survival kit price and reserve (shots, potions, escape scroll) | `EconomyContext.kitReader`: the reserve holds the kit at the NPC table's price (`StaticMerchantPricing.botNpcListPrice`, the cheapest town NPC; the bot's estimate where no town NPC sells it). A restock counter (`PurchaseFunding.survivalTranche` → `spendable`) counts that share beside the queue's money; a town's tax above it comes from that money, and when that falls short the kit at the quote is still paid from the wallet (never refused) |
| A bot's kit targets on main (what a restock buys, what the sale keeps), hot and cold | `EconomyContext.keptKit` (purchase) / `keptTargets` (sale: `ItemDisposition.keptStock`, read by the listing, `MarketPricing`'s sale count and `ShotMarketIndex`'s own supply), one reader (`publishedKit`) of the worker plan's `stats.stockTargets` over the live bag, priced by `kitReader`; the basics when the row is missing, names another potion or shot, or shots that cannot restock rose since the build, and for a purchase when a scroll is missing and the row has no scroll hours (unpriced: the worker solves no route for the row). The fallback reasons are counted for diagnostics only (`kit:basics:<reason>`, while `EconomyDiagnostics` is active); a row without the restock slots serves the sale only. Our choice, not C4 |
| Whether a road pays for a funded required kit piece or survival stock (visit, trip, tier) | `EconomicValuation.roadCarried` (read by `visitPays`/`tripPays`; step marked `required` by `WishNetwork`) |
| What to sell / list / NPC-sell | `MarketListingPolicy.evaluate` / `npcSaleForActor` |
| Bid lines | `BuyAdPolicy.linesFor/bidFor` |
| Shop town | `MarketTownPolicy.chooseTown` (see ECO-5) |
| Reservations, sale and warehouse candidates | `ItemDisposition` (see ECO-7); a paused or retained gear project's stored share: `ItemDisposition.storedEquipmentAmounts` (bank once across both owners). The sale list's walk over the bag is kept per bag object and its exact inputs (limits.md "Kept sale lists"): readers of one bag with the same reserves share it |
| A bot's arrow stock (what it keeps, may buy, sells as surplus) | `Inventory/ArrowStock`: one grade, the equipped bow's, up to 2000 and below the first weight penalty (`ceil(maxLoad / 2) − 1`), never fewer than 500 kept (`KEEP_FLOOR`, our choice: selling them cannot clear a load the other items make); a bot's bow spends no arrows (`Actor/BowResources`), so the stock is weight only. Bots only (players are free). A purchase asks `ArrowStock.admitted` once, where its path sizes it: a wish purchase in `WishPurchaseEvidence` (every leaf's units), an NPC basket line in `NpcRestockPlan.collect` (after the basket's other lines), a bid in `BuyAdPolicy.bidFor`, a cold purchase in `BotLifeState.marketPurchaseBlocker` (worker commands too); each writer that credits a bot re-reads it on its rows inside the transaction (`Database` `checkArrowPurchaseUnsafe`: AFK buy, buy-ad fill, private store, NPC basket, meeting accept and arrival), which catches concurrent buys and deliveries in flight. The surplus: `ItemDisposition.unusedArrowCandidates` (the sale's own arrow lines) is read by every trigger (an ordinary cold visit's `unused_arrows` cleanup in `PopulationService.marketListingIntent`, run beside the worker's board plan; `SurvivalFloor` sale retry; `PartyMarketBreak`) and sold by the visit's NPC cleanup; a hot bag reads the live load limit (`MarketListingPolicy.actorState` `maxLoad`) |
| Board state, settlement | `AfkTradeService` + `BoardIndex`; meetings `TradeMeetingService` |
| Where a new trade meeting can take place | `AfkTrade/MeetingAnchor.compatible`: a side with an accepted meeting meets only in that meeting's town, both anchored sides at one point. Read by every offer chooser through `PartyAdmission.personalOfferAllowed` (hot, cold, main and worker) over the life-state marker `stats.tradeMeeting = [id, revision, town, locX, locY, locZ]` (a player, with no life state: the anchor `TradeMeetingService` keeps for it, mirrored to the cold worker as the `player_anchors` table), and by `TradeMeetingService.prepareTrade` over the fresh meeting rows. At boot `TradeMeetingService.init` rewrites every saved marker from the accepted meetings (`Database.refreshTradeMeetingMarkers` → `TradeMeeting.remark`): an old one gets its anchor, a stale one is cleared |
| Cold physical purchase | `ColdMarketService.acquire` |
| NPC purchase | `NpcRestockPlan` → `NpcPurchaseBasket` |
| Plan publication | decided: the worker plan; three paths still publish (ECO-1) |
| Whether a held economy build may be served (its event proof) | `EconomyContext.heldBuildVerdict` over the proof's code/config/rates identity, `RecomputeGeneration.current`: a detached checkout's commit or a launcher install's the install marker .l2solo/installation.json `sourceCommit`; a branch tree gets a process-local identity (held builds hold in the process). A proof saved for a restart only under a published identity (`restorable`); the identity is the claimed commit plus config and rates, not a content hash: a hand-edited install or a dirty detached tree keeps the release sha (startup logs the source: `Recompute :: code identity`). A throw in a proof or advisory codec costs a full rebuild and counts as `economy.codec:<which>` (a negative or non-finite quantity included: its producer is wrong); a saved advisory that inflates past its cap is refused uncounted, like the other shape checks |

## Debt

- **ECO-1 three main paths publish a bot's board lines** — `executePlan` (worker plan), `reconcile` (main
  recompute), `ColdMarketListingService.open` → `listOnBoard`. `scripts/economy-plan-parity.js` keeps worker and the
  "old main pass" in sync by a 95 % match, not by one call. **Decided 2026-11-03: the worker plan is the only
  decider** (as for occupations); `reconcile` and the town visit become executors of world-bound steps; the second
  computation and `economy-plan-parity.js` go. Own plan in `planning/`. Large.
- **ECO-2 hot/cold copy: selling to buyers.** Hot `TradeService.findBestBuyerForActor` (`adena − distance/10`) vs
  `findAfkBuyerForActor` (expected receipts) compared in `ShoppingState` in different units; cold
  `StaticBuyerService` + `ColdMarketBuyStoreService`. "Configured buyer takes only `Other.Material`" written twice.
- **ECO-3 hot/cold copy: buying from configured merchants.** Hot `TradeService.buyFromStore`; cold
  `ColdMarketService.buyNpcStack` with a direct DB purchase fallback.
- **ECO-4 price models outside the chain.** `ItemDisposition.priceFor` (70-90 % of reference, for sorting);
  `BotNegotiationService.pricePolicy` (own persona factors); `BotAfkTradeChat.buyPriceLimit`; craft fee
  `value*0.03 + mp*10` (`CraftShopService` ~160); `TradeService.ratedPrice` (used by `normalizeStoreItems` for
  non-static stores) duplicates `StaticMerchantPricing.configuredPrice`.
- **ECO-5 two town rules.** `MarketTownPolicy.targetTownForItems` (static grade) per item and in `BuyAdPolicy`, vs
  `chooseTown` (expected value) for the plan; `saleTown` has "until step 3.6".
- **ECO-6 offer queries on main bypass `OfferQuery`.** `MarketOpportunity.hotOffers` (hand filter, no `botCanBuy`;
  its only callers are `ShotStock`'s two hot restock reads, each with its own `accept`). An item's NPC price (valuation,
  `FirstPrice`, `StaticMerchantPricing`, `ShotMarketIndex`) is one table, main's and both workers' (see the owners row).
  Still open: the per-town NPC purchase quotes are read in two more places (`MarketOpportunity.npcOffers`,
  `NpcRestockPlan.quoteFor` over `npcOffers`), and the workers' offer rows come from two builders (cold
  `ColdNpcPlanningCatalog.buildRows`: low-tier gear, cheapest per town; clan `MarketOpportunity.npcOffersAll`: per
  seller); their agreement with the table is unverified.
- **ECO-7 warehouse candidates twice** (`ItemDisposition.warehouseCandidates` vs `unreservedActorItems` +
  `isWarehouseCandidate`); a legacy craft-return path still live.
- **ECO-8 dead/compat code.** Exports only tests read (`TradeService.ratedPrice`, `MarketOpportunity.activeBuyDemandSelfIds`, `findBuyOffers`; the first
  and last are also used inside their module); `BuyAdPolicy` `legacyEstimate`; `MarketSnapshot` legacy
  shape.
- **ECO-9 stale parity scripts** `scripts/{economy-plan,decision,clan-numbers,wish-cache}-parity.js`: not in
  package.json, tests or CI; `economy-plan-parity.js` last changed at 3a7d03fb, 15 `ColdEconomyPlan` commits ago.
  Wire in or delete.
- **ECO-10 far-bot events and bid worth.** A far bot's own move is no event anywhere (`own_move` waits at every far
  place), so the stand-in pairing of `DecisionSections.occupationPlanned` (T139: `travel.leafSpotId`, `stats.standIn`)
  decides only for a forced trip and a near bot; a far bot moved to another spot without a trip (a pull) never hears
  it as an occupation event. Review whether the pairing goes or the pull becomes a link. A required item's bid worth
  has two readings: `TradeIntent.wishRows` (the queue row's value, lifted to price × floor) and
  `itemUsefulness`/`worth` (`demands`, the wish's own weighted benefit).
- **ECO-12 worker hazard (a trap, none live).** Both worker callers pass `findSpot`
  (`ColdEconomyPlan.prepare` → `MarketListingPolicy.evaluate` and `BuyAdPolicy.linesFor` via `buyAdTown`;
  `ColdSimulationWorker` ~405, trade-meeting seller). The `SpotService.findById` fallback in `targetTownForItems` (and
  `BuyAdPolicy.bidFor`/`linesFor` defaults without a town) is reached only on main. It stays a trap for a new worker
  caller.
- **ECO-13 demand sources unclear:** `MarketDemand`, `MarketTradeDemand`, `BuyInterestIndex`, `MarketDemandIndex`
  (worker), `ShotTradeDemand`, `PriceBelief.demandValue`, `MarketCounters`. `MarketDemand` looks like the entry
  (guess).

- **ECO-14 post-commit plans refused** (measured 2026-11-03, 2 h of a growing 1731-bot world):
  `invalid_afk_trade_source` 55 (a plan names a stack row that changed; open: the plan's craft step runs before its
  sale and can consume a listed stack, so part of these may be gone with the craft kit reserve below) and
  `economy_plan_need_changed` 11 (a real staleness, counted). The plan's sale keeps the kit of the craft it selects
  (`ColdEconomyPlan.prepare` → `productionKit` → `ItemDisposition.saleReservations`), since
  `BotAfkMarketService.executePlan` runs `plan.shot` first. `saleReservations` owns the sum: reserves of different
  purposes add (gear plan inputs + one production kit, as main's listing check does), the planned kit and the setup in
  progress are one purpose (the larger per item). Open: in a cold town visit (`PopulationService.applyColdResolve` →
  `executePlan`, no post-commit step around it) the plan's own refusals (`economy_plan_*`, `afk_trade_shop_changed`
  from its bid, withdraw and buy-ad blocks) still leave the lifecycle command as a worker fault (`main_command`).
- **ECO-15 the income search reads its own output.** `EquipmentIncomeRoute.select` values spots in the band's best
  hour ("own outputs are not inputs"), but its `SpotEconomics.create` weighs money by `moneyWeight(state)`: the
  packet's hour (`stats.money` `hourAdena`, the last build's, i.e. the last search's `earning`) × money price
  (its `moneyPrice`, the gap wish's ratio, at least 1 / hour). For a bot whose gap ratio is above that floor (~half of
  the 1700-bot save) the answer depends on the previous answer, and the weight moves with every build (between two
  saves 100 min apart, same-focus bots: median |Δweight| 0.015, p90 0.39). Each spot's score is a line in the
  weight (valueHours = expHours·(1 − w) + incomeHours·w − riskHours, over a walk factor), and nothing else the search
  reads moves with it, so `EquipmentIncomeRoute.search` returns with its answer the weights it stands over (the
  comparisons of lines the answer reads, kept with a rounding margin; plus the packet's hour where the band has no
  money hour); the held earning spot searches again only when the weight leaves them (EconomyContext `weightMoved`).
  A search that moves the route, through the hour the next build publishes, can still ask the next one when that
  moves the weight past a crossing (and a bot's first build, searched with no packet, asks one more). Open: value
  the weight at the band hour.
## Open questions

1. ECO-1: worker `executePlan` only, with `reconcile`/`open` reduced to executors? — decided 2026-11-03: yes (ECO-1).
2. Should hot buy/sell read the same `MarketListingPolicy`/`OfferQuery` answers as cold?
3. Player-facing price models (negotiation, chat price limit, craft fee): design choices, or read `MarketPricing`?
4. NPC price: the valuation table is canonical (owners, `cheapestPurchase` reads it); should the per-town quotes
   (`npcOffers`) read it too? Is `ProgressionRates.multiplier` vs `.adena` intended?
5. `targetTownForItems` or `chooseTown`? What is "step 3.6"?
6. Parity scripts: still a role?
7. Can legacy branches go (saved goals, parked craft plans, `MarketSnapshot` shape)?
