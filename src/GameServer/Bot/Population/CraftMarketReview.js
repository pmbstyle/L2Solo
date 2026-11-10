'use strict';
const Network = invoke('GameServer/Bot/Economy/WishNetwork');
const Packet = require('../Economy/StatsPacket');

// These reviews run only on the bot's ordinary lifecycle, never from a timer
// or population scan. The record is worker-local and survives state updates.
// A review stands on facts, not a clock: the needs it would bid or buy for,
// the bot's own bids of those items and the board's best foreign ask and bid
// of each (what its bid or purchase prices against). It runs when a need is
// short and those facts differ from the last review's, so an unsuccessful
// review cannot spin, and a line that moves no best price wakes none.
const bestQuotes = (board, id, ownerId) => [board.first?.(id, 1, { excludeOwner: ownerId })?.price ?? 0,
    board.first?.(id, 3, { excludeOwner: ownerId })?.price ?? 0];

// An accepted shot series can wait for a missing scroll while its owner
// hunts. Its procurement is separate from the equipment project's needs.
function shotRecipeBidDue(state, record, board) {
    if (state.activity !== 'hunting' || state.partyId || state.party?.partyId
        || state.stats?.tradeMeeting || state.incomingPending || !record || !board) return false;
    const wanted = state.stats?.shotRecipeDemand;
    const recipe = wanted && invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(Number(wanted.recipeId));
    if (!recipe || Number(recipe.recipeItemId) !== Number(wanted.itemId)
        || !invoke('GameServer/Bot/Economy/ShotCraftPolicy').SHOT_RECIPE_ITEM_IDS.has(Number(wanted.itemId))
        || !invoke('GameServer/Bot/Economy/CraftEligibility').canCraft(state, recipe)
        || !(Number(wanted.maxSpend) > 0) || !Number.isFinite(wanted.maxSpend)
        || !Number.isSafeInteger(wanted.batches) || wanted.batches < 1 || wanted.batches > 64
        || !Number.isFinite(wanted.inputCash) || wanted.inputCash < 0) {
        record.shotRecipeBidSeen = null;
        return false;
    }
    const held = Number(state.inventory?.[wanted.itemId]?.amount || 0);
    const incoming = Number(state.acceptedIncoming?.[wanted.itemId] || 0);
    const offered = board.ownerLines(Number(state.characterId))
        .filter(row => row.storeType === 3 && Number(row.selfId) === Number(wanted.itemId) && row.count > 0)
        .reduce((sum, row) => sum + Number(row.count), 0);
    const facts = JSON.stringify([wanted.itemId, wanted.recipeId, wanted.batches, wanted.maxSpend,
        wanted.inputCash, held, incoming, offered, bestQuotes(board, Number(wanted.itemId), Number(state.characterId))]);
    const moved = facts !== record.shotRecipeBidSeen;
    record.shotRecipeBidSeen = facts;
    return moved && (held > 0 || incoming + offered < 1);
}

function personalBidDue(state, record, board) {
    const plan = state.stats?.equipmentPlan;
    if (state.activity !== 'hunting' || !plan || plan.clanGoal && !plan.inputPreparation
        || !(plan.inputPreparation || plan.recipeId && (plan.strategy === 'craft'
            || plan.status === 'deferred' && plan.reason === 'wish_focus'))
        || state.partyId || state.party?.partyId || state.stats?.tradeMeeting || state.incomingPending) return false;
    if (!record || !board) return false;
    const moneyPrice = Number(Packet.moneyPrice(state.stats?.money));
    if (!(moneyPrice > 0)) return false;
    const needs = invoke('GameServer/Bot/Economy/TradeIntent').retainedProjectIntents(state, { moneyPrice }, () => 1);
    const owned = board.ownerLines(Number(state.characterId));
    const ItemIndex = invoke('GameServer/Item/ItemTemplateIndex'), items = invoke('GameServer/DataCache').items;
    const seen = [];
    let short = false;
    for (const need of needs) {
        if (plan.clanGoal && need.key === `power:${Number(plan.target?.selfId)}:${Number(plan.target?.slot)}`) continue;
        const targetId = Network.rootItem(need.key);
        if (!['b', 'a', 's'].includes(ItemIndex.find(items, targetId)?.etc?.rank)
            || !invoke('GameServer/Items/ItemAcquisitionCatalog').hasSource(need.itemId)) continue;
        const offered = owned.filter(row => row.storeType === 3 && row.selfId === need.itemId && row.count > 0)
            .reduce((sum, row) => sum + Number(row.count), 0);
        seen.push([need.key, need.itemId, need.amount, offered, bestQuotes(board, need.itemId, Number(state.characterId))]);
        short ||= offered < need.amount;
    }
    // Kept also when nothing is short: an own bid withdrawn later is a new fact.
    const facts = JSON.stringify(seen), moved = facts !== record.craftBidSeen;
    record.craftBidSeen = facts;
    return short && moved;
}

// Check only two indexed inputs before calculating stock. This runs on the
// ordinary bot lifecycle and does not introduce a population-wide scan.
// Returns the review's facts when it is due ('' otherwise): the caller that
// reviews (or stands the review aside) keeps them as record.clanMarketSeen.
function clanInputDue(state, record, board) {
    const plan = state.stats?.equipmentPlan;
    if (state.activity !== 'hunting' || !plan?.clanGoal || plan.strategy !== 'craft' || !Number(plan.next?.itemId)
        || state.partyId || state.party?.partyId || state.stats?.tradeMeeting || !record || !board?.list) return '';
    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(Number(plan.recipeId));
    const part = recipe?.materials?.find(row => Number(row.selfId) !== Number(recipe.recipeItemId));
    const candidates = [Number(part?.selfId), Number(recipe?.recipeItemId)]
        .filter(id => id > 0 && board.list(id, 1)?.length);
    if (!candidates.length) return '';
    const moneyPrice = Number(Packet.moneyPrice(state.stats?.money));
    if (!(moneyPrice > 0)) return '';
    const key = `power:${Number(plan.target?.selfId)}:${Number(plan.target?.slot)}`;
    const rows = invoke('GameServer/Bot/Economy/TradeIntent').retainedProjectIntents(state, { moneyPrice }, () => 1)
        .filter(row => row.key === key && candidates.includes(row.itemId));
    if (!rows.length) return '';
    const facts = JSON.stringify([key, Number(plan.recipeId), rows.map(row => [row.itemId, row.amount]),
        candidates.map(id => [id, bestQuotes(board, id, Number(state.characterId))])]);
    return facts === record.clanMarketSeen ? '' : facts;
}

module.exports = { personalBidDue, shotRecipeBidDue, clanInputDue };
