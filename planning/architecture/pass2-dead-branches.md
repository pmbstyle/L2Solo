# Second pass: dead and always-taken branches (2026-11-03, t106dev @ c29722e7 + uncommitted)

Checked at 516f6ef9 (2026-11-03).

Not yet acted on. Known items (WOR-4/5, POP-10/14/17, CMB-9/15/16, ECO-8, AI-8/9/10, PER-4, WOR-3) left out.

| Where | Condition | Why dead / always | Verdict |
|---|---|---|---|
| `Economy/CraftSupplementMaterials.js` + `GearAcquisitionPlanner` (5 sites), `Clan/ClanCraftingPolicy` | `isSupplementalMaterial` returns `false` ("kept for callers of the old interface"); `isSupplement` export unused | dead; removed 0ef32de3 |
| `BotAfkMarketService.js:~123` | `target?.condition === 'alive_and_recovered'` — no writer | dead |
| `RaidCurse.js:66-67`, `Npc/Generics/ReceivedHit.js:34-35` | `raidBossAttackTargetId` fallback; every Creature has `state` | dead (field write-only) |
| `ProductionPolicy`, `FixedShotOffers` (~45 lines), `TradeService`, `MarketOpportunity`, `WishPurchaseEvidence`, `StaticMerchantPricing` | `staticShotsDisabled` default true since T106 ("C4: no NPC sells D-S shots"); only one test sets false | dead by default, test-only knob |
| `ProductionPolicy.buyersDisabled()` (13 sites) | `staticBuyersDisabled` default false, set only by 4 tests | test-only (operator knob? ask) |
| `SpawnNpcs`, `NpcDecay`, `C4SkillEffects`, `Backpack`, `SummonControl` (11 sites) | `if (world.addNpcToGrid) … else reindex` — World always has it; else = full reindex | test-only |
| `NpcObjectIndex.find/nearTemplate` scan fallback; `HotBackgroundParty:382` `isIndexed` | index built in `World.init`; only a boot window | dead after boot |
| `Model/Npc.js:166` `!kind → killable`; `Npc.js:138` `!actor.state` | 0 of 4525 templates lack `kind`; every Creature has `state` | test-only |
| `PopulationService.js:833-845` "legacy composition API" | all 3 methods exist; DB init precedes | test-only |
| `ColdSimulationWorker` `LOOP_ALARM = true` | fixed constant; `setInterval` else dead | dead |
| `PopulationConfig` keys `partyFormationIntervalMs`, `activationLevelRange`, `partyRecruitmentChatEnabled`, `partyRecruitmentChatIntervalMs`, `partyRecruitmentChatGlobalMinIntervalMs` | no reader | dead config |
| `TownNavigation.js:11` `L2_TOWN_NAVIGATION !== '0'` | nothing sets it | dead switch |
| ~25 `typeof X === 'function'` / `?.()` guards on always-present methods (`Database.isReady` ×5, `ClanService.reload` ×4, `Generics.skillExec`, `BotManager.handlePlayerSpeak`, `LifeState.allStates`, `World.fetchNpcsInRadius` ×3, `World.registeredActorById` ×6, `World.isBotSession/fetchVisibleUsers`, `World.updateUserLocation/Presence`) | targets always defined; else returns `[]` silently | dead guards (theme 1) |
| `CharacterLocationIndex` `legacyStateCache` | only `false` user is `CharacterActorSources` (WOR-5) | dead after WOR-5 |
| `*_resetForTests` / `terminateForTest` exports | test hooks | keep (cheap) |
| `L2NODE_HOT_LOAD_TEST` | load-test hook | removed 8f90027c with `HotBotLoadTest` (the perf tool's hot scenario replaces it) |

Live, not dead: quest "compatibility entry point" files; `ClanRaidRoster` `legacy: true`; EconomyContext
`nativeCraftContinuation` (a hot/cold difference). Unproven without a real world DB: `Database.js:~3325` pricing cursor
without `seenAt`, `:~11274` legacy receipts, `BotAfkMarketService:~364`, `MarketPricing:~93`.
