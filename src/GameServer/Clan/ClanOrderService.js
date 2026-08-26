const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyLootAllocator = invoke('GameServer/Bot/Population/PartyLootAllocator');

const ORDER_KIND = 'gather_item';
const STRATEGIES = Object.freeze(['auto', 'farm', 'market']);
const DELIVERY_BATCH_SIZE = 8;

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function uniqueIds(values = []) {
    return [...new Set((values || []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))]
        .sort((left, right) => left - right);
}

function itemTemplate(itemId) {
    return (DataCache.items || []).find((item) => Number(item.selfId) === Number(itemId)) || null;
}

function itemSnapshot(item) {
    if (!item) return null;
    return {
        itemId: Number(item.selfId),
        itemName: String(item.template?.name || `Item ${item.selfId}`),
        itemKind: String(item.template?.kind || ''),
        itemPrice: Math.max(0, Math.floor(number(item.template?.price)))
    };
}

function actionTypeForGoal(goal) {
    if (!goal || ['completed', 'paused', 'blocked'].includes(String(goal.status))) return null;
    if (goal.plan?.kind === 'market') return 'market';
    if (goal.plan?.kind === 'farm') return 'party';
    if (goal.plan?.delivery?.kind === 'best_upgrade') return 'goal_plan';
    return null;
}

function orderMembers(clan, order) {
    const roster = new Set(uniqueIds(clan?.state?.memberIds || []));
    const requested = uniqueIds(order?.memberIds || []);
    return requested.length ? requested.filter((id) => roster.has(id)) : [...roster];
}

function memberState(clan, memberIds) {
    const selected = (clan?.members || []).filter((member) => memberIds.includes(Number(member.characterId ?? member.id)));
    const levels = selected.map((member) => Math.max(1, number(member.level, 1)));
    return {
        characterId: selected[0]?.characterId || memberIds[0] || 0,
        name: selected[0]?.name || 'Clan operation',
        level: levels.length ? Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length) : 1,
        stats: { role: 'tank' },
        inventory: {}
    };
}

function farmSource(itemId, clan, memberIds, options = {}) {
    if (options.source === null) return null;
    if (options.source) return options.source;
    const state = memberState(clan, memberIds);
    const sources = GearAcquisitionPlanner.sourceForItem(itemId, SpotService.ensureIndexed(), state);
    const selectedLevels = (clan?.members || [])
        .filter((member) => memberIds.includes(Number(member.characterId ?? member.id)))
        .map((member) => number(member.level));
    const ceiling = Math.max(1, ...(selectedLevels.length ? selectedLevels : [state.level])) + 5;
    return sources.find((source) => number(source.npcLevel || source.spotLevel) <= ceiling) || sources[0] || null;
}

function affordableOffer(order, itemId, remaining, options = {}) {
    if (options.offer === null) return null;
    const remainingBudget = number(order.budget) > 0 ? Math.max(0, number(order.budget) - number(order.spent)) : Infinity;
    const unitBudget = number(order.maxUnitPrice) > 0 ? number(order.maxUnitPrice) : remainingBudget;
    const budget = Math.min(unitBudget || Infinity, remainingBudget || 0);
    if (budget <= 0) return null;
    const offer = options.offer || MarketOpportunity.bestOffer(itemId, { budget });
    if (!offer) return null;
    if (number(order.maxUnitPrice) > 0 && number(offer.price) > number(order.maxUnitPrice)) return null;
    if (number(order.budget) > 0 && number(offer.price) > remainingBudget) return null;
    return { ...offer, remaining, remainingBudget };
}

async function warehouseProgress(clanId, itemId) {
    const rows = await Database.fetchClanWarehouseItems(clanId);
    return rows
        .filter((row) => Number(row.selfId) === Number(itemId))
        .reduce((sum, row) => sum + Math.max(0, number(row.amount)), 0);
}

function deliveryMember(state) {
    if (!state) return null;
    return {
        memberId: number(state.characterId) || null,
        memberName: String(state.name || 'Clan member'),
        role: String(state.party?.role || state.stats?.role || 'member'),
        level: Math.max(1, number(state.level, 1))
    };
}

function equipmentOrder(order) {
    const item = itemTemplate(order?.itemId);
    return !!item && PartyLootAllocator.equipmentDrop({
        selfId: number(order.itemId),
        kind: item.template?.kind || ''
    });
}

async function clanMemberStates(clan) {
    const ids = uniqueIds(clan?.state?.memberIds || []);
    const states = await Promise.all(ids.map((id) => LifeState.findByCharacterId(id)));
    return states.filter(Boolean);
}

async function deliveryContext(order, clan) {
    const warehouseAmount = await warehouseProgress(clan.id, order.itemId);
    if (!equipmentOrder(order)) {
        return {
            kind: 'clan_warehouse',
            status: warehouseAmount >= number(order.amount) ? 'delivered' : 'collecting',
            warehouseAmount,
            deliveredAmount: Math.min(number(order.amount), warehouseAmount),
            recipients: [],
            nextRecipient: null
        };
    }

    const [deliveries, states] = await Promise.all([
        number(order.id) > 0
            ? Database.fetchPlayerManagedClanOrderDeliveries({
                clanId: clan.id,
                orderId: order.id,
                itemId: order.itemId
            })
            : Promise.resolve([]),
        clanMemberStates(clan)
    ]);
    const deliveredAmount = deliveries.reduce((sum, entry) => sum + Math.max(0, number(entry.amount)), 0);
    const item = itemTemplate(order.itemId);
    const scored = states
        .map((state) => ({
            state,
            score: PartyLootAllocator.recipientScore(state, {
                selfId: number(order.itemId),
                name: String(order.itemName || item?.template?.name || `Item ${order.itemId}`),
                kind: String(item?.template?.kind || '')
            }, new Map())
        }))
        .filter((candidate) => Number.isFinite(candidate.score))
        .sort((left, right) => right.score - left.score
            || number(left.state.characterId) - number(right.state.characterId));
    const next = scored[0]?.state || null;
    const recipientStates = new Map(states.map((state) => [number(state.characterId), state]));
    const recipients = deliveries.map((entry) => ({
        ...(deliveryMember(recipientStates.get(number(entry.characterId))) || {
            memberId: number(entry.characterId),
            memberName: String(entry.characterName || 'Clan member'),
            role: 'member',
            level: null
        }),
        amount: Math.max(0, number(entry.amount)),
        deliveredAt: number(entry.createdAt) || null
    }));
    const nextRecipient = deliveryMember(next);
    const remaining = Math.max(0, number(order.amount) - deliveredAmount);
    const busy = !!next && (String(next.phase || '') !== 'cold'
        || String(next.simulation?.ownerId || 'legacy_main') !== 'legacy_main'
        || !!String(next.party?.partyId || ''));
    return {
        kind: 'best_upgrade',
        status: remaining <= 0
            ? 'delivered'
            : !nextRecipient ? 'blocked'
                : warehouseAmount > 0 && busy ? 'waiting_member'
                    : warehouseAmount > 0 ? 'ready' : 'collecting',
        warehouseAmount,
        deliveredAmount: Math.min(number(order.amount), deliveredAmount),
        recipients,
        nextRecipient
    };
}

async function deliverAvailable(order, clan) {
    if (!equipmentOrder(order) || number(order.id) <= 0) return { delivered: 0, code: 'warehouse_delivery_not_required' };
    let delivered = 0;
    let lastCode = 'warehouse_no_stock';
    while (delivered < DELIVERY_BATCH_SIZE) {
        const delivery = await deliveryContext(order, clan);
        if (delivery.deliveredAmount >= number(order.amount)) {
            return { delivered, code: delivered > 0 ? 'clan_order_delivered' : 'goal_completed' };
        }
        if (delivery.warehouseAmount <= 0 || !delivery.nextRecipient?.memberId) {
            return { delivered, code: delivered > 0 ? 'clan_order_delivered' : delivery.status };
        }
        const state = await LifeState.findByCharacterId(delivery.nextRecipient.memberId);
        if (!state) return { delivered, code: 'no_equipment_beneficiary' };
        const copyIndex = delivery.deliveredAmount;
        const transfer = await Database.transferClanWarehouseToMember({
            clanId: clan.id,
            characterId: state.characterId,
            selfId: order.itemId,
            amount: 1,
            goalKey: `player-order:${number(order.id)}:delivery:${copyIndex}:${number(state.characterId)}`,
            expectedSimulationRevision: number(state.simulation?.revision)
        });
        lastCode = String(transfer?.code || 'warehouse_transfer_failed');
        if (!transfer?.ok) return { delivered, code: lastCode };
        if (lastCode !== 'warehouse_withdraw_already_applied') {
            const refreshed = await LifeState.refreshInventory({
                ...state,
                simulation: {
                    ...(state.simulation || {}),
                    revision: number(transfer.simulationRevision, number(state.simulation?.revision))
                }
            }, { equip: true });
            await LifeState.upsertState(refreshed, 'clan_order_delivery');
            delivered += Math.max(0, number(transfer.amount));
        }
    }
    return { delivered, code: 'clan_order_delivered' };
}

function planFor(order, clan, progress, options = {}) {
    const remaining = Math.max(0, number(order.amount) - progress);
    if (remaining <= 0) return { kind: 'warehouse', reasonCode: 'goal_completed', selectedAt: Date.now() };
    const members = orderMembers(clan, order);
    const requested = STRATEGIES.includes(String(order.strategy)) ? String(order.strategy) : 'auto';
    const avoid = String(options.avoidPlan || '');
    const offer = requested !== 'farm' && avoid !== 'market'
        ? affordableOffer(order, order.itemId, remaining, options)
        : null;
    if (requested === 'market' || requested === 'auto' && offer) {
        return {
            kind: 'market',
            reasonCode: offer ? 'market_offer_available' : 'market_demand_open',
            maxUnitPrice: number(order.maxUnitPrice),
            budget: number(order.budget),
            selectedAt: Date.now()
        };
    }
    const source = farmSource(order.itemId, clan, members, options);
    if (requested !== 'market' && source) {
        return {
            kind: 'farm',
            sourceId: number(source.npcId),
            sourceName: String(source.npcName || `NPC ${source.npcId}`),
            sourceSpotId: source.spotId || null,
            sourceLevel: number(source.npcLevel || source.spotLevel),
            reasonCode: 'farm_source_selected',
            selectedAt: Date.now()
        };
    }
    return {
        kind: 'prepare',
        reasonCode: requested === 'market' ? 'market_offer_unavailable' : 'item_source_unavailable',
        selectedAt: Date.now()
    };
}

async function buildGoal(order, clan, options = {}) {
    const delivery = await deliveryContext(order, clan);
    const progress = delivery.deliveredAmount;
    const acquisitionProgress = delivery.kind === 'best_upgrade'
        ? Math.min(number(order.amount), progress + delivery.warehouseAmount)
        : progress;
    let plan = planFor(order, clan, acquisitionProgress, options);
    if (delivery.kind === 'best_upgrade' && progress < number(order.amount)) {
        if (!delivery.nextRecipient) {
            plan = { kind: 'prepare', reasonCode: 'no_equipment_beneficiary', selectedAt: Date.now() };
        } else if (acquisitionProgress >= number(order.amount)) {
            plan = { kind: 'prepare', reasonCode: 'warehouse_delivery_pending', selectedAt: Date.now() };
        }
    }
    plan.delivery = delivery;
    const completed = progress >= number(order.amount);
    const blocked = !completed && plan.kind === 'prepare' && plan.reasonCode !== 'warehouse_delivery_pending';
    return {
        type: 'item',
        controlledBy: 'player',
        orderId: number(order.id) || null,
        orderRevision: number(order.revision) || null,
        target: {
            itemId: number(order.itemId),
            itemName: String(order.itemName || `Item ${order.itemId}`),
            ...(delivery.nextRecipient ? {
                memberId: delivery.nextRecipient.memberId,
                memberName: delivery.nextRecipient.memberName,
                memberLevel: delivery.nextRecipient.level
            } : {}),
            ...(plan.sourceId ? { npcId: plan.sourceId, npcName: plan.sourceName, sourceLevel: plan.sourceLevel } : {})
        },
        required: number(order.amount),
        progress: Math.min(number(order.amount), progress),
        plan,
        policy: {
            strategy: String(order.strategy || 'auto'),
            maxUnitPrice: number(order.maxUnitPrice),
            budget: number(order.budget),
            spent: number(order.spent)
        },
        assignedMemberIds: orderMembers(clan, order),
        partyId: null,
        catastrophicFailures: number(clan?.state?.goal?.catastrophicFailures),
        status: completed ? 'completed' : blocked ? 'blocked' : 'executing',
        reasonCodes: [plan.reasonCode].filter(Boolean),
        createdAt: number(order.id) > 0 && number(clan?.state?.goal?.orderId) === number(order.id)
            ? number(clan.state.goal.createdAt, Date.now())
            : Date.now(),
        updatedAt: Date.now()
    };
}

async function ensureMarketDemand(clanId, order, goal) {
    if (!['auto', 'market'].includes(String(order.strategy)) || goal.status === 'completed') return null;
    const warehouseAmount = goal.plan?.delivery?.kind === 'best_upgrade'
        ? number(goal.plan.delivery.warehouseAmount)
        : 0;
    const amount = Math.max(0, number(goal.required) - number(goal.progress) - warehouseAmount);
    const maxPrice = Math.max(1, number(order.maxUnitPrice));
    const goalKey = `player-order:${number(order.id)}:${number(order.itemId)}`;
    if (amount <= 0) {
        const fulfilled = await Database.upsertClanMarketDemand({
            clanId,
            itemId: order.itemId,
            amount: 1,
            maxPrice,
            goalKey,
            status: 'fulfilled'
        });
        if (fulfilled.ok) {
            await Database.syncClanMarketDemandSignal({
                clanId,
                itemId: order.itemId,
                amount: 1,
                maxPrice,
                goalKey,
                status: 'fulfilled'
            });
        }
        return fulfilled;
    }
    const demand = await Database.upsertClanMarketDemand({
        clanId,
        itemId: order.itemId,
        amount,
        maxPrice,
        goalKey,
        status: 'open'
    });
    if (demand.ok) {
        await Database.syncClanMarketDemandSignal({
            clanId,
            itemId: order.itemId,
            amount,
            maxPrice,
            goalKey,
            status: 'open'
        });
    }
    return demand;
}

async function create(clan, payload = {}, options = {}) {
    if (!clan || String(clan.state?.mode || '') !== 'player_managed') {
        return { ok: false, code: 'target_not_player_managed' };
    }
    const itemId = Number(payload.itemId);
    const item = itemSnapshot(itemTemplate(itemId));
    const amount = Math.floor(number(payload.amount));
    const strategy = String(payload.strategy || 'auto');
    if (!item || itemId <= 0 || itemId === 57) return { ok: false, code: 'invalid_clan_order_item' };
    if (amount <= 0 || amount > 1000000) return { ok: false, code: 'invalid_clan_order_amount' };
    if (!STRATEGIES.includes(strategy)) return { ok: false, code: 'invalid_clan_order_strategy' };
    const availableMembers = new Set(uniqueIds(clan.state.memberIds || []));
    const memberIds = uniqueIds(payload.memberIds || []);
    if (memberIds.some((id) => !availableMembers.has(id))) return { ok: false, code: 'invalid_clan_order_members' };
    const basePrice = Math.max(1, number(item.itemPrice));
    const maxUnitPrice = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number(payload.maxUnitPrice, basePrice * 2))));
    const budget = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number(payload.budget))));
    const draft = {
        id: 0,
        revision: 1,
        clanId: clan.id,
        kind: ORDER_KIND,
        status: 'active',
        itemId,
        itemName: item.itemName,
        amount,
        strategy,
        maxUnitPrice,
        budget,
        spent: 0,
        memberIds
    };
    const goal = await buildGoal(draft, clan, options);
    const created = await Database.createPlayerManagedClanOrder({
        ...draft,
        goal,
        actionType: actionTypeForGoal(goal)
    });
    if (!created.ok) return created;
    const nextGoal = { ...created.goal, orderId: created.order.id, orderRevision: created.order.revision };
    await ensureMarketDemand(clan.id, created.order, nextGoal);
    if (nextGoal.plan?.delivery?.kind === 'best_upgrade' && number(nextGoal.plan.delivery.warehouseAmount) > 0) {
        return syncProgress(clan, 0, 'clan_order_delivery');
    }
    return { ...created, goal: nextGoal };
}

async function current(clanId) {
    const rows = await Database.fetchPlayerManagedClanOrders({
        clanId,
        status: ['active', 'paused', 'blocked'],
        limit: 1
    });
    return rows[0] || null;
}

async function resolveClan(clan, options = {}) {
    if (!clan || String(clan.state?.mode || '') !== 'player_managed') {
        return { ok: true, skipped: true, reason: 'target_not_player_managed' };
    }
    const order = await current(clan.id);
    if (!order) return { ok: true, skipped: true, reason: 'player_order_missing', goal: null };
    if (order.status === 'paused') return { ok: true, skipped: true, reason: 'player_order_paused', goal: clan.state?.goal || null };
    const delivery = await deliverAvailable(order, clan);
    const goal = await buildGoal(order, clan, {
        ...options,
        avoidPlan: order.strategy === 'auto' && String(options.reasonCode || '') === 'market_no_offer'
            ? 'market'
            : options.avoidPlan
    });
    const updated = await Database.updatePlayerManagedClanOrderProgress({
        clanId: clan.id,
        orderId: order.id,
        goal,
        reasonCode: delivery.delivered > 0 ? 'clan_order_delivered' : options.reasonCode || ''
    });
    if (!updated.ok) return updated;
    await ensureMarketDemand(clan.id, updated.order, updated.goal);
    return { ok: true, changed: true, order: updated.order, goal: updated.goal, reason: updated.goal.plan?.reasonCode };
}

async function syncProgress(clan, spentDelta = 0, reasonCode = '') {
    const order = await current(clan.id);
    if (!order || order.status === 'paused') return { ok: false, code: 'clan_order_not_active' };
    const delivery = await deliverAvailable(order, clan);
    const goal = await buildGoal({ ...order, spent: number(order.spent) + Math.max(0, number(spentDelta)) }, clan);
    const updated = await Database.updatePlayerManagedClanOrderProgress({
        clanId: clan.id,
        orderId: order.id,
        goal,
        spentDelta,
        reasonCode: delivery.delivered > 0 ? 'clan_order_delivered' : reasonCode
    });
    if (updated.ok) await ensureMarketDemand(clan.id, updated.order, updated.goal);
    return updated;
}

async function transition(clan, transitionName, payload = {}, options = {}) {
    const order = await current(clan.id);
    if (!order) return { ok: false, code: 'clan_order_not_active' };
    if (transitionName === 'pause' || transitionName === 'cancel') {
        return Database.transitionPlayerManagedClanOrder({
            clanId: clan.id,
            orderId: order.id,
            expectedRevision: payload.revision ?? null,
            transition: transitionName,
            reasonCode: `player_order_${transitionName}`
        });
    }
    const goal = await buildGoal(order, clan, {
        ...options,
        avoidPlan: transitionName === 'replan' && order.strategy === 'auto'
            ? String(clan.state?.goal?.plan?.kind || '')
            : ''
    });
    const result = await Database.transitionPlayerManagedClanOrder({
        clanId: clan.id,
        orderId: order.id,
        expectedRevision: payload.revision ?? null,
        transition: transitionName,
        goal,
        actionType: actionTypeForGoal(goal),
        reasonCode: `player_order_${transitionName}`
    });
    if (result.ok) await ensureMarketDemand(clan.id, result.order, result.goal);
    return result;
}

module.exports = {
    ORDER_KIND,
    STRATEGIES,
    actionTypeForGoal,
    buildGoal,
    create,
    current,
    itemSnapshot,
    itemTemplate,
    planFor,
    resolveClan,
    syncProgress,
    transition
};
