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
// A cheap representative of ordinary hunting, weighted by the actual spawn
// population. Stable per hunting unit so teammates never invent separate goals.
// This is competition context only; it does not replace the PvE gear target.
function competitionNpcId(party, leader, spot) {
    const planned = npcId(party, leader);
    if (planned) return planned;
    if (!leader) return 0;
    if (!spot) spot = invoke('GameServer/Bot/Population/SpotProfiles').findById(party?.spotId || leader.spotId);
    if (!spot) return 0;
    const level = Number(leader.level || 1);
    const { MIN_LEVEL_GAP, MAX_LEVEL_ADVANTAGE } = require('../AI/BotTargetScorer');
    const entries = (spot.npcEntries || []).filter(e => Number(e.selfId) > 0
        && Number(e.level ?? spot.avgLevel ?? level) >= level + MIN_LEVEL_GAP
        && Number(e.level ?? spot.avgLevel ?? level) <= level + MAX_LEVEL_ADVANTAGE)
        .slice().sort((a, b) => Number(a.selfId) - Number(b.selfId));
    if (!entries.length) return 0;
    let hash = 2166136261;
    for (const c of `${party?.partyId || leader.characterId}:${spot.id}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    const weight = e => Math.max(1, Number(e.count) || 1);
    let roll = (hash >>> 0) / 4294967296 * entries.reduce((sum, e) => sum + weight(e), 0);
    return Number((entries.find(e => (roll -= weight(e)) < 0) || entries.at(-1)).selfId);
}
module.exports = { npcId, competitionNpcId };
