# Economy and trade

Checked at 199c3b19 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift (~); search by name.
Scope: `Bot/Economy` (~26k lines), `AfkTrade`, `PrivateStore*`, `Bot/{TradeService,BotTradeService,
MerchantStoreConfigs}`, `src/Market*`, `src/Economy*`, `Population/ColdEconomy{Plan,Decision}`.

**Names mislead:** a `Cold*` module in Economy is usually a main-thread service both hot and cold call
(`ColdMarketService` is used by `HuntingState`, `GoalExecutor`, `ClanMarketService`). The worker-side planner is
`Population/ColdEconomyPlan.js`.

## Mechanisms

- **Wish engine:** `EconomyContext.forState` (2.1k lines, the most rewritten file) + `WishNetwork`/`WishProviders`/
  `DecisionSections`/`Reaction` (T189). Runs in the worker. Main reads it via `ColdEconomyDecision.economyFor` (far
  bot → card, near bot → held decision). Main builds only `EconomyContext.basics` (ShotStock, HealingPotionStock,
  ScrollStock, NpcRestockPlan).
- **Worker market plan:** `ColdEconomyPlan.prepare/decide` → `{take, sell, withdraw, buyAds, shot, bidLimits}` (byte
  capped), from `MarketListingPolicy`, `BuyAdPolicy`, `MarketTownPolicy`, `ReadyTradeChoice`. Main runs it with
  `BotAfkMarketService.executePlan`.
- **Main reconcile:** `BotAfkMarketService.reconcile` → `reconcileBuyAds`/`reconcileSellShop` recomputes lines on main.
- **Cold town visit:** `ColdMarketListingService.open`: enchant → NPC cleanup → `saleDecision` →
  `ColdMarketBuyStoreService.sellToBestBuyer` → `StaticBuyerService.sell` → NPC liquidation → `depositCold` →
  `listOnBoard`.
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
- **Warehouse:** hot `BotWarehouseService.depositActorAtWarehouse`, cold `depositCold`, worker mirror
  `PersonalWarehouseIndex`, craft staging `CraftWarehousePolicy`.
- **Crafting for trade:** decisions in the worker (`WealthCraftDecision`, `ShotCraftPolicy`, `CraftProfitPolicy`,
  `ProductionSalePolicy`); execution on main (`ColdWealthCraftService`, `ColdShotEconomyService`,
  `HotWealthCraftService`, `ColdCraftingService`); `CraftShopService`, `CraftWorkshopService`.
- **Hour value and spot income:** `BotHuntEfficiency.huntIncome`/`huntHour` (the bot's own hunt samples, else the
  precomputed spot table through `SpotValueTable`), `SpotEconomics.create` (crowding, calibration) — what every trip,
  purchase and wish prices an hour with; shots / potions pay (`ShotStock.usePolicy`, `EconomyContext.foundation`).
  Money of a kill is live (`SpotRewardExpectation.value`). See [tables.md](tables.md).
- **Observability:** `EconomyDiagnostics`, `MarketTelemetry`, `CraftTelemetry`, `MarketSnapshot`, `src/EconomyJournal`,
  `src/MarketTradeOverview*`, `src/MarketEconomyOverview`.

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
| An item's NPC price (valuation, first price), main and workers | `BotMarketPricing.npcPrice` over `NpcShopBuyLists.townPrices` (town sellers, cheapest row). The workers get the table as rows (`npcPriceRows`, ~600 rows ≤ ~18 KB, once per worker start or clan context revision): cold in the `npc_offers` catalogue, clan in its planning context; a crafted shot's cost reads its inputs' price there |
| Adena rate scaling | `BotEconomyPricing.scalePrice/economyRate` |
| Which offer to buy | `OfferQuery.bestSellOffer` + `OfferOrder` |
| Trip cost | `OfferOrder.tripCost` → `EconomicTrip` |
| Spendable money | `PurchaseFunding` |
| Survival kit price and reserve (shots, potions, escape scroll) | `EconomyContext.kitReader`: the reserve holds the kit at the NPC list price (`StaticMerchantPricing.botNpcListPrice`, the bot's estimate where no NPC sells it). A restock counter (`PurchaseFunding.survivalTranche` → `spendable`) counts that share beside the queue's money; a town's tax above it comes from that money, and when that falls short the kit at the quote is still paid from the wallet (never refused) |
| Whether a road pays for a funded required kit piece or survival stock (visit, trip, tier) | `EconomicValuation.roadCarried` (read by `visitPays`/`tripPays`; step marked `required` by `WishNetwork`) |
| What to sell / list / NPC-sell | `MarketListingPolicy.evaluate` / `npcSaleForActor` |
| Bid lines | `BuyAdPolicy.linesFor/bidFor` |
| Shop town | `MarketTownPolicy.chooseTown` (see ECO-5) |
| Reservations, sale and warehouse candidates | `ItemDisposition` (see ECO-7); a paused or retained gear project's stored share: `ItemDisposition.storedEquipmentAmounts` (bank once across both owners) |
| A bot's arrow stock (what it keeps, may buy, sells as surplus) | `Inventory/ArrowStock`: one grade, the equipped bow's, up to 2000 and below the first weight penalty (`ceil(maxLoad / 2) − 1`); a bot's bow spends no arrows (`Actor/BowResources`), so the stock is weight only. Read at every purchase planner and writer (ECO-15) |
| Board state, settlement | `AfkTradeService` + `BoardIndex`; meetings `TradeMeetingService` |
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
  `FirstPrice`) is one table, main's and both workers' (see the owners row). Still open: the NPC purchase quotes are
  read in four more places (`StaticMerchantPricing.cheapestPurchase`, `MarketOpportunity.npcOffers`,
  `NpcRestockPlan.quoteFor` over `npcOffers`, `NpcShopBuyLists.allOffers` for the shot price in `ShotMarketIndex`,
  which also reads the fallback lists and non-town sellers: a no-grade shot has two NPC prices, hot and cold agree on both), and the workers' offer rows come from two builders (cold
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

- **ECO-14 trades that fail because the plan moved** (measured 2026-11-03, 2 h of a growing 1731-bot world): 548 AFK
  market purchases and 43 buy-store sales failed with `trade_meeting_point_changed`, plus 126 post-commit economy plans
  refused (`economy_material_protected` 60, `invalid_afk_trade_source` 55, `economy_plan_need_changed` 11). A deal is
  agreed, then its meeting point, stock or need moves before it settles: worker and main work spent for nothing, and
  bots that never get their item. Find why the meeting point changes between agreement and arrival (owner: the trade
  meeting, `AfkTrade` meeting preparation / `BotAfkMarketService`) and whether the plan can hold it.
- **ECO-15 arrow cap and companion unload checked in many places** (merged from develop PR #207). The arrow
  capacity (`ArrowStock.purchaseAmount`) is re-checked at ~11 call sites: planners (`NpcRestockPlan.collect`,
  `ReadyTradeChoice.purchase`, `WishPurchaseEvidence.reader`, `ColdOccupationSources` `preparePurchase`), buyers
  (`ColdMarketService.buyOffer`, `BotLifeState.marketPurchaseBlocker`, `TradeService.buyFromStore`) and writers
  (`Database.checkArrowPurchaseUnsafe` in the AFK buy, buy-ad sale, private store, NPC basket, trade meeting
  receive/complete), instead of one admission the planners read. A hot companion's unload
  (`AI/CompanionInventoryCleanup`) picks its own deposit set by weight and sells arrows through
  `Database.sellItemsToNpc` directly, beside `BotWarehouseService.depositActorAtWarehouse` and `SellJunk` (ECO-7, ECO-2).
  `PopulationService` skips the worker plan for a shopping bot holding surplus arrows (`arrowCleanupFirst`), a main
  decision beside the worker plan (ECO-1).
## Open questions

1. ECO-1: worker `executePlan` only, with `reconcile`/`open` reduced to executors? — decided 2026-11-03: yes (ECO-1).
2. Should hot buy/sell read the same `MarketListingPolicy`/`OfferQuery` answers as cold?
3. Player-facing price models (negotiation, chat price limit, craft fee): design choices, or read `MarketPricing`?
4. NPC price: the valuation table is canonical (owners); should the purchase quotes (`cheapestPurchase`, `npcOffers`)
   read it too? Is `ProgressionRates.multiplier` vs `.adena` intended?
5. `targetTownForItems` or `chooseTown`? What is "step 3.6"?
6. Parity scripts: still a role?
7. Can legacy branches go (saved goals, parked craft plans, `MarketSnapshot` shape)?
