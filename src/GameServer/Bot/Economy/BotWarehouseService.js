const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const craftScanAt = new Map();
const MAX_GEAR_COPIES_PER_TYPE = 2;

function isLegacyMainState(state) {
    return String(state?.simulation?.ownerId || 'legacy_main') === 'legacy_main';
}

function itemData(item) {
    return {
        id: Number(item.fetchId?.() || item.id),
        selfId: Number(item.fetchSelfId?.() || item.selfId),
        name: item.fetchName?.() || item.name || '',
        amount: Number(item.fetchAmount?.() || item.amount || 0),
        equipped: !!(item.fetchEquipped?.() || item.equipped),
        rank: item.fetchRank?.() || item.rank || 'none',
        kind: item.fetchKind?.() || item.kind || '',
        enchant: Number(item.fetchEnchantLevel?.() ?? item.enchant ?? 0) || 0,
        stackable: !!(item.fetchStackable?.() || item.stackable),
        petData: item.fetchPetData?.() || item.petData
    };
}

function itemKind(item) {
    return String(item?.kind || templateFor(item?.selfId)?.template?.kind || '');
}

function isGear(item) {
    const kind = itemKind(item);
    return kind.startsWith('Weapon.') || kind.startsWith('Armor.');
}

function retentionAmount(item, storedAmount = 0) {
    const amount = Math.max(0, Number(item?.amount || 0));
    if (!isGear(item)) return amount;
    return Math.min(amount, Math.max(0, MAX_GEAR_COPIES_PER_TYPE - Number(storedAmount || 0)));
}

function storedAmounts(items = []) {
    return (items || []).reduce((amounts, item) => {
        const selfId = Number(item?.selfId || 0);
        if (selfId > 0) amounts.set(selfId, Number(amounts.get(selfId) || 0) + Number(item?.amount || 0));
        return amounts;
    }, new Map());
}

function overflowCandidate(item, count) {
    const amount = Math.max(0, Number(count || 0));
    if (!isGear(item) || amount <= 0) return null;
    return {
        selfId: Number(item.selfId),
        name: item.name || templateFor(item.selfId)?.template?.name || `Item ${item.selfId}`,
        count: amount,
        npcPrice: Math.max(1, Math.floor(ItemDisposition.basePrice(item) * 0.5))
    };
}

async function learnActorRecipes(actor, state = null, session = null) {
    const backpack = actor?.backpack;
    if (!session || !backpack?.fetchItems || !backpack.deleteItem || !backpack.registerRecipe || !backpack.hasRecipe) return [];
    const craftLevel = Number(backpack.fetchDwarvenCraftLevel?.(actor) || 0);
    if (craftLevel <= 0) return [];

    const craftState = {
        ...(state || {}),
        classId: Number(actor.fetchClassId?.() || state?.classId || state?.stats?.classId || 0),
        level: Number(actor.fetchLevel?.() || state?.level || 1),
        craftLevel,
        stats: { ...(state?.stats || {}), dwarvenCraftLevel: craftLevel }
    };
    const learned = [];
    for (const source of backpack.fetchItems().slice()) {
        const item = itemData(source);
        const info = ItemDisposition.recipeInfo(item);
        if (!info || backpack.hasRecipe(actor, info.recipe.recipeId)) continue;
        const decision = ItemDisposition.recipeDisposition(craftState, item, []);
        if (decision?.action !== 'learn') continue;
        if (actor.isDead?.()) continue;

        const registered = await new Promise((resolve) => {
            backpack.deleteItem(session, source.fetchId?.() || source.id, 1, () => {
                backpack.registerRecipe(actor, info.recipe);
                resolve(true);
            });
        });
        if (registered) learned.push({ selfId: item.selfId, recipeId: info.recipe.recipeId, name: item.name });
    }
    return learned;
}

async function depositActor(actor, state = null, session = null) {
    const backpack = actor?.backpack;
    if (!backpack || !actor?.fetchId) return { count: 0, items: [] };

    const learned = await learnActorRecipes(actor, state, session);
    const retained = storedAmounts(await Database.fetchWarehouseItems(actor.fetchId()));
    const stored = [];
    for (const source of ItemDisposition.unreservedActorItems(state, backpack.fetchItems().slice())) {
        const item = itemData(source);
        if (!ItemDisposition.isWarehouseCandidate(item)) continue;
        const amount = retentionAmount(item, retained.get(item.selfId));
        if (amount <= 0) continue;
        const result = await Database.transferInventoryToWarehouse(actor.fetchId(), { ...item, amount });
        if (Number(result.inventoryAmount) === 0) backpack.items = backpack.items.filter((entry) => entry !== source);
        else source.setAmount(result.inventoryAmount);
        retained.set(item.selfId, Number(retained.get(item.selfId) || 0) + amount);
        stored.push({ selfId: item.selfId, name: item.name, amount });
    }
    return { count: stored.reduce((sum, item) => sum + item.amount, 0), items: stored, learned };
}

async function depositCold(state) {
    const candidates = ItemDisposition.warehouseCandidates(state);
    if (!state || !isLegacyMainState(state) || !candidates.length) return { state, count: 0, items: [] };

    const [rows, warehouseRows] = await Promise.all([
        Database.fetchItems(state.characterId),
        Database.fetchWarehouseItems(state.characterId)
    ]);
    const retained = storedAmounts(warehouseRows);
    const inventory = { ...(state.inventory || {}) };
    const stored = [];
    const overflow = [];
    for (const candidate of candidates) {
        const amount = retentionAmount(candidate, retained.get(Number(candidate.selfId)));
        let remaining = amount;
        const excess = overflowCandidate(candidate, Number(candidate.amount || 0) - amount);
        const sources = rows
            .filter((row) => Number(row.selfId) === Number(candidate.selfId) && !row.equipped)
            .sort((left, right) => Number(right.enchant || 0) - Number(left.enchant || 0) || Number(left.id) - Number(right.id));
        // Do not change the cold summary when the physical row changed under us.
        if (sources.reduce((sum, source) => sum + Number(source.amount || 0), 0) < Number(candidate.amount || 0)) continue;
        if (excess) overflow.push(excess);
        for (const source of sources) {
            if (remaining <= 0) break;
            const amount = Math.min(remaining, Number(source.amount || 0));
            await Database.transferInventoryToWarehouse(state.characterId, {
                id: source.id,
                selfId: candidate.selfId,
                name: candidate.name,
                amount,
                stackable: !!candidate.stackable,
                petData: source.petData
            });
            source.amount = Number(source.amount || 0) - amount;
            remaining -= amount;
        }
        inventory[String(candidate.selfId)] = {
            ...candidate,
            amount: Math.max(0, Number(candidate.amount || 0) - amount)
        };
        retained.set(Number(candidate.selfId), Number(retained.get(Number(candidate.selfId)) || 0) + amount);
        if (amount > 0) stored.push({ selfId: candidate.selfId, name: candidate.name, amount });
    }
    if (!stored.length && !overflow.length) return { state, count: 0, items: [], overflow: [] };
    const depositedState = {
        ...state,
        inventory,
        stats: stored.length
            ? { ...(state.stats || {}), lastWarehouseDeposit: { items: stored, at: Date.now() } }
            : { ...(state.stats || {}) }
    };
    const liquidated = overflow.length
        ? LifeState.applyNpcLiquidation(depositedState, overflow, { source: 'warehouse_retention_overflow' })
        : Promise.resolve(depositedState);
    return liquidated.then((nextState) => ({
        state: nextState || depositedState,
        count: stored.reduce((sum, item) => sum + item.amount, 0),
        items: stored,
        overflow
    }));
}

function templateFor(selfId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(selfId)) || null;
}

function craftRequests(state, warehouseItems) {
    const plan = state?.stats?.equipmentPlan;
    if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return [];
    return (plan.materials || []).flatMap((material) => {
        const selfId = Number(material.selfId || 0);
        const stored = (warehouseItems || []).filter((item) => Number(item.selfId) === selfId)
            .reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const owned = Number(state?.inventory?.[String(selfId)]?.amount || 0);
        const missing = Math.max(0, Number(material.amount || 0) - owned);
        const amount = Math.min(stored, missing);
        return amount > 0 ? [{ selfId, amount, reason: 'craft' }] : [];
    });
}

function marketRequests(state, warehouseItems, reserved = new Map()) {
    return (warehouseItems || []).flatMap((item) => {
        const selfId = Number(item.selfId || 0);
        const stored = Math.max(0, Number(item.amount || 0) - Number(reserved.get(selfId) || 0));
        if (!selfId || stored <= 0) return [];
        const offer = MarketOpportunity.bestBuyOffer(selfId, { sellerCharacterId: state.characterId });
        if (!offer) return [];
        const amount = Math.min(stored, Number(offer.count || 0));
        return amount > 0 ? [{ selfId, amount, reason: 'market', town: offer.town || null }] : [];
    });
}

function hasFundedReleasedMarketMaterial(state) {
    return (state?.stats?.lastWarehouseWithdrawal?.items || []).some((item) => (
        item.reason === 'market'
        && Number(state.inventory?.[String(item.selfId)]?.amount || 0) > 0
        && !!MarketOpportunity.bestBuyOffer(item.selfId, { sellerCharacterId: state.characterId })
    ));
}

function pendingMarketReleaseCandidates(limit = 8, timestamp = Date.now()) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    return LifeState.allStates(2000).filter((state) => (
        state?.phase !== 'hot'
        && isLegacyMainState(state)
        && !state?.party?.partyId
        && ['hunting', 'resting'].includes(state?.activity)
        && Number(state.stats?.marketSellRetryAfter || 0) > Number(timestamp)
        && hasFundedReleasedMarketMaterial(state)
    )).sort((left, right) => Number(left.stats?.marketSellRetryAfter || 0) - Number(right.stats?.marketSellRetryAfter || 0))
        .slice(0, safeLimit);
}

async function resumeReleasedMarket(state, timestamp = Date.now()) {
    if (!state || !isLegacyMainState(state) || !hasFundedReleasedMarketMaterial(state)) return { state, resumed: false, items: [] };
    const nextState = {
        ...state,
        stats: { ...(state.stats || {}), marketSellRetryAfter: null },
        timing: {
            ...(state.timing || {}),
            nextResolveAt: state.activity === 'hunting' ? Number(timestamp) : state.timing?.nextResolveAt
        }
    };
    const saved = await LifeState.upsertState(nextState, 'cold_warehouse_market_resumed');
    return { state: saved || nextState, resumed: true, released: false, items: [] };
}

async function releaseCold(state) {
    if (!state || !isLegacyMainState(state) || state.phase === 'hot' || state.party?.partyId || !['hunting', 'resting'].includes(state.activity)) {
        return { state, released: false, items: [] };
    }
    const warehouseItems = await Database.fetchWarehouseItems(state.characterId);
    if (!warehouseItems.length) return { state, released: false, items: [] };

    const crafting = craftRequests(state, warehouseItems);
    const reserved = crafting.reduce((amounts, item) => amounts.set(
        item.selfId,
        Number(amounts.get(item.selfId) || 0) + Number(item.amount || 0)
    ), new Map());
    const selling = marketRequests(state, warehouseItems, reserved);
    const requests = [...crafting, ...selling].reduce((merged, request) => {
        const key = `${request.selfId}:${request.reason}`;
        const previous = merged.get(key);
        merged.set(key, previous ? { ...previous, amount: previous.amount + request.amount } : request);
        return merged;
    }, new Map());
    if (!requests.size) return { state, released: false, items: [] };

    const remainingByRequest = new Map([...requests.entries()].map(([key, request]) => [key, Number(request.amount || 0)]));
    const released = [];
    for (const row of warehouseItems) {
        for (const reason of ['craft', 'market']) {
            const key = `${Number(row.selfId)}:${reason}`;
            const remaining = Number(remainingByRequest.get(key) || 0);
            if (remaining <= 0 || Number(row.amount || 0) <= 0) continue;
            const amount = Math.min(remaining, Number(row.amount));
            const template = templateFor(row.selfId);
            await Database.transferWarehouseToInventory(state.characterId, {
                id: Number(row.id),
                selfId: Number(row.selfId),
                name: row.name || template?.template?.name || `Item ${row.selfId}`,
                amount,
                stackable: !!template?.etc?.stackable
            });
            row.amount = Number(row.amount) - amount;
            remainingByRequest.set(key, remaining - amount);
            released.push({ selfId: Number(row.selfId), name: row.name || template?.template?.name || `Item ${row.selfId}`, amount, reason });
        }
    }
    if (!released.length) return { state, released: false, items: [] };

    const refreshed = await LifeState.refreshInventory(state);
    const timestamp = Date.now();
    const releasedForMarket = released.some((item) => item.reason === 'market');
    const nextState = {
        ...refreshed,
        stats: {
            ...(refreshed.stats || {}),
            marketSellRetryAfter: releasedForMarket ? null : refreshed.stats?.marketSellRetryAfter,
            lastWarehouseWithdrawal: { items: released, at: timestamp }
        },
        timing: {
            ...(refreshed.timing || {}),
            nextResolveAt: refreshed.activity === 'hunting'
                ? timestamp
                : refreshed.timing?.nextResolveAt
        }
    };
    const saved = await LifeState.upsertState(nextState, 'cold_warehouse_release');
    return { state: saved || nextState, released: true, items: released };
}

function releaseCandidates(limit = 8) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const demandIds = MarketOpportunity.activeBuyDemandSelfIds();
    if (!demandIds.length) return Promise.resolve([]);
    return Database.execute([`
        SELECT DISTINCT states.characterId
        FROM warehouse_items warehouse
        INNER JOIN bot_life_state states ON states.characterId = warehouse.characterId
        WHERE warehouse.amount > 0
        AND warehouse.selfId IN (${demandIds.map(() => '?').join(', ')})
        AND states.phase = 'cold'
        AND states.simulationOwner = 'legacy_main'
        AND states.accountName NOT LIKE 'bot_craft_%'
        AND (states.partyId IS NULL OR states.partyId = '')
        AND states.activity IN ('hunting', 'resting')
        ORDER BY states.updatedAt ASC
        LIMIT ${safeLimit}`,
    demandIds], 'warehouse:release-candidates').then((rows) => rows.map((row) => Number(row.characterId)).filter(Boolean));
}

function craftReleaseCandidates(limit = 4, timestamp = Date.now()) {
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || 4));
    const candidates = LifeState.allStates(2000).filter((state) => {
        const plan = state?.stats?.equipmentPlan;
        return state?.phase !== 'hot'
            && isLegacyMainState(state)
            && !state?.party?.partyId
            && ['hunting', 'resting'].includes(state?.activity)
            && ['active', 'component_ready', 'ready_to_craft'].includes(plan?.status)
            && plan?.strategy === 'craft';
    }).sort((left, right) => Number(craftScanAt.get(left.characterId) || 0) - Number(craftScanAt.get(right.characterId) || 0))
        .slice(0, safeLimit);
    candidates.forEach((state) => craftScanAt.set(Number(state.characterId), Number(timestamp)));
    return candidates;
}

async function releaseColdBatch(limit = 8, deadlineAt = Infinity) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const released = [];
    const resumedStates = pendingMarketReleaseCandidates(safeLimit);
    for (const state of resumedStates) {
        if (Date.now() >= deadlineAt) return released;
        const resumed = await resumeReleasedMarket(state);
        if (resumed.resumed) released.push(resumed);
    }
    const remainingLimit = Math.max(0, safeLimit - released.length);
    if (remainingLimit <= 0) return released;
    const craftLimit = Math.max(1, Math.floor(remainingLimit / 2));
    const craftStates = craftReleaseCandidates(craftLimit);
    const marketIds = await releaseCandidates(remainingLimit);
    const states = [...craftStates];
    const claimed = new Set(states.map((state) => Number(state.characterId)));
    for (const characterId of marketIds) {
        if (states.length >= remainingLimit) break;
        if (claimed.has(Number(characterId))) continue;
        const state = await LifeState.findByCharacterId(characterId);
        if (!state) continue;
        states.push(state);
        claimed.add(Number(characterId));
    }
    for (const state of states) {
        if (Date.now() >= deadlineAt) break;
        try {
            const result = await releaseCold(state);
            if (result.released) released.push(result);
        } catch (error) {
            utils.infoWarn('BotWarehouse', 'cold warehouse release failed for %s: %s', state.name, error?.message || String(error));
        }
    }
    return released;
}

module.exports = {
    MAX_GEAR_COPIES_PER_TYPE,
    depositActor,
    depositCold,
    learnActorRecipes,
    itemData,
    retentionAmount,
    craftRequests,
    marketRequests,
    hasFundedReleasedMarketMaterial,
    pendingMarketReleaseCandidates,
    resumeReleasedMarket,
    releaseCold,
    releaseCandidates,
    craftReleaseCandidates,
    releaseColdBatch
};
