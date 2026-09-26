const Config = require('../../Clan/ClanSimulationConfig');
const Risk = require('./SpotRiskPolicy');
let templates, levels = new Map();

function sourceLevel(objective) {
    const Data = invoke('GameServer/DataCache');
    if (templates !== Data.npcs) {
        templates = Data.npcs;
        levels = new Map((templates || []).map(npc => [Number(npc.selfId), Number(npc.template?.level || 0)]));
    }
    const npcId = Number(objective?.raidBossTemplateId || objective?.npcId || 0);
    return levels.get(npcId) || Number(objective?.sourceLevel || 0);
}
function raidLevelAllowed(member, objective) {
    if (!(objective?.sourceKind === 'raid' || objective?.raidBoss === true)) return true;
    const level = sourceLevel(objective);
    return !level || Number(member?.level || 0) <= level + 8;
}
function applies(objective) {
    return objective?.clanOperation === 'equipment' && Number(objective.clanId) > 0;
}
function abandonedRaid(party) {
    const objective = party?.stats?.objective;
    if (!(objective?.sourceKind === 'raid' || objective?.raidBoss === true)) return false;
    if (String(party?.spotId || '') === String(objective?.spotId || '')) return false;
    const backoff = (party?.stats?.partySpotRisk?.spotBackoffs || []).find((entry) => (
        String(entry?.spotId || '') === String(objective?.spotId || '')
    ));
    if (!backoff) return false;
    const encounter = party?.stats?.raidEncounter;
    const hp = Math.max(0, Number(encounter?.hp || 0));
    const maxHp = Math.max(1, Number(encounter?.maxHp || encounter?.encounter?.mob?.maxHp || hp || 1));
    return hp / maxHp > 0.30
        || Number(backoff.deaths || 0) >= 2
        || Number(backoff.attempts || 0) >= 2;
}
function allowed(member, objective, timestamp = Date.now()) {
    // This is a game-mechanics limit, not merely an equipment-plan preference.
    // Keep it authoritative for every autonomous raid so a stale or synthetic
    // roster cannot enter hot combat and receive Raid Curse.
    if (!raidLevelAllowed(member, objective)) return false;
    if (!applies(objective)) return true;
    const level = sourceLevel(objective);
    if (level && Number(member.level) > 0
        && Number(member.level) < level - Config.operationMaxTargetLevelGap) return false;
    return !(member.stats?.clanHuntBackoffs || []).some(entry =>
        String(entry.spotId) === String(objective.spotId) && Number(entry.until) > timestamp);
}
function needsReview(party, members, timestamp) {
    const objective = party?.stats?.objective;
    if (party?.stats?.raidEncounter?.status === 'failed') return true;
    if (abandonedRaid(party)) return true;
    // Ordinary route changes and hunt backoffs must not dismantle a raid in
    // progress, but an overlevel member is different: C4 will hard-disable
    // that character as soon as it attacks or supports the raid.
    if (members.some(member => !raidLevelAllowed(member, objective))) return true;
    const raidStarted = (objective?.sourceKind === 'raid' || objective?.raidBoss === true)
        && (['preparing', 'ready'].includes(party?.stats?.raidPreparation?.status)
            || party?.stats?.raidEncounter?.status === 'active');
    if (raidStarted) return false;
    return members.some(member => !allowed(member, party.stats?.objective, timestamp));
}
function recordOutcome(state, result, objective, timestamp) {
    if (!applies(objective) || !Number(result.debug?.fights)) return result;
    // Ordinary hunt backoff is a route-selection tool. During a raid, deaths,
    // resurrection and recovery are part of one persistent boss operation;
    // applying the solo/spot threshold here dismantles the frontline before
    // the shared encounter can finish.
    if (objective?.sourceKind === 'raid' || objective?.raidBoss === true) return result;
    const deaths = Math.max(0, Number(result.patch?.deathCount ?? state.stats?.deaths ?? 0)
        - Number(state.stats?.deaths ?? state.deathCount ?? 0));
    const spotId = result.debug.spotId || objective.spotId;
    const priorBackoff = (state.stats?.clanHuntBackoffs || []).find(entry => String(entry.spotId) === String(spotId));
    const previous = priorBackoff && priorBackoff.until <= timestamp
        && Number(state.stats?.clanHuntRisk?.enteredAt || 0) <= priorBackoff.startedAt
        ? {} : state.stats?.clanHuntRisk || {};
    const risk = Risk.recordResolve(previous, {
        spotId, timestamp, fights: result.debug.fights, wins: result.debug.wins, deaths
    });
    const projected = { spotId, stats: { spotRisk: risk, spotBackoffs: state.stats?.clanHuntBackoffs || [] } };
    const backoff = Risk.backoffForStates([projected], spotId, timestamp);
    const remembered = backoff ? Risk.withBackoff(projected, backoff, timestamp) : projected;
    return { ...result, patch: { ...result.patch, stats: { ...result.patch?.stats,
        clanHuntRisk: risk, clanHuntBackoffs: remembered.stats.spotBackoffs } } };
}
module.exports = { sourceLevel, raidLevelAllowed, applies, abandonedRaid, allowed, needsReview, recordOutcome };
