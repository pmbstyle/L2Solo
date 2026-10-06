const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanService = invoke('GameServer/Clan/ClanService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const ClanOrderService = invoke('GameServer/Clan/ClanOrderService');
const ClanEconomy = require('./ClanEconomyContext');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const PurchaseFunding = invoke('GameServer/Bot/Economy/PurchaseFunding');

const metrics = {
    resolves: 0,
    purchases: 0,
    deposited: 0,
    noOffer: 0,
    blocked: 0,
    levelUps: 0,
    budgetStops: 0,
    reasonCounts: new Map()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function recordReason(code) {
    if (code) metrics.reasonCounts.set(code, (metrics.reasonCounts.get(code) || 0) + 1);
}

async function stateFor(characterId) {
    const cached = LifeState.cachedState(characterId);
    if (cached) return cached;
    const states = await LifeState.statesByIds([characterId], { ownerId: 'legacy_main', unassigned: true });
    return states[0] || null;
}

async function resolveClan(clan) {
    const playerControlled = String(clan?.state?.mode || '') === 'player_managed'
        && String(clan?.state?.goal?.controlledBy || '') === 'player';
    if (!clan || !playerControlled && number(clan.level) !== 2) {
        return { ok: true, skipped: true, reason: 'level_not_marketable' };
    }
    const goal = clan.state?.goal;
    if (!goal || goal.type !== 'item' || goal.plan?.kind !== 'market' || number(goal.progress) >= number(goal.required)) {
        return { ok: true, skipped: true, reason: 'market_goal_missing' };
    }
    const itemId = number(goal.target?.itemId);
    const assigned = new Set((goal.assignedMemberIds || []).map(Number).filter(Boolean));
    const order = playerControlled ? await ClanOrderService.current(clan.id) : null;
    const remainingBudget = order && number(order.budget) > 0
        ? Math.max(0, number(order.budget) - number(order.spent))
        : Infinity;
    const maxUnitPrice = order ? number(order.maxUnitPrice) : Infinity;
    const candidates = ClanOrderService.marketMembers(clan, [...assigned]);
    const warehouse = playerControlled ? [] : await Database.fetchClanWarehouseItems(clan.id);
    const initialOffer = playerControlled ? null : MarketOpportunity.bestOffer(itemId, { budget: Infinity });
    const economy = playerControlled ? null : ClanEconomy.forClan(clan, {
        warehouse, halls: await Database.fetchClanHallAuctions(), proofOffer: initialOffer });
    const clanBudget = economy ? Math.min(economy.budgetFor('level', itemId),
        invoke('GameServer/ClanHall/Policy').freeAdena(warehouse, clan, clan.state?.mode, null)) : 0;
    // A member on its errand for the clan is on its way; one back from it
    // holds the item and deposits it (the purchase was made in the seller's
    // town, the one purchase path, ColdMarketService.acquire).
    for (const candidate of candidates) {
        const state = await stateFor(candidate.characterId);
        const errand = state?.stats?.marketErrand;
        if (errand?.purpose === 'clan' && Number(errand.tag?.clanId) === Number(clan.id)) {
            recordReason('market_buyer_traveling');
            return { ok: true, skipped: true, reason: 'market_buyer_traveling' };
        }
        const last = state?.stats?.lastErrand;
        if (state?.phase === 'cold' && last?.purpose === 'clan' && Number(last.tag?.clanId) === Number(clan.id)
            && Number(last.selfId) === itemId && Number(state.inventory?.[itemId]?.amount || 0) > 0) {
            return deposit(clan, goal, itemId, state, { state }, last.tag.offer, { playerControlled, order });
        }
    }
    let offer = null;
    let buyer = null;
    for (const candidate of candidates) {
        const state = await stateFor(candidate.characterId);
        if (!state || state.phase !== 'cold' || String(state.partyId || '') !== '') continue;
        const nextOffer = playerControlled ? ClanOrderService.memberOffer(state, itemId, Math.min(maxUnitPrice, remainingBudget))
            : MarketOpportunity.bestOffer(itemId, { buyerCharacterId: state.characterId,
                budget: Math.min(Number(goal.plan.maxPrice) || Infinity, PurchaseFunding.spendable(state, 0, { free: true }) + clanBudget) });
        if (nextOffer) {
            offer = nextOffer;
            buyer = state;
            break;
        }
    }
    if (!offer || !buyer) {
        metrics.noOffer += 1;
        recordReason(Contracts.REASON_CODES.MARKET_NO_OFFER);
        return { ok: true, skipped: true, reason: Contracts.REASON_CODES.MARKET_NO_OFFER };
    }

    // The member buys in the offer's town (б5): at once when it stands there,
    // else it goes there with an errand and deposits at a later resolve.
    // ARCH-NOTE: No member clan-value wish exists; clan purchases use only unearmarked personal money and the treasury.
    const clanPart = playerControlled ? 0 : Math.max(0, Math.ceil(Number(offer.price)) - PurchaseFunding.spendable(buyer, 0, { free: true }));
    if (clanPart > 0) {
        const paid = await Database.payClanMember({ clanId: clan.id, characterId: buyer.characterId, amount: clanPart,
            kind: 'clan_level_purchase', moveMark: false, progressionGoal: goal });
        if (!paid.ok) return { ok: false, code: paid.code };
        buyer = LifeState.acceptNewerLifecycleRow(paid.row) || await LifeState.findByCharacterId(buyer.characterId);
    }
    const placed = { price: Number(offer.price), sourceType: offer.sourceType, sourceId: offer.sourceId, town: offer.town };
    const purchase = await ColdMarketService.acquire(buyer, itemId, 1, {
        towns: offer.town ? [offer.town] : null, maxPrice: Number(offer.price), npc: offer.sourceType === 'npc',
        purpose: 'clan', money: Number(offer.price), tag: { clanId: clan.id, offer: placed, clanPart }
    });
    if (!purchase.bought || !purchase.state) {
        if (purchase.traveling || purchase.state?.stats?.marketErrand) {
            recordReason('market_buyer_traveling');
            return { ok: true, skipped: true, reason: 'market_buyer_traveling' };
        }
        if (clanPart > 0) {
            const refund = await Database.payClanMember({ clanId: clan.id, characterId: buyer.characterId, amount: -clanPart,
                kind: 'clan_level_purchase_refund', moveMark: false });
            if (refund.ok) LifeState.acceptNewerLifecycleRow(refund.row);
        }
        metrics.blocked += 1;
        recordReason(Contracts.REASON_CODES.MARKET_PRICE_UNACCEPTABLE);
        return { ok: false, code: Contracts.REASON_CODES.MARKET_PRICE_UNACCEPTABLE, purchase };
    }
    metrics.purchases += 1;
    recordReason('market_purchase');
    return deposit(clan, goal, itemId, buyer, purchase, placed, { playerControlled, order });
}

// The member's purchase goes to the clan warehouse and advances its goal.
async function deposit(clan, goal, itemId, buyer, purchase, offer, { playerControlled, order }) {
    const inventoryRows = await Database.fetchItems(buyer.characterId);
    const item = (inventoryRows || []).find((row) => Number(row.selfId) === itemId && Number(row.amount) > 0);
    if (!item) {
        metrics.blocked += 1;
        recordReason('market_purchase_inventory_missing');
        return { ok: false, code: 'market_purchase_inventory_missing', purchase };
    }
    // Funding changes the warehouse revision and the purchase advances the
    // member's native lifecycle. Deposit against those completed writes.
    const currentClan = await GoalService.clanProjectionById(clan.id);
    const currentGoal = currentClan?.state?.goal;
    if (!currentGoal || Number(currentGoal.updatedAt) !== Number(goal.updatedAt)
        || Number(currentGoal.target?.itemId) !== itemId || currentGoal.plan?.kind !== 'market') {
        return { ok: false, code: 'clan_market_goal_changed', purchase };
    }
    const deposited = await Database.transferInventoryToClanWarehouse({
        clanId: clan.id,
        characterId: buyer.characterId,
        item,
        amount: 1,
        expectedWarehouseRevision: number(currentClan.state?.warehouseRevision),
        expectedSimulationRevision: number(purchase.state.simulation?.revision),
        resolveKey: `${clan.id}:market:${goal.updatedAt}:${buyer.characterId}:${itemId}`
    });
    if (!deposited.ok) {
        metrics.blocked += 1;
        recordReason(deposited.code);
        return { ok: false, code: deposited.code, purchase, deposited };
    }
    if (deposited.state) LifeState.acceptNewerLifecycleRow(deposited.state);
    metrics.deposited += 1;
    recordReason('market_item_to_clan_warehouse');
    const demandKey = playerControlled ? `player-order:${number(order?.id)}:${itemId}` : `${clan.id}:level-${number(clan.level)}:${itemId}`;
    const remaining = playerControlled ? Math.max(1, number(goal.required) - number(goal.progress) - 1) : 1;
    const demandMaxPrice = playerControlled ? Math.max(1, number(order?.maxUnitPrice)) : Math.max(1, number(offer.price));
    await Database.upsertClanMarketDemand({
        clanId: clan.id,
        itemId,
        amount: remaining,
        maxPrice: demandMaxPrice,
        goalKey: demandKey,
        status: playerControlled && number(goal.progress) + 1 < number(goal.required) ? 'open' : 'fulfilled'
    });
    await Database.syncClanMarketDemandSignal({
        clanId: clan.id,
        itemId,
        amount: remaining,
        maxPrice: demandMaxPrice,
        goalKey: demandKey,
        status: playerControlled && number(goal.progress) + 1 < number(goal.required) ? 'open' : 'fulfilled'
    });
    await Database.recordClanGoalEvent({
        clanId: clan.id,
        eventType: 'market_purchase',
        goalType: goal.type,
        plan: goal.plan.kind,
        reasonCode: 'market_item_to_clan_warehouse',
        payload: { itemId, amount: 1, buyerCharacterId: buyer.characterId, sourceType: offer.sourceType, sourceId: offer.sourceId }
    });
    if (playerControlled) {
        const progress = await ClanOrderService.syncProgress(clan, number(offer.price), 'market_item_to_clan_warehouse');
        return { ok: !!progress.ok, purchased: true, deposited, order: progress.order, goal: progress.goal, offer };
    }
    const advanced = await Database.advanceAutonomousClanLevel({
        clanId: clan.id,
        fromLevel: 2,
        toLevel: 3,
        requiredAmount: 1,
        requiredItemId: itemId,
        requiredItemAmount: 1
    });
    if (advanced.ok) {
        metrics.levelUps += 1;
        await ClanCrestService.ensureAutonomousCrest(clan.id);
        recordReason(Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
        if (typeof ClanService.reload === 'function') await ClanService.reload();
    }
    return { ok: true, purchased: true, deposited, advanced, offer };
}

const ClanMarketService = {
    config: Config,
    resolveClan,

    resolveBatch(limit = Config.resolveBatchSize, options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, purchases: 0, budgetStopped: false });
        const deadlineAt = Date.now() + Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        return GoalService.clanProjection().then(async (clans) => {
            const summary = { attempted: 0, purchases: 0, deposited: 0, levelUps: 0, blocked: 0, budgetStopped: false };
            for (const clan of clans.slice(0, Math.max(1, number(limit, Config.resolveBatchSize)))) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    metrics.budgetStops += 1;
                    break;
                }
                const before = { purchases: metrics.purchases, deposited: metrics.deposited, levelUps: metrics.levelUps, blocked: metrics.blocked };
                const result = await resolveClan(clan);
                summary.attempted += 1;
                summary.purchases += metrics.purchases - before.purchases;
                summary.deposited += metrics.deposited - before.deposited;
                summary.levelUps += metrics.levelUps - before.levelUps;
                summary.blocked += metrics.blocked - before.blocked;
                if (result?.ok === false) summary.blocked += 1;
            }
            metrics.resolves += summary.attempted;
            return summary;
        });
    },

    metrics() {
        return {
            resolves: metrics.resolves,
            purchases: metrics.purchases,
            deposited: metrics.deposited,
            noOffer: metrics.noOffer,
            blocked: metrics.blocked,
            levelUps: metrics.levelUps,
            budgetStops: metrics.budgetStops,
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries())
        };
    },

    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanMarketService;
