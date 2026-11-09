'use strict';
// The spot aggregate's contest at an arrival: who holds the spot. Pure over what it is
// given: no clock, no World, seeded rolls. A unit (a solo bot; a party through its leader,
// until the party aggregate) that arrives on a spot meets the units standing there once,
// at the arrival. Over room is per-target pressure: the hunters on the arriving unit's
// target species, those with no target by the species' spawn share, against that share of
// the spot's room (LevelingRoutes.capacityForSpot). Over room the arriving unit compares
// itself with each standing unit by what a player sees (VisibleStrength: weapon grade and
// glow, armour grade, people; no level), the standing unit's relationship read for at most
// MAX_PEERS met units and MAX_DISPLACED displacement candidates (more: counted
// spot:contest:capped; an unread unit counts as a stranger, so a capped read can only make
// the arrival leave):
// 1 a stranger that looks stronger stands there: avoid, outmatched;
// 2 else the weakest strangers it looks stronger than, each by its can-I-win roll, weakest
//   first, until the species is back to its room (at most MAX_DISPLACED units; a standing
//   party is never displaced): it stays when it displaced at least its own hunters or the
//   species is in room after; else avoid, outmatched;
// 3 else (even): a clanmate or friend there and under CROWDED: it stays (friends share); a
//   PvP dispute with a met stranger (ResourceCompetitionPolicy.decide's contest with PvP
//   intent, PvP on): it stays and the dispute goes to main; else avoid ('crowded' at
//   CROWDED or more, else 'even'): the first come holds the spot.
// A unit that holds its ground never avoids, read as a stay and counted spot:contest:<why>:
// one on a player's command (commanded), a safety evacuation off unsafe ground (evacuation).
// A standing unit near a player is neither met nor displaced (its body's own tactics,
// HotResourceCompetition): skipped, counted. C4 has no bot AI here: our choice, after C4
// norms (a camp is its holder's, a visibly stronger group takes it and solos move on; a
// player sees no level). Callers: the worker's solo and party arrivals and its hot arrival
// hook (ColdSimulationWorker); their outcomes for other bots go through SpotContestOutbox.
// Counts go on the situations= line (Situations.note); the contest is traced with the spot as subject.
const { decide, friendly } = require('../../Social/ResourceCompetitionPolicy');
const Visible = require('../../Social/VisibleStrength');
const { coldStanding } = require('../../Social/PvpAggression');
const TendencyRoll = require('../AI/TendencyRoll');
const Situations = require('../Situations');
const Trace = require('../DecisionTrace');
// The standing units one arrival meets (rules 1 and 3).
const MAX_PEERS = 4;
// The standing units one arrival displaces: a full C4 party (9) less itself.
const MAX_DISPLACED = 8;
const ROLLS = 4;
// How long a contest's outcome stays fresh from the arrival (its event's at), the worker's outbox and
// queue and main's competition actions alike (ColdCompetitionActions.TTL_MS).
const EVENT_TTL_MS = 10000;
// Twice the room for the arriving unit's species: friends share a spot below it. Our choice.
const CROWDED = 2;

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
// itself (ColdPvpResolver.ownSide); capacityForSpot(spot); pvp: PvP disputes carried out (main's competition
// actions with conflicts and PvP on).
// Returns { action: 'coexist' | 'stay' | 'avoid', pressure, reason?, displaced?, spotId?, peer?, event? }:
// coexist under room; stay with displaced (the standing units' ids it displaces, solos) and, for a PvP
// dispute, event (main's competition actions take it, ColdCompetitionActions) and peer; avoid with reason
// ('outmatched', 'even', 'crowded') and the spot (spotId).
function contest({ spot, npcId, arriving, standing = [], untargeted = 0, at, step, memory, personaFor, ownSide = Visible.stateSide,
    capacityForSpot, pvp = false }) {
    const peers = standing.filter(unit => Number(unit.npcId) === Number(npcId) && unit.key !== arriving.key);
    const demand = arriving.hunters + peers.reduce((n, unit) => n + unit.hunters, 0);
    const { pressure, capacity, fraction } = targetPressure(spot, npcId, demand, untargeted, capacityForSpot);
    Situations.note('spot:arrival:checked');
    if (!(pressure > 1)) return { action: 'coexist', pressure };
    Situations.note('spot:arrival:over');
    const key = `spot_contest:${spot.id}:${arriving.key}:${step}`;
    const persona = personaFor(arriving.state), own = ownSide(arriving.members, at);
    const sides = [];
    for (const unit of peers) {
        if (unit.hot) { Situations.note('spot:contest:hot_peer'); continue; }
        const side = Visible.stateSide(unit.members, at);
        sides.push({ unit, side, verdict: Visible.verdictOf(own, side) });
    }
    let capped = false;
    const relations = new Map();
    // The pair's relationship both ways, read once; null: not loaded (an unloaded view is
    // not evidence of neutral relations: a stranger).
    const relation = peer => {
        if (relations.has(peer.key)) return relations.get(peer.key);
        const ab = memory.assess({ id: arriving.id }, { id: peer.id }, {}, at), ba = memory.assess({ id: peer.id }, { id: arriving.id }, {}, at);
        const read = ab.ready && ba.ready ? { ab, ba, friendly: friendly(ab, ba) } : null;
        if (!read) Situations.note('spot:contest:memory');
        relations.set(peer.key, read);
        return read;
    };
    const verdict = outcome => {
        if (capped) Situations.note('spot:contest:capped');
        if (outcome.action !== 'avoid' || !arriving.holds) return settled(spot, arriving, { pressure, ...outcome });
        return settled(spot, arriving, { action: 'stay', pressure, reason: arriving.holds, displaced: outcome.displaced || [] });
    };
    const avoid = reason => ({ action: 'avoid', reason, spotId: String(spot.id) });
    // 1 A stranger that looks stronger holds the spot against it.
    const stronger = sides.filter(entry => entry.verdict === 'weaker');
    if (stronger.length > MAX_PEERS) capped = true;
    if (stronger.length > MAX_PEERS || stronger.some(entry => !relation(entry.unit)?.friendly)) return verdict(avoid('outmatched'));
    // 2 The weakest strangers it looks stronger than make room, weakest first.
    const weaker = sides.filter(entry => entry.verdict === 'stronger' && !entry.unit.partyId)
        .sort((a, b) => a.side.people - b.side.people || Visible.rank(a.side.look) - Visible.rank(b.side.look)
            || String(a.unit.key).localeCompare(String(b.unit.key)));
    const displaced = [];
    let left = demand + untargeted * fraction, freed = 0, reads = 0;
    const traits = persona?.traits || {};
    for (const entry of weaker) {
        if (!(left > capacity) || displaced.length >= MAX_DISPLACED) break;
        if (reads >= MAX_DISPLACED) { capped = true; break; }
        reads++;
        const read = relation(entry.unit);
        if (!read || read.friendly) continue;
        const knowledge = persona ? { source: arriving.state, persona, key: `${key}:${entry.unit.key}` } : null;
        const chance = Visible.canWin({ own, other: entry.side, traits, fear: Visible.fear(read.ab), knowledge });
        if (!Visible.willing(chance, key, 'displace', entry.unit.key)) continue;
        displaced.push(entry.unit.id);
        left -= entry.unit.hunters; freed += entry.unit.hunters;
    }
    if (displaced.length) {
        return verdict(freed >= arriving.hunters || !(left > capacity) ? { action: 'stay', reason: 'stronger', displaced } : avoid('outmatched'));
    }
    // 3 Even: friends share under CROWDED, a stranger may dispute it by PvP, else the first come holds it.
    const met = [];
    for (const entry of sides) met.push([TendencyRoll.roll('spot_contest', spot.id, arriving.key, step, entry.unit.key), entry.unit]);
    met.sort((a, b) => a[0] - b[0] || String(a[1].key).localeCompare(String(b[1].key)));
    if (met.length > MAX_PEERS) capped = true;
    const crowded = pressure >= CROWDED;
    for (const [, peer] of met.slice(0, MAX_PEERS)) {
        const read = relation(peer);
        if (!read) continue;
        if (read.friendly) {
            if (!crowded) return verdict({ action: 'stay', reason: 'friendly_share', displaced: [] });
            continue;
        }
        if (!pvp) continue;
        const dispute = pvpDispute({ spot, npcId, arriving, peer, read, key: `${key}:${peer.key}`, at, demand, capacity, pressure, persona, personaFor, ownSide });
        if (dispute) return verdict({ action: 'stay', reason: 'pvp', displaced: [], peer, event: dispute });
    }
    return verdict(avoid(crowded ? 'crowded' : 'even'));
}
// A met stranger's dispute by PvP (ResourceCompetitionPolicy.decide's contest with PvP intent): the event
// main's competition actions carry out (ColdConflictDecision replays its rolls), or null.
function pvpDispute({ spot, npcId, arriving, peer, read, key, at, demand, capacity, pressure, persona, personaFor, ownSide }) {
    const look = unit => ({ ...unit, size: unit.size, level: unit.level, own: ownSide(unit.members, at),
        seen: Visible.stateSide(unit.members, at), ...coldStanding(unit.state, at) });
    // Main replays these in call order for a participant written since (ColdConflictDecision.refresh).
    const decisionRolls = Array.from({ length: ROLLS }, (_, i) => TendencyRoll.roll('spot_contest_decision', key, i));
    let index = 0;
    const peerPersona = personaFor(peer.state);
    const outcome = decide({ pressure, actor: look(arriving), peer: look(peer), towardPeer: read.ab, towardActor: read.ba,
        actorPersona: persona, peerPersona, rng: () => decisionRolls[index++], key,
        actorKnowledge: persona ? { source: arriving.state, persona, key: `${key}:0` } : null,
        peerKnowledge: peerPersona ? { source: peer.state, persona: peerPersona, key: `${key}:1` } : null });
    if (outcome.action !== 'contest' || !outcome.pvpIntent) return null;
    return { at, key, spotId: spot.id, npcId: Number(npcId), contextVersion: 1, decisionRolls, demand, capacity, pressure,
        actor: participant(arriving, read.ab), peer: participant(peer, read.ba), relationship: [read.ab.disposition, read.ba.disposition], ...outcome };
}
// The contest's outcome counted and traced (subject: the spot; the arriving principal as its bot).
function settled(spot, arriving, verdict) {
    Situations.note(`spot:contest:${verdict.reason}`);
    if (Trace.on()) Trace.record({ kind: 'raise', name: 'spot_contested', spot: String(spot.id), bot: arriving.id,
        outcome: verdict.action, reason: verdict.reason, displaced: verdict.displaced?.length || 0,
        ...(verdict.peer ? { target: verdict.peer.id } : {}) });
    return verdict;
}
module.exports = { contest, targetPressure, MAX_PEERS, MAX_DISPLACED, EVENT_TTL_MS, CROWDED };
