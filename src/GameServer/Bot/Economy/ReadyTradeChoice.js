'use strict';
// A compact execution of an already selected shared decision, not another
// search/valuation/roll. Full need certificates stay in TradeIntent.project.
const { personalOfferAllowed } = require('../Population/PartyAdmission');
const { SELL, BUY } = require('../../AfkTrade/BoardIndex');
const MAX_INSPECTED = 20;
const positive = value => Number.isSafeInteger(value) && value > 0;
function encode(side, line, count) {
    const tuple = [side, Number(line.selfId), count, Number(line.recordId), Number(line.lineId),
        Number(line.revision), Number(line.price)];
    return [SELL, BUY].includes(side) && tuple.every(positive) && line.custodyPolicy === 1 ? tuple : null;
}
function purchase(state, economy, board) {
    const leaf = economy?.network?.activity;
    if (economy?.intentPending || economy?.routePending || leaf?.activity !== 'shopping'
        || leaf.kind !== 'buy' || leaf.sourceType !== 'afk' || leaf.quoted !== true
        || leaf.executable !== true || !positive(leaf.itemId) || !positive(leaf.amount)
        || !positive(leaf.unitPrice) || !leaf.town || !board?.heads) return null;
    const baseline = Number(leaf.heldAtDecision ?? economy.state?.inventory?.[leaf.itemId]?.amount
        ?? state.inventory?.[leaf.itemId]?.amount ?? 0);
    const acquired = Math.max(0, Number(state.inventory?.[leaf.itemId]?.amount || 0) - baseline);
    const count = Math.max(0, leaf.amount - acquired);
    if (!positive(count)) return null;
    const line = board.heads(leaf.itemId, SELL, { towns: [leaf.town], excludeOwner: state.characterId,
        maxInspected: MAX_INSPECTED, accept: row => personalOfferAllowed(row, state) && !row.enchant && row.custodyPolicy === 1
            && row.price === leaf.unitPrice && row.count >= count })[0];
    return line ? encode(SELL, line, count) : null;
}
function sale(answers, state) {
    for (const answer of answers || []) {
        if (!personalOfferAllowed(answer.line, state)) continue;
        const tuple = encode(BUY, answer.line, answer.count);
        if (tuple) return tuple;
    }
    return null;
}
// Resolve only the exact indexed quote. A changed quote waits for the next
// native event; it never authorizes a different counterparty or price.
function tradeStateForOwner(id) {
    return typeof invoke === 'function' ? invoke('GameServer/Bot/Population/BotLifeState')?.cachedState?.(Number(id)) : null;
}
function resolve(tuple, board, ownerId) {
    if (!Array.isArray(tuple) || tuple.length !== 7 || !tuple.every(positive)
        || ![SELL, BUY].includes(tuple[0])) return null;
    const [side, selfId, count, recordId, lineId, revision, price] = tuple;
    const line = board?.records?.get(recordId)?.find(row => row.lineId === lineId);
    return line && personalOfferAllowed(line, tradeStateForOwner(ownerId)) && line.storeType === side && line.custodyPolicy === 1 && line.selfId === selfId
        && line.ownerId !== Number(ownerId) && line.revision === revision && line.price === price
        && line.count >= count && (side === BUY || !line.enchant) ? line : null;
}
module.exports = { purchase, sale, resolve, MAX_INSPECTED };
