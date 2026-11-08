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

function plan(state, options) {
    return require('../AI/GearPlanSelection').selectAcquisitionPlan(state, state.stats?.equipmentPlan, options);
}

// The party's objective after its members' re-plan: the one of the first member whose
// plan needs a party, else of the first holding one (its open request, its clan's call,
// its plan); none when no member holds one. acquisitionGoal: that member's active plan.
function partyObjective(members) {
    const Request = require('./PartyRequestPlanner'), Stay = require('./PartyStay');
    const owner = members.find(member => Stay.needsParty(member.stats?.equipmentPlan) && Request.partyObjectiveForState(member))
        || members.find(member => Request.partyObjectiveForState(member));
    return { objective: owner ? Request.partyObjectiveForState(owner) : null,
        acquisitionGoal: owner?.stats?.equipmentPlan?.status === 'active' ? owner.stats.equipmentPlan : null };
}

module.exports = { acquisitionRequirementKey, acquisitionFallbackEvent, plan, partyObjective };
