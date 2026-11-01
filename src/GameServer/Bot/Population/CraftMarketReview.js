'use strict';

// These reviews run only on the bot's ordinary lifecycle, never from a timer
// or population scan. The record is worker-local and survives state updates.
function personalBidDue(state, record, timestamp, board) {
    const plan = state.stats?.equipmentPlan;
    if (state.activity !== 'hunting' || !plan || plan.clanGoal && !plan.inputPreparation
        || !(plan.inputPreparation || plan.recipeId && (plan.strategy === 'craft'
            || plan.status === 'deferred' && plan.reason === 'wish_focus'))
        || state.partyId || state.party?.partyId || state.stats?.tradeMeeting || state.incomingPending) return false;
    if (!record) return false;
    if (!Number.isFinite(record.craftBidReviewAt)) {
        record.craftBidReviewAt = timestamp + (Number(state.characterId) * 7919 % 900000);
        return false;
    }
    if (record.craftBidReviewAt > timestamp) return false;
    record.craftBidReviewAt = timestamp + 900000;
    const moneyPrice = Number(state.stats?.money?.[1]);
    if (!board || !(moneyPrice > 0)) return false;
    const needs = invoke('GameServer/Bot/Economy/TradeIntent').retainedProjectIntents(state, { moneyPrice }, () => 1);
    const owned = board.ownerLines(Number(state.characterId));
    const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex'), items = invoke('GameServer/DataCache').items;
    for (const need of needs) {
        if (plan.clanGoal && need.key === `power:${Number(plan.target?.selfId)}:${Number(plan.target?.slot)}`) continue;
        const targetId = Number(String(need.key).split(':')[1]);
        if (!['b', 'a', 's'].includes(ItemIndex.find(items, targetId)?.etc?.rank)
            || !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(need.itemId)) continue;
        const offered = owned.filter(row => row.storeType === 3 && row.selfId === need.itemId && row.count > 0)
            .reduce((sum, row) => sum + Number(row.count), 0);
        if (offered < need.amount) return true;
    }
    return false;
}

// Check only two indexed inputs before calculating stock. This runs on the
// ordinary bot lifecycle and does not introduce a population-wide scan.
function clanInputDue(state, record, timestamp, board) {
    const plan = state.stats?.equipmentPlan;
    if (state.activity !== 'hunting' || !plan?.clanGoal || plan.strategy !== 'craft' || !Number(plan.next?.itemId)
        || state.partyId || state.party?.partyId || state.stats?.tradeMeeting || !record || !board?.list
        || Number(record.clanMarketReviewAt || 0) + 120000 > timestamp) return false;
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(Number(plan.recipeId));
    const part = recipe?.materials?.find(row => Number(row.selfId) !== Number(recipe.recipeItemId));
    const candidates = [Number(part?.selfId), Number(recipe?.recipeItemId)]
        .filter(id => id > 0 && board.list(id, 1)?.length);
    if (!candidates.length) return false;
    const moneyPrice = Number(state.stats?.money?.[1]);
    if (!(moneyPrice > 0)) return false;
    const key = `power:${Number(plan.target?.selfId)}:${Number(plan.target?.slot)}`;
    return invoke('GameServer/Bot/Economy/TradeIntent').retainedProjectIntents(state, { moneyPrice }, () => 1)
        .some(row => row.key === key && candidates.includes(row.itemId));
}

module.exports = { personalBidDue, clanInputDue };
