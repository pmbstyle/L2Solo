# Second pass: dormant features and dead config (2026-11-03, t106dev)

Checked at 516f6ef9 (2026-11-03).

Read on the main checkout (t106dev + uncommitted). Known items (POP-10/12/17/18, WOR-5, PER-4, AI-8/9) left out.
Corrections to the map: **POP-14 is wrong** (the cold combat-profile migration is no longer scheduled, see D1);
**AI-8 is wrong** about `buy-bot-shop` (the handler `NpcBypasses/BuyBotShop` exists; only its link went).

| # | Feature / key | Status | Evidence | Size |
|---|---|---|---|---|
| D1 | Cold combat-profile migration (`maybeMigrateLegacyColdCombatProfiles` → `migrateLegacyColdCombatProfiles`, keys `coldCombatProfileMigration*`) | never runs; caller removed in 3fa8e44a | tests only | ~70 + 2 keys |
| D2 | Clan warehouse reservations (`reserveClanWarehouseItem`, `releaseClanWarehouseReservation`) | dormant: `reservedAmount` always 0 live, ~70 `amount − reservedAmount` checks guard nothing | tests only | ~80 + checks |
| D3 | HTML merchant shops `NpcBypasses/BuyMerchantItem`, `SellToMerchantItem`, `BuyBotShop` | no link opened them since 31900bb9, but they were still reachable: a second, non-atomic buy/sell path. Removed da467f98 | — | 382 + 3 tests |
| D4 | 16 disabled quests (`QuestRegistry`) | stated reasons stale for Q035, Q038, Q039 (NPCs/spawns now exist); real blocker: missing quest-item templates 7077, 7162, 7173-7181; `equipmentToolsByQuest` empty | — | 1624 |
| D5 | Ghost scheduler: `schedulerProfile`, `schedulerBudgetMs` (no caller), 5 s timer; keys `scheduler*BudgetMs`, `scheduler*MaxResolvesPerTick`, `schedulerIntervalMs` | telemetry only since 3fa8e44a | — | ~60 + 6 keys |
| D6 | Never-recorded metrics: `recordSchedulerRun`, `recordSchedulerSkip`, `recordEconomySafetyRepair`, `recordColdOwnerDbRetry`, `recordColdBatch` | counters always 0 (POP-15's "signal" `economySafetyRepairs` included) | — | ~45 |
| D7 | Clan strategy / ClanBrain / LLM titles (`strategicManagementEnabled=true`, `llmGoalManagementEnabled=true`, `llmTitleManagementEnabled=false`) | inert without OpenRouter (off by default): "legacy deterministic lifecycle" is the real behaviour | `ClanStrategyService.review` | ~900 |
| D8 | `staticShotsDisabled=true` | `FixedShotOffers` and `allowsFixedShot` dead, while 16 static "Shots:" store bots still sell D-S shots to players (contradicts its own "C4: no NPC sells D-S shots") | MerchantStoreConfigs ~384 | 33 + 8 sites |
| D9 | `staticBuyersDisabled=false` | A/B knob, true branch in ~12 sites, tests only | — | ~12 sites |
| D10 | Dead keys: `activationLevelRange`, `partyRecruitmentChat{Enabled,IntervalMs,GlobalMinIntervalMs}`, `partyFormationIntervalMs`, `maxResolvesPerTick`, `BotPopulation.debug`, `ClanSimulation.marketDemandTimeoutMs` | no reader; removed 0ef32de3 | — | ~15 lines |
| D11 | `PersonaEconomicPolicy`, `WealthInvestmentPolicy`, `CraftWorkshopService.publishDemand` (+ helpers) | never wired; removed 0ef32de3 | tests only | ~150 + 2 tests |
| D12 | `BotManager.findHighDensityCoord`, `botShout`; `ClanHall/Repository.clanHallBlocksDissolution` (duplicated inline); ~8 Database one-liners (`deleteCharacterQuest`, `deleteGearItems`, `deleteShortcuts`, `deleteMacros`, `updateCharacterName`, `updateWarehouseItemAmount`, `deleteWarehouseItem`, `fetchAutonomousClanOperation`) | no caller; the first three removed 0ef32de3 (the Database one-liners not re-checked) | — | ~75 |
| D13 | `Response.partySmallWindowDelete` | never sent; removed 0ef32de3 | — | small |
| D14 | `.admin` panel (`Speak.js` ~147), Admin* bypasses, UiTest | **reachable by any player; `fetchIsGM` never checked** | — | note |
| D15 | `GameServer.pvp`, `GameServer.maxOnline` | cosmetic bytes in the server list, not enforced | ServerList | — |
| D16 | `devLogPlayerChat=true` | needs `developerDiagnostics` too | Speak ~21 | — |

**D5 correction (2026-11-03):** the 5 s timer is not telemetry only: `recordSchedulerProfile` publishes the
player-activity and lag signal (`PopulationMetrics.schedulerState`) that the cold worker pressure and the background
work admissions read. Only its budget/resolve-cap part was a ghost (removed with its keys).

Live as tools: HuntCycle. HotBotLoadTest (scripts) was replaced by `src/Perf` and `perf.js run --scenario=hot` and removed (8f90027c). Native* bypasses: sent by the client mod (guess).
