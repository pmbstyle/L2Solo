'use strict';

// A buyer's fresh bilateral check can reject a specific advertised fill.
// Remember the exact buyer, quote and quantity while its
// authority and sources hold, or while a dominating backed outside option
// and its route remain valid. This is selection advice, not consent.
const refused = new Map(), LIMIT = 1024;
const scopeGroups = new WeakMap();
const authority = state => [state?.phase, Number(state?.simulation?.revision ?? -1),
    Number(state?.lastHotAt || state?.simulation?.lastHotAt || 0), Number(state?.updatedAt || 0)].join(':');
const keyOf = (owner, record, item, enchant, units) => `${owner}:${record}:${item}:${enchant}:${units}`;
const fingerprint = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

// A dominance proof only depends on the actual reserved offers it consumed.
// Other quotations of the same item do not make those offers disappear.
function witnessCurrent(board, offers, purchase) {
    if (!Array.isArray(offers) || offers.length > 5) return false;
    const seen = new Set();
    return offers.every(row => {
        if (!Array.isArray(row) || row.length !== 5 || !row.every(n => Number.isSafeInteger(n) && n > 0)) return false;
        const [recordId, lineId, revision, count, price] = row;
        if (seen.has(lineId)) return false;
        seen.add(lineId);
        return !!board.records.get(recordId)?.find(line => line.lineId === lineId && line.revision === revision
            && line.storeType === 1 && line.custodyPolicy !== 1 && line.selfId === purchase.selfId
            && Number(line.enchant || 0) === Number(purchase.enchant || 0) && line.price === price && line.count >= count
            && line.available !== false && line.executable !== false);
    });
}

// Admission revisions are local to each board mirror. Hash the same public
// category fingerprints instead, so evidence can cross to the main thread.
function admissionFingerprint(board, scope) {
    if (scope == null) return null;
    const match = /^recipe-production:([0-9])$/.exec(String(scope));
    if (!match) return null;
    const level = Number(match[1]);
    let levels = scopeGroups.get(board);
    if (!levels) { levels = new Map(); scopeGroups.set(board, levels); }
    if (!levels.has(level)) {
        const groups = new Set();
        if (level) {
            const index = invoke('GameServer/Bot/Population/ColdOccupationSources').recipeIndex(board);
            const counters = invoke('GameServer/Bot/Economy/MarketCounters');
            for (const recipe of index.catalog.rows) if (recipe.level <= level && index.accept(recipe))
                groups.add(counters.counterOf(recipe.productId));
        }
        levels.set(level, [...groups].sort());
    }
    const production = invoke('GameServer/Bot/Economy/ProductionPolicy');
    const inputs = [scope, production.buyersDisabled(), production.shotsDisabled(),
        ...levels.get(level).map(group => [group, board.groupFingerprint(group)])];
    return fingerprint(inputs);
}

function stableRoute(state) {
    return JSON.stringify([state?.phase, invoke('GameServer/Bot/Economy/EconomicTrip').key(state), state?.stats?.tradeMeeting || null]);
}
function remember(state, board, request, purchase, sourcesCurrent, { minimumFree, fundingDominance = false } = {}) {
    if (!state || !board || !purchase || typeof sourcesCurrent !== 'function') return;
    const payer = Number(request.actorA) === Number(state.characterId) ? 0 : 1;
    const lines = request.lines.filter(line => line.payer === payer && line.selfId === purchase.selfId
        && Number(line.enchant || 0) === Number(purchase.enchant || 0));
    if (!lines.length || lines.some(line => line.adId !== lines[0].adId || line.adRevision !== lines[0].adRevision)) return;
    const buyerId = Number(state.characterId), sellerId = Number(payer === 0 ? request.actorB : request.actorA);
    const quote = board.records.get(Number(lines[0].adId))?.find(line =>
        (line.storeType === 3 && line.ownerId === buyerId || line.storeType === 1 && line.ownerId === sellerId)
        && line.custodyPolicy === 1 && line.selfId === purchase.selfId
        && Number(line.enchant || 0) === Number(purchase.enchant || 0)
        && line.revision === lines[0].adRevision && lines.every(part => part.price === line.price));
    if (!quote) return;
    const key = keyOf(buyerId, quote.recordId, quote.selfId, quote.enchant || 0, purchase.units);
    refused.delete(key);
    const stable = (fundingDominance === true || Number.isFinite(minimumFree) && minimumFree >= 0) && state.phase === 'cold'
        ? { minimumFree: fundingDominance === true ? null : minimumFree, route: stableRoute(state) } : null;
    refused.set(key, { authority: authority(state), stable, revision: quote.revision, price: quote.price, sourcesCurrent });
    if (refused.size > LIMIT) refused.delete(refused.keys().next().value);
}

function rejects(line, units, buyer) {
    if (!buyer || !Number.isSafeInteger(units) || units < 1 || !(Number(buyer.characterId) > 0)
        || line.storeType === 3 && Number(line.ownerId) !== Number(buyer.characterId)
        || line.storeType === 1 && Number(line.ownerId) === Number(buyer.characterId)
        || ![1, 3].includes(line.storeType)) return false;
    const key = keyOf(Number(buyer.characterId), line.recordId, line.selfId, line.enchant || 0, units);
    const saved = refused.get(key);
    if (!saved) return false;
    const ownerCurrent = saved.stable ? stableRoute(buyer) === saved.stable.route
        && (saved.stable.minimumFree === null
            || invoke('GameServer/Bot/Economy/PurchaseFunding').spendable(buyer, 0, { free: true }) >= saved.stable.minimumFree)
        : saved.authority === authority(buyer);
    if (!ownerCurrent || saved.revision !== line.revision || saved.price !== line.price
        || !saved.sourcesCurrent()) { refused.delete(key); return false; }
    return true;
}
function clear() { refused.clear(); }
module.exports = { remember, rejects, clear, admissionFingerprint, fingerprint, witnessCurrent };
