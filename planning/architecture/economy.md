# Economy and trade

Checked at 516f6ef9 (2026-11-03).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift (~); search by name.
Scope: `Bot/Economy` (~26k lines), `AfkTrade`, `PrivateStore*`, `Bot/{TradeService,BotTradeService,
MerchantStoreConfigs}`, `src/Market*`, `src/Economy*`, `Population/ColdEconomy{Plan,Decision}`. (`Bot/BotMerchant.js`
and the HTML shop bypasses `BuyBotShop`/`BuyMerchantItem`/`SellToMerchantItem` are gone: aeed748e, da467f98.)

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
  `MarketCounters.firstPrice` → `FirstPrice` (24f9fee9).
- **Offer search:** `OfferQuery` + `OfferOrder`, trip cost `OfferOrder.tripCost` → `EconomicTrip`; main through
  `MarketOpportunity.bestOffer`.
- **Wallet:** `PurchaseFunding` ("one wallet rule for hot/cold purchases").
- **Warehouse:** hot `BotWarehouseService.depositActorAtWarehouse`, cold `depositCold`, worker mirror
  `PersonalWarehouseIndex`, craft staging `CraftWarehousePolicy`.
- **Crafting for trade:** decisions in the worker (`WealthCraftDecision`, `ShotCraftPolicy`, `CraftProfitPolicy`,
  `ProductionSalePolicy`); execution on main (`ColdWealthCraftService`, `ColdShotEconomyService`,
  `HotWealthCraftService`, `ColdCraftingService`); `CraftShopService`, `CraftWorkshopService`.
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
| Adena rate scaling | `BotEconomyPricing.scalePrice/economyRate` |
| Which offer to buy | `OfferQuery.bestSellOffer` + `OfferOrder` |
| Trip cost | `OfferOrder.tripCost` → `EconomicTrip` |
| Spendable money | `PurchaseFunding` |
| Whether a road pays for a funded required kit piece or survival stock (visit, trip, tier) | `EconomicValuation.roadCarried` (read by `visitPays`/`tripPays`; step marked `required` by `WishNetwork`; 48956cf3) |
| What to sell / list / NPC-sell | `MarketListingPolicy.evaluate` / `npcSaleForActor` |
| Bid lines | `BuyAdPolicy.linesFor/bidFor` |
| Shop town | `MarketTownPolicy.chooseTown` (see ECO-5) |
| Reservations, sale and warehouse candidates | `ItemDisposition` (see ECO-7) |
| Board state, settlement | `AfkTradeService` + `BoardIndex`; meetings `TradeMeetingService` |
| Cold physical purchase | `ColdMarketService.acquire` |
| NPC purchase | `NpcRestockPlan` → `NpcPurchaseBasket` |
| Plan publication | **open** (ECO-1) |

## Debt

- **ECO-1 — decided 2026-11-03: the worker plan is the only decider** (as for occupations); `reconcile` and the town
  visit become executors of world-bound steps; the second computation and `economy-plan-parity.js` go. Own plan in
  `planning/`, after the three flags. Was: **three main paths publish a bot's board lines** — `executePlan` (worker plan), `reconcile`
  (main recompute), `ColdMarketListingService.open` → `listOnBoard`. `scripts/economy-plan-parity.js` keeps worker
  and the "old main pass" in sync by a 95 % match, not by one call. Canonical probably `executePlan` (guess). Large.
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
  its only callers are `ShotStock`'s two hot restock reads, each with its own `accept`). NPC price read from four places (`BotMarketPricing.npcPrice`,
  `StaticMerchantPricing.cheapestPurchase`, `MarketOpportunity.npcOffers`, `NpcRestockPlan.quoteFor`); agreement
  unverified.
- **ECO-7 warehouse candidates twice** (`ItemDisposition.warehouseCandidates` vs `unreservedActorItems` +
  `isWarehouseCandidate`); a legacy craft-return path still live.
- **ECO-8 dead/compat code.** `ShotSalePolicy` alias and `describeStoreItems` — paid 2026-11-03 (a2aed31b). Exports
  only tests read (`TradeService.ratedPrice`, `MarketOpportunity.activeBuyDemandSelfIds`, `findBuyOffers`; the first
  and last are also used inside their module); `BuyAdPolicy` `legacyEstimate`; `MarketSnapshot` legacy
  shape.
- **ECO-9 stale parity scripts** `scripts/{economy-plan,decision,clan-numbers,wish-cache}-parity.js`: not in
  package.json, tests or CI; `economy-plan-parity.js` last changed at 3a7d03fb, 15 `ColdEconomyPlan` commits ago.
  Wire in or delete.
- **ECO-10 T189 gate — paid 13a7ba29.** `Reaction` is the only rule (POP-10); the gate-off path, its configure switch
  and the flag are deleted. The commit cites `docs/t189-plan.md`, which does not exist: its gate-off fixes are unconditional code.
  Left (found then): a far bot's own move is no event anywhere (`own_move` waits at every far place), so the stand-in
  pairing of `DecisionSections.occupationPlanned` (T139: `travel.leafSpotId`, `stats.standIn`) decides only for a
  forced trip and a near bot; a far bot moved to another spot without a trip (a pull) never hears it as an occupation
  event. Review whether the pairing goes or the pull becomes a link. Paid 48956cf3 (found then): a far bot never
  left to buy a funded required kit piece or survival stock sold elsewhere: its step's value (the wish's benefit) never
  paid a road. Rule now: a step of a funded required root (a `power:<item>:<slot>` kit piece, not a clan supply, or a
  `stock:` survival root; not an earning craft, crystal preparation or any other `progressionPriority` holder) is
  marked `required` by `WishNetwork` (kept in `Agenda` STEP_FIELDS). `EconomicValuation.roadCarried`, read by
  `visitPays` and `tripPays` (cold build and agenda, hot `HuntingState`): its road is already paid on a full fill; a
  part fill carries it iff share × benefit > (1 − share) × road; never a road dearer than the goods it brings
  (moneyPrice × fees + hours ≤ moneyPrice × cost). Leaf values stay the wish's benefit. `Agenda.nextSeller` lets a
  required step go up to its funded unit price, not beyond. Required stock whose road its goods do not carry (at the
  bot's hour) holds no tier, as unsupplied stock (T178): the kit tier goes on, the stock rides along in the agenda
  of a visit or is bought in town. The hot `canTravelForPurchase` request passes `wanted` (the whole need still to
  buy), so `tripPays` reads the same share as a visit's step. The visit, the trip and the tier read one step shape
  (`roadCarried`: unit price × units the seller fills, their share of the need). Accepted: a far bot with no potions
  keeps hunting without them until a town visit (a kit trip, a full-bag sale, a death's respawn).
  Left: a required item's bid worth has two readings, `TradeIntent.wishRows` (the queue row's value, lifted to
  price × floor) and `itemUsefulness`/`worth` (`demands`, the wish's own weighted benefit).
- **ECO-11 silent catches.** `ColdEconomyPlan.prepare`: a throwing `buyBatch` → `buy_error`, counted only with
  diagnostics on, no log; `PopulationService` ~345 `reconcile(...).catch(() => null)`; per-owner queue in
  `BotAfkMarketService.reconcile` swallows; `BotNegotiationService` persistence (`.catch(() => {})`);
  `TradeMeetingService` `entry.ready.catch(() => {})` (the rest there logs via `infoWarn`).
- **ECO-12 worker hazard — checked in validation: none live.** Both worker callers pass `findSpot`
  (`ColdEconomyPlan.prepare` → `MarketListingPolicy.evaluate` and `BuyAdPolicy.linesFor` via `buyAdTown`;
  `ColdSimulationWorker` ~405, trade-meeting seller). The `SpotService.findById` fallback in `targetTownForItems` (and
  `BuyAdPolicy.bidFor`/`linesFor` defaults without a town) is reached only on main. It stays a trap for a new worker
  caller.
- **ECO-13 demand sources unclear:** `MarketDemand`, `MarketTradeDemand`, `BuyInterestIndex`, `MarketDemandIndex`
  (worker), `ShotTradeDemand`, `PriceBelief.demandValue`, `MarketCounters`. `MarketDemand` looks like the entry
  (guess).

## Open questions

1. ECO-1: worker `executePlan` only, with `reconcile`/`open` reduced to executors? Or does main keep a recompute?
2. Should hot buy/sell read the same `MarketListingPolicy`/`OfferQuery` answers as cold?
3. Player-facing price models (negotiation, chat price limit, craft fee): design choices, or read `MarketPricing`?
4. Which NPC price source is canonical? Is `ProgressionRates.multiplier` vs `.adena` intended?
5. `targetTownForItems` or `chooseTown`? What is "step 3.6"?
6. Parity scripts: still a role?
7. Can legacy branches go (saved goals, parked craft plans, `MarketSnapshot` shape)? (`ShotSalePolicy` gone, a2aed31b.)
