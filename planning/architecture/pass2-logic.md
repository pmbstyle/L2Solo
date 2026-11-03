# Second pass: game logic bugs (2026-11-03)

Checked at 516f6ef9 (2026-11-03).

Checked against Lisvus C4 (Mobius C4 not fetched). **All 10 re-verified on t106dev** (2026-11-03, probes rerun there).

| # | Bug | Where | C4 / correct | Confidence |
|---|---|---|---|---|
| L1 | A PK who dies drops ~0.7 items and needs 6 PKs | `PkDropPolicy.enabled/rollPlan` (hot `PkDeathDrop`, cold `Database` ~3038, estimate `EconomicValuation`) | `pk >= 5`; one karma roll, then each item on its own chance (bag 50 %, worn armour 40 %, weapon 10 %) up to 10 | probe + source |
| | **L1 fixed 2026-11-03** in `PkDropPolicy` (one rule hot/cold/valuation). `config/default.ini` `pkDeathDropChance` is now the KarmaRateDrop roll and must be `0.7` | | | |
| L2 | Dying with karma takes no karma off | hot `DeathExperience.applyDeathPenalty` (record has no karma); cold commit SQL and `updateColdCharacterExperience` subtract only on gain | `addExp(-lost)` washes karma via `calculateKarmaLost`; `Karma.karmaLostForExperience` already handles negatives | source |
| | **L2 fixed 2026-11-03**: `DeathExperience.karmaLost` (hot `applyDeathPenalty` record karma; cold `applyColdDeath` record `karmaLost`, applied once by the cold commit). Left: `BotLifeState.prepareResolve` main-thread persist path still writes unwashed `stats.karma` | | | |
| L3 | Hot bot-only parties stand at 31 % HP and re-pull | `HotBackgroundParty` ~460 uses `RestPolicy.needsRest` trigger lines as stand line | cold party and hot solo rest to 95 %; `RestPolicy` needs a "rest until" line | reading |
| | **L3 fixed 2026-11-03**: `HotBackgroundParty` keeps a party resting to `RestPolicy` locked lines | | | |
| L4 | Restart gives full HP and MP | `RestartPoint`, `BotAI` revive `restoreFullVitals`; cold `resolveDeathRecovery` | Lisvus `doRevive`: HP × 0.7, MP not restored; one respawn rule | source |
| | **L4 fixed 2026-11-03**: `Formulas.respawnHp` (0.7) in `Revive` (every revival, skills too) and `resolveDeathRecovery`; MP and CP kept | | | |
| L5 | Cold bots with karma never trade; errands wiped each step; may rest forever | `ColdSimulationKernel.lifecycleKind` returns `resolver` for any karma first; `ColdKarmaPolicy.plan` clears equipmentPlan, marketReturn, craftReturn, supplyErrand, warehouse*; no spot → `resting` without `restUntil` | all "PK trades in Floran" code unreachable cold; hot walks to Floran from anywhere. One rule hot/cold (design 5.8) | reading |
| L6 | Unreachable "traveling with market reason → command" branch | `ColdSimulationKernel.js` ~406 after ~376 returns for every `traveling` | dead or lost route | reading |
| L7 | Newbie Guide fully heals bots; resting uses it as a heal | `BotBuffs.applyFullNewbieBlessing`, `RestingState`, `HotTownRebuff` | C4 Newbie Guide only buffs | reading |
| L8 | NPC pays ≥ 1 adena for a 0-price item | `NpcSellRules.npcBuyPrice` `max(1, …)` | C4 `price / 2` = 0; an adena source | reading |
| L9 | Non-PK killed by monsters never drops items | not implemented | Lisvus `PlayerRateDrop` (C4 config) 5 % above level 4 — check Mobius defaults first | guess |
| L10 | `session.townGossip` never set; "stay seated forever" branch | `RestingState.js` ~250 | dead, no exit if ever set | reading |

Correct per Lisvus: Lucky to level 4, death EXP % `6.5 − 0.07·level`, overhit cap 25 %, party EXP bonus, `pkKillKarma`,
mob EXP gap (5/6)^(gap−5), `karmaLostForExperience`, static buyer cap (no buy-sell profit), `TripPayment` ≥ 0.
