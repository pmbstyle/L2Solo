const Policy = require('../../Social/RevengePolicy');
const MAX_ACTORS = 128;
const partyId = state => state.party?.partyId || state.partyId || null;
const unitId = state => partyId(state) || `solo:${state.characterId}`;
function available(state, at) {
    return state?.phase === 'cold' && ['hunting', 'grouped'].includes(state.activity) && state.vitals?.hp > 0
        && state.spotId && !state.stats?.travel && !state.stats?.coldCompetition?.wait
        && !state.stats?.supplyErrand && !state.stats?.warehouseWorkflow && !state.stats?.marketReturn
        && !(state.stats?.karma > 0) && !(state.stats?.pvpEncounter?.expiresAt > at)
        && Math.max(Number(state.stats?.revengeUntil || 0), Number(state.stats?.coldCompetition?.conflictUntil || 0)) <= at;
}
function nearby(a, b) {
    return a?.spotId === b?.spotId && Math.hypot(a?.loc?.locX - b?.loc?.locX, a?.loc?.locY - b?.loc?.locY) <= Policy.NOTICE_RADIUS
        && Math.abs(a?.loc?.locZ - b?.loc?.locZ) <= 500;
}
class ColdRevengeMonitor {
    constructor() { this.cursor = 0; this.cooldowns = new Map(); this.report = { evaluated: 0, intents: 0 }; }
    sample(entries, memory, at, personaFor, rng) {
        for (const [id, until] of this.cooldowns) if (until <= at) this.cooldowns.delete(id);
        const byId = new Map(entries.map(e => [e.state.characterId, e]));
        const active = entries.filter(e => available(e.state, at));
        const events = [];
        const identity = s => ({ id: s.characterId, clanId: Number(s.stats?.clanId || 0), partyId: partyId(s) });
        const participant = e => ({ id: e.state.characterId, name: e.state.name, partyId: partyId(e.state),
            size: e.context?.party?.memberIds?.length || 1, partyUpdatedAt: e.context?.party?.updatedAt,
            revision: Number(e.state.simulation?.revision || 0), memoryRevision: memory.views.get(e.state.characterId)?.revision });
        const examined = Math.min(MAX_ACTORS, active.length);
        Object.assign(this.report, { at, active: active.length, sampledActors: examined });
        for (let i = 0; i < examined; i++) {
            const actor = active[(this.cursor + i) % active.length], a = actor.state;
            if (this.cooldowns.has(unitId(a))) continue;
            for (const id of memory.views.get(a.characterId)?.characterIds || []) {
                const peer = byId.get(id), b = peer?.state;
                if (!available(b, at) || unitId(a) === unitId(b) || this.cooldowns.has(unitId(b)) || !nearby(a, b)) continue;
                if (!memory.views.get(id)?.ready) continue;
                const social = Policy.evaluate(memory.assess(identity(a), identity(b), {}, at), personaFor(a));
                if (!(social.chance > 0)) continue;
                // One roll per group per cooldown, independent of observer/heartbeat frequency.
                this.cooldowns.set(unitId(a), at + Policy.RETRY_MS);
                this.report.evaluated++;
                const roll = rng();
                if (roll < social.chance) {
                    this.cooldowns.set(unitId(b), at + Policy.RETRY_MS);
                    this.report.intents++;
                    events.push({ key: `revenge:${at}:${a.characterId}:${b.characterId}`, at, action: 'revenge', reason: social.reason,
                        spotId: a.spotId, npcId: 0, pvpIntent: true, revengeRoll: roll, chance: social.chance,
                        actor: participant(actor), peer: participant(peer) });
                }
                break;
            }
        }
        this.cursor += examined;
        return events;
    }
}
module.exports = { ColdRevengeMonitor, available, nearby, MAX_ACTORS };
