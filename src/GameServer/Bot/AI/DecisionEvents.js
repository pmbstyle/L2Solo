'use strict';
const { isMainThread } = require('node:worker_threads');
const Sections = require('../Economy/DecisionSections');
const TownVisitInterval = require('../Economy/TownVisitInterval');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const WishProviders = invoke('GameServer/Bot/Economy/WishProviders');
// The reasons code raises by name (raiseDecision). A near bot's moved fact
// raises on the background thread, which compares its posted row with the
// one before (ColdSimulationWorker's state writer).
const reasons = new Set(['town', 'revived', 'money', 'build', 'sources', 'supply', 'occupation', 'relations', 'combat', 'benefits']);
// Every reason marks a section, so the next build reconsiders the held focus and activity.
const bit = Sections.sectionBit;
// A section name (raiseSections) marks its own bit.
const sectionBits = { ...Object.fromEntries(Sections.SECTIONS.map(name => [name, bit(name)])), funding: bit('money') };
// A named reason marks the sections of its fact in the one table
// (DecisionSections.FACT_SECTIONS); town is an arrival, no fact.
const factBits = fact => Sections.sectionMask(Sections.FACT_SECTIONS[fact]);
const reasonBits = { ...sectionBits, money: factBits('funding'), build: factBits('build'),
    revived: factBits('dead'), relations: factBits('relations'), town: bit('supply') | bit('money') };
function statsFor(session) {
    return session.coldLifeState ? (session.coldLifeState.stats ||= {}) : (session.decisionStats ||= {});
}
function decisionStatsFor(session) {
    return { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...session?.coldLifeState?.stats };
}
// One event on a bot's stats: a new sequence invalidates the held decision,
// the bits name the sections it touched. The held activity stays and
// WishNetwork rerolls it only when gone, outscored or off a moved focus. An
// execution that proved the held step impossible drops it: the economy inputs
// do not record that failure, so the step would be chosen again.
function applyRaise(stats, bits, impossible = false) {
    stats.decisionSeq = Math.max(0, Math.trunc(Number(stats.decisionSeq) || 0)) + 1;
    stats.wishDirty = (Number(stats.wishDirty) || 0) | bits;
    if (impossible) stats.activityLeaf = 0;
    return stats;
}
// A near bot (a body on main) takes its decisions on the background thread:
// the raise waits on the session (nearRaise, ORed while pending) and rides its
// next post (BotLifeState.notifyNearFacts); the decision that consumed it
// clears it (receive). impossibleSeq is the raise that proved the held step
// impossible: the worker drops the step only for that raise, never again for
// a later raise of the same pending bag. Any other bot raises on its stats.
function raiseDecision(session, reason, { impossible = false } = {}) {
    if (!reasons.has(reason)) throw new TypeError('unknown_decision_event');
    const stats = statsFor(session);
    // Visit ends share the arrival clock until a single native arrival event
    // exists. A fact of the body, kept on its stats: never part of a raise.
    if (reason === 'town') stats.visitEvery = TownVisitInterval.arrived(stats);
    const bits = reasonBits[reason] || 0;
    // lazy: cycle BotLifeState requires this module at its top.
    const Life = isMainThread && session.actor ? invoke('GameServer/Bot/Population/BotLifeState') : null;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase === 'hot') {
        const raise = session.nearRaise ||= { seq: 0, bits: 0, impossible: false };
        raise.seq = session.raiseSeq = Number(session.raiseSeq || 0) + 1;
        raise.bits |= bits;
        if (impossible) { raise.impossible = true; raise.impossibleSeq = raise.seq; }
        Life.notifyNearFacts(session, reason);
        return;
    }
    applyRaise(stats, bits, impossible);
}
// A real command rejection belongs to the accepted decision that attempted
// it. The caller persists this returned state through its existing writer;
// late failures never invalidate a newer decision or raise an event twice.
function rejectedState(current, accepted = current) {
    const source = accepted?.stats;
    if (!current?.stats || !source || Number(current.characterId) !== Number(accepted.characterId) || current.stats.wishDirty
        || Sections.decisionRefusal(current, Number(source.decisionSeq || 0), Number(source.activityLeaf || 0),
            source.wishFocus?.[0] ?? null)) return current;
    if (source.wishSections) {
        const baseline = Sections.baselineIdentity(source.wishSections);
        if (!baseline || baseline !== Sections.baselineIdentity(current.stats.wishSections)) return current;
    }
    const next = { ...current, stats: { ...current.stats } };
    applyRaise(next.stats, reasonBits.sources, true);
    return next;
}
// A near bot's posted raise bag on the background thread's mind (stats),
// against the last raise it applied in this life (applied): taken once per
// raise seq. The bag is cumulative, so its impossible mark drops the held
// step only while the raise that set it (impossibleSeq) is not yet applied.
// Returns the raise seq now applied.
function takePostedRaise(stats, raise, applied) {
    if (raise && Number(raise.seq) > applied) applyRaise(stats, Number(raise.bits) || 0,
        raise.impossible === true && Number(raise.impossibleSeq || 0) > applied);
    return Math.max(applied, Number(raise?.seq || 0));
}
// A near bot's pending raise on the cold row its body cools to
// (BotLifeState.mergeSessionIntoLifeState): no decision will answer it, so the
// row's stats take it, the step dropped only while its impossible raise is
// unanswered. The session keeps it: the body ends with the cooling, and a
// cooling that rolls back leaves the raise waiting for its decision.
function applyPendingRaise(session, stats) {
    const raise = session?.nearRaise;
    if (raise) applyRaise(stats, Number(raise.bits) || 0, raise.impossible === true);
}
// A hot body's rejection: one impossible raise while it waits for its
// decision, a second rejection in that window adds nothing.
function rejectSession(session, accepted) {
    const characterId = Number(session?.actor?.fetchId?.());
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || session.nearRaise?.impossible) return false;
    const current = { characterId, stats: decisionStatsFor(session) };
    if (rejectedState(current, accepted) === current) return false;
    raiseDecision(session, 'sources', { impossible: true });
    return true;
}
// What a near decision carries beside its card (payload.near), taken in the
// background thread from the same build: the mind keys (statsPacket), whether
// the money queue funds a shot restock the stock needs (ShotStock
// needsActorRestock) and the personal craft plan of the chosen leaf
// (ShoppingState). The view over the card cannot answer these: it has no
// queue and no plans.
function nearFields(economy, state) {
    const stock = economy.stock('shots');
    return { statsPacket: economy.statsPacket,
        shotRestock: !!stock.needed && economy.purchaseBudget(stock.itemId) > 0,
        // A near body may also order consumables at a workshop (allowStock).
        personalCraft: WishProviders.personalCraftPlan(state, economy, { allowStock: true }) || null,
        // The auto-shot verdict (ShotStock.enableAutoShot's inputs): the
        // build's shot stock, itself ShotStock.usePolicy over its tables.
        shots: { itemId: stock.itemId, ownedUsePerHour: stock.ownedUsePerHour,
            beginnerUsePerHour: stock.beginnerUsePerHour, paidUsePerHour: stock.paidUsePerHour } };
}
// The near decision the background thread took for this body
// (economy_decided, the coordinator's admission): its mind keys join the
// body's stats, the view over its card is what the body's readers take
// (held), and the raise it consumed no longer waits; a later raise still
// pending keeps its bits, but an impossible raise this decision answered no
// longer marks it. The auto-shot verdict is the worker's, from the same
// build's shot stock (near.shots).
function receive(session, card, near) {
    const actor = session.actor;
    Object.assign(statsFor(session), near.statsPacket);
    session.heldEconomy = Object.assign(Decisions.nearView(Economy.stateForActor(actor, session), card), near);
    session.heldNearSeq = Number(near.nearSeq || 0);
    session.activationEconomyDecision = null;
    const raise = session.nearRaise, answered = Number(near.raiseSeq || 0);
    if (raise && answered >= raise.seq) session.nearRaise = null;
    else if (raise?.impossible && answered >= Number(raise.impossibleSeq || 0)) { raise.impossible = false; raise.impossibleSeq = 0; }
    if (near.shots) ShotStock.enableAutoShot(actor, { stock: near.shots });
    return session.heldEconomy;
}
// The decision a near body holds: the last one received, else (before the
// first) its cold handoff's accepted card. Without one it waits for the
// worker's first answer; the body's target search cannot invent a new job.
function held(session) {
    if (session?.heldEconomy) return session.heldEconomy;
    if (!session?.actor) return null;
    const view = Decisions.nearView(Economy.stateForActor(session.actor, session), session.activationEconomyDecision || null);
    session.activationEconomyDecision = null;
    view.statsPacket = statsFor(session);
    return session.heldEconomy = view;
}
// A near bot's wallet against its decision's money baseline (the far soft
// point's money reading, DecisionSections.moneyChanged): a crossing raises
// money once; nothing while that raise waits or before a baseline exists.
function checkWallet(session, actor) {
    if (Number(session.nearRaise?.bits) & reasonBits.money) return false;
    const stats = statsFor(session);
    if (!stats.wishSections) return false;
    const wallet = actor.backpack?.fetchTotalAdena?.() ?? actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0;
    // lazy: worker the native market owner is main-thread only; this module also handles cold projections.
    const escrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(actor.fetchId?.());
    if (!Sections.moneyChanged({ adena: wallet, stats }, stats.wishSections, escrow, true)) return false;
    raiseDecision(session, 'money');
    return true;
}
// One raise per step: the sections a step's checks raised (the round's hard
// events, DecisionSections.events, and on the background thread the soft
// point, softEvents) in one decisionSeq bump, their bits ORed into the bits
// already raised. Nothing when no list names a section.
function raiseSections(before, after, ...lists) {
    let bits = 0;
    for (const list of lists) for (const section of list) bits |= sectionBits[section] || 0;
    if (!bits) return 0;
    const stats = after.stats ||= {};
    stats.decisionSeq = Math.max(Number(before.stats?.decisionSeq) || 0, Number(stats.decisionSeq) || 0) + 1;
    stats.wishDirty = (Number(stats.wishDirty) || 0) | bits;
    return bits;
}
module.exports = { statsFor, decisionStatsFor, applyRaise, raiseDecision, takePostedRaise, applyPendingRaise, nearFields, receive, held, checkWallet, rejectedState, rejectSession, raiseSections };
