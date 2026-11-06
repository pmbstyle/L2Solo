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
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
// The situations a body raises by name (raiseDecision): its arrival in town, its
// respawn, a step proved impossible, leaving a party, a spot empty of prey or
// unsafe ground for it, a spot it could not reach, a player's command naming a
// spot, its wallet; and what main's executors raise on a far row that went near
// meanwhile (raiseFar): a goal done, a visit's step failed, a full bag. Its own
// facts it detects on its post (detectNear).
const reasons = new Set(['arrived_town', 'revived', 'goal_failed', 'party_left', 'spot_empty', 'spot_dangerous',
    'spot_unreachable', 'player_command', 'money', 'goal_done:goal', 'goal_failed:visit', 'bag_full']);
// The situations whose payload is a fact (Situations.raisedFacts): a later one of the
// same name and payload moves to the bag's end, a later command replaces the earlier.
const FACTS = new Set(['spot_unreachable', 'spot_dangerous', 'player_command']);
// A near bot's pending raises (session.nearRaise.names): at most NEAR_NAMES
// distinct situations wait for the worker's answer (limits.md); one past them is
// counted (nearOverflow) and dropped.
const NEAR_NAMES = 16;
let nearOverflow = 0;
// A body's stats (its row's, else its own decision stats): read here, written only
// through replaceStats, never in place (the session's row object may be the one the
// state cache holds).
const NO_STATS = Object.freeze({});
function statsFor(session) {
    return session.coldLifeState ? session.coldLifeState.stats || NO_STATS : session.decisionStats || NO_STATS;
}
// The one writer of a body's stats: a new stats object on a new row object.
function replaceStats(session, stats) {
    if (session.coldLifeState) session.coldLifeState = { ...session.coldLifeState, stats };
    else session.decisionStats = stats;
    return stats;
}
// The facts a body's raise carries (Situations.applyFacts) on its copy of the stats.
function withFacts(session, name, payload) {
    const stats = { ...statsFor(session) };
    if (Situations.applyFacts(stats, name, payload)) replaceStats(session, stats);
}
function decisionStatsFor(session) {
    return { ...session?.heldEconomy?.statsPacket, ...session?.decisionStats, ...session?.coldLifeState?.stats };
}
// A far bot's own preparation stands in its state for its next review (its own
// output: heard only where its row says).
function applyOwnRaise(state) {
    return Situations.raise({ ...(state.stats || {}) }, 'own_preparation', null, Situations.place(state), state.characterId);
}
// A near bot (a body on main) takes its decisions on the background thread:
// the raise waits on the session (nearRaise, ORed while pending) and rides its
// next post (BotLifeState.notifyNearFacts); the decision that consumed it
// clears it (receive). The bag: { seq, names: [{ name, payload|null, seq }, ...]
// (each entry the raise seq it joined at: an answer applied the entries up to its
// seq, receive), impossible, impossibleSeq }; impossibleSeq is the raise that proved the held
// step impossible: the worker drops the step only for that raise, never again
// for a later raise of the same pending bag. A far bot's row takes it through
// the one SQL writer of its bits (BotLifeState.raiseOnRow), never through a
// whole-row save; a session with no row (a fixture, the worker) on its stats.
// payload: a fact the situation carries (Situations.raisedFacts: spot_unreachable's
// { spotId, reason }, player_command's { spotId, at }).
function raiseDecision(session, reason, { impossible = false, payload: fact = null } = {}) {
    if (!reasons.has(reason)) throw new TypeError('unknown_decision_event');
    // Visit ends share the arrival clock until a single native arrival event
    // exists. A fact of the body, kept on its stats: never part of a raise.
    if (reason === 'arrived_town') replaceStats(session, { ...statsFor(session), visitEvery: TownVisitInterval.arrived(statsFor(session)) });
    // lazy: cycle BotLifeState requires this module at its top.
    const Life = isMainThread && session.actor ? invoke('GameServer/Bot/Population/BotLifeState') : null;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase === 'hot') {
        const raise = nearBag(session, [{ name: reason, payload: fact }], true);
        if (impossible) { raise.impossible = true; raise.impossibleSeq = raise.seq; raise.impossibleName = reason; }
        // A body's arrival in town is its stop there too: what waited for the town wakes.
        if (reason === 'arrived_town') raise.stop = 'town';
        // A command a body that never posts cannot be answered: dropped, counted.
        if (reason === 'player_command' && !Life.nearPosts(session)) {
            FailureLog.note('near.command_lost', new Error(`player_command on ${session.actor.fetchId?.()}: the body posts nothing`));
            dropCommand(raise);
        }
        Life.notifyNearFacts(session, reason);
        return;
    }
    const payload = impossible ? { ...fact, impossible } : fact;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase === 'cold') {
        raiseFar(session.actor.fetchId(), [{ name: reason, payload }], `situation_${reason}`);
        return;
    }
    replaceStats(session, Situations.raise({ ...statsFor(session) }, reason, payload, Situations.OPEN, session.actor?.fetchId?.()));
}
// A body's pending bag with these situations joined: a new raise (a new seq)
// when one joins it, or always (force: a named raise or a stop, whose post is
// flushed at once: named). One that waits already adds nothing, but a fact's
// (FACTS) moves to the end with its payload, so the background thread writes it
// after what came before, as the body did (its own copy: Situations.applyFacts);
// past NEAR_NAMES it is counted and dropped.
// names: [{ name, payload }].
function nearBag(session, names, force = false) {
    const raise = session.nearRaise ||= { seq: 0, names: [], impossible: false };
    let joined = force, command = false;
    const added = [];
    for (const { name, payload = null } of names) {
        const fact = FACTS.has(name), key = fact && name !== 'player_command' ? String(payload?.spotId) : null;
        const at = raise.names.findIndex(held => held.name === name && (!fact || name === 'player_command'
            || String(held.payload?.spotId) === key));
        if (at >= 0 && !fact) continue;
        if (at >= 0) raise.names.splice(at, 1);
        else if (raise.names.length >= NEAR_NAMES) { nearOverflow++; continue; }
        const entry = { name, payload: payload ?? null, seq: 0 };
        raise.names.push(entry); added.push(entry);
        withFacts(session, name, payload ?? null);
        joined = true;
        command ||= name === 'player_command';
    }
    if (joined) raise.seq = session.raiseSeq = Number(session.raiseSeq || 0) + 1;
    for (const entry of added) entry.seq = raise.seq;
    // The command's raise and the post that carries it: the body's next post (notifyNearFacts
    // numbers it nearSeq + 1); its answer is the one for this seq (settle).
    if (command) { raise.commandSeq = raise.seq; raise.commandPost = Number(session.nearSeq || 0) + 1; }
    if (force) raise.named = true;
    return raise;
}
// The body's bag as its post carries it (BotLifeState.notifyNearFacts): a copy.
const postedBag = session => ({ ...session.nearRaise, names: session.nearRaise.names.map(entry => ({ ...entry })) });
// A body's own facts on its post (BotLifeState.notifyNearFacts, main, A1): the
// situations of the posted row against its decision's baseline (the row's
// wishSections: the last decision received), a fact the baseline lacks against
// its previous post, joined to its bag. The previous post is kept as its facts
// only (session.nearFacts: the fact digests and the funding mark, no bag copy),
// dropped as the body cools. The worker hears them with the bag.
function detectNear(session, row, escrow = 0) {
    const previous = session.nearFacts, next = {};
    const names = Situations.detect(previous ? {} : row, row, { escrow, facts: previous?.facts, funding: previous?.funding, out: next, body: true });
    // The wallet reaching the build's threshold (stats.affordAt on the posted row): once
    // per threshold, re-armed by the next build's (a far bot's is its step's soft point).
    const afford = row.stats?.wishSections?.affordAt, kind = afford ? Sections.goalReached(row, row.stats.wishSections, escrow) : null;
    const armed = afford ? `${afford.kind}:${afford.at}` : null;
    if (kind && session.nearAffordRaised !== armed) { names.push(`goal_affordable:${kind}`); session.nearAffordRaised = armed; }
    session.nearFacts = next;
    if (names.length) nearBag(session, names.map(name => ({ name, payload: null })));
}
// A body's rest ends (RestingState): its stop, carried by its bag to the worker,
// where what waited for a stop wakes (Situations.stop); a far bot's is its step's.
function stop(session) {
    const Life = isMainThread && session?.actor ? invoke('GameServer/Bot/Population/BotLifeState') : null;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase !== 'hot') return;
    const raise = nearBag(session, [], true);
    if (raise.stop !== 'town') raise.stop = 'rest';
    Life.notifyNearFacts(session, 'rest_end');
}
// A posted bag's raises on the background thread's mind (stats), heard where the
// body stands (Situations.bodyPlace); its stop (rest: the STOP plane; town: both);
// its impossible mark drops the held step (with the situation that set it,
// impossibleName) only while the raise that set it is unanswered. applied: the raise
// seq already applied: an entry that joined at or before it is not raised again (the
// bag is cumulative: its marks and wakes landed once).
// subject: the bot (the decision trace).
function raiseBag(stats, raise, impossible, where, subject, applied = 0) {
    for (const { name, payload, seq } of Array.isArray(raise?.names) ? raise.names : []) {
        if (Number(seq || 0) > applied) Situations.raise(stats, name, payload ?? null, where, subject);
    }
    if (impossible) Situations.raise(stats, raise.impossibleName || 'goal_failed', { impossible: true }, where, subject);
    if (raise?.stop) Situations.stop(stats, raise.stop === 'town' ? Situations.OPEN : Situations.REST, subject);
}
// A body's failed step waits for the worker's answer to it: its goal_failed raise
// (impossible) is still in its bag. Where the body acts, it tries the failed errand
// again only after that answer (ShoppingState, HuntingState, FollowingState).
const failureWaits = session => session?.nearRaise?.impossible === true;
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
// raises: [{ name, payload }] (BotLifeState.raiseOnRow's).
async function raiseFar(characterId, raises, reason) {
    // lazy: cycle BotLifeState requires this module at its top.
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const raised = await Life.raiseOnRow(characterId, raises, reason);
    if (raised) return raised;
    const session = Life.cachedState(characterId)?.phase === 'hot'
        ? invoke('GameServer/World/World').registeredActorById?.(Number(characterId))?.session : null;
    if (session?.actor) {
        for (const { name, payload } of raises) {
            const { impossible, ...fact } = payload || {};
            raiseDecision(session, name, { impossible: impossible === true, payload: Object.keys(fact).length ? fact : null });
        }
    } else FailureLog.note('situations.raise_lost', new Error(`${raises.map(raise => raise.name).join('+')} on ${characterId}: no far row, no body`));
    return null;
}
// An executor's outcome on main (a purchase landed, a visit's step refused, a
// refused purchase): one situation raised where the bot is (raiseFar); a failure is
// counted (FailureLog situations.raise_on). Raised from inside the bot's own command
// (a town command, a review), it lands after that command ends (its revision-checked
// writes first; counted raise:after_command), never mid-command. payload: as raiseFar's.
// Resolves the raised row's state (null when it did not land on a far row).
function raiseOn(characterId, name, payload = null, reason = `situation_${name}`) {
    const run = () => module.exports.raiseFar(characterId, [{ name, payload }], reason)
        .catch(error => { FailureLog.note('situations.raise_on', error); return null; });
    // lazy: cycle the coordinator requires this module at its top.
    const owned = isMainThread ? invoke('GameServer/Bot/Population/ColdSimulationCoordinator').commandInflight?.get?.(Number(characterId)) : null;
    if (!owned) return run();
    Situations.note('raise:after_command');
    return Promise.resolve(owned).catch(() => null).then(run);
}
// The mind keys a row raise writes (BotLifeState.raiseOnRow).
const RAISED_KEYS = Object.freeze(['woken', 'waiting', 'wishDirty', 'situationSeq', 'activityLeaf', 'earning', 'spotMarks']);
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
    return raiseFar(current.characterId, [{ name: 'goal_failed', payload: { impossible: true } }], 'situation_rejected');
}
// A near bot's posted raise bag on the background thread's mind (stats),
// against the last raise it applied in this life (applied): taken once per
// raise seq. The bag is cumulative, so its impossible mark drops the held
// step only while the raise that set it (impossibleSeq) is not yet applied.
// Returns the raise seq now applied. where: the body's place (Situations.bodyPlace).
function takePostedRaise(stats, raise, applied, where, subject = 0) {
    if (raise && Number(raise.seq) > applied) raiseBag(stats, raise,
        raise.impossible === true && Number(raise.impossibleSeq || 0) > applied, where, subject, applied);
    return Math.max(applied, Number(raise?.seq || 0));
}
// A near bot's pending raise on the cold row its body cools to
// (BotLifeState.mergeSessionIntoLifeState): no decision will answer it, so the
// row's stats take it, the step dropped only while its impossible raise is
// unanswered. The session keeps it: the body ends with the cooling, and a
// cooling that rolls back leaves the raise waiting for its decision.
// where: the cold row's place.
function applyPendingRaise(session, stats, where, subject = 0) {
    const raise = session?.nearRaise;
    if (raise) raiseBag(stats, raise, raise.impossible === true, where, subject);
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
// background thread from the same build: the mind keys (statsPacket) and the
// personal craft plan of the chosen leaf (ShoppingState). The view over the card cannot answer these: it has no
// queue and no plans.
function nearFields(economy, state) {
    const stock = economy.stock('shots');
    return { statsPacket: economy.statsPacket,
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
    replaceStats(session, { ...statsFor(session), ...near.statsPacket });
    session.heldEconomy = Object.assign(Decisions.nearView(Economy.stateForActor(actor, session), card), near);
    session.heldNearSeq = Number(near.nearSeq || 0);
    session.activationEconomyDecision = null;
    settle(session, near);
    // What the answer did not take yet is still the body's (an older answer must not
    // take back a command or a mark main holds while it waits): its facts again.
    // Only the entries this answer did not apply (raised after its seq).
    const answered = Number(near.raiseSeq || 0);
    for (const { name, payload, seq } of session.nearRaise?.names || []) {
        if (FACTS.has(name) && Number(seq || 0) > answered) withFacts(session, name, payload);
    }
    if (near.shots) ShotStock.enableAutoShot(actor, { stock: near.shots });
    return session.heldEconomy;
}
// The raise an answer (near: its raiseSeq, the raise it applied; its nearSeq, the
// post it answers) settled: all of it, or only the impossible mark and the command
// it took. A command whose post was answered without it (refused or lost on the
// way) is dropped and counted (FailureLog near.command_lost): the body never waits
// for an answer that will not come.
function settle(session, near) {
    const raise = session.nearRaise, answered = Number(near.raiseSeq || 0);
    if (!raise) return;
    if (answered >= raise.seq) { session.nearRaise = null; return; }
    if (raise.impossible && answered >= Number(raise.impossibleSeq || 0)) { raise.impossible = false; raise.impossibleSeq = 0; }
    if (!raise.commandSeq) return;
    const lost = answered < raise.commandSeq;
    if (lost && !(Number(near.nearSeq || 0) >= raise.commandPost)) return;
    if (lost) FailureLog.note('near.command_lost', new Error(`player_command ${raise.commandSeq} on ${session.actor?.fetchId?.()}: answered ${answered}`));
    dropCommand(raise);
}
const dropCommand = raise => {
    raise.names = raise.names.filter(entry => entry.name !== 'player_command');
    raise.commandSeq = 0; raise.commandPost = null;
};
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
// The spot a body's held decisions name for its hunt (main executes it, never
// chooses one, situations.md §8): its card's hunting leaf (leaf: the caller's read
// of it), else its held earning answer (stats.earning). None when there is none or
// its situations ruled it out (its spot marks: unreachable, unsafe ground; SpotRiskPolicy).
const heldSpotId = (session, leaf = null) => heldSpotOf(statsFor(session), leaf);
// The same over a bot's stats (a far row's: GoalExecutor) and its card's leaf.
function heldSpotOf(stats = {}, leaf = null) {
    const id = leaf?.activity === 'hunting' && leaf.spotId != null ? leaf.spotId : stats?.earning?.spotId;
    return id != null && !Risk.isMarked(stats, id) ? String(id) : null;
}
// A body that needs a spot (BotDecisionService, HuntingState) while its held answer
// names none it may take asks again once per answer (Situations.spotAsk over the
// session: spot_empty raised on 'ask'); 'none' when the answer to its ask names none
// either: the caller's defined fallback. spotHeld: it holds a spot, the ask is over.
function needSpot(session) {
    const verdict = Situations.spotAsk(session, statsFor(session).earning, session.actor?.fetchId?.());
    if (verdict === 'ask') raiseDecision(session, 'spot_empty');
    return verdict;
}
const spotHeld = session => { if (session?.spotAsk) session.spotAsk = null; };
// A player's command the background thread has not answered yet: the card the body
// holds still names the spot the command replaced (BotDecisionService waits for it).
// The answer for its seq settles it (settle; a lost one drops it, counted); a body no
// longer near (cooled: its row took the bag, DecisionEvents.applyPendingRaise) waits
// for none: dropped, counted (near.command_dropped).
function commandPending(session) {
    const raise = session?.nearRaise;
    if (!raise?.commandSeq) return false;
    // lazy: cycle BotLifeState requires this module at its top.
    const Life = isMainThread && session.actor ? invoke('GameServer/Bot/Population/BotLifeState') : null;
    if (Life?.cachedState(session.actor.fetchId?.())?.phase === 'hot') return true;
    FailureLog.note('near.command_dropped', new Error(`player_command ${raise.commandSeq} on ${session.actor?.fetchId?.()}: not near`));
    dropCommand(raise);
    return false;
}
// A near bot's wallet against its decision's money baseline (the far soft
// point's money reading, DecisionSections.moneyChanged): a crossing raises
// money once; nothing while that raise waits or before a baseline exists.
function checkWallet(session, actor) {
    if (session.nearRaise?.names?.some(entry => entry.name === 'money')) return false;
    const stats = statsFor(session);
    if (!stats.wishSections) return false;
    const wallet = actor.backpack?.fetchTotalAdena?.() ?? actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() ?? 0;
    // lazy: worker the native market owner is main-thread only; this module also handles cold projections.
    const escrow = invoke('GameServer/Bot/Economy/BotAfkMarketService').buyOrderEscrow(actor.fetchId?.());
    if (!Sections.moneyChanged({ adena: wallet, stats }, stats.wishSections, escrow, true)) return false;
    raiseDecision(session, 'money');
    return true;
}
module.exports = { rejections: () => rejections, refused, statsFor, replaceStats, decisionStatsFor, applyOwnRaise, raiseDecision, raiseFar, raiseOn, failureWaits, detectNear, stop, takePostedRaise, applyPendingRaise, postedBag, nearFields, receive, settle, held, heldSpotId, heldSpotOf, needSpot, spotHeld, commandPending, checkWallet, rejects, rejectOnRow, withRaise, rejectSession,
    NEAR_NAMES, nearOverflow: () => nearOverflow };
