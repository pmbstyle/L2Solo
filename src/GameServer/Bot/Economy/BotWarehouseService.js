const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const ColdSafeEnchantService = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const depositQueues = new Map();
const craftStageChecks = new Map();
const CRAFT_STAGE_CACHE_MS = 30000;
const CRAFT_VISIT_RETRY_MS = 5 * 60 * 1000;
const CRAFT_STAGE_CACHE_LIMIT = 1024;
const { MAX_GEAR_COPIES_PER_TYPE } = require('./WarehouseRules');

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

async function learnActorRecipes(actor, state = null, session = null, { recipeIds = null } = {}) {
    const backpack = actor?.backpack;
    if (!session || !backpack?.fetchItems || !backpack.deleteItem || !backpack.registerRecipe || !backpack.hasRecipe) return [];
    const craftLevel = Number(backpack.fetchDwarvenCraftLevel?.(actor) || 0);
    if (craftLevel <= 0) return [];
    const accepted = LifeState.cachedState(Number(actor.fetchId())) || state;
    if (!recipeIds) {
        const leaf = invoke('GameServer/Bot/Population/ColdSimulationCoordinator').economyDecisions.decided(accepted)?.activity;
        recipeIds = leaf?.activity === 'crafting' && Number(leaf.recipeId) > 0 ? [Number(leaf.recipeId)] : [];
    }
    if (!recipeIds.length) return [];

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
        if (!info || !recipeIds.includes(Number(info.recipe.recipeId)) || backpack.hasRecipe(actor, info.recipe.recipeId)) continue;
        const decision = ItemDisposition.recipeDisposition(craftState, item, []);
        if (decision?.action !== 'learn') continue;
        if (actor.isDead?.()) continue;

        const Commit = require('./EconomyCommit');
        const current = LifeState.cachedState(Number(actor.fetchId())) || state;
        if (!current || current.phase !== 'hot') continue;
        const admitted = await Commit.admit(current, Commit.KINDS.learn);
        let registered;
        try { registered = await Database.learnColdRecipes(actor.fetchId(), [info.recipe], null, {
            economyCommand: admitted.command, validate: () => {
                const registered = invoke('GameServer/World/World').registeredActorById(Number(actor.fetchId()));
                if (registered?.session !== session || registered?.actor !== actor || session.actor !== actor || actor.isDead?.()
                    || Number(backpack.fetchDwarvenCraftLevel?.(actor) || 0) < Number(info.recipe.level)) throw Error('recipe_actor_changed');
            }
        }); } finally { Commit.finish(actor.fetchId(), admitted.command); }
        if (registered.coldLifeRow) Commit.acceptRow(registered.coldLifeRow);
        if (registered.learned?.length) {
            const book = backpack.fetchRecipeBook?.(actor, info.recipe.type);
            if (book && !book.some(entry => Number(entry.recipeId) === Number(info.recipe.recipeId))) book.push(Object.fromEntries(
                ['recipeId', 'recipeItemId', 'level', 'productId', 'productCount', 'successRate', 'mpCost'].map(key => [key, info.recipe[key]])));
            const remaining = Number(source.fetchAmount?.() || item.amount) - 1;
            if (remaining > 0) source.setAmount?.(remaining);
            else backpack.items = backpack.fetchItems().filter(entry => entry !== source);
            invoke('GameServer/Bot/Economy/CraftWorkshopService').recipesChanged(actor.fetchId());
            learned.push({ selfId: item.selfId, recipeId: info.recipe.recipeId, name: item.name });
        }
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
    if (state && invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)) {
        const sources = actor?.backpack?.fetchItems?.().slice() || [];
        const inventory = LifeState.inventorySummaryFromItems(sources);
        for (const [id, item] of Object.entries(inventory)) inventory[id] = { ...state.inventory?.[id], ...item };
        const actual = { ...state, inventory };
        const wanted = new Map(ItemDisposition.warehouseCandidates(actual).map(item => [Number(item.selfId), Number(item.amount)]));
        const result = [];
        for (const source of sources) {
            const item = itemData(source), id = item.selfId;
            if (item.equipped || !(wanted.get(id) > 0)) continue;
            const sold = Math.min(item.amount, Number(selling.get(id) || 0));
            selling.set(id, Number(selling.get(id) || 0) - sold);
            const storable = Math.min(Number(wanted.get(id)), Math.max(0, item.amount - sold));
            if (storable > 0) { wanted.set(id, Number(wanted.get(id)) - storable); result.push({ source, item, storable }); }
        }
        return result;
    }
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
    return serializeDeposit(actor.fetchId(), async () => {
        const released = await releaseActorAtWarehouse(actor, state, session, target);
        if (released.length) session.shoppingNpcSale = invoke('GameServer/Bot/Economy/MarketListingPolicy').npcSaleForActor(session);
        const deposited = await depositActorUnlocked(actor, state, session);
        return { ...deposited, released };
    });
}

function hasActorWithdrawalCandidates(actor, state) {
    return invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)
        && Object.keys(invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').inventory({ characterId: actor?.fetchId?.() })).length > 0;
}
async function releaseActorAtWarehouse(actor, state, session, target) {
    if (!hasActorWithdrawalCandidates(actor, state)) return [];
    const id = Number(actor.fetchId()), rows = await Database.fetchWarehouseItems(id);
    const current = invoke('GameServer/Bot/Economy/MarketListingPolicy').actorState(session);
    for (const [key, item] of Object.entries(current.inventory)) current.inventory[key] = { ...state?.inventory?.[key], ...item };
    const policy = require('./CraftWarehousePolicy');
    const craft = policy.planFor(current) ? policy.stage(current, rows)?.requests || [] : [];
    const reserved = storedReservations(current, rows, craft);
    const requests = [...craft, ...marketRequests(current, rows, reserved)], released = [];
    const validate = () => {
        if (session.actor !== actor || actor.isDead?.() || !isAtWarehouseService(actor, target)
            || session.activeTrade || session.trade || session.activeNegotiation || actor.fetchPrivateStoreType?.())
            throw new Error('warehouse_actor_changed');
    };
    for (const request of requests.slice(0, 16)) {
        let left = request.amount;
        for (const row of rows.filter(row => Number(row.selfId) === request.selfId
            && Number(row.enchant || 0) === Number(request.enchant || 0))) {
            if (!(left > 0)) break;
            const item = { ...row, amount: Math.min(left, Number(row.amount)), stackable: templateFor(row.selfId)?.etc?.stackable === true };
            validate();
            const moved = await Database.transferWarehouseToInventory(id, item, { validate });
            const held = actor.backpack.fetchItemRaw(moved.inventoryId);
            if (held) held.setAmount(moved.inventoryAmount);
            else actor.backpack.insertItem(moved.inventoryId, row.selfId, { amount: moved.inventoryAmount,
                enchant: moved.enchant, petData: moved.petData, equipped: false, slot: 0 });
            row.amount -= item.amount; left -= item.amount;
            released.push({ selfId: row.selfId, amount: item.amount, reason: request.reason });
        }
    }
    return released;
}

async function depositColdUnlocked(state, candidates) {
    const [rows, warehouseRows] = await Promise.all([
        Database.fetchItems(state.characterId, 'warehouse_deposit_cold'),
        Database.fetchWarehouseItems(state.characterId)
    ]);
    const retained = storedAmounts(warehouseRows);
    const stored = [];
    const overflow = [];
    const stopped = () => ({ state: LifeState.cachedState(state.characterId) || state,
        count: stored.reduce((sum, item) => sum + item.amount, 0), items: stored, overflow,
        aborted: true, reason: 'economy_state_changed' });
    try {
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
            let deposited = null;
            const craftDepositTarget = Number(candidate.craftDepositTarget || 0)
                || (invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(state)
                    ? Number(state.stats?.equipmentPlan?.inputPreparation?.target?.selfId || 0) : 0);
            for (const source of sources) {
                if (remaining <= 0) break;
                const amount = Math.min(remaining, Number(source.amount || 0));
                const before = LifeState.cachedState(state.characterId);
                const transfer = await Database.transferInventoryToWarehouse(state.characterId, {
                    id: source.id,
                    selfId: candidate.selfId,
                    name: candidate.name,
                    amount,
                    stackable: !!candidate.stackable,
                    petData: source.petData
                }, { coldState: state, craftDepositTarget, craftDepositKind: candidate.craftDepositKind || null });
                source.amount = Number(source.amount || 0) - amount;
                remaining -= amount;
                if (!deposited) { deposited = { selfId: candidate.selfId, name: candidate.name, amount: 0 }; stored.push(deposited); }
                deposited.amount += amount;
                if (before && LifeState.cachedState(state.characterId) !== before) return stopped();
                if (!transfer?.coldLifeRow) throw new Error('warehouse_projection_missing');
                const projected = LifeState.acceptInventoryProjection(transfer.coldLifeRow);
                if (!projected) return stopped();
                // Keep the visit's unsaved metadata; only inventory authority
                // comes from the committed physical projection.
                state = { ...state, inventory: projected.inventory, adena: projected.adena,
                    vitals: projected.vitals, simulation: projected.simulation, updatedAt: projected.updatedAt,
                    ...(craftDepositTarget ? { stats: { ...state.stats, craftWarehouseDepositTarget: craftDepositTarget,
                        ...(candidate.craftDepositKind ? { craftWarehouseDepositKind: candidate.craftDepositKind } : {}) } } : {}) };
            }
            retained.set(Number(candidate.selfId), Number(retained.get(Number(candidate.selfId)) || 0) + amount);
        }
    } catch (error) {
        if (error?.message === 'economy_state_changed' || error?.message === 'warehouse_owner_changed') return stopped();
        throw error;
    }
    if (!stored.length && !overflow.length) return { state, count: 0, items: [], overflow: [] };
    const depositedState = {
        ...state,
        stats: stored.length
            ? { ...(state.stats || {}), lastWarehouseDeposit: { items: stored, at: Date.now(),
                ...(state.stats?.equipmentPlan?.inputPreparation?.target?.selfId
                    ? { projectTarget: Number(state.stats.equipmentPlan.inputPreparation.target.selfId) } : {}) } }
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
    if (!state || !candidates.length) {
        return Promise.resolve({ state, count: 0, items: [] });
    }
    return serializeDeposit(state.characterId, () => depositColdUnlocked(state, candidates));
}

function templateFor(selfId) {
    return ItemTemplateIndex.findLast(DataCache.items, selfId, templateFor) || null;
}

function craftRequests(state, warehouseItems) {
    const plan = ItemDisposition.equipmentInputPlan(state);
    if (!['active', 'component_ready', 'ready_to_craft'].includes(plan?.status) || plan.strategy !== 'craft') return [];
    const Crafting = require('../../Clan/ClanCraftingPolicy');
    return Crafting.warehouseMaterials(plan, state.inventory || {}, warehouseItems || [])
        .map(item => ({ ...item, reason: 'craft' }));
}

// A no-op review is common while a bot accumulates the remaining materials.
// Only a changed bag, warehouse or ownership invalidates it immediately.
function craftBagIdentity(state) {
    const plan = state.stats?.equipmentPlan || {};
    const items = Object.values(state.inventory || {}).filter(item => Number(item.selfId) !== 57).map(item => [
        item.selfId, item.amount, item.equippedCount, item.equipped, item.protected, item.protectedAmount,
        item.reservedAmount, item.acceptedCustomer, item.assignedClan, item.available, item.starterMobLootAmount
    ]);
    return require('node:crypto').createHash('sha256').update(JSON.stringify([items,
        plan.recipeId, plan.target, plan.status, plan.strategy, plan.outputAmount, plan.craftProviders, plan.componentRecipes,
        plan.inputPreparation, state.stats?.shotCraft?.preparing, state.stats?.wealthCraft,
        state.stats?.clanMaterialDemand, invoke('GameServer/Clan/ClanSupplyPolicy').contentIdentity(state)
    ])).digest('hex');
}

function returnStage(state, stock, identity, bagIdentity, timestamp) {
    const id = Number(state.characterId), previous = craftStageChecks.get(id);
    if (previous && previous.identity === identity && previous.bag === bagIdentity && timestamp - previous.at < CRAFT_STAGE_CACHE_MS)
        return previous.stage;
    const stage = require('./CraftWarehousePolicy').stage(state, stock());
    if (craftStageChecks.size >= CRAFT_STAGE_CACHE_LIMIT && !craftStageChecks.has(id))
        craftStageChecks.delete(craftStageChecks.keys().next().value);
    craftStageChecks.set(id, { identity, bag: bagIdentity, at: timestamp, stage });
    return stage;
}

// A kit parked during a different objective can require a warehouse visit
// after it becomes the active objective again. Only that recorded deposit
// can trigger a trip, once per warehouse contents, after the current fight.
function beginCraftReturn(state, timestamp = Date.now(), { allowParty = false } = {}) {
    const plan = ItemDisposition.equipmentInputPlan(state);
    if (state?.phase !== 'cold' || state.activity !== 'hunting' || !allowParty && (state.party?.partyId || state.partyId)
        || state.stats?.marketReturn || state.stats?.tradeMeeting || plan?.clanGoal
        || plan?.strategy !== 'craft' || !['active', 'component_ready', 'ready_to_craft'].includes(plan.status)) return null;
    const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
    if (!Index.ready() || !Index.hasItems(state)) return null;
    const identity = Index.contentIdentity(state), previous = state.stats?.craftWarehouseVisit;
    const bagIdentity = craftBagIdentity(state);
    if (!identity || Number(previous?.target) === Number(plan.target.selfId) && previous?.identity === identity
        && previous?.bagIdentity === bagIdentity && timestamp - Number(previous.at || 0) < CRAFT_VISIT_RETRY_MS) return null;
    let warehouse;
    const stock = () => warehouse ||= Object.values(Index.inventory(state));
    const policy = require('./CraftWarehousePolicy'), stage = returnStage(state, stock, identity, bagIdentity, timestamp);
    // Older parked plans retain their existing one-time collection path.
    const legacy = state.stats?.craftWarehouseDepositKind !== 'active'
        && Number(state.stats?.craftWarehouseDepositTarget) === Number(plan.target?.selfId);
    const requests = stage ? stage.requests : legacy ? craftRequests(state, stock()) : [];
    if (!requests.length) return null;
    const town = invoke('GameServer/World/TownRespawn').getClosestTown(state.loc?.locX, state.loc?.locY, state.loc?.locZ);
    if (!town) return null;
    return invoke('GameServer/Bot/Population/ColdTrip').toTown(state, {
        to: { locX: town.locX, locY: town.locY, locZ: town.locZ }, townName: town.name,
        regionName: town.name, arrivalActivity: 'shopping', reason: 'craft_warehouse'
    }, timestamp, {
        marketReturn: { loc: { ...state.loc }, spotId: state.spotId || null, regionName: state.currentRegion || null },
        craftWarehouseVisit: { target: Number(plan.target.selfId), identity, bagIdentity, at: timestamp }
    });
}

function marketRequests(state, warehouseItems, reserved = new Map(), options = {}) {
    const economy = options.economy || require('../Population/ColdEconomyDecision').economyFor(state);
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
        { ...state, inventory }, { ...options, economy, stored: reserved });
    const inBag = new Map(ItemDisposition.saleCandidates(state, { unlimited: true,
        reserved: economy.craftReservations || ItemDisposition.selectedCraftAmounts(state, economy.network) })
        .map((item) => [`${Number(item.selfId)}:${Number(item.enchant || 0)}`, Number(item.count)]));
    const choices = [
        ...decision.listings,
        ...decision.npc,
        ...decision.answers.map((answer) => ({ ...answer.item, count: answer.count, town: answer.line.town }))
    ];
    return choices.flatMap((item) => {
        const selfId = Number(item.selfId);
        const enchant = Number(item.enchant || 0);
        const stored = warehouseItems.filter(row => Number(row.selfId) === selfId && Number(row.enchant || 0) === enchant)
            .reduce((sum, row) => sum + Number(row.amount), 0);
        const available = Math.max(0, stored - (reserved.get(selfId) || 0));
        const amount = Math.min(available, Math.max(0, Number(item.count) - (inBag.get(`${selfId}:${enchant}`) || 0)));
        return amount > 0 ? [{ selfId, amount, enchant, reason: 'market', town: item.town || null }] : [];
    });
}

function canRelease(state, options = {}) {
    return options.inTown === true && !!state && state.phase === 'cold'
        && !(state.party?.partyId || state.partyId) && ['hunting', 'resting', 'shopping', 'merchant'].includes(state.activity);
}

function materialRequests(state, warehouseItems) {
    // ARCH-NOTE: the legacy plan and captured worker materials can describe
    // the same recipe gap. Reserve/withdraw that gap once across both readers.
    const merged = new Map();
    const Policy = require('./CraftWarehousePolicy');
    const craft = Policy.planFor(state) ? Policy.stage(state, warehouseItems)?.requests || [] : craftRequests(state, warehouseItems);
    for (const request of [...craft, ...ColdSafeEnchantService.warehouseRequests(state, warehouseItems)]) {
        const key = `${request.selfId}:${request.reason}${request.reason === 'market' ? `:${Number(request.enchant || 0)}` : ''}`;
        const previous = merged.get(key);
        merged.set(key, previous ? { ...previous, amount: Math.max(previous.amount, request.amount) } : request);
    }
    return [...merged.values()];
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
    const materials = materialRequests(state, warehouseItems);
    const reserved = storedReservations(state, warehouseItems, materials);
    const selling = marketRequests(state, warehouseItems, reserved, options);
    recordStage('item_plan', planStartedAt);
    return releaseRequests(state, warehouseItems, [...materials, ...selling], options);
}

function storedReservations(state, warehouseItems, materials) {
    const reserved = materials.reduce((amounts, item) => amounts.set(
        item.selfId,
        Number(amounts.get(item.selfId) || 0) + Number(item.amount || 0)
    ), new Map());
    // A not-yet-ready stage stays in custody, including crystals and other
    // supplements that the clan's material-withdrawal helper omits.
    const policy = require('./CraftWarehousePolicy'), active = policy.planFor(state);
    if (active) {
        const stock = policy.available(state, warehouseItems);
        const demand = ItemDisposition.equipmentMaterialAmounts({ ...state, inventory: stock.combined }, active.plan);
        for (const [id, needed] of Object.entries(demand)) {
            const keep = Math.min(Number(stock.warehouse[id] || 0), Math.max(0, Number(needed) - Number(stock.bag[id] || 0)));
            reserved.set(Number(id), Math.max(Number(reserved.get(Number(id)) || 0), keep));
        }
    }
    // A paused personal kit owns its stored share too. Active material
    // withdrawals above take priority when both kits need the same item.
    for (const [id, held] of Object.entries(ItemDisposition.retainedEquipmentAmounts(state))) {
        const storedNeed = Math.max(0, Number(held) - Number(state.inventory?.[id]?.amount || 0));
        reserved.set(Number(id), Number(reserved.get(Number(id)) || 0) + storedNeed);
    }
    return reserved;
}

async function releaseRequests(state, warehouseItems, requested, options = {}) {
    const current = LifeState.cachedState(state.characterId) || state;
    if (!canRelease(current, options) || current !== state) return { state: current, released: false, items: [], reason: 'economy_state_changed' };
    const recordStage = (stage, startedAt) => options.onStage?.(stage, Date.now() - startedAt);
    const requests = requested.reduce((merged, request) => {
        const key = `${request.selfId}:${request.reason}${request.reason === 'market' ? `:${Number(request.enchant || 0)}` : ''}`;
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
                const key = `${Number(row.selfId)}:${reason}${reason === 'market' ? `:${Number(row.enchant || 0)}` : ''}`;
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
    hasActorWithdrawalCandidates,
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
    beginCraftReturn,
    marketRequests,
    withdrawalRecord,
    releaseCold,
};
