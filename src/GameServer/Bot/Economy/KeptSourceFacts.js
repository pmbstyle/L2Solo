'use strict';
// The source facts of a bot's wish build (WishProviders sourcePath over
// GearAcquisitionPlanner.sourceFacts), named by what they read, kept with the
// bot's held build (EconomyContext, beside its source ground) for the next
// build of the same bot. Owns the record's layout; worker and main builds.
// Shadow stage (decision links step 5, S0): every fact is still built; the
// record keeps digests only, and the next build counts what keeping the facts
// would have done (projection:fact:<kept | moved:<input> | moved:crowd |
// moved:spoiler | moved:price | absent | unkeyed>, the time a kept one took
// as projection:fact_kept) and whether a kept one answered the same
// (projection:verify:<same | differ:output>). Diagnostics only.
//
// What a fact reads:
// - the build's inputs every fact reads, named (`fields`: the provider's band,
//   hour, spoiler and trip rows, the walk's own reads, the route reader's,
//   the spot value reader's), one digest per build;
// - identities: the planning spots, their source index and the ground cells
//   of the route reader (kept with the held build: the same cells answer the
//   same spots; a reset is a new array);
// - its own: the item (and whether only Spoil is asked), whether the build
//   had read the spoiler when it asked (the walk's band reads it), and the
//   crowd of every spot whose value it read (the reader's hunters there);
// - a price or a bag count read inside its scope: such a fact keeps nothing.
const { createHash } = require('node:crypto');
const { fnv1a32 } = require('../Fnv1a');
const Diagnostics = require('./EconomyDiagnostics');

// Facts per record: a build reads ~3-25 (63 seen for a level-70 crafter).
const LIMIT = 24;
const ROW = 3;
const digestOf = texts => createHash('sha256').update(texts.join('\n')).digest('base64').slice(0, 22);
// One fact's own key: the item, spoil only, the spoiler as the build had read it.
const factKey = (key, spoilerSeen) => (typeof key === 'number' ? key * 2 : Number(String(key).slice(6)) * 2 + 1) * 4 + spoilerSeen;
const crowdDigest = pairs => fnv1a32(pairs.join(','));
const outputDigest = best => fnv1a32(best ? JSON.stringify([best.kind, best.spotId, best.npcId, best.hours,
    best.netHourCost, best.town, best.tripHours, best.tripFees]) : 'null');

// prior: the held build's record (or null); spots, index, cells: this build's
// identities; fields(): this build's inputs as [name, value] rows, null when a
// reader does not name them (no fact is keyed).
function session(prior, { spots, index, cells, fields }) {
    let global = null, moved = null;
    const rows = [];
    let cut = 0;
    // Why no prior fact can stand, '' when the build's inputs are the prior's.
    const judge = () => {
        if (moved !== null) return moved;
        const list = fields();
        if (!list) return (moved = 'unkeyed');
        const texts = list.map(([name, value]) => `${name}=${JSON.stringify(value)}`);
        global = { digest: digestOf(texts), names: list.map(row => row[0]), hashes: Uint32Array.from(texts, text => fnv1a32(text)) };
        if (!prior?.digest) return (moved = 'absent');
        if (prior.spots !== spots || prior.index !== index) return (moved = 'moved:spots');
        if (prior.cells !== cells) return (moved = 'moved:ground');
        if (prior.digest === global.digest) return (moved = '');
        const at = global.names.findIndex((name, i) => prior.names[i] !== name || prior.hashes[i] !== global.hashes[i]);
        return (moved = `moved:${at >= 0 ? global.names[at] : 'inputs'}`);
    };
    const priorRow = key => {
        const facts = prior?.facts;
        if (!facts) return -1;
        for (let at = 0; at < facts.length; at += ROW) if (facts[at] >>> 2 === key >>> 2) return at;
        return -1;
    };
    // A fact just built: key (sourcePath's), spoilerSeen (0 unread, 1 none, 2 a
    // spoiler), best (its answer), inputs (what its scope read), crowd ([spot
    // ordinal, hunters] pairs, flat; null: a spot off the list), ms (its time).
    function built(key, spoilerSeen, best, inputs, crowd, ms) {
        const own = factKey(key, spoilerSeen), crowdHash = crowd ? crowdDigest(crowd) : 0, output = outputDigest(best);
        const read = !!(inputs?.items.length || inputs?.bag.length);
        let outcome = judge() || (read ? 'moved:price' : !crowd ? 'unkeyed' : '');
        if (!outcome) {
            const at = priorRow(own);
            outcome = at < 0 ? 'absent' : prior.facts[at] !== own ? 'moved:spoiler'
                : prior.facts[at + 1] !== crowdHash ? 'moved:crowd' : 'kept';
            if (outcome === 'kept') {
                Diagnostics.duration('projection:fact_kept', ms);
                Diagnostics.count('projection', 'verify', prior.facts[at + 2] === output ? 'same' : 'differ:output');
            }
        }
        Diagnostics.count('projection', 'fact', outcome);
        if (read || !crowd || moved === 'unkeyed') return;
        if (rows.length >= LIMIT * ROW) { cut++; return; }
        rows.push(own, crowdHash, output);
    }
    // The record for the held build, null when nothing is keyed. Under the
    // same inputs a prior fact this build did not ask stays (a quiet build
    // asks only the followed gear's), each still judged by its own reads.
    function finish() {
        if (moved === null && prior) judge();
        if (moved === '') for (let at = 0; at < prior.facts.length; at += ROW) {
            if (rows.some((key, i) => i % ROW === 0 && key >>> 2 === prior.facts[at] >>> 2)) continue;
            if (rows.length >= LIMIT * ROW) { cut++; continue; }
            rows.push(prior.facts[at], prior.facts[at + 1], prior.facts[at + 2]);
        }
        if (cut) Diagnostics.count('cap', 'kept_facts', 'cut', cut);
        if (!global || moved === 'unkeyed') return null;
        return { digest: global.digest, names: global.names, hashes: global.hashes, spots, index, cells,
            facts: Uint32Array.from(rows) };
    }
    return { built, finish };
}

module.exports = { session, LIMIT };
