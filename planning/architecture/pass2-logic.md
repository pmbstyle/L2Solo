# Second pass: game logic bugs (2026-11-03)

Checked at 199c3b19 (2026-11-04).

Checked against Lisvus C4 (Mobius C4 not fetched); re-verified on t106dev (2026-11-03, probes rerun there). Open rows only.

| # | Bug | Where | C4 / correct | Confidence |
|---|---|---|---|---|
| L2 | Dying with karma: the main-thread persist path writes unwashed `stats.karma` | `BotLifeState.prepareResolve` persist path (hot `applyDeathPenalty` and cold `applyColdDeath` wash by `DeathExperience.karmaLost`) | `addExp(-lost)` washes karma via `calculateKarmaLost`; one rule (PER-6) | source |
| L5 | Cold bots with karma never trade; errands wiped each step; may rest forever | `ColdSimulationKernel.lifecycleKind` returns `resolver` for any karma first; `ColdKarmaPolicy.plan` clears equipmentPlan, marketReturn, craftReturn, supplyErrand, warehouse*; no spot → `resting` without `restUntil` | all "PK trades in Floran" code unreachable cold; hot walks to Floran from anywhere. One rule hot/cold (design 5.8) | reading |
| L6 | Unreachable "traveling with market reason → command" branch | `ColdSimulationKernel.js` ~406 after ~376 returns for every `traveling` | dead or lost route | reading |
| L7 | Newbie Guide fully heals bots; resting uses it as a heal | `BotBuffs.applyFullNewbieBlessing`, `RestingState`, `HotTownRebuff` | C4 Newbie Guide only buffs | reading |
| L8 | NPC pays ≥ 1 adena for a 0-price item | `NpcSellRules.npcBuyPrice` `max(1, …)` | C4 `price / 2` = 0; an adena source | reading |
| L9 | Non-PK killed by monsters never drops items | not implemented | Lisvus `PlayerRateDrop` (C4 config) 5 % above level 4 — check Mobius defaults first | guess |
| L10 | `session.townGossip` never set; "stay seated forever" branch | `RestingState.js` ~250 | dead, no exit if ever set | reading |

Correct per Lisvus: Lucky to level 4, death EXP % `6.5 − 0.07·level`, overhit cap 25 %, party EXP bonus, `pkKillKarma`,
mob EXP gap (5/6)^(gap−5), `karmaLostForExperience`, static buyer cap (no buy-sell profit), `TripPayment` ≥ 0.
