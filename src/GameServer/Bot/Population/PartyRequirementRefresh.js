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

module.exports = { acquisitionRequirementKey, acquisitionFallbackEvent, plan };
