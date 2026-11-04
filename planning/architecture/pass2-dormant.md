# Second pass: dormant features and dead config (2026-11-03, t106dev)

Checked at 39e43408 (2026-11-04).

Read on the main checkout (t106dev + uncommitted). Open rows only. Known items (POP-17, WOR-5, PER-4, AI-8/9) left out.

| # | Feature / key | Status | Evidence | Size |
|---|---|---|---|---|
| D2 | Clan warehouse reservations (`reserveClanWarehouseItem`, `releaseClanWarehouseReservation`) | dormant: `reservedAmount` always 0 live, ~70 `amount − reservedAmount` checks guard nothing | tests only | ~80 + checks |
| D4 | 16 disabled quests (`QuestRegistry`) | stated reasons stale for Q035, Q038, Q039 (NPCs/spawns now exist); real blocker: missing quest-item templates 7077, 7162, 7173-7181; `equipmentToolsByQuest` empty | — | 1624 |
| D7 | Clan strategy / ClanBrain / LLM titles (`strategicManagementEnabled=true`, `llmGoalManagementEnabled=true`, `llmTitleManagementEnabled=false`) | inert without OpenRouter (off by default): "legacy deterministic lifecycle" is the real behaviour | `ClanStrategyService.review` | ~900 |
| D8 | `staticShotsDisabled=true` | `FixedShotOffers` and `allowsFixedShot` dead, while 16 static "Shots:" store bots still sell D-S shots to players (contradicts its own "C4: no NPC sells D-S shots") | MerchantStoreConfigs ~384 | 33 + 8 sites |
| D9 | `staticBuyersDisabled=false` | A/B knob, true branch in ~12 sites, tests only | — | ~12 sites |
| D12 | ~8 Database one-liners (`deleteCharacterQuest`, `deleteGearItems`, `deleteShortcuts`, `deleteMacros`, `updateCharacterName`, `updateWarehouseItemAmount`, `deleteWarehouseItem`, `fetchAutonomousClanOperation`) | no caller | — | ~30 |
| D14 | `.admin` panel (`Speak.js` ~147), Admin* bypasses, UiTest | **reachable by any player; `fetchIsGM` never checked** (decided: stays open, debt.md) | — | note |
| D15 | `GameServer.pvp`, `GameServer.maxOnline` | cosmetic bytes in the server list, not enforced | ServerList | — |
| D16 | `devLogPlayerChat=true` | needs `developerDiagnostics` too | Speak ~21 | — |

Live as tools: HuntCycle. Native* bypasses: sent by the client mod (guess).
