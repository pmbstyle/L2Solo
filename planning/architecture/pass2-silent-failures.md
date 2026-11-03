# Second pass: silent failures and masking defaults (2026-11-03)

Checked at 516f6ef9 (2026-11-03).

**Re-verified on t106dev** (2026-11-03); line numbers below are approximate, from the first (stale) pass — search by name. At the
survey there was no `unhandledRejection` handler in `src/`: a floating write promise without a catch crashed the server.
Fixed 39f8d4fe: `NodeL2` logs an unhandled rejection once per reason and counts it; an uncaught exception still
exits (after the final flush).

| Where | Pattern | Player effect | Sev | Known |
|---|---|---|---|---|
| `BackgroundResolver` ~1167, ~1515 | `npcForSpot(...) \|\| { maxHp: max(1, spot.mob?.hp \|\| 1), pDef: 1, … }` | no template → a 1-HP mob with the spot's real rewards: free cold EXP and drops | high | new |
| `ColdSimulationKernel` solo ~2172, party ~2079 | catch → `fault` without stack → requeue (party every 1 s) | bot or party frozen, retries forever | high | POP-1, **fixed 6e521123** (backoff, quarantine, stack logged) |
| `BotAI/SpotValueTable` ~123 | geodata manifest read → null | spot values missing | low | new |
| `ColdSimulationCoordinator` ~1947 | main command catch → `ok:false, retryAfterMs:5000`, no log | bot repeats the failing sell/buy every 5 s | high | **fixed 6e521123**: a command's throw is a bot fault (first stack logged); a DB error a plain retry, counted `commandDbErrors`, first logged |
| `ColdSimulationCoordinator` ~1889 | `flatMap → []` drops bad requests with no ack | worker waits on a command that never returns | med | new |
| `ColdSimulationKernel` ~1519 | command send catch → requeue +5 s, no log | loop every 5 s | med-high | **fixed 6e521123** for a throw (fault tracker); a refused post still requeues +5 s |
| `ColdCommitQueue` ~459 | `afterCommitError` never read | training/review/events after commit lost | high | POP-2; counted since 81e24715 (`failures.afterCommitErrors`), not logged |
| `Inventory/ShotStock` ~553 + `Bot/TradeService` ~425-443 | catch-all around buys; failed refund only attached to the error | adena lost, no item, no log | med-high | new (PER-2) |
| `ColdSimulationOwner` ~116 | `catch → return state` on row parse | cache misses settlements, PK drops, revisions | med | new |
| `ColdShotEconomyService` ~224 | `catch → return state` after a paid recipe buy | may re-buy or mismatch adena | med | new |
| `ColdWealthCraftService` ~390 | catch after committed sale | revenue lost from accounting | low-med | new |
| `Cooldown` ~40, `PartyCompanionService` ~862 | `try { BotTradeService.cleanup } catch {}` | player's trade window stays open with a gone bot | med | new |
| `BotTownTravel` ~96, `ShoppingState` ~1189/1206 | `markHot(...).catch(() => null).then(BotAI.init)` | bot hot in memory while row cold: two owners | med | new |
| `Database` ~4402 + `HotBackgroundParty` ~326 | errors flattened to `party_opening_rollback`, caller `.catch(() => {})` | marked raid never starts, no log | med | new |
| `HuntingState` ~410, `TownServiceCatalog` ~155 | SpotService/World in catch → null/[] | stale spot; empty town targets | low-med | POP-3 twins |
| `BotSupportPlanner` ~440/454 | empty catch on party/summon lookup | support skips buffs | med | new |
| `ReceivedHit` ~176/185, `BotManager` ~801/814, `RemoveShortcut` ~16 | write promise with no catch | DB rejection crashed the server; since 39f8d4fe logged once and counted | med | new |
| `BotEventJournal.record(...).catch(() => {})` in Die, NpcDied, LevelUp, Backpack, Attack, BotSpotTravel, BotTownTravel | journal failures | bot forgets events in dialogue | low | new |
| `ClassTransfer` ~65 | rollback write `.catch(() => {})` | DB class ≠ memory class | low | new |
| `Database` ~3553/3586 | AFK credit `Math.max(1, … \|\| 1)` | 0/NaN becomes 1 (latent) | low | new |
| `ProgressionRates` ~227, `NpcShopPriceScale` ~2, `BotEconomyPricing` ~7 | `Math.max(1, rate \|\| 1)` | rates below 1 ignored | low | new |
| `PopulationService` ~2895 vs ~2459, `BackgroundWorkGovernor` ~142, `FloorAwareActivationPolicy` ~57 | `\|\| 40` vs `\|\| 0` for the same "0 = off" config | config 0 means off in one place, default in another | low | new |

Known items also confirmed: ECO-11 set, CMB-14 stat-recalc catches, WOR-13 minion/geometry/arena catches, AI-10.
The scan flagged 210 catches; the list above is the ones that matter.
