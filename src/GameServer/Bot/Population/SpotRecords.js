'use strict';
// A spot's reputation: "that camp is held, and by whom", the spot aggregate's own record of
// its arrivals, known to a bot by hearsay: a hold is heard at the bot's town arrival (C4's
// shout and trade chat, heard in town; our choice), so a bot knows a held record only when
// the spot became held before its last town arrival; a clearing is known at once. Its own
// sight is its outing's contest_lost mark (SpotRiskPolicy), not this record.
// Written only at an arrival over a spot's room or well under it (the worker's arrivalContest,
// far and near arrivals alike): an over-room arrival counts one more contested arrival and
// takes the holder (the best look standing there, the largest unit) from the units it met; an
// arrival finding the spot at CLEAR of its room or less clears the record. No clock: a spot
// is held after HELD contested arrivals, until an arrival finds it clear. Read when a solo bot
// chooses a spot (SpotSearch.rank's filter, through reader: the earning search, the plan's
// source at route time, the leveling goal): a held spot repels a bot that looks weaker than
// its holder, has fewer people, or looks even and is more cautious than assertive; never the
// spot it stands on. The store lives on the worker (the only writer: arrivals, and town
// arrivals through heard, far and near); main writes none, so its searches read none.
// Records and hearings start empty at a worker start (rebuilt in HELD arrivals and the next
// town visits).
// Transitions are traced with the spot as subject (spot_reputation: held, cleared).
const Visible = require('../../Social/VisibleStrength');
const Trace = require('../DecisionTrace');
const Situations = require('../Situations');
// Contested arrivals before a spot is held.
const HELD = 5;
// The share of the room at or under which an arrival clears the spot's record.
const CLEAR = 0.8;
// spotId -> { contested, holder: { look, people }, heldSeq (the hold's number, once held) };
// at most one per catalogue spot. heardAt: botId -> the last hold's number at its last town
// arrival; at most one per bot. holds: the holds numbered so far.
const records = new Map(), heardAt = new Map();
let holds = 0;

// The record after an arrival: pressure (SpotContest's, the arriving species' demand over its
// room), units (the units standing there that the arrival met, and the arriving one when it
// stays). null: no record (cleared, or never contested).
function arrived(record, pressure, units) {
    if (pressure <= CLEAR) return null;
    if (!(pressure > 1)) return record;
    let people = 0;
    const looks = [];
    for (const unit of units) {
        people = Math.max(people, unit.members.length);
        for (const member of unit.members) looks.push(Visible.stateLook(member));
    }
    return { contested: (record?.contested || 0) + 1, holder: { look: Visible.best(looks), people },
        ...(record?.heldSeq ? { heldSeq: record.heldSeq } : {}) };
}
const trait = (traits, key) => Math.max(0, Math.min(1, Number(traits?.[key] ?? 0.5) || 0));
// Whether a held record repels a unit { look, people, traits } (VisibleStrength's look).
function repels(record, unit) {
    if (!(record?.contested >= HELD)) return false;
    const looks = Visible.compare(unit.look, record.holder.look);
    if (looks < 0 || record.holder.people > unit.people) return true;
    return looks === 0 && record.holder.people === unit.people && trait(unit.traits, 'caution') > trait(unit.traits, 'assertiveness');
}
// The worker's arrival: the spot's record moved, traced when it becomes held or a held one clears.
function note(spotId, pressure, units) {
    const id = String(spotId), record = records.get(id) || null;
    let next = arrived(record, pressure, units);
    if (next === record) return;
    if (next?.contested === HELD) next = { ...next, heldSeq: ++holds };
    if (next) records.set(id, next); else records.delete(id);
    if (!Trace.on()) return;
    if (next?.contested === HELD) Trace.record({ kind: 'raise', name: 'spot_reputation', reason: 'held', spot: id, people: next.holder.people });
    else if (!next && record?.contested >= HELD) Trace.record({ kind: 'raise', name: 'spot_reputation', reason: 'cleared', spot: id, contested: record.contested });
}
// A bot's town arrival (the worker's far step take, a near body's bag): it hears the holds so
// far. Counted spot:heard when any record is held.
function heard(botId) {
    heardAt.set(Number(botId), holds);
    if (records.size) Situations.note('spot:heard');
}
// A solo bot's filter for a search (state: the bot; persona: its BotPersona): spotId -> repelled,
// or null when it has heard of no hold. Counted spot:repelled by the search per candidate it drops.
function reader(state, persona) {
    const known = heardAt.get(Number(state.characterId));
    if (!known || !records.size) return null;
    const unit = { look: Visible.stateLook(state), people: 1, traits: persona?.traits || {} }, own = String(state.spotId ?? '');
    return spotId => {
        if (String(spotId) === own) return false;
        const record = records.get(String(spotId));
        return record?.heldSeq <= known && repels(record, unit);
    };
}
function clear() { records.clear(); heardAt.clear(); holds = 0; }
module.exports = { arrived, repels, note, heard, reader, clear, HELD, CLEAR };
