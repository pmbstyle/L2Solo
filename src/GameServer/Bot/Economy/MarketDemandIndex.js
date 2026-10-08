const { SELL, BUY, offerFields } = require('../../AfkTrade/BoardIndex');

const WANTED_TTL_MS = 30 * 60 * 1000;

function timestampForWanted(wanted = {}) {
    const value = wanted || {};
    return Math.max(Number(value.lastMissingAt || 0), Number(value.lastTradeAdAt || 0));
}

function demandSignal(state, selfId, timestamp) {
    if (!state || Number(state.characterId || 0) <= 0) return null;
    const wanted = state.stats?.marketWanted;
    const shotWanted = state.stats?.shotDemand;
    const recipeWanted = state.stats?.shotRecipeDemand;
    const plan = state.stats?.equipmentPlan;
    const wantedAt = timestampForWanted(wanted);
    const recentWanted = Number(wanted?.itemId || 0) === Number(selfId)
        && wantedAt > 0
        && wantedAt + WANTED_TTL_MS > timestamp;
    const recentShot = Number(shotWanted?.itemId || 0) === Number(selfId)
        && Number(shotWanted?.at || 0) + WANTED_TTL_MS > timestamp;
    const recentRecipe = Number(recipeWanted?.itemId || 0) === Number(selfId)
        && Number(recipeWanted?.at || 0) + WANTED_TTL_MS > timestamp;
    const activeTarget = plan?.status === 'active'
        && Number(plan.target?.selfId || 0) === Number(selfId);
    const material = ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
        ? (plan.materials || []).find((item) => Number(item.selfId) === Number(selfId) && Number(item.missing || 0) > 0)
        : null;

    if (!recentWanted && !recentShot && !recentRecipe && !activeTarget && !material) return null;
    const ready = recentWanted || recentShot || recentRecipe
        || (activeTarget && plan.strategy === 'market') || Boolean(material?.marketFallback);
    const economicWanted = recentShot ? shotWanted : recentRecipe ? recipeWanted : null;
    return {
        characterId: Number(state.characterId),
        origin: 'own_need', scope: 'own', observedAt: timestamp,
        authority: { ownerId: Number(state.characterId), updatedAt: Number(state.updatedAt || 0) },
        selfId: Number(selfId), enchant: 0,
        needId: economicWanted?.needId || `own:${state.characterId}:${recentShot ? 'charge'
            : recentRecipe ? `recipe:${selfId}` : material ? `material:${selfId}` : `item:${selfId}`}`,
        availability: { from: timestamp, until: recentShot ? Number(shotWanted.at) + WANTED_TTL_MS
            : recentRecipe ? Number(recipeWanted.at) + WANTED_TTL_MS : recentWanted ? wantedAt + WANTED_TTL_MS : timestamp },
        name: state.name || null,
        town: state.currentRegion || null,
        amount: Math.max(1, Number(economicWanted?.amount || (recentWanted ? wanted?.amount : material?.missing) || 1)),
        budget: Math.max(0, Math.min(Number(state.adena || 0), economicWanted?.maxSpend === undefined
            ? Infinity : Number(economicWanted.maxSpend))),
        ready,
        source: recentShot ? 'shots' : recentRecipe ? 'shot_recipe' : recentWanted ? 'wanted'
            : material ? 'craft' : plan.strategy === 'market' ? 'market_plan' : 'progression_plan'
    };
}

// Private wants remain an own/group planning API. Seller projections never
// call it on foreign states or read their wallets. No allStates fallback.
function signalsOfState(state, timestamp = Date.now()) {
    const ids = new Set([Number(state?.stats?.marketWanted?.itemId || 0),
        Number(state?.stats?.shotDemand?.itemId || 0), Number(state?.stats?.shotRecipeDemand?.itemId || 0),
        Number(state?.stats?.equipmentPlan?.target?.selfId || 0)]);
    for (const row of state?.stats?.equipmentPlan?.materials || []) ids.add(Number(row.selfId));
    const entries = [];
    for (const selfId of ids) {
        if (!(selfId > 0)) continue;
        const signal = demandSignal(state, selfId, timestamp);
        if (signal) entries.push([selfId, signal]);
    }
    return entries;
}
function indexSignals(ownStates, timestamp = Date.now(), { ownerId = 0, groupOwnerIds = [] } = {}) {
    const allowed = new Set([Number(ownerId), ...groupOwnerIds.map(Number)]);
    const byItem = new Map();
    for (const state of ownStates || []) {
        if (!allowed.has(Number(state?.characterId))) continue;
        for (const [selfId, signal] of signalsOfState(state, timestamp)) {
            if (!byItem.has(selfId)) byItem.set(selfId, []);
            byItem.get(selfId).push(signal);
        }
    }
    return byItem;
}

function* permittedQuotes(selfId, { board = null, ownerId = 0, excludeCharacterId = ownerId,
    enchant = 0, timestamp = Date.now(), side = BUY, town = null } = {}) {
    const rows = board ? board.list(Number(selfId), side, town)
        : invoke('GameServer/AfkTrade/AfkTradeService').offers(selfId, side, { characterId: excludeCharacterId });
    for (const source of rows || []) {
        const owner = Number(source.ownerId ?? source.sourceId);
        const units = Number(source.count), price = Number(source.price);
        if (owner === Number(excludeCharacterId) || Number(source.enchant || 0) !== Number(enchant)
            || !Number.isSafeInteger(units) || units < 1 || !(price > 0) || !Number.isFinite(price)) continue;
        const line = source.storeType ? offerFields(source) : source;
        const authority = { recordId: Number(line.recordId), lineId: Number(line.lineId),
            revision: line.expectedRevision ?? source.revision ?? null };
        yield { ...line, origin: side === BUY ? 'public_bid' : 'public_ask', authority,
            needId: `bid:${authority.recordId}:${authority.lineId}`, characterId: owner, ownerId: owner,
            selfId: Number(selfId), enchant: Number(enchant), units, amount: units, count: units,
            maxPrice: price, price, observedAt: timestamp, sourceRevision: board?.itemRevision(selfId) ?? null,
            scope: 'board', availability: { from: timestamp, until: timestamp },
            // This is the public quote amount, never proof of funded escrow.
            budget: units * price, quoted: true, exclusive: false, guaranteed: false };
    }
}

function demandFor(selfId, options = {}) {
    const timestamp = Number(options.now ?? options.timestamp) || Date.now();
    const unitPrice = Math.max(0, Number(options.unitPrice || 0));
    const quotes = [], towns = {}, needs = new Set();
    let units = 0, willingUnits = 0, count = 0, tail = false;
    for (const quote of permittedQuotes(selfId, { ...options, timestamp,
        ownerId: options.ownerId ?? options.excludeCharacterId })) {
        if (needs.has(quote.needId)) continue;
        if (quotes.length < 8) needs.add(quote.needId);
        count++;
        units += quote.units;
        if (quote.price >= unitPrice) willingUnits += quote.units;
        if (quote.town) towns[quote.town] = (towns[quote.town] || 0) + quote.units;
        if (quotes.length < 8) quotes.push(quote); else tail = true;
    }
    // Several public bids need separate executable comparisons: neither their
    // foreign preference overlap nor an exposure/lifetime is observed.
    return { selfId: Number(selfId), known: count <= 1 && !tail, quoteKnown: !tail,
        lifetimeKnown: false, horizonHours: NaN, applicableUnits: count <= 1 ? units : NaN,
        willingUnits: count <= 1 ? willingUnits : NaN, bots: 0, readyBots: 0, fundedBots: 0,
        afkOrders: count, units, readyUnits: units, fundedUnits: willingUnits, unitPrice, towns,
        signals: [], quotes, unknownTail: tail, repeatable: false };
}

// An own physical row is one preparation unit. Equal physical authority is
// counted once even when a bag/board/warehouse projection repeats it.
function createOwnStock(ownerId, { timestamp = Date.now(), reserved = {} } = {}) {
    return { ownerId: Number(ownerId), timestamp, reserved: { ...reserved }, groups: new Map(), physical: new Set(), known: true };
}
function knownNeeds(sources, { ownerId = 0, groupOwnerIds = [] } = {}) {
    const allowed = new Set([Number(ownerId), ...groupOwnerIds.map(Number)]);
    const needs = new Map();
    let known = true, publicNeeds = 0;
    for (const source of sources || []) {
        const publicQuote = source.origin === 'public_bid' && source.authority?.recordId > 0 && source.authority?.lineId > 0;
        if (!publicQuote && !allowed.has(Number(source.characterId ?? source.ownerId))) continue;
        const units = Number(source.units ?? source.amount);
        if (!source.needId || !Number.isFinite(units) || units < 0) { known = false; continue; }
        const existing = needs.get(source.needId);
        if (existing) existing.units = Math.max(existing.units, units);
        else {
            if (publicQuote && ++publicNeeds > 1) known = false;
            needs.set(source.needId, { needId: source.needId, units, origin: source.origin });
        }
    }
    return { known, needs };
}
function prepareStockRow(index, row, { origin = 'inventory', authority = null, availableAt = index.timestamp,
    scope = 'own', free = false } = {}) {
    if (!index.known || !row) return false;
    const owner = Number(row.ownerId ?? row.characterId ?? index.ownerId);
    if (owner !== index.ownerId || !['own', 'accepted_own', 'assigned_group'].includes(scope)) return false;
    const selfId = Number(row.selfId), enchant = Number(row.enchant || 0);
    const count = Number(row.count ?? row.amount ?? 0);
    const key = `${selfId}:${enchant}`;
    const physicalId = authority ?? row.physicalAuthority ?? (Number(row.id ?? row.objectId) > 0
        ? `item:${Number(row.id ?? row.objectId)}` : origin === 'board'
            ? `board:${row.recordId}:${row.lineId}` : `${origin}:${key}`);
    if (index.physical.has(physicalId)) return true;
    if (!Number.isSafeInteger(selfId) || selfId < 1 || !Number.isSafeInteger(enchant) || enchant < 0
        || !Number.isSafeInteger(count) || count < 0 || !Number.isFinite(availableAt)) {
        index.known = false; return false;
    }
    index.physical.add(physicalId);
    if (selfId === 57 || availableAt > index.timestamp || row.acceptedCustomerMaterial || row.assignedElsewhere) return true;
    const equipped = free ? 0 : Number(row.equippedCount ?? (row.equipped ? count : 0));
    const protectedUnits = free ? 0 : Math.max(Number(row.protectedAmount || 0), Number(index.reserved[selfId] || 0));
    if (!Number.isSafeInteger(equipped) || equipped < 0 || !Number.isSafeInteger(protectedUnits) || protectedUnits < 0) {
        index.known = false; return false;
    }
    const keep = Math.min(count, equipped + protectedUnits);
    if (!free) index.reserved[selfId] = Math.max(0, Number(index.reserved[selfId] || 0) - Math.max(0, keep - equipped));
    const units = count - keep;
    const group = index.groups.get(key) || { selfId, enchant, units: 0, listedUnits: 0,
        prices: new Set(), scope: 'own', availability: { from: index.timestamp, until: index.timestamp } };
    group.units += units;
    if (!Number.isSafeInteger(group.units)) { index.known = false; return false; }
    if (origin === 'board') { group.listedUnits += units; group.prices.add(Number(row.price)); }
    index.groups.set(key, group);
    return true;
}
function jointStock(state, { board = null, warehouse = [], incoming = [], reserved = {}, timestamp = Date.now() } = {}) {
    const index = createOwnStock(state?.characterId, { timestamp, reserved: { ...reserved } });
    const inventory = state?.physicalInventory ?? state?.inventory ?? {};
    for (const row of Array.isArray(inventory) ? inventory : Object.values(inventory)) prepareStockRow(index, row);
    for (const row of board?.ownerLines(state?.characterId) || []) {
        if (row.storeType === SELL) prepareStockRow(index, row, { origin: 'board', free: true });
    }
    for (const row of warehouse || []) prepareStockRow(index, row, { origin: 'warehouse' });
    for (const row of incoming || []) prepareStockRow(index, row, { origin: 'incoming', scope: 'accepted_own',
        authority: row.physicalAuthority, availableAt: Number(row.availableAt) });
    return index;
}

// The sellers of an item: the board's sell lines, and `options.supplyByItem`
// (the supply a caller already has, by item) besides.
function supplyFor(selfId, options = {}) {
    const offers = [];
    let units = 0, minimumPrice = Infinity;
    for (const quote of permittedQuotes(selfId, { ...options, ownerId: options.excludeCharacterId, side: SELL })) {
        offers.push(quote); units += quote.units; minimumPrice = Math.min(minimumPrice, quote.price);
    }
    return { selfId: Number(selfId), sellers: offers.length, units, minimumPrice, offers };
}

function snapshot(selfId, options = {}) {
    return {
        demand: demandFor(selfId, options),
        supply: supplyFor(selfId, options)
    };
}

module.exports = { WANTED_TTL_MS, demandFor, demandSignal, indexSignals, signalsOfState,
    snapshot, supplyFor, timestampForWanted, permittedQuotes, createOwnStock, prepareStockRow, jointStock, knownNeeds };
