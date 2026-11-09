const Material = require('./CraftMaterialParty');
function activePlanTarget(plan) {
    return plan?.status === 'active' ? Number(plan.next?.npcId || plan.targetNpcId || 0) : 0;
}

// A member's state on the main thread: BotLifeState's cache. The cold worker
// passes its own records as stateOf.
function cachedState(id) {
    // lazy: worker BotLifeState is the main thread's cache; worker callers pass stateOf.
    return invoke('GameServer/Bot/Population/BotLifeState').cachedState(id);
}
// The shared objective wins; an ordinary hunting party follows its leader's
// active plan. A randomly selected encounter representative cannot retarget it.
function npcId(party, leader, stateOf = cachedState) {
    if (Material.isObjective(party?.stats?.objective)) {
        const members = (party.memberIds || []).slice(0, Material.MAX_MEMBERS)
            .map(id => Number(id) === Number(leader?.characterId) ? leader : stateOf(id)).filter(Boolean);
        return Material.target(party, members);
    }
    // A help party agreed to level on its shared spot. The leader's old
    // equipment target may not even spawn there.
    if (party?.stats?.objective?.reason === 'clan_help') {
        return Number(party.stats.objective.npcId || 0);
    }
    return Number(party?.stats?.objective?.npcId || 0)
        || activePlanTarget(party?.stats?.acquisitionGoal)
        || activePlanTarget(leader?.stats?.equipmentPlan);
}
// The species a hunting unit competes for on its spot (SpotContest's per-target pressure):
// its planned target when that spawns on the spot, else a cheap representative of
// ordinary hunting: drawn among the spawns in a body's target level window
// (BotTargetScorer), else among every spawn (a far round fights whatever spawns there, so
// a unit that outlevelled the window still hunts it), weighted by the spawn population. Stable per hunting unit so teammates never invent separate goals.
// 0 only for a spot that spawns nothing (or none known): every unit on a spot is counted,
// met and displaceable. This is competition context only; it does not replace the PvE
// gear target. Our choice: C4 has no such rule, players crowd the mobs they farm.
// Lazy: loaded on first use (load order), then kept; a require per call was ~1% of the cold worker (perf-map 2026-10-14).
let scorer = null;
function competitionNpcId(party, leader, spot, stateOf = cachedState) {
    const planned = npcId(party, leader, stateOf);
    if (!leader) return planned;
    if (!spot) spot = invoke('GameServer/Bot/Population/SpotProfiles').findById(party?.spotId || leader.spotId);
    const spawns = (spot?.npcEntries || []).filter(e => Number(e.selfId) > 0);
    if (!spawns.length) return planned;
    if (planned && spawns.some(e => Number(e.selfId) === planned)) return planned;
    const level = Number(leader.level || 1);
    const { MIN_LEVEL_GAP, MAX_LEVEL_ADVANTAGE } = scorer ||= require('../AI/BotTargetScorer');
    const levelOf = e => Number(e.level ?? spot.avgLevel ?? level);
    const fitting = spawns.filter(e => levelOf(e) >= level + MIN_LEVEL_GAP && levelOf(e) <= level + MAX_LEVEL_ADVANTAGE);
    const entries = (fitting.length ? fitting : spawns).sort((a, b) => Number(a.selfId) - Number(b.selfId));
    let hash = 2166136261;
    for (const c of `${party?.partyId || leader.characterId}:${spot.id}`) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    const weight = e => Math.max(1, Number(e.count) || 1);
    let roll = (hash >>> 0) / 4294967296 * entries.reduce((sum, e) => sum + weight(e), 0);
    return Number((entries.find(e => (roll -= weight(e)) < 0) || entries.at(-1)).selfId);
}
module.exports = { npcId, competitionNpcId };
