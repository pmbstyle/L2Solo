'use strict';

// What a review decided, in order (design rules, Agenda; user 11-03): the step the bot
// takes and the steps after it. A step that ends moves the held plan to the next with
// no weighing; proof, money queue, bids and focus move as one. Only an agenda that has
// no step left, or a native plan that failed, is a build.
const Reaction = require('./Reaction');
const Funding = require('./PurchaseFunding');
const Network = require('./WishNetwork');

const positive = value => Math.max(0, Number(value) || 0);
const NO_REQUIREMENTS = Object.freeze([]);
// What a kept step's check, card and act read: nothing else is held per bot.
const STEP_FIELDS = ['key', 'nodeKey', 'rootKey', 'activity', 'kind', 'sourceType', 'quoted', 'executable', 'town', 'itemId',
    'amount', 'wanted', 'unitPrice', 'availableUnits', 'price', 'valueHours', 'object', 'npcId', 'staged'];
function stepRow(leaf) {
    const row = { requirements: NO_REQUIREMENTS };
    for (const field of STEP_FIELDS) if (leaf[field] !== undefined) row[field] = leaf[field];
    return row;
}
// What each move did, for the health line: the steps moved to, the next sellers of an
// item, the steps dropped and why, the agendas that ended and why.
const counts = {};
const count = name => { (counts[name] ||= [0])[0]++; };

// A wish that took what it needed leaves the queue; an input leaves its root's price.
function paid(queue, done) {
    return queue.map(wish => wish.key === done.rootKey ? { ...wish, price: positive(wish.price) - positive(done.price) } : wish)
        .filter(wish => wish.key !== done.rootKey || wish.price >= 1);
}
// The goods a step brought in leave the bids a plan projected; a retained
// project's bid reads today's bag and has them counted already.
function bidsAfter(rows, filled) {
    if (!filled?.length) return rows;
    return rows.map(row => {
        const taken = !row.retainedProject && filled.find(entry => entry[0] === Number(row.itemId));
        return taken ? { ...row, amount: row.amount - taken[1] } : row;
    }).filter(row => row.amount > 0);
}
const filledAfter = (filled = [], done, units) => {
    const taken = filled.find(entry => entry[0] === Number(done.itemId));
    return taken ? filled.map(entry => entry === taken ? [entry[0], entry[1] + units] : entry)
        : [...filled, [Number(done.itemId), units]];
};
// A filled focus hands on to the next of the queue with no weighing: a goal first, as
// the build's focus, stock only when no goal is left.
function focusAfter(network, queue, playedHours) {
    const { focus } = network;
    if (!focus || queue.some(wish => wish.key === focus[0])) return focus;
    const doable = queue.filter(Network.fundable);
    const next = doable.find(wish => !wish.key.startsWith('stock:')) || doable[0];
    return next ? [next.key, playedHours, positive(next.price)] : null;
}
// The next seller of what a seller could not fill or lost, anywhere the bot can reach.
// What it wanted stands, less the step's progress, its value per unit too: a dearer
// line stops there. The next seller counts from the bag as it is.
function nextSeller(done, progress, network, ask) {
    const rest = (positive(done.wanted) || positive(done.amount)) - progress;
    if (!(rest > 0)) return null;
    const offer = ask.bestOffer(done);
    if (!offer) return null;
    const hoursPerUnit = positive(done.valueHours) / positive(done.amount);
    if (hoursPerUnit > 0 && offer.unitPrice * positive(network.moneyPrice) > hoursPerUnit) return null;
    const amount = Math.min(rest, offer.availableUnits);
    return { ...done, amount, wanted: rest, town: offer.town, unitPrice: offer.unitPrice, availableUnits: offer.availableUnits, sourceType: offer.sourceType,
        heldAtDecision: ask.held(done.itemId), price: offer.unitPrice * amount + offer.tripFees,
        ...(hoursPerUnit > 0 ? { valueHours: hoursPerUnit * amount } : {}) };
}
function moved(held, state, leaf, { queue, filled, rest }, ask) {
    const { plan } = held, { network, statsPacket } = plan;
    const focus = focusAfter(network, queue, positive(state.stats?.playedHours));
    const decisionSeq = Number(statsPacket.decisionSeq || 0) + 1, activityLeaf = Network.leafId(leaf);
    const eventProof = Object.freeze({ ...plan.eventProof, activity: ask.identity(leaf),
        decision: Object.freeze([decisionSeq, activityLeaf, focus?.[0] ?? null]) });
    return { ...held, heldUnits: leaf.heldAtDecision, plan: { ...plan, eventProof,
        statsPacket: { ...statsPacket, decisionSeq, activityLeaf, wishFocus: focus },
        network: { ...network, queue, focus, activity: leaf, activityLeaf, decisionSeq, agenda: rest, filled } } };
}
// One entry: a held plan's step ended. why: the verdict's reason. A filled step leaves
// the queue, a failed one only the plan: its root keeps its place and the review that
// ends the agenda reads it, the stages that stood on it wait with it. Both ask for the
// next seller: here at once, elsewhere after this town's steps. ask: the leaf's own
// check, the best offer, a step's progress, the bag's count of an item, the identity.
// Answers the held entry on its next step, or null: the agenda ended, a build decides.
function advance(held, state, why, deps, ask) {
    if (!Reaction.agendaHears(state, why) || deps.fullReview || !held?.plan.network.activity) return null;
    const { network } = held.plan, done = network.activity, agenda = network.agenda;
    if (!agenda) return null;
    // The step's progress, read once (its own check's count): what it brought in leaves the
    // bids and what the next seller is asked for, filled or not.
    const filled = why === 'check:filled', later = network.later || [], progress = ask.progress(done);
    const queue = filled ? paid(network.queue, done) : network.queue;
    const bought = progress > 0 ? filledAfter(network.filled, done, progress) : network.filled;
    const seller = nextSeller(done, progress, network, ask);
    const kept = filled ? agenda : agenda.filter(row => !(row.staged && row.rootKey === done.rootKey));
    const here = kept.filter(row => row.town === done.town), away = kept.filter(row => row.town !== done.town);
    const steps = !seller ? kept : seller.town === done.town ? [seller, ...kept] : [...here, seller, ...away];
    for (let at = 0; at < steps.length; at++) {
        const inQueue = queue.find(wish => wish.key === steps[at].rootKey);
        const wish = inQueue || later.find(row => row.key === steps[at].rootKey);
        const leaf = Funding.stampRatio({ ...steps[at] }, wish);
        const refusal = ask.refused(leaf), cause = refusal ? refusal.reason : ask.visitPays(leaf, steps.slice(at + 1)) ? '' : 'visit';
        if (cause) { count(`agenda_dropped|${cause}`); ask.dropped?.(leaf, cause); continue; }
        count(steps[at] === seller ? 'agenda_seller' : 'agenda_moved');
        return moved(held, state, leaf, { queue: inQueue || !wish ? queue : [...queue, wish], filled: bought,
            rest: steps.slice(at + 1) }, ask);
    }
    count(`agenda_end|${filled ? 'empty' : why}`);
    return null;
}
module.exports = { advance, stepRow, bidsAfter, NO_REQUIREMENTS, counts: () => counts };
