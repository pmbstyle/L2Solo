'use strict';

// How a bot reacts (design rules, Recompute; user 11-02). A bot holds its plan. A
// change only stands against the decision's baseline, the mark; where the bot stands
// decides whether it hears the change now. One question, one table: hears(link, place).
// The step's facts, the soft point, the held plan's verdict and the doors to a build
// all ask it; none keeps a rule of its own. A new rule is a row here.

const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);
const partyIdOf = state => String(state.party?.partyId || state.partyId || '');

// The gate (coldMomentGate), one per thread. Off, every bot reads as the author's.
let gate = false;
const configure = on => { gate = on === true; };

// Places, as bits of a link's waits. OPEN hears everything: a body near a player, the
// gate off. HUNT: the gate off, a far bot alone on a hunting leaf (T174). Behind the
// gate: WORK on a hunt, the road or in a party's fight, REST, VISIT a town visit past
// its first look, STAND anywhere else (a stall, a craft, a meeting).
const OPEN = 0, HUNT = 1, WORK = 2, REST = 4, VISIT = 8, STAND = 16;
const FIELD = WORK | REST, GATED = FIELD | VISIT | STAND;
const NAMES = new Map([[OPEN, 'open'], [HUNT, 'hunt'], [WORK, 'work'], [REST, 'rest'], [VISIT, 'visit'], [STAND, 'stand']]);

// leaf: the held leaf, if the reader has it. before: the state a step left, read
// for the one moment that is a change of place: arriving in town, where what
// waited in the field is heard, once.
function place(state, leaf = null, before = null) {
    if (state.phase !== 'cold') return OPEN;
    if (!gate) return !partyIdOf(state) && FIELD_ACTIVITIES.has(state.activity) && leaf?.activity === 'hunting' ? HUNT : OPEN;
    if (state.stats?.tradeMeeting) return STAND;
    if (state.activity === 'hunting' || state.activity === 'traveling' || state.activity === 'grouped') return WORK;
    if (state.activity === 'resting') return REST;
    if (state.activity === 'shopping') return before && FIELD_ACTIVITIES.has(before.activity) ? OPEN : VISIT;
    return STAND;
}
// A place under the rule (behind the gate, far), and one in the field.
const gated = where => !!(where & GATED);
const field = where => !!(where & FIELD);
const reactive = state => gated(place(state));
// On a visit past its look a bot works down what the look decided: what ended a step of
// the agenda moves the plan to the next.
const onVisit = state => place(state) === VISIT;
const agendaHears = (state, why) => onVisit(state) && why.startsWith('check:');
// Which step reads its facts: a round's end, the gate off a hunt only. Behind the gate a
// party's round too, and the step that arrives in town: its one look.
function readsFacts(before, after) {
    return before.activity === 'hunting'
        || gated(place(before)) && (before.activity === 'grouped' || !place(after, null, before));
}

const link = (sections, waits) => Object.freeze({ sections: Object.freeze(sections), waits });
const KIT = ['build', 'benefits', 'sources'], STOCK = ['supply', 'sources'];
const BOUGHT = ['sources', 'money'], OBSERVED = ['occupation', 'benefits', 'sources'];

// Every change a bot can hear: the sections of the decision it touches, the places
// it waits at. What has no place in waits is heard at once everywhere.
const LINKS = Object.freeze({
    // Its own state (DecisionSections.factEvents).
    build: link(KIT, WORK | VISIT),
    recipes: link(KIT, WORK | VISIT),
    dead: link(['combat'], 0),
    relations: link(['relations'], WORK | VISIT),
    party: link(['relations'], 0),
    // A search found a better spot: the bot finishes where it stands, and a job that
    // is no hunt (income_later) before it hears of it.
    income_moved: link(['occupation'], WORK | VISIT),
    income_later: link(['occupation'], GATED),
    // A spot too full to enter, and what main refused at the act: the plan cannot stand.
    crowded: link(['occupation', 'sources'], 0),
    rejected: link(['sources'], 0),
    // A body's arrival in town.
    town: link(['supply', 'money'], 0),
    // Main moved the bot's goal; its native plan failed or moved; the step's own
    // review of a craft or clan market.
    goal_moved: link([], 0),
    native: link([], 0),
    craft_bid: link([], 0),
    clan_market: link([], 0),
    funding: link(['funding'], WORK | VISIT),
    occupation: link(['occupation'], 0),
    riskDeaths: link(['combat', 'occupation'], 0),
    supply: link(['supply'], FIELD | VISIT),
    bag: link(STOCK, FIELD | VISIT),
    stores: link(STOCK, WORK | VISIT),
    // Its own warehouse: what it put in and took is its doing, heard as it arrives in town.
    warehouse: link(STOCK, GATED),
    // A condition, not a change: a need that opened (a supply gone, potions under
    // what the survival drink keeps, the bag full, the load a level up).
    need_supply: link(['supply'], 0),
    need_bag: link(STOCK, 0),
    // Its own doing is no event (own outputs are not inputs): its trips and where
    // they end, its craft preparation.
    own_move: link(['occupation'], GATED),
    own_preparation: link(['sources', 'benefits', 'money'], GATED),
    // The soft point (DecisionSections.softEvents). Money is read in town and when the
    // goal comes in reach; a rest is no review of the purse (user 11-02).
    money: link(['money'], FIELD | VISIT),
    goal: link(['money'], 0),
    observation: link(OBSERVED, WORK | VISIT),
    market: link(BOUGHT, 0),
    // The held plan's own proof (EconomyContext.heldBuildVerdict).
    crafter_mp: link(['sources'], FIELD | VISIT),
    bands: link(STOCK, FIELD | VISIT),
    own_loss: link(BOUGHT, WORK | VISIT),
    quantity: link(BOUGHT, HUNT | FIELD | VISIT),
    liquidation: link(BOUGHT, HUNT | FIELD | VISIT),
    threat: link(OBSERVED, 0),
    // The leaf's own check (EconomyContext.LEAF_CHECKS). Who sells what is read at
    // the market: a bot in the field learns of a gone offer as it arrives. A bot short
    // of a price away from the shop earns on: the shop reads its purse.
    excluded: link(['occupation', 'sources'], 0),
    material_done: link(['sources'], 0),
    offer: link(BOUGHT, 0),
    offer_gone: link(BOUGHT, FIELD),
    filled: link(BOUGHT, 0),
    short: link(BOUGHT, FIELD | STAND),
    sale: link(STOCK, 0),
    craft: link(STOCK, 0),
    target: link(['relations'], 0),
    improvement: link(['sources'], 0),
    unsupported: link(['sources'], 0),
    // The doors to a build. candidates: a build weighs every gear candidate. request:
    // main's ask makes the bot decide. look: another's question does.
    candidates: link([], FIELD),
    request: link([], FIELD),
    look: link([], GATED)
});
// Who asks for a bot's plan, and does the answer become its plan. Only a bot's own
// moment decides (no link). Main's request decides where the bot hears it; elsewhere
// its next step decides and answers. Another's question is a look: elsewhere the plan
// it holds answers. A reader with no row looks.
const door = (heard, keeps) => Object.freeze({ link: heard, keeps });
const READER = door('look', true);
const DOORS = Object.freeze({
    step: door(null, true), member: door(null, true), economy_near: door(null, true),
    // A deal is a look with its goods counted: the plan answers while their count stands.
    meeting_prepare: door('look', false),
    economy_refresh: door('request', false),
    workerPartyGoal: door('look', false), item_need: door('look', false)
});
const rowOf = caller => DOORS[caller] || READER;

const hears = (name, where) => !(LINKS[name].waits & where);
const sections = name => LINKS[name].sections;
// What a door gets when the plan does not stand: 'decide', 'request' or 'look'.
function answer(caller, state) {
    const { link: name } = rowOf(caller);
    return !name || hears(name, place(state)) ? 'decide' : name;
}
const keeps = caller => rowOf(caller).keeps;
// The link a better spot comes by: a hunter's own, or a job that is no hunt, which ends first.
const incomeLink = leaf => !leaf || leaf.activity === 'hunting' ? 'income_moved' : 'income_later';
// Why a review opened, in the reviewer's words: a goal that failed, or that main moved.
function goalMoment(why) {
    if (/^(events:)?check:/.test(why)) return 'goal_failed';
    return why === 'goal' ? 'goal_moved' : null;
}
// Decision 11-02: a bot at work or at rest weighs only the gear it follows; every
// candidate waits for a real review. why: what refused the held plan; none: no plan
// stood, as at a first build.
const quiet = (state, why) => !!why && !hears('candidates', place(state)) && !goalMoment(why);
// The sections of the links heard here, each once.
function heard(names, where) {
    const out = new Set();
    for (const name of names) if (hears(name, where)) for (const section of LINKS[name].sections) out.add(section);
    return [...out];
}
// The same for a real raise: what each link woke and where, for the health line.
const raisedCounts = {};
function raise(names, where) {
    for (const name of names) if (hears(name, where)) {
        const key = `${name}@${NAMES.get(where)}`;
        raisedCounts[key] = (raisedCounts[key] || 0) + 1;
    }
    return heard(names, where);
}
// One reason with no sections of its own: is it heard here, counted as a raise.
function woke(name, where) {
    raise([name], where);
    return hears(name, where);
}

module.exports = { FIELD_ACTIVITIES, partyIdOf, configure, on: () => gate, place, gated, field, reactive, onVisit, agendaHears, readsFacts, hears, heard, raise, woke, raisedCounts: () => raisedCounts, sections,
    answer, keeps, incomeLink, goalMoment, quiet,
    placeName: where => NAMES.get(where), LINKS };
