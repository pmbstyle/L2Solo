'use strict';

// The supply decision of a design bot: what a heard chain of facts makes it do
// about its consumable and its bag. supplyChoice(facts, state) -> actions, in
// one of two variants on the same state, so a run can compare them:
//   'table'    the rows of supply-rows.js (a C4 player's plain rules);
//   'formula'  the trip priced in hours of value: go when the loss the trip
//              prevents beats its price, else stay.
// Pure on plain data; called by the design plane once per heard chain, and
// once more for the other variant as a shadow that changes nothing (shadow).
//
// state = { place: 'hunt' | 'road' | 'town', town (where it stands, null in
//   the field), spotTown (the held spot's town), need (needs.consumable or
//   null), surplus ([[id, count]], needs.surplus), npcBuy ({ id: the NPC's buy
//   price in the town it stands in or goes to }), wallet (adena), roadMoney (the fare back to the held spot;
//   walking: 0), toHours, backHours (the trip's legs), horizon (the hunting
//   hours to a full bag after the visit: need.hours, or with no need the same
//   rule with no stock), offers ({ town, price, channel }:
//   the seller of need.id in the town it stands in, else the one the fewest fare away, null when none), fightsBare (its held
//   row's hour without shots kills anything), variant,
//   value (formula only: { hour, bare, withoutDrop: hour values of its shots
//   form, its bare form and its hunted form with a full bag; bagFull: its bag is full now; bagHoursBare:
//   hours to its bag's fact hunting bare; outHours: hours to its shots' end;
//   M: the line's best NPC income an hour; moneyWeight }) }
const ROWS = require('./supply-rows');

// The closed set of actions a supply answer is made of. equip has no maker
// yet: the purchase of a kit part is its only producer and no rule buys one
// yet.
const ACTIONS = Object.freeze(['go', 'buy', 'sell', 'equip', 'stay', 'back']);
const act = (kind, fields, row) => ({ kind, ...fields, row });

const hasMoney = state => state.wallet > state.roadMoney || state.surplus.length > 0;
// Stuck is a state of the bot, whichever fact woke it: it holds none of the shots
// it fires, has no adena, nothing to sell, and its held row kills nothing without
// shots; no new fact but a change of its state (loot, a gift) ends it. The one
// rule for both variants and the run's count.
const stuck = state => !!state.need && state.need.held === 0 && !hasMoney(state) && !state.fightsBare;
// Why a bot stays: stuck, no adena and nothing to sell (it hunts bare), or the
// trip costs more than it prevents (the formula only).
const stayReason = state => (stuck(state) ? 'no_bare_hour' : !hasMoney(state) ? 'no_money' : 'trip_costs_more');
// Units of the need adena buys from its offer, the fare back kept.
const affordable = (state, offer, money) => Math.min(state.need.short, Math.floor(Math.max(0, money - state.roadMoney) / offer.price));
const sellerTown = state => state.offers?.town ?? state.spotTown;

// The words a row's condition is made of: (kinds of the heard facts, state) -> bool.
const WORDS = Object.freeze({
    out: kinds => kinds.has('out'),
    outOrBag: kinds => kinds.has('out') || kinds.has('bag'),
    walletOrSurplus: (kinds, state) => hasMoney(state),
    noWalletNoSurplus: (kinds, state) => !hasMoney(state),
    surplus: (kinds, state) => state.surplus.length > 0,
    belowTarget: (kinds, state) => !!state.need && state.need.short > 0
});

function npcBuyOf(state, id) {
    const price = state.npcBuy[id];
    if (typeof price !== 'number') throw new Error(`no NPC buy price for item ${id}`);
    return price;
}

// The action makers a row runs: (state, row id, kinds of the heard facts) -> actions.
const MAKERS = Object.freeze({
    goNearestSeller: (state, row) => [act('go', { town: sellerTown(state) }, row)],
    stay: (state, row) => [act('stay', { reason: stayReason(state) }, row)],
    sellAllNpc: (state, row) => state.surplus.map(([id, count]) => act('sell', { id, count, price: npcBuyOf(state, id) }, row)),
    // Only where this town's NPC sells it.
    buyToTarget: (state, row) => {
        const offer = state.offers;
        if (!offer || offer.town !== state.town) return [];
        const count = affordable(state, offer, state.wallet);
        return count > 0 ? [act('buy', { id: state.need.id, count, price: offer.price, channel: offer.channel }, row)] : [];
    },
    back: (state, row) => [act('back', {}, row)]
});

// Rules a reserved row waits for, by its reserved name (none yet).
const RESERVED = Object.freeze({});

// A row the reader cannot run throws by its id and the unknown name.
function checked(row) {
    if (row.reserved) return row;
    if (!MAKERS[row.then]) throw new Error(`row ${row.id}: action '${row.then}' is not in the closed set`);
    for (const word of row.when) if (!WORDS[word]) throw new Error(`row ${row.id}: no condition word '${word}'`);
    return row;
}
const holds = (row, kinds, state) => row.when.every(word => WORDS[word](kinds, state));

// What its surplus brings at the NPC.
const saleOf = state => state.surplus.reduce((sum, [id, count]) => sum + count * npcBuyOf(state, id), 0);

// The state after town actions: a sale adds its adena and leaves nothing to
// spare of the item, a purchase spends its adena and adds to the need.
function applied(state, actions) {
    let next = state;
    for (const action of actions) {
        if (action.kind === 'sell') {
            next = { ...next, wallet: next.wallet + action.count * action.price, surplus: next.surplus.filter(([id]) => id !== action.id) };
        } else if (action.kind === 'buy') {
            next = { ...next, wallet: next.wallet - action.count * action.price,
                need: { ...next.need, held: next.need.held + action.count, short: next.need.short - action.count } };
        }
    }
    return next;
}

function townChain(state, rows, label) {
    const out = [];
    let now = state;
    for (const row of rows.map(checked)) {
        const make = row.reserved ? RESERVED[row.reserved] : holds(row, new Set(), now) && MAKERS[row.then];
        if (!make) continue;
        const actions = make(now, label || row.id, new Set());
        out.push(...actions);
        now = applied(now, actions);
    }
    return out;
}

const kindsOf = facts => new Set(facts.map(fact => fact.kind));

// The table variant: in the field the first row that holds, in town every row that holds.
function table(facts, state, rows = ROWS) {
    if (state.place === 'town') return townChain(state, rows.TOWN);
    const kinds = kindsOf(facts);
    for (const row of rows.FIELD.map(checked)) if (!row.reserved && holds(row, kinds, state)) return MAKERS[row.then](state, row.id, kinds);
    return [];
}

// The formula variant. In the field: stay is worth 0; going prevents the loss
// of the hours until the next fact on which it would go anyway (at most the
// hours to a full bag after the visit, state.horizon: the stock rule's H): out of shots, the hours to its bag's fact hunting bare at the
// bare hour's shortfall, scaled by the share of the target the trip buys
// (with its wallet and what its surplus sells for there first, as in town);
// its bag full, the hours to its shots' end at the drop's share of the hour;
// both at once, those hours of each. Its price: the road's hours at
// its own hour's value and the adena it spends at the money weight. Going
// wins when it prevents more than it costs; a stay gives the table's reason
// (stayReason). In town the
// levers are the table's: sell all to the NPC, buy to target (an NPC price is
// within any buyer's ceiling where an NPC sells), back.
function formula(facts, state) {
    if (state.place === 'town') return townChain(state, ROWS.TOWN, 'formula');
    const kinds = kindsOf(facts), out = kinds.has('out');
    // A bag already full (its fact heard earlier and declined) stands with an out fact as both at once.
    const bag = kinds.has('bag') || (out && state.value.bagFull === true);
    if (!out && !bag) return [];
    const value = state.value, horizon = state.horizon, offer = state.offers;
    const units = out && state.need && state.need.short > 0 && offer ? affordable(state, offer, state.wallet + saleOf(state)) : 0;
    const share = out && state.need && state.need.short > 0 ? units / state.need.short : 0;
    const outLoss = out ? Math.min(bag ? horizon : value.bagHoursBare, horizon) * (value.hour - value.bare) * share : 0;
    const bagLoss = bag ? Math.min(out ? horizon : value.outHours, horizon) * ((out ? value.bare : value.hour) - value.withoutDrop) : 0;
    const price = (state.toHours + state.backHours) * value.hour
        + (state.roadMoney + units * (offer?.price || 0)) / value.M * value.moneyWeight;
    if (outLoss + bagLoss - price > 0) return [act('go', { town: sellerTown(state) }, 'formula')];
    return [act('stay', { reason: stayReason(state) }, 'formula')];
}

const VARIANTS = Object.freeze({ table: (facts, state) => table(facts, state), formula });
function answerOf(variant, facts, state) {
    if (!VARIANTS[variant]) throw new Error(`no supply variant '${variant}'`);
    return VARIANTS[variant](facts, state);
}

function supplyChoice(facts, state) {
    return answerOf(state.variant, facts, state);
}

// The state's variant's answer and the other's on the same facts and state;
// differ names the table's row(s) that answered ('none': no row held) and the
// two answers' kinds when they differ, null when they agree.
const sameAction = (a, b) => a.kind === b.kind && a.town === b.town && a.id === b.id && a.count === b.count && a.reason === b.reason;
const kindList = actions => actions.map(action => (action.reason ? `${action.kind}:${action.reason}` : action.kind)).join('+') || 'none';
function shadow(facts, state) {
    const other = state.variant === 'table' ? 'formula' : 'table';
    const actions = supplyChoice(facts, state), shadowed = answerOf(other, facts, state);
    const byTable = state.variant === 'table' ? actions : shadowed, byFormula = state.variant === 'table' ? shadowed : actions;
    const same = byTable.length === byFormula.length && byTable.every((action, at) => sameAction(action, byFormula[at]));
    const row = [...new Set(byTable.map(action => action.row))].join('+') || 'none';
    return { actions, other: shadowed, differ: same ? null : { row, reason: `table ${kindList(byTable)} / formula ${kindList(byFormula)}` } };
}

module.exports = { ACTIONS, WORDS, MAKERS, RESERVED, stuck, stayReason, supplyChoice, table, formula, shadow };
