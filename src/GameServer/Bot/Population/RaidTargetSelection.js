'use strict';

const Policy = require('./OpportunisticRaidPolicy');
const Combat = require('./ColdCombatProfile');
const Items = require('../../Item/ItemTemplateIndex');
const Priority = require('./RaidRosterPriority');
const { LIMITS } = require('./RaidSearchCounters');

// Runs in the existing paced worker request. Prepare the nine once, then
// compare their actual charged attacks with each boss and its native guards.
function assess(members, candidates, options = {}) {
    const targets = candidates.slice(0, LIMITS.targetCandidates);
    const timestamp = options.timestamp ?? Date.now(), maxSeconds = options.maxFightSeconds ?? 720;
    const meta = { bossId: 0, considered: 0, rejected: {}, unknown: 0, fullForecast: false };
    const full = (spot, preparation = null) => {
        meta.bossId = spot.raidBossTemplateId;
        meta.fullForecast = true;
        return { ...Policy.assessment(members, spot, { ...options, preparation }), targetSelection: meta };
    };
    if (!targets.length) return { ready: false, reason: 'raid_no_fast_target',
        reasons: ['raid_no_fast_target'], unchecked: ['combat'], targetSelection: meta };
    if (!Policy.composition(members).ready || Policy.equipmentFailures(members).length) return full(targets[0]);
    const preparation = Policy.prepared(members, timestamp);
    if (!preparation.ready) return full(targets[0], preparation);
    const damage = preparation.states.filter(s => Policy.role(s) !== 'healer')
        .map(state => ({ state, profile: Combat.fightProfile(state, preparation.at) }));
    const fits = [], unknown = [], npcs = invoke('GameServer/DataCache').npcs;
    const reject = reason => { meta.rejected[reason] = (meta.rejected[reason] || 0) + 1; };
    for (const spot of targets) {
        meta.considered++;
        if (!members.every(s => Policy.levelAllowed(s, spot.avgLevel))) { reject('raid_level'); continue; }
        const npc = Items.find(npcs, spot.raidBossTemplateId);
        const estimate = npc && Policy.damageEstimate(damage, npc);
        // Unknown or incomplete data keeps access to full admission. It must
        // never masquerade as proof that this target is impossible.
        if (!estimate?.complete || !Number.isFinite(estimate.grossDps) || !Number.isFinite(estimate.regen)) {
            unknown.push(spot); meta.unknown++; continue;
        }
        if (estimate.grossDps <= estimate.regen * 1.5) { reject('raid_damage_below_regeneration'); continue; }
        if (!Number.isFinite(estimate.seconds) || estimate.seconds > maxSeconds) {
            reject('raid_fight_too_long'); continue;
        }
        fits.push({ spot, seconds: estimate.seconds, netDps: estimate.grossDps - estimate.regen });
    }
    fits.sort((a,b) => a.seconds - b.seconds || Priority.targetScore(a.spot) - Priority.targetScore(b.spot)
        || a.spot.raidBossTemplateId - b.spot.raidBossTemplateId);
    const best = fits[0];
    if (best) {
        meta.seconds = best.seconds;
        meta.netDps = best.netDps;
        return full(best.spot, preparation);
    }
    if (unknown.length) return full(unknown[0], preparation);
    return { ready: false, reason: 'raid_no_fast_target', reasons: ['raid_no_fast_target'],
        unchecked: ['defense', 'healing', 'supplies'], targetSelection: meta };
}

module.exports = { assess };
