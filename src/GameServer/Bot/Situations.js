'use strict';

// The situations a bot hears and where it hears them: one catalogue for both threads
// (main's raises, the worker's steps). How a bot reacts (design rules, Recompute; user 11-02). A bot holds its plan. A
// change only stands against the decision's baseline, the mark; where the bot stands
// decides whether it hears the change now. One question, one table: hears(link, place).
// The step's facts, the soft point, the held plan's verdict and the doors to a build
// all ask it; none keeps a rule of its own. A new rule is a row here.

const FIELD_ACTIVITIES = new Set(['hunting', 'resting', 'traveling']);

// Places, as bits of a link's waits. OPEN hears everything: a body near a player, a
// far bot the step it arrives in town. A far bot: WORK on a hunt, the road or in a
// party's fight, REST, VISIT a town visit past its first look, STAND anywhere else (a
// stall, a craft, a meeting).
const OPEN = 0, WORK = 1, REST = 2, VISIT = 4, STAND = 8;
const FIELD = WORK | REST, GATED = FIELD | VISIT | STAND;
const NAMES = new Map([[OPEN, 'open'], [WORK, 'work'], [REST, 'rest'], [VISIT, 'visit'], [STAND, 'stand']]);

// before: the state a step left, read for the one moment that is a change of place:
// arriving in town, where what waited in the field is heard, once.
function place(state, before = null) {
    if (state.phase !== 'cold') return OPEN;
    if (state.stats?.tradeMeeting) return STAND;
    if (state.activity === 'hunting' || state.activity === 'traveling' || state.activity === 'grouped') return WORK;
    if (state.activity === 'resting') return REST;
    if (state.activity === 'shopping') return before && FIELD_ACTIVITIES.has(before.activity) ? OPEN : VISIT;
    return STAND;
}
// A place under the rule (far, not arriving), and one in the field.
const gated = where => !!(where & GATED);
const field = where => !!(where & FIELD);
const reactive = state => gated(place(state));
// On a visit past its look a bot works down what the look decided: what ended a step of
// the agenda moves the plan to the next.
const onVisit = state => place(state) === VISIT;
const agendaHears = (state, why) => onVisit(state) && why.startsWith('check:');
// Which step reads its facts: a hunt's round, a far party's round, and the step that
// arrives in town: its one look.
function readsFacts(before, after) {
    return before.activity === 'hunting'
        || gated(place(before)) && (before.activity === 'grouped' || !place(after, before));
}

const link = (sections, waits) => Object.freeze({ sections: Object.freeze(sections), waits });
const KIT = ['build', 'benefits', 'sources'], STOCK = ['supply', 'sources'];
const BOUGHT = ['sources', 'money'], OBSERVED = ['occupation', 'benefits', 'sources'];

// Every situation a bot can hear: the sections of the build it touches, the places
// it waits at (both temporary: the build runs on its sections until it moves to
// woken decisions). What has no place in waits is heard at once everywhere.
const SITUATIONS = Object.freeze({
    // Its own state (detect). A level moved, or the rest of the kit (worn gear,
    // hennas, skills, class, the craft): read apart, a level up wins a step that moved both.
    level_up: link(KIT, WORK | VISIT),
    gear_changed: link(KIT, WORK | VISIT),
    recipe_learned: link(KIT, WORK | VISIT),
    died: link(['combat'], 0),
    // A hot body's respawn in town (BotAI): its town arrival follows as its own.
    revived: link(['combat'], 0),
    relations: link(['relations'], WORK | VISIT),
    party_joined: link(['relations'], 0),
    party_left: link(['relations'], 0),
    // A search found a better spot: the bot finishes where it stands, and a job that
    // is no hunt (income_later) before it hears of it.
    income_moved: link(['occupation'], WORK | VISIT),
    income_later: link(['occupation'], GATED),
    // A spot too full to enter (the room at arrival), and what main refused at the
    // act or a body that failed its step five times: the plan cannot stand.
    spot_crowded: link(['occupation', 'sources'], 0),
    goal_failed: link(['sources'], 0),
    // A spot whose spawns admit none of the bot's fights alone (a kit or level it
    // lost, a stand-in ground): the bot stands with nothing to hunt, its plan cannot
    // stand. The occupation rebuild searches its spot afresh and drops the kept route.
    spot_empty: link(['occupation', 'sources'], 0),
    // A body's arrival in town.
    arrived_town: link(['supply', 'money'], 0),
    // Main moved the bot's goal; its native plan failed or moved; the step's own
    // review of a craft or clan market.
    goal_moved: link([], 0),
    native: link([], 0),
    craft_bid: link([], 0),
    clan_market: link([], 0),
    funding: link(['funding'], WORK | VISIT),
    // A move the bot did not order (a flight, a pull, a push out, a party's call).
    moved_by_world: link(['occupation'], 0),
    // Deaths at its spot, or the death recovery's level penalty raised (a death, the
    // spot's pressure): the ground the bot may fight on moved.
    spot_dangerous: link(['combat', 'occupation'], 0),
    // The recovery's penalty lifted by clean wins.
    recovered: link(['combat', 'occupation'], 0),
    supply: link(['supply'], FIELD | VISIT),
    bag: link(STOCK, FIELD | VISIT),
    stores: link(STOCK, WORK | VISIT),
    // Its own warehouse: what it put in and took is its doing, heard as it arrives in town.
    warehouse: link(STOCK, GATED),
    // A condition, not a change: a need that opened. The planned shot ran out; the
    // survival potions ran out or fell under what the survival drink keeps; the
    // trip's scroll ran out; the bag full or the load a level up.
    shots_out: link(['supply'], 0),
    'stock_low:potions': link(['supply'], 0),
    stock_low: link(['supply'], 0),
    bag_full: link(STOCK, 0),
    // Its own doing is no event (own outputs are not inputs): its trips and where
    // they end, its craft preparation.
    own_move: link(['occupation'], GATED),
    own_preparation: link(['sources', 'benefits', 'money'], GATED),
    // The soft point (DecisionSections.softEvents). Money is read in town and when the
    // goal comes in reach; a rest is no review of the purse (user 11-02).
    money: link(['money'], FIELD | VISIT),
    goal: link(['money'], 0),
    // Its own samples moved: also the observation bit, the earning spot search's
    // event (DecisionSections SECTIONS); a gear-threat flip raises no such bit.
    observation: link([...OBSERVED, 'observation'], WORK | VISIT),
    market: link(BOUGHT, 0),
    // The held plan's own proof (EconomyContext.heldBuildVerdict).
    crafter_mp: link(['sources'], FIELD | VISIT),
    bands: link(STOCK, FIELD | VISIT),
    own_loss: link(BOUGHT, WORK | VISIT),
    quantity: link(BOUGHT, FIELD | VISIT),
    liquidation: link(BOUGHT, FIELD | VISIT),
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

const hears = (name, where) => !(SITUATIONS[name].waits & where);
const sections = name => SITUATIONS[name].sections;
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
    for (const name of names) if (hears(name, where)) for (const section of SITUATIONS[name].sections) out.add(section);
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

// The fact readers (DecisionSections: the views and facts its builds keep as their
// baseline). lazy: cycle DecisionSections reads this catalogue at its top.
let Readers = null;
const readers = () => Readers ||= require('./Economy/DecisionSections');
// The situations of a bot's own state between the facts a decision kept and the
// facts now, in fact order: previousFact(name) reads the kept one, current the
// facts now (DecisionSections.factsOf). funding: the money fact's hard part moved
// (DecisionSections.moneyChanged). planned: the occupation the held decision ordered
// (DecisionSections.occupationPlanned), its own output, no event. Both threads: the
// step's diff (detect) and the held build's verdict (EconomyContext).
function factNames(previousFact, current, funding = false, planned = false) {
    const names = [];
    const add = name => { if (!names.includes(name)) names.push(name); };
    if (!previousFact('dead') && current.dead) add('died');
    if (previousFact('build') !== current.build) {
        // A baseline kept before the level was its own fact reads as gear.
        const level = previousFact('level');
        add(level !== undefined && level !== current.level ? 'level_up' : 'gear_changed');
    }
    if (previousFact('recipes') !== current.recipes) add('recipe_learned');
    if (previousFact('relations') !== current.relations) add('relations');
    // A new party or a new role in it reads as joining it.
    if (previousFact('party') !== current.party) add(current.party === readers().NO_PARTY ? 'party_left' : 'party_joined');
    if (funding) add('funding');
    // Resting reads as hunting at its spot: a rest where the bot hunted is
    // none, a rest at another spot is an occupation event.
    if (!planned && previousFact('occupation') !== current.occupation) add('moved_by_world');
    if (current.riskDeaths > previousFact('riskDeaths')) add('spot_dangerous');
    // The recovery's level penalty, up (a death, the spot's pressure) or down
    // (its clean wins, SpotRiskPolicy.recordRecovery). A baseline kept before
    // the fact was recorded has none to compare.
    const recovery = previousFact('recovery');
    if (recovery !== undefined && recovery !== current.recovery) add(current.recovery < recovery ? 'recovered' : 'spot_dangerous');
    // Physical exhaustion is never hidden by economic uncertainty.
    if (previousFact('supply') !== current.supply) add('supply');
    if (previousFact('bag') !== current.bag) add('bag');
    if (previousFact('stores') !== current.stores) add('stores');
    if (previousFact('warehouse') !== current.warehouse) add('warehouse');
    return names;
}
// The step's fact diff, one function for both threads (a far step's projection,
// BotLifeState.prepareResolve; a near bot's post): the situations of its own state
// against the decision's baseline (stats.wishSections), a fact the baseline lacks
// against the state before. round: escrow (the buy-order escrow the money fact
// reads), leaf (the step's held leaf: the move it ordered raises nothing; none, as
// on main: every move is an event), unhuntable (the round found its spot empty of
// prey, BackgroundResolver, once a stay: a fact of the round, not of the states).
function detect(before, after, { escrow = 0, leaf = null, unhuntable = false } = {}) {
    const Sections = readers();
    // Main may replay a validated worker packet that already describes this
    // same round. Compare its actual baselines, not sequence alone; a packet
    // preceding a new death/level/resource event still raises that event.
    const represented = Number(after.stats?.decisionSeq || 0) > Number(before.stats?.decisionSeq || 0)
        ? after.stats?.wishSections : null;
    const previous = represented || before.stats?.wishSections || {};
    let original;
    // A fact the baseline kept as null (no recipe book read) is kept: only a
    // fact the baseline lacks reads the state before.
    const previousFact = key => Object.hasOwn(previous, key) ? previous[key] : (original ||= Sections.semanticFacts(before))[key];
    // No memory and no recipe book here: the relations and the recipes the
    // decision kept stand until the next verdict, which reads both; the party with them.
    const view = Sections.stateView(after);
    const current = { ...Sections.factsOf(view), relations: previousFact('relations'), recipes: previousFact('recipes'), party: previousFact('party') };
    const funding = Sections.moneyChanged(after, represented || before.stats?.wishSections, escrow, false)
        || !previous.funding && Sections.fundingMark(before) !== Sections.fundingMark(after);
    const names = factNames(previousFact, current, funding, Sections.occupationPlanned(after, leaf));
    if (unhuntable) names.push('spot_empty');
    return gated(place(after, before)) ? names.concat(needsOpened(before, after, names, view)) : names;
}
// A need that opened in this step, one raise: one that stays open raises nothing more.
// now: the step's view of after (stateView), its supply ids read once.
function needsOpened(before, after, names, now) {
    const count = (state, id) => Math.max(0, Number(state.inventory?.[id]?.amount) || 0);
    const ranOut = id => count(before, id) > 0 && !count(after, id);
    const [scrollId, shotId, potionId] = now.supply.map(row => row[0]);
    const floor = readers().potionSurvivalTarget(after);
    const opened = [];
    if (ranOut(shotId)) opened.push('shots_out');
    if (ranOut(potionId) || count(before, potionId) >= floor && count(after, potionId) < floor) opened.push('stock_low:potions');
    if (ranOut(scrollId)) opened.push('stock_low');
    if (names.includes('bag')) {
        const was = readers().stateView(before);
        if (now.bagFull > was.bagFull || now.weight > was.weight) opened.push('bag_full');
    }
    return opened;
}
// The sections a list of situations touches wherever the bot stands.
const sectionsOf = names => heard(names, OPEN);

module.exports = { FIELD_ACTIVITIES, place, gated, field, reactive, onVisit, agendaHears, readsFacts, hears, heard, raise, woke, raisedCounts: () => raisedCounts, sections,
    answer, keeps, incomeLink, goalMoment, quiet,
    placeName: where => NAMES.get(where), SITUATIONS, detect, factNames, sectionsOf };
