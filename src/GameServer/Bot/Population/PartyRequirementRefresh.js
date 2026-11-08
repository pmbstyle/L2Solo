'use strict';

function acquisitionRequirementKey(plan) {
    return JSON.stringify({
        status: plan?.status || null,
        strategy: plan?.strategy || null,
        partyNeed: plan?.partyNeed || (plan?.requiresParty ? 'required' : 'solo_ok'),
        partyNeedReason: plan?.partyNeedReason || null,
        requiresParty: Boolean(plan?.requiresParty),
        target: Number(plan?.target?.selfId || 0),
        nextSpot: plan?.next?.spotId || null,
        nextNpc: Number(plan?.next?.npcId || 0),
        nextItem: Number(plan?.next?.itemId || 0)
    });
}

function acquisitionFallbackEvent(state, previousPlan, failure, nextPlan) {
    return {
        type: 'gear_acquisition_fallback',
        summary: `${state.name} abandoned an unproductive ${previousPlan?.target?.name || `item ${failure.targetId}`} drop route`,
        weight: 3,
        meta: {
            reason: failure.reason,
            targetId: failure.targetId,
            npcId: failure.npcId,
            resolves: failure.resolves,
            targetKills: failure.targetKills,
            nextStrategy: nextPlan?.strategy
        }
    };
}

// A plan the member's row takes in place of its own: neither its clan-locked plan
// stands against it (GearAcquisitionPlanner.clanPlanKeptAgainst) nor does it serve
// another clan's goal (ClanMembershipPolicy.foreignGoal). Main's write of a member
// plan reads the same answer on its copy.
function mayHold(member, plan) {
    return !require('../AI/GearAcquisitionPlanner').clanPlanKeptAgainst(member, plan)
        && !require('../../Clan/ClanMembershipPolicy').foreignGoal(member, plan);
}

// The member's plan at its party's re-plan: the selection's, unless the member may
// not hold it; then its current plan stands (nothing to write, the party's objective
// follows the plans held). A refused selection carries no replan context: its failure
// belongs to the plan not taken.
function plan(state, options) {
    const current = state.stats?.equipmentPlan;
    const selection = require('../AI/GearPlanSelection').selectAcquisitionPlan(state, current, options);
    return mayHold(state, selection.acquisitionPlan) ? selection : { acquisitionPlan: current };
}

// The party's objective after its members' re-plan: the one of the first member whose
// plan needs a party, else of the first holding one (PartyRequestPlanner.memberObjective:
// its open request, its clan's call, its plan); none when no member holds one.
// acquisitionGoal: that member's active plan.
function partyObjective(members) {
    const Request = require('./PartyRequestPlanner'), Stay = require('./PartyStay');
    const owner = members.find(member => Stay.needsParty(member.stats?.equipmentPlan) && Request.memberObjective(member))
        || members.find(member => Request.memberObjective(member));
    return { objective: owner ? Request.memberObjective(owner) : null,
        acquisitionGoal: owner?.stats?.equipmentPlan?.status === 'active' ? owner.stats.equipmentPlan : null };
}

module.exports = { acquisitionRequirementKey, acquisitionFallbackEvent, mayHold, plan, partyObjective };
