# Second pass: silent failures and masking defaults (2026-11-03)

Checked at 199c3b19 (2026-11-04).

**Re-verified on t106dev** (2026-11-03); line numbers below are approximate, from the first (stale) pass — search by
name. Open rows only. A floating promise without a catch reaches the process backstop (`NodeL2`: an unhandled
rejection is logged once per reason and counted).

| Where | Pattern | Player effect | Sev | Known |
|---|---|---|---|---|
| `BackgroundResolver` ~1167, ~1515 | `npcForSpot(...) \|\| { maxHp: max(1, spot.mob?.hp \|\| 1), pDef: 1, … }` | no template → a 1-HP mob with the spot's real rewards: free cold EXP and drops | high | new |
| `BotAI/SpotValueTable` ~123 | geodata manifest read → null | spot values missing | low | new |
| `ColdSimulationCoordinator` ~1945 | `flatMap → []` drops bad requests with no ack (counted, `cold.request_dropped:<why>`) | worker waits on a command that never returns | med | new |
| `Inventory/ShotStock` ~646 + `Bot/TradeService` ~425-443 | catch-all around buys; failed refund only attached to the error (counted, `shots.store_buy`) | adena lost, no item | med-high | new (PER-2) |
| `Database` ~4402 + `HotBackgroundParty` ~326 | errors flattened to `party_opening_rollback`, caller `.catch(() => {})` | marked raid never starts, no log | med | new |
| `TownServiceCatalog` ~155 | World in catch → [] | empty town targets | low-med | POP-3 twin |
| `ReceivedHit` ~176/185, `BotManager` ~801/814, `RemoveShortcut` ~16 | write promise with no catch | a DB rejection reaches only the process backstop (logged once, counted); the write is lost | med | new |
| `ClassTransfer` ~65 | rollback write `.catch(() => {})` | DB class ≠ memory class | low | new |
| `Database` ~3553/3586 | AFK credit `Math.max(1, … \|\| 1)` | 0/NaN becomes 1 (latent) | low | new |
| `ProgressionRates` ~227, `NpcShopPriceScale` ~2, `BotEconomyPricing` ~7 | `Math.max(1, rate \|\| 1)` | rates below 1 ignored | low | new |
| `PopulationService` ~2895 vs ~2459, `BackgroundWorkGovernor` ~142, `FloorAwareActivationPolicy` ~57 | `\|\| 40` vs `\|\| 0` for the same "0 = off" config | config 0 means off in one place, default in another | low | new |

Known items also confirmed: CMB-14 stat-recalc catches, WOR-13 minion/geometry/arena catches.
The scan flagged 210 catches; the list above is the ones that matter.
