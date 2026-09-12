const { decide } = require('./ColdCompetitionPolicy');
const INTERVAL_MS = 30000;
const PAIR_COOLDOWN_MS = 2 * 60000;
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
        this.revenge = new (require('./ColdRevengeMonitor').ColdRevengeMonitor)();
        this.report = { mode: 'observe', scans: 0, evaluated: 0, outcomes: {}, pvpIntents: 0, recent: [],
            skipped: { cooldown: 0, conflictCooldown: 0, encounterRate: 0, memory: 0, incompleteParty: 0 } };
    }
    sample(entries, memory, timestamp) {
        if (this.lastAt !== null && timestamp - this.lastAt < INTERVAL_MS) return;
        // No catch-up burst after worker stalls or startup.
        const elapsed = this.lastAt === null ? 0 : Math.min(INTERVAL_MS, timestamp - this.lastAt);
        this.lastAt = timestamp;
        for (const [key, until] of this.pairs) if (until <= timestamp) this.pairs.delete(key);
        for (const [key, until] of this.bots) if (until <= timestamp) this.bots.delete(key);
        const parties = new Map();
        const states = new Map(entries.filter(e => e.state).map(e => [Number(e.state.characterId), e.state]));
        // Incremental snapshots may leave different party versions on teammates.
        // Entry ordering must never allow an older roster to replace a newer one.
        for (const { context } of entries) if (context?.party) {
            const party = context.party, previous = parties.get(party.partyId);
            if (!previous || Number(party.updatedAt || 0) > Number(previous.updatedAt || 0)) {
                parties.set(party.partyId, party);
            }
        }
        const partyTargets = new Map();
        const groups = new Map(), untargeted = new Map();
        let active = 0;
        for (const { state, context = {} } of entries) {
            if (state?.phase !== 'cold' || !['hunting', 'grouped'].includes(state.activity)
                || !(state.vitals?.hp > 0) || state.stats?.travel || !context.spot
                || state.stats?.coldCompetition?.wait
                || state.spotId !== context.spot.id) continue;
            active++;
            const partyId = state.party?.partyId || state.partyId || null;
            if (partyId && !partyTargets.has(partyId)) {
                const party = parties.get(partyId);
                partyTargets.set(partyId, party ? require('./PartyHuntingTarget').competitionNpcId(
                    party, states.get(Number(party.leaderId)), context.spot) : 0);
            }
            const target = partyId ? partyTargets.get(partyId) || 0 : Number(context.targetNpcId || 0)
                || require('./PartyHuntingTarget').competitionNpcId(null, state, context.spot);
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
            for (const unit of group.units.values()) {
                unit.hunters = unit.members;
                if (unit.partyId) {
                    const party = parties.get(unit.partyId), ids = party?.memberIds;
                    const members = Array.isArray(ids) ? ids.map(id => states.get(Number(id))) : [];
                    if (party?.status !== 'active' || party.spotId !== group.spotId || !Array.isArray(ids)
                        || ids.length < 2 || ids.length > 9 || new Set(ids).size !== ids.length || !ids.includes(party.leaderId)
                        || party.stats?.travel || party.stats?.coldCompetition?.wait
                        || members.some(s => !s || s.phase !== 'cold' || !(s.vitals?.hp > 0)
                            || !['hunting', 'grouped', 'resting'].includes(s.activity) || s.spotId !== group.spotId
                            || (s.party?.partyId || s.partyId) !== unit.partyId || s.stats?.travel || s.stats?.coldCompetition?.wait
                            || s.stats?.pvpEncounter || s.stats?.supplyErrand || s.stats?.warehouseWorkflow || s.stats?.marketReturn)) {
                        group.units.delete(unit.unitKey); this.report.skipped.incompleteParty++; continue;
                    }
                    unit.hunters = unit.hunters.filter(s => ids.includes(s.characterId));
                    if (!unit.hunters.length) { group.units.delete(unit.unitKey); continue; }
                    unit.members = members;
                    unit.size = members.length;
                    unit.level = members.reduce((sum, s) => sum + Number(s.level || 1), 0);
                }
                const principal = unit.hunters.reduce((a, b) => a.characterId < b.characterId ? a : b);
                Object.assign(unit, { id: Number(principal.characterId), name: principal.name, state: principal });
                unit.level /= unit.size;
            }
            if (group.pressure > 1 && group.units.size > 1) pressured.push(group);
        }
        pressured.sort((a, b) => a.key.localeCompare(b.key));
        // Busy grounds contain several independent encounters. Rotate grounds
        // fairly and sample bounded pairs, never the quadratic set of all rivals.
        const sampled = [];
        for (let round = 0; round < 8 && sampled.length < 32; round++) {
            for (let i = 0; i < pressured.length && sampled.length < 32; i++) {
                const group = pressured[(this.cursor + i) % pressured.length];
                // Actual shortages bring independent hunting units into contact
                // more often. A nearly full ground keeps its quieter cadence.
                const unitsPerPair = group.pressure >= 1.5 ? 2 : 4;
                if (round < Math.ceil(group.units.size / unitsPerPair)) sampled.push({ group, round });
            }
        }
        Object.assign(this.report, { scans: this.report.scans + 1, at: timestamp, activeHunters: active,
            targetGroups: groups.size, pressuredGroups: pressured.length, sampledGroups: Math.min(32, pressured.length),
            sampledPairs: sampled.length, pressureModel: 'spot_capacity_times_spawn_share', lastScanEvents: 0, events: [] });
        for (const { group, round } of elapsed > 0 ? sampled : []) {
            const rng = seeded(`${group.key}:${Math.floor(timestamp / INTERVAL_MS)}${round ? `:${round}` : ''}`);
            const units = [...group.units.values()].filter(u => !this.bots.has(u.unitKey)).sort((a, b) => a.id - b.id);
            if (units.length < 2) { this.report.skipped.cooldown++; continue; }
            const aIndex = Math.floor(rng() * units.length);
            let actor = units[aIndex];
            const offset = 1 + Math.floor(rng() * (units.length - 1));
            let peer = units[(aIndex + offset) % units.length];
            const pairKey = [actor.unitKey, peer.unitKey].sort().join('|');
            if (this.pairs.has(pairKey) || this.bots.has(actor.unitKey) || this.bots.has(peer.unitKey)) {
                this.report.skipped.cooldown++; continue;
            }
            // A peaceful encounter can recur soon. An actual dispute retains its
            // persisted cooldown, including every member of a competing party.
            const conflictCooling = [actor, peer].some(unit => Number(parties.get(unit.partyId)?.stats?.coldCompetition?.conflictUntil || 0) > timestamp
                || unit.members.some(s => Number(s.stats?.coldCompetition?.conflictUntil || 0) > timestamp));
            // Scale meetings, not hostility: friendship, temperament and the
            // persisted post-fight cooldown still decide whether anyone fights.
            const ratePerMinute = Math.min(4, 0.6 + (group.pressure - 1) * 1.8);
            if (rng() >= 1 - Math.exp(-ratePerMinute * elapsed / 60000)) {
                this.report.skipped.encounterRate++; continue;
            }
            // The group remains one competitor, but different actual hunters
            // can start or suffer a dispute. Cooldowns follow the group identity.
            const select = (unit, initiating) => {
                if (unit.hunters.length === 1) return unit;
                const candidates = unit.hunters.slice().sort((a, b) => a.characterId - b.characterId);
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
            if (!ab.ready || !ba.ready) { this.report.skipped.memory++; continue; }
            const decisionRolls = Array.from({ length: 4 }, () => rng());
            let decisionIndex = 0;
            const outcome = decide({ pressure: group.pressure, actor, peer, towardPeer: ab, towardActor: ba,
                actorPersona: this.personaFor(actor.state), peerPersona: this.personaFor(peer.state), rng: () => decisionRolls[decisionIndex++] });
            // Cooling down a conflict must not prevent leaving the spot or cooperating.
            if (outcome.action === 'contest' && conflictCooling) { this.report.skipped.conflictCooldown++; continue; }
            this.pairs.set(pairKey, timestamp + PAIR_COOLDOWN_MS);
            this.bots.set(actor.unitKey, timestamp + BOT_COOLDOWN_MS);
            this.bots.set(peer.unitKey, timestamp + BOT_COOLDOWN_MS);
            this.report.evaluated++; this.report.lastScanEvents++;
            this.report.outcomes[outcome.action] = (this.report.outcomes[outcome.action] || 0) + 1;
            if (outcome.pvpIntent) this.report.pvpIntents++;
            const event = { at: timestamp, key: `competition:${Math.floor(timestamp / INTERVAL_MS)}:${group.key}:${[actor.id, peer.id].sort((a, b) => a - b).join(':')}`,
                spotId: group.spotId, npcId: group.npcId, contextVersion: 1, decisionRolls,
                demand: group.demand, capacity: group.capacity, pressure: group.pressure,
                actor: { id: actor.id, name: actor.name, size: actor.size, activeSize: actor.hunters.length, partyId: actor.partyId,
                    partyUpdatedAt: parties.get(actor.partyId)?.updatedAt, revision: Number(actor.state.simulation?.revision || 0), memoryRevision: ab.revision },
                peer: { id: peer.id, name: peer.name, size: peer.size, activeSize: peer.hunters.length, partyId: peer.partyId,
                    partyUpdatedAt: parties.get(peer.partyId)?.updatedAt, revision: Number(peer.state.simulation?.revision || 0), memoryRevision: ba.revision },
                relationship: [ab.disposition, ba.disposition], ...outcome };
            this.report.events.push(event);
            this.report.recent.push(event);
            this.report.recent = this.report.recent.slice(-12);
        }
        this.cursor += Math.min(32, pressured.length);
        if (elapsed > 0) {
            const revenge = this.revenge.sample(entries, memory, timestamp, this.personaFor, seeded(`revenge:${timestamp}`));
            this.report.events.push(...revenge);
            this.report.recent = [...this.report.recent, ...revenge].slice(-12);
            this.report.revenge = { ...this.revenge.report };
        }
    }
    snapshot() { return this.report; }
}
module.exports = { ColdCompetitionMonitor, INTERVAL_MS, seeded };
