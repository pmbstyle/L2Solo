const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Pricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const Listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
DataCache.init();

const originalRate = process.env.L2NODE_PROGRESSION_RATE;
const originalSpawns = DataCache.npcSpawns;
const template = (id) => DataCache.items.find((item) => Number(item.selfId) === id);
const pricingItem = (id) => ({ selfId: id, basePrice: template(id).template.price });
const state = {
    characterId: 2004010, level: 40, adena: 3088547,
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    stats: {
        classId: 27, equipment: [],
        equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 439, slot: 10 } }
    }
};
function goalFor(buyer) {
    return Needs.evaluate(buyer, { spot: { id: 'field' }, now: 1000 })
        .find((goal) => goal.type === 'upgrade_gear');
}

try {
    for (const rate of ['x1', 'x10', 'x50']) {
        process.env.L2NODE_PROGRESSION_RATE = rate;
        const rich = { ...state, adena: 1000000000 };
        const goal = goalFor(rich);
        const item = pricingItem(439);
        assert.strictEqual(goal.target.adena, Pricing.referencePrice(item), `${rate}: gear estimates must use the market reference`);
        assert.strictEqual(goal.plan.priceSource, 'reference');
        const bid = BuyStore.bidFor(rich, goal);
        assert(bid.price >= Listings.listingFloor(item), `${rate}: a funded bid must overlap the seller's permitted range`);

        const npcItem = pricingItem(178);
        const npcPrice = Math.min(...Market.npcOffersAll(178).map((offer) => offer.price));
        assert.strictEqual(Pricing.npcPrice(npcItem), npcPrice);
        const ask = Listings.listingPrice({ ...npcItem, price: 3394700 }, {});
        assert(ask < npcPrice, `${rate}: a stale Bone Staff ask must undercut available NPC stock`);
        assert(ask >= npcItem.basePrice * 0.5, 'private asks must remain above NPC liquidation value');
        const preferred = Disposition.priceFor(rich, npcItem, template(178));
        assert(preferred < npcPrice, 'the initial sale valuation must also account for NPC alternatives');
    }

    process.env.L2NODE_PROGRESSION_RATE = 'x10';
    const goal = goalFor(state);
    assert.strictEqual(goal.target.adena, 3790000, 'Karmian Tunic has no ordinary NPC alternative');
    // The shortfall keeps the operating reserve (10% of the budget here) like
    // every other purchase (PurchaseFunding): 701,453 + 308,855.
    assert.strictEqual(goal.plan.requiredAdena, 1010308, 'funding shortfall must use the corrected estimate and keep the operating reserve');
    const legacyGoal = {
        ...goal,
        target: { ...goal.target, adena: 379000 },
        plan: { estimatedCost: 379000, marketTown: null }
    };
    const bid = BuyStore.bidFor(state, legacyGoal);
    // The shared operating reserve rounds its 10% up (PurchaseFunding), one adena below the old floor.
    assert.strictEqual(bid.price, 2779692, 'the saved CorinCloud estimate must no longer cap his bid at 379000');
    assert(bid.price >= Listings.listingFloor(pricingItem(439)));
    assert(bid.price * bid.count <= state.adena - Math.floor(state.adena * 0.1));
    assert.strictEqual(BuyStore.bidFor({ ...state, adena: 2000000 }, goal), null,
        'a buyer below the seller floor must return to earning rather than open an unfillable WTB');
    assert.strictEqual(BuyStore.bidFor(state, { ...goal, plan: { ...goal.plan, reserve: 1000000 } }), null,
        'a purchase plan reserve must not be spent to fund a store');

    const quotedState = { ...state, stats: { ...state.stats, equipmentPlan: {
        ...state.stats.equipmentPlan, market: { price: 2500000, town: 'Giran', reserve: 50000 }
    } } };
    const quotedGoal = goalFor(quotedState);
    assert.strictEqual(quotedGoal.target.adena, 2500000, 'a concrete offer must not be multiplied by the rate again');
    assert.strictEqual(quotedGoal.plan.priceSource, 'offer');
    assert.strictEqual(BuyStore.bidFor(state, quotedGoal).price, 2500000, 'WTB must respect a concrete offer limit');

    const originalOffers = AfkTrade.offers;
    // A kill is worth the bot's measured income per kill (its hour value),
    // whatever the rate: three hunts of 10 kills earning perKill each.
    const withIncome = (buyer, perKill) => {
        let next = buyer;
        for (let i = 0; i < 3; i += 1) {
            next = { ...next, stats: { ...next.stats, huntEfficiency: Efficiency.record(next, { spotId: 'field',
                exp: 1000, cycleMs: 60000, adena: perKill * 8, loot: perKill * 2, kills: 10, timestamp: 1000 }) } };
        }
        return next;
    };
    const materialBuyer = withIncome({ characterId: 2004011, level: 50, adena: 10000000,
        inventory: {}, stats: { equipmentPlan: { status: 'active', strategy: 'craft',
            recipeId: 1, marketFallback: false, clanGoal: { clanId: 1 }, materials: [
                { selfId: 2068, amount: 3, missing: 3, farmEffort: 1000 }
            ], next: { itemId: 2068 } } } }, 12500);
    try {
        let ask = 3000000;
        AfkTrade.offers = (selfId, type, options) => {
            assert.strictEqual(Number(selfId), 2068);
            assert.strictEqual(type, AfkTrade.SELL);
            assert.strictEqual(options.characterId, materialBuyer.characterId);
            return [{ selfId: 2068, price: ask, count: 3, town: 'Giran',
                sourceType: 'afk_bot_store', sourceId: 2004012 }];
        };
        const materialGoal = (buyer = materialBuyer) => Needs.evaluate(buyer, { now: 1000 })
            .find((candidate) => candidate.type === 'buy_craft_material');
        const wanted = materialGoal();
        assert.strictEqual(wanted.target.itemId, 2068, 'a fresh craft plan must notice a cheaper AFK component');
        assert.strictEqual(wanted.plan.marketTown, 'Giran');
        assert.strictEqual(wanted.plan.priceSource, 'offer');
        assert.strictEqual(BuyStore.bidFor(materialBuyer, wanted).price, ask,
            'a reviewed AFK ask may exceed the generic material price cap');
        // The decided hour value (N0b/G8) replaces the author's level x 25 x rate:
        // a bot that measurably earns a tenth per kill finds the same ask too expensive.
        assert.strictEqual(materialGoal(withIncome({ ...materialBuyer,
            stats: { ...materialBuyer.stats, huntEfficiency: [] } }, 1250)), undefined,
        'the same ask must be too expensive for a bot that earns a tenth per kill');
        ask = 7000000;
        assert.strictEqual(materialGoal(), undefined, 'an ask costlier than farming must be ignored');
        assert.strictEqual(Needs.evaluate({ ...materialBuyer,
            inventory: { 2068: { selfId: 2068, amount: 2 } } }, { now: 1000 })
            .some((candidate) => candidate.type === 'buy_craft_material'), false,
        'a partial purchase must not inflate the estimated farm cost of the remaining piece');
        ask = 3000000;
        assert.strictEqual(Needs.evaluate({ ...materialBuyer,
            inventory: { 2068: { selfId: 2068, amount: 2 } } }, { now: 1000 })
            .find((candidate) => candidate.type === 'buy_craft_material').target.amount, 1,
        'a revised order must request only the remaining component');
        assert.strictEqual(Needs.evaluate({ ...materialBuyer, adena: 200000 }, { now: 1000 })
            .some((candidate) => candidate.type === 'buy_craft_material'), false,
        'the bot must retain its Adena reserve');
        assert.strictEqual(Needs.evaluate({ ...materialBuyer, stats: { ...materialBuyer.stats,
            marketRetryAfter: 1001 } }, { now: 1000 })
            .some((candidate) => candidate.type === 'buy_craft_material'), false,
        'a failed material purchase must respect retry delay');
    } finally {
        AfkTrade.offers = originalOffers;
    }

    const enchanted = { ...pricingItem(178), enchant: 3 };
    assert.strictEqual(Pricing.npcPrice(enchanted), Infinity, 'ordinary NPC stock must not cap enchanted gear');
    assert.strictEqual(Listings.listingFloor(enchanted), 2454000);
    const inventoryState = { ...state, stats: {}, inventory: { 178: {
        selfId: 178, amount: 2, equipped: true, equippedCount: 1, enchant: null,
        instances: [{ equipped: true, enchant: 0 }, { equipped: false, enchant: 3 }]
    } } };
    const candidate = Disposition.saleCandidates(inventoryState).find((item) => item.selfId === 178);
    assert.strictEqual(candidate.npcComparable, false, 'enchanted saleable stock must not be capped by ordinary NPC stock');
    assert.strictEqual(candidate.enchant, undefined, 'aggregated stock must not advertise one enchant level for every instance');
    assert.strictEqual(Pricing.npcPrice(candidate), Infinity);
    assert(candidate.price > Pricing.npcPrice(pricingItem(178)));

    // Rechecking a persisted pre-fix ask must classify demand at the corrected
    // price, otherwise the old overprice still makes its actual buyer invisible.
    const npcItem = pricingItem(178);
    const buyer = { characterId: 2, adena: 900000, stats: {
        equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 178 } }
    } };
    const decision = Listings.classify(state, {
        ...npcItem, price: 3394700, count: 1, kind: 'Weapon.Blunt', rank: 'd'
    }, { states: [buyer], now: 1000 });
    assert.strictEqual(decision.action, 'list', 'NPC-aware repricing must make funded demand visible for old stores');

    DataCache.npcSpawns = [];
    assert.strictEqual(Pricing.npcPrice(npcItem), Infinity, 'unspawned catalog shops are not available alternatives');
    DataCache.npcSpawns = originalSpawns;
    assert.strictEqual(Pricing.npcPrice(npcItem), 899800, 'NPC price cache must refresh when spawns reload');

    const originalInvoke = global.invoke;
    global.invoke = (name) => {
        assert(!name.startsWith('GameServer/World/'), 'snapshot pricing must not load live world dependencies');
        return originalInvoke(name);
    };
    try {
        Pricing.useNpcOfferSnapshot([{ selfId: 178, price: 490800 }, { selfId: 178, price: 449900 }]);
        DataCache.npcSpawns = [];
        assert.strictEqual(Pricing.referencePrice(npcItem), 449900, 'worker snapshots must use the same cheapest NPC price');
        Pricing.useNpcOfferSnapshot([{ selfId: 178, price: 480000 }]);
        assert.strictEqual(Pricing.referencePrice(npcItem), 480000, 'a replaced worker catalog must replace cached prices');
    } finally {
        global.invoke = originalInvoke;
    }
    console.log('Bot market price alignment checks passed');
} finally {
    DataCache.npcSpawns = originalSpawns;
    if (originalRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
    else process.env.L2NODE_PROGRESSION_RATE = originalRate;
}
