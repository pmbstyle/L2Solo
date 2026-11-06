'use strict';
// The spot aggregate's contest at an arrival (situations.md §8, B9, B14; step 2). Pure over what it
// is given: no clock, no World, seeded rolls. A unit (a solo bot; a party through its leader, until the
// party aggregate, step 8) that arrives on a spot meets the units standing there once, at the arrival.
// Over room is per-target pressure (B9): the hunters on the arriving unit's target species, those with
// no target by the species' spawn share, against that share of the spot's room
// (LevelingRoutes.capacityForSpot). Over room, at most MAX_PEERS standing units on the same species,
// picked and ordered by a seeded roll of (spot, arriving unit, arrival step, peer) (more: counted
// spot:contest:capped), each decided by the shared ResourceCompetitionPolicy.decide in that order: the
// first outcome other than coexist and yield wins; with none, yield when any yielded, else coexist. A
// unit that holds its ground never gets avoid, read as coexist and counted spot:contest:<why>: one on
// a player's command (B14, commanded), a safety evacuation off unsafe ground (evacuation). A standing unit near a player is not met here (its body's own tactics,
// HotResourceCompetition): skipped, counted. Callers: the worker's solo and party arrivals and its hot
// arrival hook (ColdSimulationWorker); their outcomes for other bots go through SpotContestOutbox.
// Counts go on the situations= line (Situations.note); the contest is traced with the spot as subject.
const { decide } = require('../../Social/ResourceCompetitionPolicy');
const Visible = require('../../Social/VisibleStrength');
const { coldStanding } = require('../../Social/PvpAggression');
const TendencyRoll = require('../AI/TendencyRoll');
const Situations = require('../Situations');
const Trace = require('../DecisionTrace');
// The standing units one arrival meets (limits.md "Spot contest").
const MAX_PEERS = 4;
const ROLLS = 4;
// A yield's pause (an execution pause, not a decision: limits.md "Spot contest"), here and in main's
// competition actions.
const WAIT_MS = 15000;
// How long a contest's outcome stays fresh from the arrival (its event's at), the worker's outbox and
// queue and main's competition actions alike (ColdCompetitionActions.TTL_MS).
const EVENT_TTL_MS = 10000;

// spot: its catalogue profile (npcEntries: [{ selfId, count }]); npcId: the target species; demand: the
// hunters on it (the arriving ones included); untargeted: the hunters on the spot with no target.
// { pressure, capacity, fraction } (pressure 0: the species does not spawn here).
function targetPressure(spot, npcId, demand, untargeted, capacityForSpot) {
    const rows = spot?.npcEntries || [];
    const weight = row => Math.max(1, Number(row.count) || 1);
    const count = rows.filter(row => Number(row.selfId) === Number(npcId)).reduce((n, row) => n + weight(row), 0);
    const total = rows.reduce((n, row) => n + weight(row), 0);
    if (!count || !total) return { pressure: 0, capacity: 0, fraction: 0 };
    const fraction = count / total, capacity = Math.max(1, capacityForSpot(spot) * fraction);
    return { pressure: (demand + untargeted * fraction) / capacity, capacity, fraction };
}

// A unit as decide reads it and as main's actions fence it: { key (party id or solo:<id>), id, name
// (its principal), partyId, partyRevision, size, level, hunters (its hunting members), members (states),
// state (the principal's), npcId, hot }.
function participant(unit, relation) {
    return { id: unit.id, name: unit.name, size: unit.size, activeSize: unit.hunters, partyId: unit.partyId || null,
        partyRevision: unit.partyRevision, revision: Number(unit.state?.simulation?.revision || 0), memoryRevision: relation.revision };
}

// One arrival's contest. arriving: the unit that arrives (above, plus holds: why it may not avoid, null,
// 'commanded' or 'evacuation'); standing: the units standing on the spot, the arriving one not among them; untargeted:
// the hunters there with no target; at: the arrival's time; step: its step (the arriving principal's own
// counter); memory: the interaction memory (assess); personaFor(state); ownSide(states, at): how a side knows
// itself (ColdPvpResolver.ownSide); capacityForSpot(spot).
// Returns { action: 'coexist' | 'yield' | 'avoid' | 'offer_party' | 'contest', pressure, peer?, event? }: event,
// the outcome as main's competition actions take it (ColdCompetitionActions), for one touching a standing unit.
function contest({ spot, npcId, arriving, standing = [], untargeted = 0, at, step, memory, personaFor, ownSide = Visible.stateSide,
    capacityForSpot }) {
    const peers = standing.filter(unit => Number(unit.npcId) === Number(npcId) && unit.key !== arriving.key);
    const demand = arriving.hunters + peers.reduce((n, unit) => n + unit.hunters, 0);
    const { pressure, capacity } = targetPressure(spot, npcId, demand, untargeted, capacityForSpot);
    Situations.note('spot:arrival:checked');
    if (!(pressure > 1)) return { action: 'coexist', pressure };
    Situations.note('spot:arrival:over');
    const met = [];
    for (const unit of peers) {
        if (unit.hot) { Situations.note('spot:contest:hot_peer'); continue; }
        met.push([TendencyRoll.roll('spot_contest', spot.id, arriving.key, step, unit.key), unit]);
    }
    met.sort((a, b) => a[0] - b[0] || String(a[1].key).localeCompare(String(b[1].key)));
    if (met.length > MAX_PEERS) Situations.note('spot:contest:capped');
    const look = unit => ({ ...unit, size: unit.size, level: unit.level, own: ownSide(unit.members, at),
        seen: Visible.stateSide(unit.members, at), ...coldStanding(unit.state, at) });
    let yielded = null;
    for (const [, peer] of met.slice(0, MAX_PEERS)) {
        const ab = memory.assess({ id: arriving.id }, { id: peer.id }, {}, at);
        const ba = memory.assess({ id: peer.id }, { id: arriving.id }, {}, at);
        // An unloaded view is not evidence of neutral relations.
        if (!ab.ready || !ba.ready) { Situations.note('spot:contest:memory'); continue; }
        const key = `spot_contest:${spot.id}:${arriving.key}:${step}:${peer.key}`;
        // Main replays these in call order for a participant written since (ColdConflictDecision.refresh).
        const decisionRolls = Array.from({ length: ROLLS }, (_, i) => TendencyRoll.roll('spot_contest_decision', key, i));
        let index = 0;
        const actorPersona = personaFor(arriving.state), peerPersona = personaFor(peer.state);
        let outcome = decide({ pressure, actor: look(arriving), peer: look(peer), towardPeer: ab, towardActor: ba,
            actorPersona, peerPersona, rng: () => decisionRolls[index++], key,
            actorKnowledge: actorPersona ? { source: arriving.state, persona: actorPersona, key: `${key}:0` } : null,
            peerKnowledge: peerPersona ? { source: peer.state, persona: peerPersona, key: `${key}:1` } : null });
        if (outcome.action === 'avoid' && arriving.holds) {
            Situations.note(`spot:contest:${arriving.holds}`);
            outcome = { action: 'coexist', pvpIntent: false, reason: arriving.holds };
        }
        if (outcome.action === 'coexist') continue;
        const event = { at, key, spotId: spot.id, npcId: Number(npcId), contextVersion: 1, decisionRolls, demand, capacity, pressure,
            actor: participant(arriving, ab), peer: participant(peer, ba), relationship: [ab.disposition, ba.disposition], ...outcome };
        if (outcome.action === 'yield') { yielded ||= { action: 'yield', pressure, peer, event }; continue; }
        return settled(spot, arriving, { action: outcome.action, pressure, peer, event });
    }
    return settled(spot, arriving, yielded || { action: 'coexist', pressure });
}
// The contest's outcome counted and traced (subject: the spot; the arriving principal as its bot).
function settled(spot, arriving, verdict) {
    Situations.note(`spot:contest:${verdict.action}`);
    if (Trace.on()) Trace.record({ kind: 'raise', name: 'spot_contested', spot: String(spot.id), bot: arriving.id,
        outcome: verdict.action, ...(verdict.event?.pvpIntent ? { reason: 'pvp' } : {}), ...(verdict.peer ? { target: verdict.peer.id } : {}) });
    return verdict;
}
module.exports = { contest, targetPressure, MAX_PEERS, WAIT_MS, EVENT_TTL_MS };
