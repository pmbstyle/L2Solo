const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ColdSafeEnchantService = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const depositQueues = new Map();
const { MAX_GEAR_COPIES_PER_TYPE } = require('./WarehouseRules');
let templateSource = null;
let templateIndex = new Map();

function isLegacyMainState(state) {
    return String(state?.simulation?.ownerId || 'legacy_main') === 'legacy_main';
}

function serializeDeposit(characterId, work) {
    const key = Number(characterId);
    const previous = depositQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    depositQueues.set(key, next);
    return next.finally(() => {
        if (depositQueues.get(key) === next) depositQueues.delete(key);
    });
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
        count: amount
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

async function depositActorUnlocked(actor, state = null, session = null) {
    const backpack = actor?.backpack;
    if (!backpack || !actor?.fetchId) return { count: 0, items: [] };

    const learned = await learnActorRecipes(actor, state, session);
    const retained = storedAmounts(await Database.fetchWarehouseItems(actor.fetchId()));
    const stored = [];
    for (const { source, item, storable } of storableActorItems(actor, state, session?.shoppingNpcSale)) {
        const amount = retentionAmount({ ...item, amount: storable }, retained.get(item.selfId));
        if (amount <= 0) continue;
        const result = await Database.transferInventoryToWarehouse(actor.fetchId(), { ...item, amount });
        if (Number(result.inventoryAmount) === 0) backpack.items = backpack.items.filter((entry) => entry !== source);
        else source.setAmount(result.inventoryAmount);
        retained.set(item.selfId, Number(retained.get(item.selfId) || 0) + amount);
        stored.push({ selfId: item.selfId, name: item.name, amount });
    }
    return { count: stored.reduce((sum, item) => sum + item.amount, 0), items: stored, learned };
}

function depositActor(actor, state = null, session = null) {
    if (!actor?.backpack || !actor?.fetchId) return Promise.resolve({ count: 0, items: [] });
    return serializeDeposit(actor.fetchId(), () => depositActorUnlocked(actor, state, session));
}

// The actor's warehouse candidates and the amount of each that may be stored:
// what the town visit sells to the NPC (npcSale, by selfId) stays in the bag for that sale.
function storableActorItems(actor, state = null, npcSale = null) {
    const selling = new Map(npcSale || []);
    const rows = [];
    for (const source of ItemDisposition.unreservedActorItems(state, actor?.backpack?.fetchItems?.().slice() || [])) {
        const item = itemData(source);
        if (!ItemDisposition.isWarehouseCandidate(item)) continue;
        const sold = Math.min(Number(item.amount || 0), Number(selling.get(item.selfId) || 0));
        selling.set(item.selfId, Number(selling.get(item.selfId) || 0) - sold);
        if (Number(item.amount || 0) > sold) rows.push({ source, item, storable: Number(item.amount || 0) - sold });
    }
    return rows;
}

function hasActorDepositCandidates(actor, state = null, npcSale = null) {
    return storableActorItems(actor, state, npcSale).length > 0;
}

function isAtWarehouseService(actor, target) {
    if (!actor || target?.serviceRole !== 'warehouse') return false;
    const npc = (invoke('GameServer/World/World').npc?.spawns || []).find((candidate) => (
        Number(candidate.fetchId?.() || 0) === Number(target.actorId || 0)
        && Number(candidate.fetchSelfId?.() || 0) === Number(target.npcSelfId || 0)
    ));
    if (!npc || !/^Warehouse (Keeper|Chief|Freightman)$/i.test(npc.fetchTitle?.() || '')) return false;
    return Math.hypot(
        Number(actor.fetchLocX?.()) - Number(npc.fetchLocX?.()),
        Number(actor.fetchLocY?.()) - Number(npc.fetchLocY?.())
    ) <= 300;
}

function depositActorAtWarehouse(actor, state, session, target) {
    if (!isAtWarehouseService(actor, target)) {
        return Promise.reject(new Error('warehouse NPC is no longer active'));
    }
    return depositActor(actor, state, session);
}

async function depositColdUnlocked(state, candidates) {
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
            ...inventory[String(candidate.selfId)],
            amount: Math.max(0, Number(inventory[String(candidate.selfId)]?.amount || 0) - amount),
            ...(Array.isArray(inventory[String(candidate.selfId)]?.instances) ? {
                instances: inventory[String(candidate.selfId)].instances.map((instance) => {
                    const source = sources.find((row) => Number(row.id) === Number(instance.id));
                    return source ? { ...instance, amount: Number(source.amount) } : instance;
                }).filter((instance) => Number(instance.amount) > 0)
            } : {})
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
    // Room to store is not a sale decision. Excess copies stay in the bag
    // for the market visit's common disposition, without a separate payout.
    return {
        state: depositedState,
        count: stored.reduce((sum, item) => sum + item.amount, 0),
        items: stored,
        overflow
    };
}

function depositCold(state) {
    const candidates = ItemDisposition.warehouseCandidates(state);
    if (!state || !isLegacyMainState(state) || !candidates.length) {
        return Promise.resolve({ state, count: 0, items: [] });
    }
    return serializeDeposit(state.characterId, () => depositColdUnlocked(state, candidates));
}

function templateFor(selfId) {
    const items = DataCache.items || [];
    if (items !== templateSource) {
        templateSource = items;
        templateIndex = new Map(items.map((item) => [Number(item.selfId), item]));
    }
    return templateIndex.get(Number(selfId)) || null;
}

function historicalGearOverflow(items = [], maxUnits = 16) {
    let remaining = Math.max(1, Math.min(64, Number(maxUnits) || 16));
    const groups = new Map();
    (items || []).forEach((item) => {
        const selfId = Number(item?.selfId || 0);
        if (!selfId || Number(item?.amount || 0) <= 0 || !isGear(item)) return;
        if (!groups.has(selfId)) groups.set(selfId, []);
        groups.get(selfId).push(item);
    });

    const selected = [];
    for (const selfId of [...groups.keys()].sort((left, right) => left - right)) {
        if (remaining <= 0) break;
        let retained = MAX_GEAR_COPIES_PER_TYPE;
        const rows = groups.get(selfId).sort((left, right) => (
            Number(right.enchant || 0) - Number(left.enchant || 0)
            || Number(left.id || 0) - Number(right.id || 0)
        ));
        for (const row of rows) {
            if (remaining <= 0) break;
            const amount = Math.max(0, Number(row.amount || 0));
            const kept = Math.min(retained, amount);
            retained -= kept;
            const overflow = amount - kept;
            if (overflow <= 0) continue;
            const liquidated = Math.min(overflow, remaining);
            const candidate = overflowCandidate({
                ...row,
                name: row.name || templateFor(selfId)?.template?.name || `Item ${selfId}`
            }, liquidated);
            if (!candidate) continue;
            selected.push({
                id: Number(row.id),
                selfId,
                amount: liquidated,
                enchant: Math.max(0, Number(row.enchant || 0))
            });
            remaining -= liquidated;
        }
    }
    return selected;
}

function historicalCleanupCandidates(afterCharacterId = 0, limit = 4, options = {}) {
    const cursor = Math.max(0, Number(afterCharacterId) || 0);
    const safeLimit = Math.max(1, Math.min(32, Number(limit) || 4));
    return Database.execute([`
        SELECT DISTINCT warehouse.characterId
        FROM warehouse_items warehouse INDEXED BY warehouse_items_characterId
        CROSS JOIN bot_life_state states ON states.characterId = warehouse.characterId
        WHERE warehouse.characterId > ?
          AND warehouse.amount > 0
          AND states.phase = 'cold'
          AND states.simulationOwner = 'legacy_main'
          AND states.accountName NOT LIKE 'bot_craft_%'
          AND (states.partyId IS NULL OR states.partyId = '')
          AND states.activity IN ('hunting', 'resting')
        ORDER BY warehouse.characterId ASC
        LIMIT ${safeLimit}`,
    [cursor], { onTiming: options.onTiming }], 'warehouse:cleanup-candidates').then((rows) => rows
        .map((row) => Number(row.characterId))
        .filter((characterId) => characterId > cursor));
}

function cleanupHistoricalOwner(characterId, maxUnits = 16) {
    return serializeDeposit(characterId, () => cleanupHistoricalOwnerUnlocked(characterId, maxUnits));
}

async function cleanupHistoricalOwnerUnlocked(characterId, maxUnits) {
    let [state] = await LifeState.statesByIds([Number(characterId)], { ownerId: 'legacy_main', unassigned: true });
    if (!canRelease(state)) return { ok: false, reason: 'owner_unavailable', characterId: Number(characterId) };
    const warehouseItems = await Database.fetchWarehouseItems(characterId);
    state = LifeState.cachedState(characterId) || state;
    if (!canRelease(state)) return { ok: false, reason: 'owner_unavailable', characterId: Number(characterId) };
    const selections = historicalGearOverflow(warehouseItems, maxUnits);
    if (!selections.length) {
        return { ok: true, reason: 'no_overflow', characterId: Number(characterId), rowsRemoved: 0, units: 0, payout: 0 };
    }
    const reserved = reservedWithdrawalAmounts(state, warehouseItems);
    const selling = marketRequests(state, warehouseItems, reserved);
    const selectedAmounts = storedAmounts(selections);
    const requests = selling.map((request) => ({ ...request,
        amount: Math.min(request.amount, selectedAmounts.get(request.selfId) || 0)
    })).filter((request) => request.amount > 0);
    const result = await releaseRequests(state, selections, requests);
    return { ...result, ok: !result.aborted, reason: result.aborted ? result.reason : result.released ? 'market_released' : 'market_kept',
        characterId: Number(characterId), rowsRemoved: 0,
        units: result.items.reduce((total, item) => total + item.amount, 0), payout: 0 };
}

async function cleanupHistoricalBatch(options = {}) {
    const cursor = Math.max(0, Number(options.cursor) || 0);
    const ownerLimit = Math.max(1, Math.min(32, Number(options.ownerLimit) || 4));
    const maxUnits = Math.max(1, Math.min(64, Number(options.maxUnitsPerOwner) || 16));
    const deadlineAt = Number.isFinite(Number(options.deadlineAt)) ? Number(options.deadlineAt) : Infinity;
    const characterIds = await historicalCleanupCandidates(cursor, ownerLimit);
    const summary = {
        cursor,
        exhausted: characterIds.length < ownerLimit,
        candidates: characterIds.length,
        ownersScanned: 0,
        ownersCompacted: 0,
        rowsRemoved: 0,
        units: 0,
        payout: 0,
        skipped: 0,
        errors: 0,
        budgetStopped: false
    };

    for (const characterId of characterIds) {
        if (Date.now() >= deadlineAt) {
            summary.exhausted = false;
            summary.budgetStopped = true;
            break;
        }
        try {
            const result = await cleanupHistoricalOwner(characterId, maxUnits);
            summary.cursor = characterId;
            summary.ownersScanned += 1;
            if (!result?.ok) {
                if (result?.reason === 'cleanup_error') summary.errors += 1;
                else summary.skipped += 1;
                continue;
            }
            if (Number(result.units || 0) > 0) summary.ownersCompacted += 1;
            summary.rowsRemoved += Math.max(0, Number(result.rowsRemoved || 0));
            summary.units += Math.max(0, Number(result.units || 0));
            summary.payout += Math.max(0, Number(result.payout || 0));
        } catch (error) {
            summary.cursor = characterId;
            summary.ownersScanned += 1;
            summary.errors += 1;
            utils.infoWarn('BotWarehouse', 'historical cleanup failed for %d: %s', characterId, error?.message || error);
        }
    }
    return summary;
}

function craftRequests(state, warehouseItems) {
    const plan = state?.stats?.equipmentPlan;
    if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return [];
    const Crafting = require('../../Clan/ClanCraftingPolicy');
    if (Crafting.isPersonalCraft(state)) return [];
    return Crafting.warehouseMaterials(plan, state.inventory || {}, warehouseItems || [])
        .map(item => ({ ...item, reason: 'craft' }));
}

function marketRequests(state, warehouseItems, reserved = new Map(), options = {}) {
    const stored = storedAmounts(warehouseItems);
    const inventory = { ...(state.inventory || {}) };
    const summary = LifeState.inventorySummaryFromItems(warehouseItems);
    for (const [key, item] of Object.entries(summary)) {
        const owned = inventory[key];
        inventory[key] = { ...item, ...owned, amount: Number(owned?.amount || 0) + item.amount,
            ...(item.instances ? { instances: [...(owned?.instances || []), ...item.instances] } : {}) };
    }
    // A temporary inventory for the one common E choice. It is never saved:
    // only selected physical rows move and the transaction commits the real
    // bag projection alongside them.
    // Warehouse units in this temporary bag are not counted again as occupied
    // room. Only the stock reserved to remain there limits the E keep option.
    const decision = invoke('GameServer/Bot/Economy/BotAfkMarketService').saleDecision(
        { ...state, inventory }, { ...options, stored: reserved });
    const inBag = new Map(ItemDisposition.saleCandidates(state, { unlimited: true })
        .map((item) => [Number(item.selfId), Number(item.count)]));
    const choices = [
        ...decision.listings,
        ...decision.npc,
        ...decision.answers.map((answer) => ({ ...answer.item, count: answer.count, town: answer.line.town }))
    ];
    return choices.flatMap((item) => {
        const selfId = Number(item.selfId);
        const available = Math.max(0, (stored.get(selfId) || 0) - (reserved.get(selfId) || 0));
        const amount = Math.min(available, Math.max(0, Number(item.count) - (inBag.get(selfId) || 0)));
        return amount > 0 ? [{ selfId, amount, reason: 'market', town: item.town || null }] : [];
    });
}

function canRelease(state, options = {}) {
    return options.inTown === true && !!state && isLegacyMainState(state) && state.phase === 'cold'
        && !(state.party?.partyId || state.partyId) && ['hunting', 'resting', 'shopping', 'merchant'].includes(state.activity);
}

function reservedWithdrawalAmounts(state, warehouseItems) {
    const requests = [...craftRequests(state, warehouseItems), ...ColdSafeEnchantService.warehouseRequests(state, warehouseItems)];
    return requests.reduce((amounts, item) => amounts.set(item.selfId,
        (amounts.get(item.selfId) || 0) + item.amount), new Map());
}

function releaseCold(state, options = {}) {
    if (!canRelease(state, options)) return Promise.resolve({ state, released: false, items: [] });
    return serializeDeposit(state.characterId, () => releaseColdUnlocked(state, options));
}

async function releaseColdUnlocked(state, options = {}) {
    if (!canRelease(state, options)) {
        return { state, released: false, items: [] };
    }
    const recordStage = (stage, startedAt) => options.onStage?.(stage, Date.now() - startedAt);
    const fetchStartedAt = Date.now();
    const warehouseItems = await Database.fetchWarehouseItems(state.characterId)
        .finally(() => recordStage('item_fetch', fetchStartedAt));
    // The read yielded to lifecycle writers. Plan with their latest goals and
    // reservations rather than merely checking whether the old owner survives.
    state = LifeState.cachedState(state.characterId) || state;
    if (!canRelease(state, options)) return { state, released: false, items: [] };
    if (!warehouseItems.length) return { state, released: false, items: [] };

    const planStartedAt = Date.now();
    const crafting = craftRequests(state, warehouseItems);
    const reserved = crafting.reduce((amounts, item) => amounts.set(
        item.selfId,
        Number(amounts.get(item.selfId) || 0) + Number(item.amount || 0)
    ), new Map());
    const enchanting = ColdSafeEnchantService.warehouseRequests(state, warehouseItems);
    for (const item of enchanting) reserved.set(item.selfId, (reserved.get(item.selfId) || 0) + item.amount);
    const selling = marketRequests(state, warehouseItems, reserved, options);
    recordStage('item_plan', planStartedAt);
    return releaseRequests(state, warehouseItems, [...crafting, ...enchanting, ...selling], options);
}

async function releaseRequests(state, warehouseItems, requested, options = {}) {
    const current = LifeState.cachedState(state.characterId) || state;
    if (!canRelease(current, options) || current !== state) return { state: current, released: false, items: [], reason: 'economy_state_changed' };
    const recordStage = (stage, startedAt) => options.onStage?.(stage, Date.now() - startedAt);
    const requests = requested.reduce((merged, request) => {
        const key = `${request.selfId}:${request.reason}`;
        const previous = merged.get(key);
        merged.set(key, previous ? { ...previous, amount: previous.amount + request.amount } : request);
        return merged;
    }, new Map());
    if (!requests.size) return { state, released: false, items: [] };

    const remainingByRequest = new Map([...requests.entries()].map(([key, request]) => [key, Number(request.amount || 0)]));
    const released = [];
    const timestamp = Date.now();
    let atomicSnapshot = false;
    let recorded = false;
    const recordWithdrawal = async () => {
        if (!released.length || recorded) return;
        recorded = true;
        const row = await Database.patchWarehouseWithdrawal(state.characterId, withdrawalRecord(released, timestamp));
        if (row) state = LifeState.acceptWarehouseWithdrawal(row) || state;
    };
    const stopped = async () => {
        await recordWithdrawal();
        return { state: LifeState.cachedState(state.characterId) || state,
            released: released.length > 0, items: released, reason: 'economy_state_changed', aborted: true };
    };
    const transferStartedAt = Date.now();
    try {
        for (const row of warehouseItems) {
            for (const reason of ['craft', 'enchant', 'market']) {
                const latest = LifeState.cachedState(state.characterId) || state;
                // The requests are tied to this planning snapshot. A changed
                // goal between rows waits for another bounded release attempt.
                if (!canRelease(latest, options) || latest !== state) return stopped();
                const key = `${Number(row.selfId)}:${reason}`;
                const remaining = Number(remainingByRequest.get(key) || 0);
                if (remaining <= 0 || Number(row.amount || 0) <= 0) continue;
                const amount = Math.min(remaining, Number(row.amount));
                const template = templateFor(row.selfId);
                const withdrawal = { selfId: Number(row.selfId), name: row.name || template?.template?.name || `Item ${row.selfId}`, amount, reason };
                const inTown = options.inTown === true
                    && invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state);
                if (!inTown) return stopped();
                const transfer = await Database.transferWarehouseToInventory(state.characterId, {
                    id: Number(row.id),
                    selfId: Number(row.selfId),
                    name: row.name || template?.template?.name || `Item ${row.selfId}`,
                    amount,
                    stackable: !!template?.etc?.stackable
                }, { coldState: state, inTown });
                row.amount = Number(row.amount) - amount;
                remainingByRequest.set(key, remaining - amount);
                released.push(withdrawal);
                if (transfer?.coldLifeRow) {
                    // Physical stock and its projection already committed in
                    // one transaction. Never overwrite a newer cache/owner
                    // with the row returned by an earlier awaited transfer.
                    if ((LifeState.cachedState(state.characterId) || state) !== state) return stopped();
                    state = LifeState.acceptInventoryProjection(transfer.coldLifeRow) || state;
                    atomicSnapshot = true;
                }
            }
        }
    } catch (error) {
        if (error?.message === 'economy_state_changed' || error?.message === 'warehouse_owner_changed') return stopped();
        await recordWithdrawal();
        throw error;
    } finally {
        recordStage('item_transfer', transferStartedAt);
    }
    if (!released.length) return { state, released: false, items: [] };
    await recordWithdrawal();

    const refreshStartedAt = Date.now();
    // The native transfer already returned the real bag. The fallback only
    // supports callers/test adapters using the original row-only return shape.
    const refreshed = atomicSnapshot ? state : await LifeState.refreshInventory(state);
    recordStage('item_refresh', refreshStartedAt);
    if ((LifeState.cachedState(state.characterId) || state) !== state || !canRelease(state, options)) return stopped();
    const enchantStartedAt = Date.now();
    let enchantResult;
    try {
        enchantResult = released.some((item) => item.reason === 'enchant')
            ? await ColdSafeEnchantService.enchantSafe(refreshed)
            : { state: refreshed, enchanted: false, operations: [] };
    } finally {
        recordStage('item_enchant', enchantStartedAt);
    }
    const releasedState = LifeState.cachedState(state.characterId) || enchantResult.state || refreshed;
    if (!canRelease(releasedState, options)) return stopped();
    if (atomicSnapshot) return { state: releasedState, released: true, items: released };
    const releasedForMarket = released.some((item) => item.reason === 'market');
    const nextState = {
        ...releasedState,
        stats: {
            ...(releasedState.stats || {}),
            marketSellRetryAfter: releasedForMarket ? null : releasedState.stats?.marketSellRetryAfter,
            lastWarehouseWithdrawal: withdrawalRecord(released, timestamp)
        },
        timing: {
            ...(releasedState.timing || {}),
            nextResolveAt: releasedState.activity === 'hunting'
                ? timestamp
                : releasedState.timing?.nextResolveAt
        }
    };
    // Native withdrawal persisted only its own metadata in the transaction;
    // a full lifecycle upsert here would overwrite concurrent goals/stats.
    return { state: nextState, released: true, items: released };
}

function withdrawalRecord(items, at) {
    return require('../LastOperations').compact({ at: Number(at) },
        items.map(item => [Number(item.selfId), Number(item.amount), item.reason === 'market' ? 1 : 0]), { marketFirst: true });
}

module.exports = {
    MAX_GEAR_COPIES_PER_TYPE,
    depositActor,
    depositActorAtWarehouse,
    hasActorDepositCandidates,
    isAtWarehouseService,
    depositCold,
    learnActorRecipes,
    itemData,
    retentionAmount,
    craftRequests,
    marketRequests,
    withdrawalRecord,
    historicalGearOverflow,
    historicalCleanupCandidates,
    cleanupHistoricalOwner,
    cleanupHistoricalBatch,
    releaseCold,
};
