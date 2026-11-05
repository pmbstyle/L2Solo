const { decide } = require('./ColdCompetitionPolicy');
const Visible = require('../../Social/VisibleStrength');
const { coldStanding } = require('../../Social/PvpAggression');
const BotErrands = require('./BotErrands');
const PartyHuntingTarget = require('./PartyHuntingTarget');
// A party competes as one unit only when no member is on one of these errands.
const PARTY_MEMBER_BUSY_FLAGS = ['pvpEncounter', 'supplyErrand', 'warehouseWorkflow', 'marketReturn'];
const INTERVAL_MS = 30000;
const PAIR_COOLDOWN_MS = 2 * 60000;
const BOT_COOLDOWN_MS = 2 * 60000;
const unitKeyOf = (partyId, id) => partyId || `solo:${id}`;
// The spot a cold bot competes at: alive, hunting, not travelling or waiting,
// and standing at its own spot (spotOf); null when it does not compete.
function hunterSpot(state, spotOf) {
    if (state?.phase !== 'cold' || !['hunting', 'grouped'].includes(state.activity)
        || !(state.vitals?.hp > 0) || state.stats?.travel || state.stats?.coldCompetition?.wait) return null;
    const spot = spotOf(state);
    return spot && state.spotId === spot.id ? spot : null;
}
const TendencyRoll = require('../AI/TendencyRoll');
const { ColdRevengeMonitor } = require('./ColdRevengeMonitor');
class ColdCompetitionMonitor {
    // ownSide(states, timestamp): how a side knows itself (U26). The worker passes the
    // exact one (ColdPvpResolver.ownSide); standalone tests see themselves as others do.
    // leaderParty(characterId): the party row a bot leads, or null (the
    // worker's parties table, ColdSimulationKernel.leaderParty).
    // spotOf(state): the spot a bot stands at (SpotService.standingSpot).
    constructor({ capacityForSpot, personaFor, isTargetAllowed = () => true, ownSide = Visible.stateSide, onCooldown = () => {},
        knowledgeFor = () => null, leaderParty = () => null, spotOf = () => null }) {
        this.ownSide = ownSide;
        this.spotOf = spotOf;
        this.leaderParty = leaderParty;
        this.knowledgeFor = knowledgeFor;
        this.onCooldown = onCooldown;
        this.capacityForSpot = capacityForSpot;
        this.personaFor = personaFor;
        this.isTargetAllowed = isTargetAllowed;
        this.lastAt = null;
        this.cursor = 0;
        this.pairs = new Map();
        this.bots = new Map();
        this.revenge = new ColdRevengeMonitor({ onCooldown, leaderParty });
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
        // One row per party (the parties table), read through its leader.
        for (const { state } of entries) {
            const party = state ? this.leaderParty(Number(state.characterId)) : null;
            if (party) parties.set(party.partyId, party);
        }
        this.evaluate(entries, memory, timestamp, { elapsed, parties, states, cursor: this.cursor });
        if (elapsed > 0) {
            const revenge = this.revenge.sample(entries, memory, timestamp, this.personaFor);
            this.report.events.push(...revenge);
            this.report.recent = [...this.report.recent, ...revenge].slice(-12);
            this.report.revenge = { ...this.revenge.report };
        }
    }

    // Explicit-array compatibility stays above. Worker supplies only affected
    // hunters and lazy full-roster/current-party readers to this SAME evaluator.
    sampleSpot(entries, memory, timestamp, options) {
        this.lastAt = timestamp;
        return this.evaluate(entries, memory, timestamp, { ...options, cursor: 0 });
    }

    evaluate(entries, memory, timestamp, { elapsed, parties, states, cursor = 0,
        maxPairs = 32, pairOffset = 0, targetForParty = null, acceptEvent = () => true }) {
        maxPairs = Math.max(0, Math.min(32, maxPairs));
        const partyTargets = new Map();
        const groups = new Map(), untargeted = new Map();
        let active = 0;
        for (const { state } of entries) {
            const spot = hunterSpot(state, this.spotOf);
            if (!spot) continue;
            active++;
            const partyId = state.party?.partyId || state.partyId || null;
            if (partyId && !partyTargets.has(partyId)) {
                const party = parties.get(partyId);
                partyTargets.set(partyId, targetForParty ? targetForParty(partyId) : party ? PartyHuntingTarget.competitionNpcId(
                    party, states.get(Number(party.leaderId)), spot, id => states.get(Number(id))) : 0);
            }
            // A solo hunter's target is the one main validates its event with.
            const target = partyId ? partyTargets.get(partyId) || 0
                : PartyHuntingTarget.competitionNpcId(null, state, spot);
            if (!target) { untargeted.set(state.spotId, (untargeted.get(state.spotId) || 0) + 1); continue; }
            if (!this.isTargetAllowed(target)) continue;
            const spawnRows = spot.npcEntries || [];
            const count = spawnRows.filter(r => Number(r.selfId) === target).reduce((n, r) => n + Math.max(1, Number(r.count) || 1), 0);
            const total = spawnRows.reduce((n, r) => n + Math.max(1, Number(r.count) || 1), 0);
            if (!count || !total) continue;
            const key = `${state.spotId}:${target}`;
            if (!groups.has(key)) groups.set(key, { key, spotId: state.spotId, npcId: target, fraction: count / total,
                capacity: Math.max(1, this.capacityForSpot(spot) * count / total), demand: 0, units: new Map() });
            const group = groups.get(key), unitKey = unitKeyOf(partyId, state.characterId);
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
                    const members = Array.isArray(ids) && ids.length >= 2 && ids.length <= 9
                        ? ids.map(id => states.get(Number(id))) : [];
                    if (party?.status !== 'active' || party.spotId !== group.spotId || !Array.isArray(ids)
                        || ids.length < 2 || ids.length > 9 || new Set(ids).size !== ids.length || !ids.includes(party.leaderId)
                        || party.stats?.travel || party.stats?.coldCompetition?.wait
                        || members.some(s => !s || s.phase !== 'cold' || !(s.vitals?.hp > 0)
                            || !['hunting', 'grouped', 'resting'].includes(s.activity) || s.spotId !== group.spotId
                            || (s.party?.partyId || s.partyId) !== unit.partyId || s.stats?.travel || s.stats?.coldCompetition?.wait
                            || BotErrands.busyWith(s, PARTY_MEMBER_BUSY_FLAGS))) {
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
        let planned = 0;
        for (let round = 0; round < 8; round++) {
            for (let i = 0; i < pressured.length; i++) {
                const group = pressured[(cursor + i) % pressured.length];
                // Actual shortages bring independent hunting units into contact
                // more often. A nearly full ground keeps its quieter cadence.
                const unitsPerPair = group.pressure >= 1.5 ? 2 : 4;
                if (round < Math.ceil(group.units.size / unitsPerPair)) {
                    if (planned >= pairOffset && sampled.length < maxPairs) sampled.push({ group, round });
                    planned++;
                }
            }
        }
        Object.assign(this.report, { scans: this.report.scans + 1, at: timestamp, activeHunters: active,
            targetGroups: groups.size, pressuredGroups: pressured.length, sampledGroups: Math.min(32, pressured.length),
            sampledPairs: sampled.length, pressureModel: 'spot_capacity_times_spawn_share', lastScanEvents: 0, overflow: false, events: [] });
        this.report.nextPairOffset = planned > pairOffset + sampled.length ? pairOffset + sampled.length : 0;
        // One roll per decision from its own parts (group, interval, round, units):
        // no stream is shared by two decisions, so no draw depends on another's.
        const interval = Math.floor(timestamp / INTERVAL_MS);
        for (const { group, round } of elapsed > 0 ? sampled : []) {
            const units = [...group.units.values()].filter(u => !this.bots.has(u.unitKey)).sort((a, b) => a.id - b.id);
            if (units.length < 2) { this.report.skipped.cooldown++; continue; }
            const aIndex = Math.floor(TendencyRoll.roll('competition_pair_a', group.key, interval, round) * units.length);
            let actor = units[aIndex];
            const offset = 1 + Math.floor(TendencyRoll.roll('competition_pair_b', group.key, interval, round) * (units.length - 1));
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
            if (TendencyRoll.roll('competition_meet', group.key, interval, round, pairKey) >= 1 - Math.exp(-ratePerMinute * elapsed / 60000)) {
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
                let roll = TendencyRoll.roll('competition_hunter', group.key, interval, round, unit.unitKey) * weights.reduce((sum, n) => sum + n, 0);
                const state = candidates.find((s, index) => (roll -= weights[index]) < 0) || candidates.at(-1);
                return { ...unit, id: Number(state.characterId), name: state.name, state };
            };
            actor = select(actor, true); peer = select(peer, false);
            const ab = memory.assess({ id: actor.id }, { id: peer.id }, {}, timestamp);
            const ba = memory.assess({ id: peer.id }, { id: actor.id }, {}, timestamp);
            // An unloaded view is not evidence of neutral relations.
            if (!ab.ready || !ba.ready) { this.report.skipped.memory++; continue; }
            const key = `competition:${interval}:${group.key}:${[actor.id, peer.id].sort((a, b) => a - b).join(':')}`;
            // Main reuses this verdict; it replays these four in call order only for a
            // participant written since this scan (ColdConflictDecision.refresh).
            const decisionRolls = Array.from({ length: 4 }, (_, i) => TendencyRoll.roll('competition_decision', key, i));
            let decisionIndex = 0;
            const look = unit => ({ ...unit, own: this.ownSide(unit.members, timestamp), seen: Visible.stateSide(unit.members, timestamp),
                ...coldStanding(unit.state, timestamp) });
            const outcome = decide({ pressure: group.pressure, actor: look(actor), peer: look(peer), towardPeer: ab, towardActor: ba,
                actorPersona: this.personaFor(actor.state), peerPersona: this.personaFor(peer.state), rng: () => decisionRolls[decisionIndex++], key,
                actorKnowledge: this.knowledgeFor(actor.state, this.personaFor(actor.state), `${key}:0`),
                peerKnowledge: this.knowledgeFor(peer.state, this.personaFor(peer.state), `${key}:1`) });
            // Cooling down a conflict must not prevent leaving the spot or cooperating.
            if (outcome.action === 'contest' && conflictCooling) { this.report.skipped.conflictCooldown++; continue; }
            const event = { at: timestamp, key,
                spotId: group.spotId, npcId: group.npcId, contextVersion: 1, decisionRolls,
                demand: group.demand, capacity: group.capacity, pressure: group.pressure,
                actor: { id: actor.id, name: actor.name, size: actor.size, activeSize: actor.hunters.length, partyId: actor.partyId,
                    partyRevision: parties.get(actor.partyId)?.revision, revision: Number(actor.state.simulation?.revision || 0), memoryRevision: ab.revision },
                peer: { id: peer.id, name: peer.name, size: peer.size, activeSize: peer.hunters.length, partyId: peer.partyId,
                    partyRevision: parties.get(peer.partyId)?.revision, revision: Number(peer.state.simulation?.revision || 0), memoryRevision: ba.revision },
                relationship: [ab.disposition, ba.disposition], ...outcome };
            if (!acceptEvent(event)) { this.report.overflow = true; break; }
            this.pairs.set(pairKey, timestamp + PAIR_COOLDOWN_MS);
            this.bots.set(actor.unitKey, timestamp + BOT_COOLDOWN_MS);
            this.bots.set(peer.unitKey, timestamp + BOT_COOLDOWN_MS);
            this.report.evaluated++; this.report.lastScanEvents++;
            this.report.outcomes[outcome.action] = (this.report.outcomes[outcome.action] || 0) + 1;
            if (outcome.pvpIntent) this.report.pvpIntents++;
            this.onCooldown('pair', pairKey, timestamp + PAIR_COOLDOWN_MS, [actor.unitKey, peer.unitKey]);
            this.onCooldown('unit', actor.unitKey, timestamp + BOT_COOLDOWN_MS, [actor.unitKey]);
            this.onCooldown('unit', peer.unitKey, timestamp + BOT_COOLDOWN_MS, [peer.unitKey]);
            this.report.events.push(event);
            this.report.recent.push(event);
            this.report.recent = this.report.recent.slice(-12);
        }
        this.cursor += Math.min(32, pressured.length);
        return this.report;
    }
    // The main thread skipped these forecasts for its action budget, so they
    // never happened: drop the cooldowns their scan set and let the pairs
    // re-decide next scan. A cooldown set by a later scan is kept.
    release(events) {
        for (const event of events) {
            const a = unitKeyOf(event.actor?.partyId, event.actor?.id), b = unitKeyOf(event.peer?.partyId, event.peer?.id);
            if (event.action === 'revenge') { this.revenge.release([a, b], Number(event.at)); continue; }
            const pairKey = [a, b].sort().join('|');
            if (this.pairs.get(pairKey) === Number(event.at) + PAIR_COOLDOWN_MS) this.pairs.delete(pairKey);
            for (const key of [a, b]) if (this.bots.get(key) === Number(event.at) + BOT_COOLDOWN_MS) this.bots.delete(key);
        }
    }
    snapshot() { return this.report; }
}
module.exports = { ColdCompetitionMonitor, INTERVAL_MS, hunterSpot };
