# Second pass: dead and always-taken branches (2026-11-03, t106dev @ c29722e7 + uncommitted)

Checked at 5771494a (2026-11-03).

Open rows only. Known items (WOR-4/5, POP-14/17, CMB-9/15/16, ECO-8, AI-8/9/10, PER-4, WOR-3) left out.

| Where | Condition | Why dead / always | Verdict |
|---|---|---|---|
| `ProductionPolicy`, `FixedShotOffers` (~45 lines), `TradeService`, `MarketOpportunity`, `WishPurchaseEvidence`, `StaticMerchantPricing` | `staticShotsDisabled` default true since T106 ("C4: no NPC sells D-S shots"); only one test sets false | dead by default, test-only knob (decided: goes, debt.md) |
| `ProductionPolicy.buyersDisabled()` (13 sites) | `staticBuyersDisabled` default false, set only by 4 tests | test-only (operator knob? ask) |
| `NpcObjectIndex.find/nearTemplate` scan fallback; `HotBackgroundParty:382` `isIndexed` | index built in `World.init`; only a boot window | dead after boot (test worlds never build the index) |
| `World.fetchNpcsInRadius` (`typeof` / `?.()`, 8 sites), `World.isBotSession`, `World.fetchVisibleUsers` (`ClanWarRuntime`), `World.updateUserLocation/Presence` (`Model/Actor`) | targets always defined; else returns `[]` silently | dead guards for test doubles (debt.md theme 6) |
| `CharacterLocationIndex` `legacyStateCache` | only `false` user is `CharacterActorSources` (WOR-5) | dead after WOR-5 |
| `*_resetForTests` / `terminateForTest` exports | test hooks | keep (cheap) |

Live, not dead: quest "compatibility entry point" files; `ClanRaidRoster` `legacy: true`; EconomyContext
`nativeCraftContinuation` (a hot/cold difference). Unproven without a real world DB: `Database.js:~3325` pricing cursor
without `seenAt`, `:~11274` legacy receipts, `BotAfkMarketService:~364`, `MarketPricing:~93`.
