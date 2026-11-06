'use strict';
// A craft gear route stalls when its kit collects nothing for STALL_KILLS kills (ours:
// about 2-4 h of a hunter's fights, limits.md "Craft route stall"). Owned here, read by
// the gear plan (GearAcquisitionPlanner: finalizePlan stamps equipmentPlan.stall
// { kills, kind }, craftPlanFailure judges it at the build) and by the step's fact diff
// (DecisionSections.factsOf kills/stall, Situations.factNames: source_stalled at the
// crossing). The kill count is stats.fightsWon: a far round's wins
// (BotLifeState.prepareResolve) and a body's kills near a player (NpcDied), one counter.
// A bot that hunts something else still counts: its route collected nothing for those
// kills either; a bot that does not hunt (town, a party's rest) counts none and needs no
// stall. Plain stats reads, both threads. No clock.
const STALL_KILLS = 300;
const killsOf = state => Math.max(0, Number(state?.stats?.fightsWon) || 0);
// The stall a plan stamps now (kind: 'craft').
const stallFor = (state, kind) => ({ kills: killsOf(state) + STALL_KILLS, kind });
// The kill threshold a state's gear plan waits at, 0: none.
const stallKills = state => Math.max(0, Number(state?.stats?.equipmentPlan?.stall?.kills) || 0);
// The count crossed the threshold between two readings (the decision's baseline, now).
const crossed = (before, now, at) => at > 0 && Number(before) < at && Number(now) >= at;
module.exports = { STALL_KILLS, killsOf, stallFor, stallKills, crossed };
