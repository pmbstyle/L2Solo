# Second pass: silent failures and masking defaults (2026-11-03)

Checked at 199c3b19 (2026-11-04).

**Re-verified on t106dev** (2026-11-03); line numbers below are approximate, from the first (stale) pass — search by
name. Open rows only. A floating promise without a catch reaches the process backstop (`NodeL2`: an unhandled
rejection is logged once per reason and counted).

| Where | Pattern | Player effect | Sev | Known |
|---|---|---|---|---|
| `BackgroundResolver` ~1167, ~1515 | `npcForSpot(...) \|\| { maxHp: max(1, spot.mob?.hp \|\| 1), pDef: 1, … }` | no template → a 1-HP mob with the spot's real rewards: free cold EXP and drops | high | new |
| `BotAI/SpotValueTable` ~123 | geodata manifest read → null | spot values missing | low | new |
| `ColdSimulationCoordinator` ~1889 | `flatMap → []` drops bad requests with no ack | worker waits on a command that never returns | med | new |
| `ColdSimulationKernel` ~1519 | a refused command post → requeue +5 s, no log (a throw is a bot fault) | loop every 5 s | med | — |
| `ColdCommitQueue` ~459 | an `afterCommit` throw outside a named step is counted (`failures.afterCommitErrors`), not logged | training/review/events after commit lost | high | POP-2 |
| `Inventory/ShotStock` ~553 + `Bot/TradeService` ~425-443 | catch-all around buys; failed refund only attached to the error | adena lost, no item, no log | med-high | new (PER-2) |
| `ColdSimulationOwner` ~116 | `catch → return state` on row parse | cache misses settlements, PK drops, revisions | med | new |
| `ColdShotEconomyService` ~224 | `catch → return state` after a paid recipe buy | may re-buy or mismatch adena | med | new |
| `ColdWealthCraftService` ~390 | catch after committed sale | revenue lost from accounting | low-med | new |
| `Cooldown` ~40, `PartyCompanionService` ~862 | `try { BotTradeService.cleanup } catch {}` | player's trade window stays open with a gone bot | med | new |
| `BotTownTravel` ~96, `ShoppingState` ~1189/1206 | `markHot(...).catch(() => null).then(BotAI.init)` | bot hot in memory while row cold: two owners | med | new |
| `Database` ~4402 + `HotBackgroundParty` ~326 | errors flattened to `party_opening_rollback`, caller `.catch(() => {})` | marked raid never starts, no log | med | new |
| `HuntingState` ~410, `TownServiceCatalog` ~155 | SpotService/World in catch → null/[] | stale spot; empty town targets | low-med | POP-3 twins |
| `BotSupportPlanner` ~440/454 | empty catch on party/summon lookup | support skips buffs | med | new |
| `ReceivedHit` ~176/185, `BotManager` ~801/814, `RemoveShortcut` ~16 | write promise with no catch | a DB rejection reaches only the process backstop (logged once, counted); the write is lost | med | new |
| `BotEventJournal.record(...).catch(() => {})` in Die, NpcDied, LevelUp, Backpack, Attack, BotSpotTravel, BotTownTravel | journal failures | bot forgets events in dialogue | low | new |
| `ClassTransfer` ~65 | rollback write `.catch(() => {})` | DB class ≠ memory class | low | new |
| `Database` ~3553/3586 | AFK credit `Math.max(1, … \|\| 1)` | 0/NaN becomes 1 (latent) | low | new |
| `ProgressionRates` ~227, `NpcShopPriceScale` ~2, `BotEconomyPricing` ~7 | `Math.max(1, rate \|\| 1)` | rates below 1 ignored | low | new |
| `PopulationService` ~2895 vs ~2459, `BackgroundWorkGovernor` ~142, `FloorAwareActivationPolicy` ~57 | `\|\| 40` vs `\|\| 0` for the same "0 = off" config | config 0 means off in one place, default in another | low | new |

Known items also confirmed: ECO-11 set, CMB-14 stat-recalc catches, WOR-13 minion/geometry/arena catches, AI-10.
The scan flagged 210 catches; the list above is the ones that matter.
