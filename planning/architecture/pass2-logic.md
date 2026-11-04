# Second pass: game logic bugs (2026-11-03)

Checked at 39e43408 (2026-11-04).

Checked against Lisvus C4 (Mobius C4 not fetched). 2026-11-04 pass read today's changes (fight gate and readiness,
unhuntable ground, NPC price table, meeting anchors, craft kit reserve, party fences, FailureLog, PR #207 arrow stock and
reserves); confidence "reading" = the path read to its end, "probe" = a node probe on game data, "guess" = not read to
the end. Open rows only, by impact.

| # | Bug | Where | C4 / correct | Confidence |
|---|---|---|---|---|
| L24 | After 4 failed hot writes a supply errand's return resumes the AI anyway (`population.supply_return_cold`): the bot plays hot with a cold, unfenced row, the two-owner state 352fa954 removed | `BotTownTravel.returnSupplyHot` ~106 | one owner: stay parked and leave it to the cold path, or fence until a write lands | reading; rare |
| L25 | An accepted meeting has no age limit: a cold side fighting or resting is skipped and progress waits on events; meanwhile `MeetingAnchor.compatible` limits all its trades to the point and `partyTradeAllowed('party')` keeps it out of parties | `TradeMeetingService.processMeeting` | a meeting that ends (our design, not C4) | guess |
| L26 | `fencedBots` is one Set: a failed party or PvP activation's `finally` releases every id it fenced, including a member who left meanwhile and is now fenced by another owner | `ColdSimulationCoordinator.releaseFence`, `HotPartyLifecycle.activate`, `PvpEncounterLifecycle.activate` | release only fences this owner holds; `handoffToMain` CAS is the backstop | reading; frequency guess |
| L27 | Cold karma wash falls short when one round both gains EXP and ends in death: the commit washes the net gain `max(0, exp − old)/260` plus the death's `karmaLost`, so X gained and Y lost washes X/260 (Y < X) or Y/260, not (X+Y)/260; `stats.karma` is then overwritten from `characters` | `Database.applyColdPhysicalStateUnsafe` ~3041 and the death wash ~3074 | Lisvus washes on each `addExp`, gain and death loss alike | reading |
| L28 | Hot ground look judges spawns with `{ soloSafety: true }` only; cold adds the recovery `maxTargetLevel` (`soloPickOptions`), so under a recovery a hot bot keeps a ground cold would raise | `BotDecisionService.groundLook` vs `BackgroundResolver.admittedShares` / `routeRefuses` | one option set hot and cold | reading |
| L5 | Cold bots with karma never trade; errands wiped each step; no spot → `resting` without `restUntil` | `ColdSimulationKernel.lifecycleKind` returns `resolver` for any karma first; `ColdKarmaPolicy.plan` clears equipmentPlan, marketReturn, craftReturn, supplyErrand, warehouse* | all "PK trades in Floran" code unreachable cold; hot walks to Floran from anywhere. One rule hot/cold (design 5.8) | reading |
| L6 | Unreachable "traveling with market reason → command" branch | `ColdSimulationKernel.lifecycleKind` ~421, after ~393 returns `resolver` for every `traveling` | dead or lost route | reading |
| L7 | Newbie Guide fully heals bots; resting uses it as a heal | `AI/BotBuffs.applyFullNewbieBlessing` (`setHp`/`setMp` to max), `RestingState.beginNewbieGuideRecovery`, `HotTownRebuff` | C4 Newbie Guide only buffs | reading |
| L8 | NPC pays ≥ 1 adena for a 0-price item | `NpcSellRules.npcBuyPrice` `max(1, …)` | C4 `price / 2` = 0; an adena source | reading |
| L9 | Non-PK killed by monsters never drops items | not implemented | Lisvus `PlayerRateDrop` (C4 config) 5 % above level 4 — check Mobius defaults first | guess |
| L10 | `session.townGossip` never set true; "stay seated forever" branch | `RestingState.js` ~270 | dead, no exit if ever set | reading |
| L29 | Warehouse has no slot cap; a companion's overweight unload (`BotWarehouseService` `unload`) deposits without bound | `Database.transferInventoryToWarehouse` | C4 100 slots, 120 for dwarves (Lisvus `WAREHOUSE_SLOTS_*`) | reading |

Correct per Lisvus: Lucky to level 4, death EXP % `6.5 − 0.07·level`, overhit cap 25 %, party EXP bonus, `pkKillKarma`,
mob EXP gap (5/6)^(gap−5), `karmaLostForExperience` (the death-time wash, hot and cold), static buyer cap (no buy-sell
profit), `TripPayment` ≥ 0, weight penalty steps 50/66.7/80/100 %.
