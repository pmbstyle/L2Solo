function activePlanTarget(plan) {
    return plan?.status === 'active' ? Number(plan.next?.npcId || plan.targetNpcId || 0) : 0;
}

// The shared objective wins; an ordinary hunting party follows its leader's
// active plan. A randomly selected encounter representative cannot retarget it.
function npcId(party, leader) {
    return Number(party?.stats?.objective?.npcId || 0)
        || activePlanTarget(party?.stats?.acquisitionGoal)
        || activePlanTarget(leader?.stats?.equipmentPlan);
}
module.exports = { npcId };
