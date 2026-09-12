// One aggregate recovery outcome. The worker commits the entire roster
// atomically even when gratitude is on cooldown or memory is not loaded.
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const ColdHelp = require('../../Social/ColdCombatHelpMemory');
const RECOVERY_MS = 15000;
const distance = (a, b) => Math.hypot(a.loc?.locX - b.loc?.locX, a.loc?.locY - b.loc?.locY, a.loc?.locZ - b.loc?.locZ);
function resolve({ party, members, timestamp: at, episodeId, assessRelationship }) {
    // The legacy sequential resolver cannot commit a paid rescue atomically.
    if (!episodeId) return null;
    const dead = members.find(s => s.vitals.hp <= 0);
    if (!dead) return null;
    const safe = members.every(s => s.phase === 'cold' && !s.stats?.pvpEncounter && !s.stats?.travel
        && !(s.stats?.coldPvp?.flagUntil > at));
    const result = (reason, patches, nextAt, helps = []) => {
        const events = ColdHelp.eventsFor(helps, episodeId, at, assessRelationship,
            id => members.find(s => s.characterId === id));
        return { atomic: true, memberResults: members.map((state, index) => ({ state, result: {
            patch: patches.get(state.characterId) || {}, events: helps.filter(h => h.sourceId === state.characterId).map(h => ({
                type: 'resurrection', summary: `${state.name || 'Bot'} was resurrected by ${members.find(s => s.characterId === h.targetId)?.name || h.targetId}`,
                weight: 4, meta: { helperId: h.targetId, partyId: party.partyId } })),
            memoryEvents: events.filter(e => e.sourceId === state.characterId),
            materialize: { exp: 0, sp: 0, adena: 0, items: [] }, nextResolveAt: nextAt,
            debug: { reason, populationTelemetryOwner: index === 0, fights: 0, wins: 0,
                ...(index === 0 ? { resurrections: helps.length } : {}) }
        } })), events: [], nextResolveAt: nextAt,
        partyPatch: { stats: { ...party.stats, restUntil: nextAt, lastResolveAt: at } },
        debug: { reason, fights: 0, wins: 0, resurrections: helps.length } };
    };
    if (!safe) return null;
    for (const caster of members.filter(s => s.vitals.hp > 0)) {
        const profile = Profile.profileFor(caster, at);
        const skill = profile.skills.find(s => {
            const r = Rules.resolve(s);
            return !s.passive && r.skillType === Rules.RESURRECT && r.target === 'corpse_player'
                && !s.itemId && !r.itemConsumeId && !s.hp && !r.notUsedInC4
                && Number(s.mp || 0) <= caster.vitals.mp
                && !(caster.stats?.coldCombat?.cooldowns?.[s.selfId] > at)
                && distance(caster, dead) <= Number(r.castRange || 400);
        });
        if (!skill) continue;
        const until = at + RECOVERY_MS;
        const patches = new Map(members.filter(s => s.vitals.hp > 0).map(s => [s.characterId, {
            activity: 'resting', stats: { ...s.stats, restUntil: until }
        }]));
        patches.set(caster.characterId, { activity: 'resting',
            vitals: { ...caster.vitals, mp: caster.vitals.mp - Number(skill.mp || 0) },
            stats: { ...caster.stats, restUntil: until, coldCombat: { ...caster.stats?.coldCombat,
                cooldowns: { ...caster.stats?.coldCombat?.cooldowns, [skill.selfId]: at + Number(skill.reuse || 0) } } }
        });
        patches.set(dead.characterId, { activity: 'resting', vitals: { ...dead.vitals, hp: 1 },
            stats: { ...dead.stats, restUntil: until, lastResurrectAt: at,
                coldPvp: { ...dead.stats?.coldPvp, recoverUntil: 0, flagUntil: 0 },
                coldCombat: { ...dead.stats?.coldCombat, effects: [], cp: 0, cpAt: at, charges: 0, chargeExpiresAt: null, summon: null } } });
        return result('party_resurrected', patches, until,
            [{ sourceId: dead.characterId, targetId: caster.characterId, type: 'resurrected' }]);
    }
    return null;
}
module.exports = { resolve, RECOVERY_MS };
