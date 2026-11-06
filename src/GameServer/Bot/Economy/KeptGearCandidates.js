'use strict';
// The gear candidates of a bot's wish review (WishProviders: the items the
// review weighs, each with its value and gain), kept with the bot's held build
// (EconomyContext, beside its source facts) and served to the next build while
// everything the weighing read is the same (decision links step 5, S4): it is
// a pure function of what it reads, so the same reads give the same list.
// Two lists are held, one for a full review and one for a quiet build (it
// weighs only the followed gear). Owns the record's layout: the build notes
// a weighing's reads through capture() and reads a kept list only through the
// named readers (boardHolds, items, bag, offers, cash, moves, candidates);
// worker and main builds.
//
// What the weighing reads:
// - the build's inputs it reads beside items (`fields`: the bot's kit and the
//   kit of the preparation it plans for, as the weighing reads them, its
//   progression, the gear a quiet build holds, the hours its value is weighed
//   over, death hours, money hour, trip rows, reserve, persona, the crystal
//   shop, the failed gear errands' marks), one digest per build (KeptSourceFacts.inputDigest);
// - per item priced: its price (the weighing reads the board only through
//   prices and offers), and whether and how it was compared with the budget;
// - per bag answer (an item held or not) and per offer asked (the arrow room,
//   the NPC and fixed offers, the item's lines, and whether the build had
//   asked it before; the offer it got is kept too, so a served list fills the
//   build's offer memo as the weighing did);
// - the wallet only through its comparisons: each price compared with the
//   purchase budget and each cost with the adena, and the answer;
// - each weighed item's market trend.
// A kept list replays its reads (prices through the price reader), so the
// build reads and decides as a fresh one; its bag and cash answers are what
// it is checked on.
// A list of more than RECORD_SLOTS numbers is not kept.
// Counted with diagnostics on: projection:gear:<kept | absent | unkeyed |
// moved:<input> | <read that moved>>, projection:gear_unkept:<size | shape>,
// and one kept list in 16 also weighed fresh: projection:gear_verify:<same |
// differ:<part>> (the fresh one serves).
const Diagnostics = require('./EconomyDiagnostics');
const { inputDigest, firstMoved, verifyDue } = require('./KeptSourceFacts');

// A quiet build's list is ~20-70 numbers; a full review prices ~70-190 kit
// items and weighs ~20-50 candidates: ~230-730 numbers (2-6 KB). 1024
// numbers (8 KB) bound one list; a larger one is weighed every build.
const RECORD_SLOTS = 1024;
// The packed sections, numbers per row: the board [its serial and epoch]
// (one row, none without a board), an item read [itemCode: id and flags; its
// price, 0 when not priced], a bag answer [id, negative when not held], an
// offer [id, arrow room, asked before, the item's revision] (its NPC and
// fixed offer arrays and the offer it got in `refs`, three per offer), a
// cash comparison [cost, threshold, answer], a trend [id, move], a candidate
// [item, slot, value, attack, defence] (the rest of a candidate follows from
// the build's inputs: WishProviders).
const SECTIONS = ['board', 'items', 'quantity', 'purchases', 'cash', 'moves', 'candidates'];
const WIDTH = { board: 2, items: 2, quantity: 1, purchases: 4, cash: 3, moves: 2, candidates: 5 };
// An item read as one number: its id and whether it was priced, compared
// with the purchase budget, and within it (a budget threshold adds the reserve).
const itemCode = (id, priced, compared, within) => Number(id) * 8 + (priced ? 4 : 0) + (compared ? 2 : 0) + (within ? 1 : 0);
const revisionParts = [0, 0, 0, 0];
// A board's serial and epoch (a row of `board`), null without one.
function boardRow(board) {
    if (!board?.writeItemRevision) return null;
    board.writeItemRevision(0, revisionParts);
    return [revisionParts[0], revisionParts[1]];
}
// An item's lines' revision on its board as one number (generation and
// changes; the serial and epoch are the board row's), -1 without a board,
// null past what one number holds (not kept).
function revisionCode(board, id) {
    if (!board?.writeItemRevision) return -1;
    board.writeItemRevision(Number(id), revisionParts);
    const [, , generation, changes] = revisionParts;
    return generation < 4096 && changes < 2 ** 40 ? generation * 2 ** 40 + changes : null;
}
// An input's text: plain objects, arrays, maps, sets and scalars, with what
// JSON loses (undefined, -0, NaN, infinities) spelled out; null for any other
// shape (the build keeps nothing).
function textOf(value) {
    let plain = true;
    const text = JSON.stringify(value, (key, field) => {
        if (field === undefined) return '\u0000u';
        if (typeof field === 'number') return Number.isFinite(field) && !Object.is(field, -0) ? field : `\u0000${Object.is(field, -0) ? '-0' : field}`;
        if (field instanceof Map) return { '\u0000map': [...field] };
        if (field instanceof Set) return { '\u0000set': [...field] };
        if (field && typeof field === 'object' && !Array.isArray(field)) {
            const proto = Object.getPrototypeOf(field);
            if (proto !== Object.prototype && proto !== null) plain = false;
        }
        return field;
    });
    return plain ? text : null;
}

// The record of one weighing: digest, names and hashes (diagnostics), data
// (the sections in SECTIONS order), counts (rows per section), refs (per
// offer its NPC and fixed offer arrays and the offer). rows: { section:
// [[numbers]] }; why it is not kept ('size', 'shape': a value no number).
function pack(global, rows, refs) {
    const counts = SECTIONS.map(section => rows[section].length);
    const size = SECTIONS.reduce((sum, section) => sum + rows[section].length * WIDTH[section], 0);
    if (size > RECORD_SLOTS) return 'size';
    const data = new Float64Array(size);
    let at = 0;
    for (const section of SECTIONS) for (const row of rows[section]) {
        if (row.length !== WIDTH[section] || row.some(value => typeof value !== 'number')) return 'shape';
        data.set(row, at); at += row.length;
    }
    return { ...global, data, counts: Uint16Array.from(counts), refs };
}
// The rows of one section of a record, each as read(data, its first slot, its ordinal).
function rowsOf(record, section, read) {
    let at = 0;
    for (const name of SECTIONS) {
        if (name === section) break;
        at += record.counts[SECTIONS.indexOf(name)] * WIDTH[name];
    }
    const rows = [], width = WIDTH[section], data = record.data;
    for (let row = 0; row < record.counts[SECTIONS.indexOf(section)]; row++, at += width) rows.push(read(data, at, row));
    return rows;
}

// A kept list as the build reads it (WishProviders), section by section.
// Whether the board is the one the list was weighed on (its serial and epoch; both none too).
function boardHolds(record, board) {
    const now = boardRow(board), [held] = rowsOf(record, 'board', (data, at) => [data[at], data[at + 1]]);
    return !now === !held && (!now || now[0] === held[0] && now[1] === held[1]);
}
// The items read: { id, priced, compared (with the purchase budget), within, price (0 when not priced) }.
const items = record => rowsOf(record, 'items', (data, at) => {
    const code = data[at];
    return { id: Math.floor(code / 8), priced: (code & 4) > 0, compared: (code & 2) > 0, within: (code & 1) > 0, price: data[at + 1] };
});
// The bag answers: { id, held }.
const bag = record => rowsOf(record, 'quantity', (data, at) => ({ id: Math.abs(data[at]), held: data[at] > 0 }));
// The offers asked, in order: { id, room (the arrow room), asked (before, by
// the build), revision (of the item's lines), npc, fixed (the offer arrays),
// offer (what it got) }.
const offers = record => rowsOf(record, 'purchases', (data, at, row) => ({ id: data[at], room: data[at + 1], asked: data[at + 2] === 1,
    revision: data[at + 3], npc: record.refs[row * 3], fixed: record.refs[row * 3 + 1], offer: record.refs[row * 3 + 2] }));
// Whether an offer's item lines on this board are the ones it read.
const linesHold = (board, offer) => revisionCode(board, offer.id) === offer.revision;
// The cash comparisons: { cost, threshold (with the reserve), holds (the answer) }.
const cash = record => rowsOf(record, 'cash', (data, at) => ({ cost: data[at], threshold: data[at + 1], holds: data[at + 2] === 1 }));
// The market trends read: { id, trend }.
const moves = record => rowsOf(record, 'moves', (data, at) => ({ id: data[at], trend: data[at + 1] }));
// The candidates: { id, slot, value, gain } (the rest of a candidate follows
// from the build's inputs: WishProviders).
const candidates = record => rowsOf(record, 'candidates', (data, at) => ({ id: data[at], slot: data[at + 1], value: data[at + 2],
    gain: { attack: data[at + 3], defence: data[at + 4] } }));

// The reads of one weighing on `board`, noted as it runs (WishProviders);
// done(candidates) hands them to keep().
function capture(board) {
    const rows = { quantity: [], purchases: [], cash: [], moves: [], items: [] }, refs = [], budget = new Map();
    return {
        // A bag answer: the item held or not.
        bag(id, held) { rows.quantity.push([held ? Number(id) : -Number(id)]); },
        // An offer asked: { id, room, asked (before), npc, fixed, offer }.
        offer({ id, room, asked, npc, fixed, offer }) {
            rows.purchases.push([Number(id), room, asked ? 1 : 0, revisionCode(board, id)]);
            refs.push(npc, fixed, offer);
        },
        // A price compared with the purchase budget, and whether within it.
        budget(id, within) { budget.set(Number(id), within); },
        // A cost compared with the adena: its threshold and the answer.
        cash(cost, threshold, holds) { rows.cash.push([cost, threshold, holds ? 1 : 0]); },
        move(id, trend) { rows.moves.push([Number(id), trend]); },
        // An item the weighing read, with its price (null when not priced).
        item(id, price) {
            rows.items.push(price == null ? [itemCode(id), 0] : [itemCode(id, true, budget.has(Number(id)), budget.get(Number(id))), price]);
        },
        // The weighing done: its candidates ({ item, slot, value, gain }).
        done(weighed) {
            const now = boardRow(board);
            return { rows: { ...rows, board: now ? [now] : [],
                candidates: weighed.map(row => [Number(row.item.selfId), row.slot, row.value, row.gain.attack, row.gain.defence]) }, refs };
        }
    };
}

// held: the held build's lists ({ full, quiet }, or null); fields(): this
// build's inputs as [name, value] rows, null when one cannot be named
// (nothing is kept); quiet: a quiet build's list is asked.
function session(lists, fields, quiet) {
    const slot = quiet ? 'quiet' : 'full', prior = lists?.[slot] || null;
    const diagnostic = Diagnostics.active();
    const count = (outcome, reason) => { if (diagnostic) Diagnostics.count('projection', outcome, reason); };
    let global = null;
    // The prior record whose inputs hold, or null.
    function held() {
        const list = fields();
        global = list && inputDigest(list, diagnostic, textOf);
        if (!global) { count('gear', 'unkeyed'); return null; }
        if (!prior) { count('gear', 'absent'); return null; }
        if (prior.digest === global.digest) return prior;
        count('gear', `moved:${firstMoved(prior, global)}`);
        return null;
    }
    // The held record's own reads came back: why ('' kept); true: weigh it
    // fresh too (and pass the record to keep as `verified`).
    function judged(why) {
        count('gear', why || 'kept');
        return !why && verifyDue('gear');
    }
    // The lists for the held build: this build's (record, or its weighing as
    // capture().done() gives it; none when unkeyed or of a shape it cannot
    // hold) in its slot, the other kept; verified: the held record a fresh
    // weighing checks.
    function keep(weighing, verified = null) {
        const packed = weighing.data ? weighing : global && pack(global, weighing.rows, weighing.refs);
        if (typeof packed === 'string') count('gear_unkept', packed);
        const record = typeof packed === 'string' ? null : packed;
        if (verified) {
            const slots = (list, section) => rowsOf(list, section, (data, at) => data.subarray(at, at + WIDTH[section]));
            const asked = record && offers(record);
            const part = !record ? 'unkept' : SECTIONS.find(section => {
                const was = slots(verified, section), now = slots(record, section);
                return was.length !== now.length || was.some((row, i) => row.some((value, at) => !Object.is(value, now[i][at])));
            })
                || (offers(verified).some((offer, i) => offer.npc !== asked[i].npc || offer.fixed !== asked[i].fixed) ? 'refs' : '');
            count('gear_verify', part ? `differ:${part}` : 'same');
        }
        const next = { full: lists?.full || null, quiet: lists?.quiet || null, [slot]: record || null };
        return next.full || next.quiet ? next : null;
    }
    return { held, judged, keep };
}

module.exports = { session, capture, boardHolds, items, bag, offers, linesHold, cash, moves, candidates, RECORD_SLOTS };
