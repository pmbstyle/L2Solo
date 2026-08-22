const Database = invoke('Database');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanService = invoke('GameServer/Clan/ClanService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');

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
    if (!clan || number(clan.level) !== 2) return { ok: true, skipped: true, reason: 'level_not_marketable' };
    const goal = clan.state?.goal;
    if (!goal || goal.type !== 'item' || goal.plan?.kind !== 'market' || number(goal.progress) >= number(goal.required)) {
        return { ok: true, skipped: true, reason: 'market_goal_missing' };
    }
    const itemId = number(goal.target?.itemId);
    const candidates = (clan.members || [])
        .filter((member) => member.phase === 'cold' && number(member.characterId) > 0)
        .sort((left, right) => number(right.adena) - number(left.adena) || number(left.characterId) - number(right.characterId));
    let offer = null;
    let buyer = null;
    for (const candidate of candidates) {
        const state = await stateFor(candidate.characterId);
        if (!state || state.phase !== 'cold' || String(state.partyId || '') !== '') continue;
        const nextOffer = MarketOpportunity.bestOffer(itemId, {
            town: state.currentRegion || 'Giran',
            budget: number(state.adena),
            buyerCharacterId: state.characterId
        });
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

    const shoppingState = {
        ...buyer,
        activity: 'shopping',
        currentRegion: offer.town || buyer.currentRegion || 'Giran'
    };
    const purchaseGoal = {
        type: 'buy_craft_material',
        status: 'active',
        target: { itemId, itemName: goal.target?.itemName || 'Blood Mark' },
        plan: {
            expectedBenefit: 'market_buy_craft_material',
            marketTown: shoppingState.currentRegion
        }
    };
    const purchase = await ColdMarketService.tryPurchase(shoppingState, purchaseGoal);
    if (!purchase?.purchased || !purchase.state) {
        metrics.blocked += 1;
        recordReason(purchase?.reason || Contracts.REASON_CODES.MARKET_PRICE_UNACCEPTABLE);
        return { ok: false, code: purchase?.reason || Contracts.REASON_CODES.MARKET_PRICE_UNACCEPTABLE, purchase };
    }
    metrics.purchases += 1;
    recordReason('market_purchase');

    const inventoryRows = await Database.fetchItems(buyer.characterId);
    const item = (inventoryRows || []).find((row) => Number(row.selfId) === itemId && Number(row.amount) > 0);
    if (!item) {
        metrics.blocked += 1;
        recordReason('market_purchase_inventory_missing');
        return { ok: false, code: 'market_purchase_inventory_missing', purchase };
    }
    const deposited = await Database.transferInventoryToClanWarehouse({
        clanId: clan.id,
        characterId: buyer.characterId,
        item,
        amount: 1,
        expectedWarehouseRevision: number(clan.state?.warehouseRevision),
        expectedSimulationRevision: number(purchase.state.simulationRevision),
        resolveKey: `${clan.id}:market:${goal.updatedAt}:${buyer.characterId}:${itemId}`
    });
    if (!deposited.ok) {
        metrics.blocked += 1;
        recordReason(deposited.code);
        return { ok: false, code: deposited.code, purchase, deposited };
    }
    metrics.deposited += 1;
    recordReason('market_item_to_clan_warehouse');
    const demandKey = `${clan.id}:level-${number(clan.level)}:${itemId}`;
    await Database.upsertClanMarketDemand({
        clanId: clan.id,
        itemId,
        amount: 1,
        maxPrice: Config.bloodMarkMaxPrice,
        goalKey: demandKey,
        status: 'fulfilled'
    });
    await Database.syncClanMarketDemandSignal({
        clanId: clan.id,
        itemId,
        amount: 1,
        maxPrice: Config.bloodMarkMaxPrice,
        goalKey: demandKey,
        status: 'fulfilled'
    });
    await Database.recordClanGoalEvent({
        clanId: clan.id,
        eventType: 'market_purchase',
        goalType: goal.type,
        plan: goal.plan.kind,
        reasonCode: 'market_item_to_clan_warehouse',
        payload: { itemId, amount: 1, buyerCharacterId: buyer.characterId, sourceType: offer.sourceType, sourceId: offer.sourceId }
    });
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
