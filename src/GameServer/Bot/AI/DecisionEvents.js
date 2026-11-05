'use strict';
const { isMainThread } = require('node:worker_threads');
const FailureLog = require('../../../FailureLog');
const Sections = require('../Economy/DecisionSections');
const Situations = require('../Situations');
const TownVisitInterval = require('../Economy/TownVisitInterval');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Decisions = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const WishProviders = invoke('GameServer/Bot/Economy/WishProviders');
// The situations a body raises by name (raiseDecision): its arrival in town, its
// respawn, a step proved impossible, leaving a party, a spot empty of prey, its
// wallet. A near bot's moved fact raises on the background thread, which compares
// its posted row with the one before (ColdSimulationWorker's state writer).
const reasons = new Set(['arrived_town', 'revived', 'goal_failed', 'party_left', 'spot_empty', 'money']);
// A near bot's pending raises (session.nearRaise.names): at most NEAR_NAMES
// distinct situations wait for the worker's answer (limits.md); one past them is
// counted (nearOverflow) and dropped.
const NEAR_NAMES = 16;
let nearOverflow = 0;
function statsFor(session) {
    return session.coldLifeState ? (session.coldLifeState.stats ||= {}) : (session.decisionStats ||= {});
}
function decisionStatsFor(session) {
    return { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...session?.coldLifeState?.stats };
}
// A far bot's own preparation stands in its state for its next review (its own
// output: heard only where its row says).
function applyOwnRaise(state) {
    return Situations.raise({ ...(state.stats || {}) }, 'own_preparation', null, Situations.place(state));
}
// A near bot (a body on main) takes its decisions on the background thread:
// the raise waits on the session (nearRaise, ORed while pending) and rides its
// next post (BotLifeState.notifyNearFacts); the decision that consumed it
// clears it (receive). The bag: { seq, names: [[situation, payload|null], ...],
// impossible, impossibleSeq }; impossibleSeq is the raise that proved the held
// step impossible: the worker drops the step only for that raise, never again
// for a later raise of the same pending bag. A far bot's row takes it through
// the one SQL writer of its bits (BotLifeState.raiseOnRow), never through a
// whole-row save; a session with no row (a fixture, the worker) on its stats.
function raiseDecision(session, reason, { impossible = false } = {}) {
    if (!reasons.has(reason)) throw new TypeError('unknown_decision_event');
    const stats = statsFor(session);
    // Visit ends share the arrival clock until a single native arrival event
    // exists. A fact of the body, kept on its stats: never part of a raise.
    if (reason === 'arrived_town') stats.visitEvery = TownVisitInterval.arrived(stats);
    // lazy: cycle BotLifeState requires this module at its top.
    const Life = isMainThread && session.actor ? invoke('GameServer/Bot/Population/BotLifeState') : null;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase === 'hot') {
        const raise = session.nearRaise ||= { seq: 0, names: [], impossible: false };
        raise.seq = session.raiseSeq = Number(session.raiseSeq || 0) + 1;
        const waits = raise.names.some(([name]) => name === reason);
        if (!waits && raise.names.length < NEAR_NAMES) raise.names.push([reason, null]);
        else if (!waits) nearOverflow++;
        if (impossible) { raise.impossible = true; raise.impossibleSeq = raise.seq; raise.impossibleName = reason; }
        Life.notifyNearFacts(session, reason);
        return;
    }
    const payload = impossible ? { impossible } : null;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase === 'cold') {
        raiseFar(session.actor.fetchId(), [[reason, payload]], `situation_${reason}`);
        return;
    }
    Situations.raise(stats, reason, payload);
}
// A posted bag's raises on the background thread's mind (stats), heard as a
// body near a player hears (Situations OPEN); its impossible mark drops the held
// step (with the situation that set it, impossibleName) only while the raise that
// set it is unanswered.
function raiseBag(stats, raise, impossible) {
    for (const [name, payload] of Array.isArray(raise?.names) ? raise.names : []) Situations.raise(stats, name, payload);
    if (impossible) Situations.raise(stats, raise.impossibleName || 'goal_failed', { impossible: true });
}
// A real command rejection belongs to the accepted decision that attempted
// it: late failures never invalidate a newer decision or raise an event twice.
const rejections = {};
// A refusal with no state to mark: read on the health line.
const refused = why => { rejections[why] = (rejections[why] || 0) + 1; };
// Does the rejection still belong to the decision current holds (no raise
// waits, the same echo and baseline)? Counted by why when it does.
function rejects(current, accepted = current, why = 'other') {
    const source = accepted?.stats;
    if (!current?.stats || !source || Number(current.characterId) !== Number(accepted.characterId) || current.stats.wishDirty
        || Sections.decisionRefusal(current, Number(source.decisionSeq || 0), Number(source.activityLeaf || 0),
            source.wishFocus?.[0] ?? null)) return false;
    if (source.wishSections) {
        const baseline = Sections.baselineIdentity(source.wishSections);
        if (!baseline || baseline !== Sections.baselineIdentity(current.stats.wishSections)) return false;
    }
    rejections[why] = (rejections[why] || 0) + 1;
    return true;
}
// A raise on a far bot's row (BotLifeState.raiseOnRow). A row no longer far (its
// body went hot meanwhile) takes it where the bot is now: its body's bag. One that
// lands nowhere is counted (situations.raise_lost). Resolves the raised row's
// state, null when it did not land on a far row. Main only.
async function raiseFar(characterId, names, reason) {
    // lazy: cycle BotLifeState requires this module at its top.
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const raised = await Life.raiseOnRow(characterId, names, reason);
    if (raised) return raised;
    const session = Life.cachedState(characterId)?.phase === 'hot'
        ? invoke('GameServer/World/World').registeredActorById?.(Number(characterId))?.session : null;
    if (session?.actor) {
        for (const [name, payload] of names) raiseDecision(session, name, { impossible: payload?.impossible === true });
    } else FailureLog.note('situations.raise_lost', new Error(`${names.map(([name]) => name).join('+')} on ${characterId}: no far row, no body`));
    return null;
}
// The mind keys a row raise writes (BotLifeState.raiseOnRow).
const RAISED_KEYS = Object.freeze(['woken', 'waiting', 'wishDirty', 'situationSeq', 'activityLeaf']);
// A state the caller writes after its raise landed (raised: the raised row's
// state): built on the raised row's revision, carrying its raised mind.
const withRaise = (state, raised) => ({ ...state, simulation: raised.simulation,
    stats: { ...state.stats, ...Object.fromEntries(RAISED_KEYS.map(key => [key, raised.stats?.[key]])) } });
// A far bot's rejection: goal_failed with its held step dropped, raised on its
// row (raiseFar); the caller's own write carries only its own fields. null (at
// once) when the rejection is not the held decision's, else a promise of the
// raised row's state (null when it did not land on a far row).
function rejectOnRow(current, accepted, why) {
    if (!rejects(current, accepted, why)) return null;
    return raiseFar(current.characterId, [['goal_failed', { impossible: true }]], 'situation_rejected');
}
// A near bot's posted raise bag on the background thread's mind (stats),
// against the last raise it applied in this life (applied): taken once per
// raise seq. The bag is cumulative, so its impossible mark drops the held
// step only while the raise that set it (impossibleSeq) is not yet applied.
// Returns the raise seq now applied.
function takePostedRaise(stats, raise, applied) {
    if (raise && Number(raise.seq) > applied) raiseBag(stats, raise,
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
    if (raise) raiseBag(stats, raise, raise.impossible === true);
}
// A hot body's rejection: one impossible raise while it waits for its
// decision, a second rejection in that window adds nothing.
function rejectSession(session, accepted) {
    const characterId = Number(session?.actor?.fetchId?.());
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || session.nearRaise?.impossible) return false;
    if (!rejects({ characterId, stats: decisionStatsFor(session) }, accepted)) return false;
    raiseDecision(session, 'goal_failed', { impossible: true });
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
    if (session.nearRaise?.names?.some(([name]) => name === 'money')) return false;
    const stats = statsFor(session);
    if (!stats.wishSections) return false;
    const wallet = actor.backpack?.fetchTotalAdena?.() ?? actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0;
    // lazy: worker the native market owner is main-thread only; this module also handles cold projections.
    const escrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(actor.fetchId?.());
    if (!Sections.moneyChanged({ adena: wallet, stats }, stats.wishSections, escrow, true)) return false;
    raiseDecision(session, 'money');
    return true;
}
module.exports = { rejections: () => rejections, refused, statsFor, decisionStatsFor, applyOwnRaise, raiseDecision, takePostedRaise, applyPendingRaise, nearFields, receive, held, checkWallet, rejects, rejectOnRow, withRaise, rejectSession,
    NEAR_NAMES, nearOverflow: () => nearOverflow };
