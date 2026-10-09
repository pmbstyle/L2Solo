// Applicability of defence from this bot's own recent opponents on its hunt.
// Unknown threats and PvP preserve the conservative physical/magic estimate.
const SpotIndex = require('../AI/SpotIndex');
const NpcSkills = require('../../Npc/NpcSkills');

function prepare(state, deps = {}, previous = null) {
    const stats = state.stats || {};
    const observations = (stats.targetCombat?.lastDefeatedNpcIds || []).slice(-8).map(Number);
    const observed = observations.join(',');
    const spot = SpotIndex.spotById(deps.spots, stats.marketReturn?.spotId ?? state.spotId);
    const revision = deps.memory?.revision ?? stats.memoryRevision ?? 0;
    const relations = deps.memory?.relations || stats.relations || [];
    const hostile = relations.some(row => Number(row.hostility ?? row.anger ?? 0) > 0);
    const pvp = Boolean(stats.pvpEncounter || state.pvpEncounter);
    const scores = String(stats.wishFocus?.[0] || '').startsWith('scores:');
    if (previous && previous.observed === observed && previous.spot === spot
        && previous.revision === revision && previous.hostile === hostile
        && previous.pvp === pvp && previous.scores === scores) return previous;
    let mask = 3;
    if (spot && observations.length && !pvp && !scores
        && !hostile) {
        let matched = false, uncertain = false;
        for (const entry of spot.npcEntries || []) {
            if (!observations.includes(Number(entry.selfId))) continue;
            matched = true;
            if (NpcSkills.threatFor(entry.selfId) !== 1) { uncertain = true; break; }
        }
        if (matched && !uncertain) mask = 1;
    }
    return { observed, spot, revision, hostile, pvp, scores, mask };
}
function maskFor(state, deps) { return prepare(state, deps).mask; }
module.exports = { prepare, maskFor };
