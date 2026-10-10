'use strict';
// The treasury part of a clan purchase (clanPart): the price minus the
// member's own free money, paid into the member's wallet before its errand.
// It stays the clan's money while the member carries it: it travels with an
// errand that is on its way or waiting to leave (party, town visit), and it
// returns to the clan when the purchase fails at once or the errand ends
// without spending it (E193, E194). One rule for the equipment goal
// (ClanEquipmentService) and the clan-level goal (ClanMarketService).
const CombinedErrands = require('../Bot/Population/CombinedErrandPolicy');
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
    return { ...back, state: back.ok ? LifeState().acceptNewerLifecycleRow(back.row) : null };
}

// The member's clan errand for this item is still pending.
function errandKept(state, clanId, selfId) {
    return CombinedErrands.pending(state).some(errand => errand.purpose === 'clan'
        && Number(errand.selfId) === Number(selfId) && Number(errand.tag?.clanId) === Number(clanId));
}

// After ColdMarketService.acquire: 'bought', 'kept' (the errand carries the
// credit), 'refunded', or the refund's failure code.
async function settle(clanId, characterId, selfId, clanPart, purchase, kind, bought = !!purchase?.bought) {
    if (bought) return 'bought';
    if (purchase?.traveling || purchase?.pending || errandKept(purchase?.state, clanId, selfId)) return 'kept';
    const back = await refund(clanId, characterId, clanPart, kind);
    return back.ok ? 'refunded' : `refund_${back.code}`;
}

// A clan errand that ends on arrival (filled, or no plan left) returns the
// credit it did not spend; a remainder errand carries its own clanPart.
async function returnUnspent(characterId, errand, spent) {
    const clanId = Number(errand?.tag?.clanId);
    const left = Math.max(0, Number(errand?.tag?.clanPart || 0) - Math.max(0, Number(spent) || 0));
    if (errand?.purpose !== 'clan' || !(clanId > 0) || !(left > 0)) return null;
    return refund(clanId, characterId, left, 'clan_errand_refund');
}

module.exports = { needed, fund, refund, settle, errandKept, returnUnspent };
