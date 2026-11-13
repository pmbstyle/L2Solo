'use strict';
// The spot aggregate's contest at an arrival: who holds the spot. Pure over what it is
// given: no clock, no World, seeded rolls. A unit (a solo bot; a party through its leader,
// until the party aggregate) that arrives on a spot meets the units standing there once,
// at the arrival. Over room is per-target pressure: the hunters on the arriving unit's
// target species, those with no target by the species' spawn share, against that share of
// the spot's room (LevelingRoutes.capacityForSpot). Over room with nobody else on its
// species (no unit there on it, near a player or far, and no hunter without a target) the
// arriving unit stays (first_come): the first come holds the spot, however thin its share
// of the room. Else the arriving unit compares
// itself with each standing unit by what a player sees (VisibleStrength: weapon grade and
// glow, armour grade, people; no level), the standing unit's relationship read for at most
// MAX_PEERS met units and MAX_DISPLACED displacement candidates (more: counted
// spot:contest:capped; an unread unit counts as a stranger, so a capped read can only make
// the arrival leave):
// 1 a stranger that looks stronger stands there: the arriving unit answers the strongest one
//   (answer): leave (avoid, outmatched), share (stay, tolerated) or dispute (stay, pvp);
// 2 else the weakest strangers it looks stronger than, each by its can-I-win roll, weakest
//   first, until the species is back to its room (at most MAX_DISPLACED units; a standing
//   party is never displaced), each answering the arrival at the pressure then: leave
//   (displaced), share, or dispute (one per arrival; the loop ends): it stays when it
//   displaced at least its own hunters, or the pressure after is within its own tolerance,
//   or one stood its ground and the pressure after is under CROWDED (it takes the
//   leftovers); else avoid, outmatched;
// 3 else (even): a clanmate or friend there and under CROWDED: it stays (friends share);
//   else it answers the first met stranger: share (stay, shared), dispute (stay, pvp) or
//   leave ('crowded' at CROWDED or more, else 'even'): the first come holds the spot (a
//   body near a player or an unread stranger there turns it away: neither answers it).
// The answer of the unit that does not hold the spot by look is its persona's
// (ResourceCompetitionPolicy.decide with it as the actor): avoid → leave; a party offer (no
// party forms at the spot), a yield or a contest without PvP → share while the pressure is
// within its tolerance (ResourceCompetitionPolicy.tolerance, ≤ 1.15× room), else leave
// (counted spot:contest:past_tolerance); a contest with PvP intent, PvP on → a dispute main
// carries out. A sharer takes the crowd's equal share; the stay judge (spot_disappoints)
// sends it away when that earns too far below its expectation.
// A unit that holds its ground never avoids, read as a stay and counted spot:contest:<why>:
// one on a player's command (commanded), a safety evacuation off unsafe ground (evacuation).
// A standing unit near a player is neither met nor displaced (its body's own tactics,
// HotResourceCompetition): skipped, counted. C4 has no bot AI here: our choice, after C4
// norms (a camp is its holder's, a visibly stronger group takes it and solos move on; a
// player sees no level). Callers: the worker's solo and party arrivals and its hot arrival
// hook (ColdSimulationWorker); their outcomes for other bots go through SpotContestOutbox.
// Counts go on the situations= line (Situations.note); the contest is traced with the spot as subject.
const { decide, friendly, tolerance } = require('../../Social/ResourceCompetitionPolicy');
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
// coexist under room; stay with displaced (the standing units' ids it displaces, solos), peer (the
// stronger unit it shares under, tolerated; the one it disputes, pvp) and, for a PvP dispute, event
// (main's competition actions take it, ColdCompetitionActions); avoid with reason ('outmatched',
// 'even', 'crowded') and the spot (spotId).
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
    // Nobody else hunts its species here: the first come holds it, over room or not.
    if (!peers.length && !(untargeted > 0)) return verdict({ action: 'stay', reason: 'first_come', displaced: [] });
    // unit answers other (a met unit, read: the pair's relationship read) at a pressure.
    const reply = (unit, other, read, atPressure, peerKey) => answer({ spot, npcId, unit, other, read, pressure: atPressure,
        key: `${key}:${peerKey}`, at, demand, capacity, personaFor, ownSide, pvp });
    // 1 A stranger that looks stronger holds the spot: it answers the strongest one.
    const stronger = sides.filter(entry => entry.verdict === 'weaker');
    if (stronger.length > MAX_PEERS) { capped = true; return verdict(avoid('outmatched')); }
    const holders = stronger.filter(entry => !relation(entry.unit)?.friendly)
        .sort((a, b) => b.side.people - a.side.people || Visible.rank(b.side.look) - Visible.rank(a.side.look)
            || String(a.unit.key).localeCompare(String(b.unit.key)));
    if (holders.length) {
        const holder = holders[0].unit, read = relation(holder);
        // An unread holder is a stranger it cannot weigh: it leaves.
        const said = read ? reply(arriving, holder, read, pressure, holder.key) : { answer: 'leave' };
        if (said.answer === 'share') return verdict({ action: 'stay', reason: 'tolerated', displaced: [], peer: holder });
        if (said.answer === 'dispute') return verdict({ action: 'stay', reason: 'pvp', displaced: [], peer: holder, event: said.event });
        return verdict(avoid('outmatched'));
    }
    // 2 The weakest strangers it looks stronger than make room, weakest first.
    const weaker = sides.filter(entry => entry.verdict === 'stronger' && !entry.unit.partyId)
        .sort((a, b) => a.side.people - b.side.people || Visible.rank(a.side.look) - Visible.rank(b.side.look)
            || String(a.unit.key).localeCompare(String(b.unit.key)));
    const displaced = [];
    let left = demand + untargeted * fraction, freed = 0, reads = 0, answered = false, stood = false, dispute = null;
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
        // The weaker one answers the arrival (it is the actor: the read reversed).
        const said = reply(entry.unit, arriving, { ab: read.ba, ba: read.ab }, left / capacity, entry.unit.key);
        answered = true;
        if (said.answer === 'leave') {
            displaced.push(entry.unit.id);
            left -= entry.unit.hunters; freed += entry.unit.hunters;
            continue;
        }
        stood = true;
        if (said.answer === 'dispute') { dispute = { peer: entry.unit, event: said.event }; break; }
        Situations.note('spot:contest:tolerated_standing');
    }
    if (answered) {
        const after = left / capacity;
        if (!(freed >= arriving.hunters || after <= tolerance(persona) || (stood && after < CROWDED))) return verdict(avoid('outmatched'));
        return verdict(dispute ? { action: 'stay', reason: 'pvp', displaced, ...dispute } : { action: 'stay', reason: 'stronger', displaced });
    }
    // 3 Even: friends share under CROWDED, else it answers the first met stranger.
    const met = [];
    for (const entry of sides) met.push([TendencyRoll.roll('spot_contest', spot.id, arriving.key, step, entry.unit.key), entry.unit]);
    met.sort((a, b) => a[0] - b[0] || String(a[1].key).localeCompare(String(b[1].key)));
    if (met.length > MAX_PEERS) capped = true;
    const crowded = pressure >= CROWDED, even = avoid(crowded ? 'crowded' : 'even');
    const readable = met.slice(0, MAX_PEERS).map(([, peer]) => [peer, relation(peer)]).filter(([, read]) => read);
    if (!crowded && readable.some(([, read]) => read.friendly)) return verdict({ action: 'stay', reason: 'friendly_share', displaced: [] });
    const first = readable.find(([, read]) => !read.friendly);
    if (!first) return verdict(even);
    const said = reply(arriving, first[0], first[1], pressure, first[0].key);
    if (said.answer === 'share') return verdict({ action: 'stay', reason: 'shared', displaced: [] });
    if (said.answer === 'dispute') return verdict({ action: 'stay', reason: 'pvp', displaced: [], peer: first[0], event: said.event });
    return verdict(even);
}
// unit's answer to other at a contest it does not hold by look (read: { ab: unit toward other,
// ba: back }): { answer: 'leave' | 'share' | 'dispute', event? }. A dispute's event is what main's
// competition actions carry out (ColdConflictDecision replays its rolls for a participant written
// since), actor the disputing unit.
function answer({ spot, npcId, unit, other, read, pressure, key, at, demand, capacity, personaFor, ownSide, pvp }) {
    const look = side => ({ ...side, size: side.size, level: side.level, own: ownSide(side.members, at),
        seen: Visible.stateSide(side.members, at), ...coldStanding(side.state, at) });
    // Main replays these in call order for a participant written since (ColdConflictDecision.refresh).
    const decisionRolls = Array.from({ length: ROLLS }, (_, i) => TendencyRoll.roll('spot_contest_decision', key, i));
    let index = 0;
    const persona = personaFor(unit.state), otherPersona = personaFor(other.state);
    const outcome = decide({ pressure, actor: look(unit), peer: look(other), towardPeer: read.ab, towardActor: read.ba,
        actorPersona: persona, peerPersona: otherPersona, rng: () => decisionRolls[index++], key,
        actorKnowledge: persona ? { source: unit.state, persona, key: `${key}:0` } : null,
        peerKnowledge: otherPersona ? { source: other.state, persona: otherPersona, key: `${key}:1` } : null });
    if (outcome.action === 'avoid') return { answer: 'leave' };
    if (outcome.action === 'contest' && outcome.pvpIntent && pvp) {
        return { answer: 'dispute', event: { at, key, spotId: spot.id, npcId: Number(npcId), contextVersion: 1, decisionRolls, demand, capacity,
            pressure, actor: participant(unit, read.ab), peer: participant(other, read.ba), relationship: [read.ab.disposition, read.ba.disposition], ...outcome } };
    }
    if (pressure <= tolerance(persona)) return { answer: 'share' };
    Situations.note('spot:contest:past_tolerance');
    return { answer: 'leave' };
}
// A unit that lost at a spot contest (displaced off its spot, or sharing it under a stronger
// unit's kill-stealing at its arrival) remembers who did it: mob_contested toward the stronger
// unit's principal (by), written by the victim's own commit. step: the victim's step counter;
// at: the step's time. C4 has no bot memory: our choice (a player remembers who took his camp).
function grievance({ victim, by, step, at }) {
    return { key: `spot:${victim}:${by}:${step}`, sourceId: Number(victim), targetId: Number(by), kind: 'character', type: 'mob_contested', at };
}
// The contest's outcome counted and traced (subject: the spot; the arriving principal as its bot).
function settled(spot, arriving, verdict) {
    Situations.note(`spot:contest:${verdict.reason}`);
    if (Trace.on()) Trace.record({ kind: 'raise', name: 'spot_contested', spot: String(spot.id), bot: arriving.id,
        outcome: verdict.action, reason: verdict.reason, displaced: verdict.displaced?.length || 0,
        ...(verdict.peer ? { target: verdict.peer.id } : {}) });
    return verdict;
}
module.exports = { contest, grievance, targetPressure, MAX_PEERS, MAX_DISPLACED, EVENT_TTL_MS, CROWDED };
