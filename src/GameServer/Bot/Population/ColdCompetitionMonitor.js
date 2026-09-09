const { decide } = require('./ColdCompetitionPolicy');
const INTERVAL_MS = 30000;
const PAIR_COOLDOWN_MS = 10 * 60000;
const BOT_COOLDOWN_MS = 2 * 60000;
function seeded(seed) {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ h >>> 15, 1 | h); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
class ColdCompetitionMonitor {
    constructor({ capacityForSpot, personaFor, isTargetAllowed = () => true }) {
        this.capacityForSpot = capacityForSpot;
        this.personaFor = personaFor;
        this.isTargetAllowed = isTargetAllowed;
        this.lastAt = null;
        this.cursor = 0;
        this.pairs = new Map();
        this.bots = new Map();
        this.report = { mode: 'observe', scans: 0, evaluated: 0, outcomes: {}, pvpIntents: 0, recent: [] };
    }
    sample(entries, memory, timestamp) {
        if (this.lastAt !== null && timestamp - this.lastAt < INTERVAL_MS) return;
        // No catch-up burst after worker stalls or startup.
        const elapsed = this.lastAt === null ? 0 : Math.min(INTERVAL_MS, timestamp - this.lastAt);
        this.lastAt = timestamp;
        for (const [key, until] of this.pairs) if (until <= timestamp) this.pairs.delete(key);
        for (const [key, until] of this.bots) if (until <= timestamp) this.bots.delete(key);
        const partyTargets = new Map();
        const parties = new Map();
        for (const { context } of entries) if (context?.party) parties.set(context.party.partyId, context.party);
        for (const { context } of entries) if (context?.party) partyTargets.set(context.party.partyId,
            Number(context.party.stats?.objective?.npcId || context.party.stats?.acquisitionGoal?.next?.npcId || context.targetNpcId || 0));
        const groups = new Map(), untargeted = new Map();
        let active = 0;
        for (const { state, context = {} } of entries) {
            if (state?.phase !== 'cold' || !['hunting', 'grouped'].includes(state.activity)
                || !(state.vitals?.hp > 0) || state.stats?.travel || !context.spot
                || state.stats?.coldCompetition?.wait
                || state.spotId !== context.spot.id) continue;
            active++;
            const partyId = state.party?.partyId || state.partyId || null;
            const target = partyId ? partyTargets.get(partyId) || 0 : Number(context.targetNpcId || 0);
            if (!target) { untargeted.set(state.spotId, (untargeted.get(state.spotId) || 0) + 1); continue; }
            if (!this.isTargetAllowed(target)) continue;
            const spawnRows = context.spot.npcEntries || [];
            const count = spawnRows.filter(r => Number(r.selfId) === target).reduce((n, r) => n + Math.max(1, Number(r.count) || 1), 0);
            const total = spawnRows.reduce((n, r) => n + Math.max(1, Number(r.count) || 1), 0);
            if (!count || !total) continue;
            const key = `${state.spotId}:${target}`;
            if (!groups.has(key)) groups.set(key, { key, spotId: state.spotId, npcId: target, fraction: count / total,
                capacity: Math.max(1, this.capacityForSpot(context.spot) * count / total), demand: 0, units: new Map() });
            const group = groups.get(key), unitKey = partyId || `solo:${state.characterId}`;
            group.demand++;
            if (!group.units.has(unitKey)) group.units.set(unitKey, { id: Number(state.characterId), name: state.name,
                partyId, unitKey, size: 0, level: 0, state, members: [] });
            const unit = group.units.get(unitKey);
            unit.size++; unit.level += Number(state.level || 1);
            unit.members.push(state);
            // A stable representative per independent party; never compare teammates.
            if (Number(state.characterId) < unit.id) Object.assign(unit, { id: Number(state.characterId), name: state.name, state });
        }
        const pressured = [];
        for (const group of groups.values()) {
            group.pressure = (group.demand + (untargeted.get(group.spotId) || 0) * group.fraction) / group.capacity;
            if (group.pressure > 1 && group.units.size > 1) pressured.push(group);
            for (const unit of group.units.values()) unit.level /= unit.size;
        }
        pressured.sort((a, b) => a.key.localeCompare(b.key));
        Object.assign(this.report, { scans: this.report.scans + 1, at: timestamp, activeHunters: active,
            targetGroups: groups.size, pressuredGroups: pressured.length, sampledGroups: Math.min(32, pressured.length),
            pressureModel: 'spot_capacity_times_spawn_share', lastScanEvents: 0 });
        for (let i = 0; elapsed > 0 && i < Math.min(32, pressured.length); i++) {
            const group = pressured[(this.cursor + i) % pressured.length];
            const rng = seeded(`${group.key}:${Math.floor(timestamp / INTERVAL_MS)}`);
            const units = [...group.units.values()].sort((a, b) => a.id - b.id);
            const aIndex = Math.floor(rng() * units.length);
            let actor = units[aIndex];
            const offset = 1 + Math.floor(rng() * (units.length - 1));
            let peer = units[(aIndex + offset) % units.length];
            const pairKey = [actor.unitKey, peer.unitKey].sort().join('|');
            if (this.pairs.has(pairKey) || this.bots.has(actor.unitKey) || this.bots.has(peer.unitKey)) continue;
            const ratePerMinute = Math.min(0.8, 0.1 + (group.pressure - 1) * 0.15);
            if (rng() >= 1 - Math.exp(-ratePerMinute * elapsed / 60000)) continue;
            // The group remains one competitor, but different actual hunters
            // can start or suffer a dispute. Cooldowns follow the group identity.
            const select = (unit, initiating) => {
                if (unit.members.length === 1) return unit;
                const candidates = unit.members.slice().sort((a, b) => a.characterId - b.characterId);
                const weights = candidates.map(s => {
                    const t = this.personaFor(s)?.traits || {};
                    return initiating ? 0.1 + Number(t.assertiveness ?? 0.5) + Number(t.ambition ?? 0.5) : 1;
                });
                let roll = rng() * weights.reduce((sum, n) => sum + n, 0);
                const state = candidates.find((s, index) => (roll -= weights[index]) < 0) || candidates.at(-1);
                return { ...unit, id: Number(state.characterId), name: state.name, state };
            };
            actor = select(actor, true); peer = select(peer, false);
            const ab = memory.assess({ id: actor.id }, { id: peer.id }, {}, timestamp);
            const ba = memory.assess({ id: peer.id }, { id: actor.id }, {}, timestamp);
            // An unloaded view is not evidence of neutral relations.
            if (!ab.ready || !ba.ready) continue;
            const outcome = decide({ pressure: group.pressure, actor, peer, towardPeer: ab, towardActor: ba,
                actorPersona: this.personaFor(actor.state), peerPersona: this.personaFor(peer.state), rng });
            this.pairs.set(pairKey, timestamp + PAIR_COOLDOWN_MS);
            this.bots.set(actor.unitKey, timestamp + BOT_COOLDOWN_MS);
            this.bots.set(peer.unitKey, timestamp + BOT_COOLDOWN_MS);
            this.report.evaluated++; this.report.lastScanEvents++;
            this.report.outcomes[outcome.action] = (this.report.outcomes[outcome.action] || 0) + 1;
            if (outcome.pvpIntent) this.report.pvpIntents++;
            this.report.recent.push({ at: timestamp, key: `competition:${Math.floor(timestamp / INTERVAL_MS)}:${group.key}:${[actor.id, peer.id].sort((a, b) => a - b).join(':')}`,
                spotId: group.spotId, npcId: group.npcId,
                demand: group.demand, capacity: group.capacity, pressure: group.pressure,
                actor: { id: actor.id, name: actor.name, size: actor.size, partyId: actor.partyId,
                    partyUpdatedAt: parties.get(actor.partyId)?.updatedAt, revision: Number(actor.state.simulation?.revision || 0), memoryRevision: ab.revision },
                peer: { id: peer.id, name: peer.name, size: peer.size, partyId: peer.partyId,
                    partyUpdatedAt: parties.get(peer.partyId)?.updatedAt, revision: Number(peer.state.simulation?.revision || 0), memoryRevision: ba.revision },
                relationship: [ab.disposition, ba.disposition], ...outcome });
            this.report.recent = this.report.recent.slice(-12);
        }
        this.cursor += Math.min(32, pressured.length);
    }
    snapshot() { return this.report; }
}
module.exports = { ColdCompetitionMonitor, INTERVAL_MS, seeded };
