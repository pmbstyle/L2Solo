'use strict';
// The source facts of a bot's wish build (WishProviders sourcePath over
// GearAcquisitionPlanner.sourceFacts), kept with the bot's held build
// (EconomyContext, beside its source ground) and served to the next build of
// the same bot while every input the fact read is the same (decision links
// step 5, S1): the walk is a pure function of what it reads, so the same reads
// give the same answer. Owns the record's layout; worker and main builds.
//
// What a fact reads:
// - the build's inputs every fact reads, named (`fields`: the provider's band,
//   hour, the bot's Spoil and trip rows, the walk's own reads, the route
//   reader's, the spot value reader's), one digest per build;
// - identities: the planning spots, their source index and the ground cells
//   of the route reader (kept with the held build; cells only fill, so the
//   same array answers every spot it answered; a reset is a new array);
// - its own: the item (and whether only Spoil is asked), whether the build
//   bot spoils (the walk's band reads it; a build reads it once, WishProviders),
//   and the crowd of every spot whose value it read (the reader's hunters);
// - a price or a bag count read inside its scope: such a fact is not kept (none
//   does today), so a kept fact replays no read and the build's read scopes
//   and event proof are the fresh build's.
// A fact is not kept when its answer names a town off EconomicTrip.towns or a
// kind other than drop and spoil, or it read more than MAX_CROWD spots.
// Counted with diagnostics on: projection:fact:<kept | moved:<input> |
// moved:crowd | moved:spoiler | absent | unkeyed>, projection:unkept:<why>,
// and one kept fact in 16 also built fresh: projection:verify:<same |
// differ:<field>> (the fresh one serves).
const { createHash } = require('node:crypto');
const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('./EconomyDiagnostics');
const Trip = require('./EconomicTrip');

// A record holds at most LIMIT facts in RECORD_SLOTS numbers (~2.3 KB): a
// build asks ~3-25 facts (63 seen for a level-70 crafter), a fact reads a few
// spots. MAX_CROWD: the spots one kept fact may have read.
const LIMIT = 24;
const RECORD_SLOTS = 288;
const MAX_CROWD = 32;
const VERIFY_EVERY = 16;
const KINDS = ['drop', 'spoil'];
const NO_TOWN = 255;
// A packed fact: [own key, crowd reads, kind * 256 + town or -1 (no ready
// source), then with an answer its hours, netHourCost, spot ordinal, npcId,
// tripHours, tripFees, then each crowd read as ordinal * 65536 + hunters].
const HEAD = 3, ANSWER = 6;
const crowdAt = (data, at) => at + HEAD + (data[at + 2] >= 0 ? ANSWER : 0);
const endAt = (data, at) => crowdAt(data, at) + data[at + 1];
// The digest of a build's named inputs ([name, value] rows, each value as
// `text` writes it; null: a value it cannot write): { digest, and with
// diagnostics on the names and a hash per row (firstMoved names the first
// that moved) }. Shared by the kept pieces of a wish build (KeptGearCandidates).
function inputDigest(list, diagnostic, text = JSON.stringify) {
    const values = list.map(([, value]) => text(value));
    if (values.includes(null)) return null;
    const texts = list.map(([name], at) => `${name}=${values[at]}`);
    return { digest: createHash('sha256').update(texts.join('\n')).digest('base64').slice(0, 22),
        ...(diagnostic ? { names: list.map(row => row[0]), hashes: Uint32Array.from(texts, row => fnv1a32(row)) } : {}) };
}
// The first input two digests differ in, 'inputs' when either named none.
function firstMoved(prior, global) {
    const at = !prior.names || !global.names ? -1
        : global.names.findIndex((name, i) => prior.names[i] !== name || prior.hashes[i] !== global.hashes[i]);
    return at >= 0 ? global.names[at] : 'inputs';
}
const verifyTurns = new Map();
// Whether this kept answer of `kind` ('fact', 'gear') is the one in
// VERIFY_EVERY of its kind also built fresh (diagnostics only): each kind
// counts its own, so a build's mix of kinds cannot align one kind's turns.
function verifyDue(kind) {
    if (!Diagnostics.active()) return false;
    const turn = (verifyTurns.get(kind) || 0) + 1;
    verifyTurns.set(kind, turn);
    return turn % VERIFY_EVERY === 0;
}
// One fact's own key: the item, spoil only, the spoiler as the build had read it.
const factKey = (key, spoilerSeen) => (typeof key === 'number' ? key * 2 : Number(String(key).slice(6)) * 2 + 1) * 4 + spoilerSeen;

// A fact's answer as sourcePath reads it, from its packed row.
function answerAt(data, at, spots) {
    const code = data[at + 2];
    if (code < 0) return null;
    const town = code % 256;
    return { kind: KINDS[Math.floor(code / 256)], hours: data[at + 3], netHourCost: data[at + 4],
        spotId: spots[data[at + 5]].id, npcId: data[at + 6], town: town === NO_TOWN ? null : Trip.towns[town],
        tripHours: data[at + 7], tripFees: data[at + 8] };
}
// The packed row of a fact just built, or why it is not kept.
function pack(own, best, crowd, spots) {
    if (!crowd) return 'crowd';
    if (crowd.length > MAX_CROWD * 2) return 'crowd_size';
    const row = [own, crowd.length / 2, -1];
    if (best) {
        const kind = KINDS.indexOf(best.kind), town = best.town == null ? NO_TOWN : Trip.towns.indexOf(best.town);
        let spot = -1;
        for (let i = 0; i < crowd.length && spot < 0; i += 2) if (spots[crowd[i]]?.id === best.spotId) spot = crowd[i];
        if (kind < 0) return 'kind';
        if (town < 0) return 'town';
        if (spot < 0) return 'spot';
        row[2] = kind * 256 + town;
        row.push(best.hours, best.netHourCost, spot, best.npcId, best.tripHours, best.tripFees);
    }
    for (let i = 0; i < crowd.length; i += 2) {
        if (!(Number.isSafeInteger(crowd[i + 1]) && crowd[i + 1] >= 0 && crowd[i + 1] < 65536)) return 'hunters';
        row.push(crowd[i] * 65536 + crowd[i + 1]);
    }
    return row;
}
// The first answer field two answers differ in, '' when they are the same.
function differs(a, b) {
    if (!a || !b) return a === b ? '' : 'answer';
    for (const field of ['kind', 'hours', 'netHourCost', 'spotId', 'npcId', 'town', 'tripHours', 'tripFees'])
        if (!Object.is(a[field], b[field])) return field;
    return '';
}

// prior: the held build's record (or null); spots, index, cells: this build's
// identities; fields(): this build's inputs as [name, value] rows, null when a
// reader does not name them (no fact is kept).
function session(prior, { spots, index, cells, fields }) {
    const diagnostic = Diagnostics.active();
    let global = null, moved = null;
    // The packed rows of the new record.
    const rows = [];
    let slots = 0, cut = 0;
    const count = (outcome, reason) => { if (diagnostic) Diagnostics.count('projection', outcome, reason); };
    // Why no prior fact can stand, '' when the build's inputs are the prior's.
    const judge = () => {
        if (moved !== null) return moved;
        const list = fields();
        if (!list) return (moved = 'unkeyed');
        global = inputDigest(list, diagnostic);
        if (!prior?.digest) return (moved = 'absent');
        if (prior.spots !== spots || prior.index !== index) return (moved = 'moved:spots');
        if (prior.cells !== cells) return (moved = 'moved:ground');
        if (prior.digest === global.digest) return (moved = '');
        return (moved = `moved:${firstMoved(prior, global)}`);
    };
    const priorAt = item => {
        const data = prior?.data;
        if (!data) return -1;
        for (let at = 0; at < data.length; at = endAt(data, at)) if (data[at] >>> 2 === item) return at;
        return -1;
    };
    const has = item => rows.some(row => row[0] >>> 2 === item);
    const add = row => {
        if (rows.length >= LIMIT || slots + row.length > RECORD_SLOTS) { cut++; return; }
        rows.push(row); slots += row.length;
    };
    // The kept answer of the fact `key` asked with `spoilerSeen` (1 none, 2 a
    // spoiler; 0 a fact kept before the build read it once): { best } (best null: no ready source), or null:
    // build it. huntersAt(ordinal): the crowd there now. A kept answer with
    // `verify` set is built fresh too and handed back to built().
    function take(key, spoilerSeen, huntersAt) {
        const own = factKey(key, spoilerSeen);
        const why = judge();
        if (why) { count('fact', why); return null; }
        const at = priorAt(own >>> 2), data = prior.data;
        if (at < 0) { count('fact', 'absent'); return null; }
        if (data[at] !== own) { count('fact', 'moved:spoiler'); return null; }
        const end = endAt(data, at);
        for (let i = crowdAt(data, at); i < end; i++) {
            const ordinal = Math.floor(data[i] / 65536);
            if (huntersAt(ordinal) !== data[i] - ordinal * 65536) { count('fact', 'moved:crowd'); return null; }
        }
        count('fact', 'kept');
        const verify = verifyDue('fact');
        if (!verify) add(Array.prototype.slice.call(data, at, end));
        return { best: answerAt(data, at, spots), verify };
    }
    // A fact just built: key, spoilerSeen (as take), best (its answer), inputs
    // (what its scope read), crowd ([spot ordinal, hunters] pairs, flat; null:
    // a spot off the list or no crowd reader), kept (the kept answer it verifies).
    function built(key, spoilerSeen, best, inputs, crowd, kept = null) {
        if (kept) {
            const field = differs(kept.best, best);
            count('verify', field ? `differ:${field}` : 'same');
        }
        if (judge() === 'unkeyed') return;
        if (inputs?.items.length || inputs?.bag.length) { count('unkept', 'price'); return; }
        const row = pack(factKey(key, spoilerSeen), best, crowd, spots);
        if (!Array.isArray(row)) { count('unkept', row); return; }
        add(row);
    }
    // The record for the held build, null when nothing is kept. Under the
    // same inputs a prior fact this build did not ask stays (a quiet build
    // asks only the followed gear's), each still judged by its own reads.
    function finish() {
        if (moved === null && prior) judge();
        if (moved === '') {
            const data = prior.data;
            for (let at = 0; at < data.length; at = endAt(data, at))
                if (!has(data[at] >>> 2)) add(Array.prototype.slice.call(data, at, endAt(data, at)));
        }
        if (cut) count('unkept', 'cap');
        if (!global || moved === 'unkeyed' || !rows.length) return null;
        return { digest: global.digest, ...(global.names ? { names: global.names, hashes: global.hashes } : {}),
            spots, index, cells, data: Float64Array.from(rows.flat()) };
    }
    return { take, built, finish };
}

module.exports = { session, inputDigest, firstMoved, verifyDue, LIMIT, RECORD_SLOTS };
