'use strict';
// The treasury part of a clan purchase (clanPart): the price minus the
// member's own free money, paid into the member's wallet before its errand.
// It stays the clan's money while the member carries it: it travels with an
// errand that is on its way or waiting to leave (party, town visit), and it
// returns to the clan when the purchase fails at once or the errand ends
// without spending it. One rule for the equipment goal
// (ClanEquipmentService) and the clan-level goal (ClanMarketService).
const CombinedErrands = require('../Bot/Population/CombinedErrandPolicy');
const Diagnostics = require('../Bot/Economy/EconomyDiagnostics');
const Trace = require('../Bot/DecisionTrace');
const Database = () => invoke('Database');
const LifeState = () => invoke('GameServer/Bot/Population/BotLifeState');
const PurchaseFunding = () => invoke('GameServer/Bot/Economy/PurchaseFunding');

// The member's money earmarked for its own unpaid wishes is not used, as the
// errand's own funding check (purpose 'clan') does.
function needed(state, price) {
    return Math.max(0, Math.ceil(Number(price) || 0) - Math.floor(PurchaseFunding().spendable(state, 0, { free: true })));
}

async function fund(clanId, state, price, kind, progressionGoal = null) {
    const clanPart = needed(state, price);
    if (!(clanPart > 0)) return { ok: true, state, clanPart: 0 };
    const paid = await Database().payClanMember({ clanId, characterId: state.characterId, amount: clanPart,
        kind, moveMark: false, progressionGoal });
    if (!paid.ok) return { ok: false, code: paid.code, paid };
    return { ok: true, clanPart,
        state: LifeState().acceptNewerLifecycleRow(paid.row) || await LifeState().findByCharacterId(state.characterId) };
}

async function refund(clanId, characterId, amount, kind) {
    if (!(amount > 0)) return { ok: true, state: null };
    const back = await Database().payClanMember({ clanId, characterId, amount: -amount, kind, moveMark: false });
    if (!back.ok && Diagnostics.active()) Diagnostics.count('clan_credit', 'refund_failed', back.code || 'unknown');
    return { ...back, state: back.ok ? LifeState().acceptNewerLifecycleRow(back.row) : null };
}

// The member already carries an errand for this clan (for this item when
// selfId is given): one clan errand at a time, so one credit at a time.
function hasClanErrand(state, clanId, selfId = null) {
    return CombinedErrands.pending(state).some(errand => errand.purpose === 'clan'
        && Number(errand.tag?.clanId) === Number(clanId) && (selfId === null || Number(errand.selfId) === Number(selfId)));
}

// After ColdMarketService.acquire; returns { code, state } (state: the
// member's row after a refund, else the purchase's). Bought at once: the
// credit not spent goes back ('bought', or 'bought_refund_<code>' when that
// fails). Not bought: 'kept' when this acquire left an errand (on its way, or
// waiting for its party or town visit) or a pending meeting, else 'refunded'
// or the refund's failure code.
async function settle(clanId, characterId, clanPart, purchase, kind, bought = !!purchase?.bought) {
    const kept = !!(purchase?.traveling || purchase?.pending || purchase?.errandAt);
    if (!bought && kept) return { code: 'kept', state: purchase?.state || null };
    const amount = !bought ? clanPart
        : kept ? 0 : Math.max(0, Number(clanPart || 0) - Math.max(0, Number(purchase?.spent) || 0));
    const back = await refund(clanId, characterId, amount, kind);
    const code = bought ? (back.ok ? 'bought' : `bought_refund_${back.code}`) : (back.ok ? 'refunded' : `refund_${back.code}`);
    return { code, state: back.state || purchase?.state || null };
}

// A clan errand that ends on arrival (filled, or no plan left) returns the
// credit it did not spend; a remainder errand carries its own clanPart.
async function returnUnspent(characterId, errand, spent) {
    const clanId = Number(errand?.tag?.clanId);
    const left = Math.max(0, Number(errand?.tag?.clanPart || 0) - Math.max(0, Number(spent) || 0));
    if (errand?.purpose !== 'clan' || !(clanId > 0) || !(left > 0)) return null;
    return refund(clanId, characterId, left, 'clan_errand_refund');
}

// A clan errand's lifecycle, traced at the commit that changes the bot's errands (every end, whoever wrote it: a
// purchase, the need gone, a lapse, a drop): taken when it enters them; when it leaves them, done (the commit bought
// its last units: lastErrand), lapsed (its time ran out) or failed (the commit's reason). One errand: its key.
function clanErrands(state) {
    const errands = new Map();
    for (const errand of state?.stats?.marketErrands || [])
        if (errand?.purpose === 'clan' && Number(errand.tag?.clanId) > 0) errands.set(CombinedErrands.key(errand), errand);
    return errands;
}
function traceCommitted(previous, next) {
    const before = clanErrands(previous), after = clanErrands(next);
    if (!before.size && !after.size) return;
    const record = (phase, errand, reason) => Trace.record({ kind: 'errand', bot: Number(next.characterId), phase,
        errandKey: `clan:${Number(errand.tag.clanId)}`, item: Number(errand.selfId) || undefined, errandAt: Number(errand.at) || undefined,
        ...(reason ? { reason: String(reason) } : {}) });
    for (const [key, errand] of after) if (!before.has(key)) record('taken', errand);
    const bought = next.stats?.lastErrand, fresh = bought && Number(bought.at) !== Number(previous.stats?.lastErrand?.at);
    for (const [key, errand] of before) {
        if (after.has(key)) continue;
        if (fresh && bought.purpose === 'clan' && Number(bought.selfId) === Number(errand.selfId)
            && Number(bought.units) >= Number(errand.amount)) record('done', errand);
        else if (CombinedErrands.lapsed(errand.at, Number(next.updatedAt) || Date.now())) record('lapsed', errand);
        else record('failed', errand, next.stats?.lastReason || 'dropped');
    }
}

module.exports = { needed, fund, refund, settle, hasClanErrand, returnUnspent, traceCommitted };
