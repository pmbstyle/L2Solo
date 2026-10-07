const assert = require('assert');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('market-price-alignment');
require('../src/Global');
isolated.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(isolated.directory, { recursive: true, force: true }));

const DataCache = invoke('GameServer/DataCache');
const Pricing = invoke('GameServer/Bot/Economy/BotMarketPricing');
const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const Listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Market = invoke('GameServer/Bot/Economy/MarketOpportunity');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const OfferQuery = invoke('GameServer/Bot/Economy/OfferQuery');
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
const board = AfkTrade.boardIndex();
const quoteIds = [94004010, 94004011];

function close(actual, expected, message) {
    assert(Number.isFinite(actual) && Number.isFinite(expected), message);
    assert(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-12,
        `${message}: ${actual} vs ${expected}`);
}

// The documented n45e key is evaluated independently of TendencyRoll.
// No RNG, clock, persona or counter is replaced.
function keyedRoll(text) {
    let hash = 2166136261;
    for (const character of text) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    hash += 0x6D2B79F5;
    let value = Math.imul(hash ^ hash >>> 15, 1 | hash);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
}

// E7: public observations enter a weighted log mean; own deals halve the
// understanding part of the error every three deals, in every grade.
// Inputs are the real public APIs, never a returned goal's price.
function publicPrice(id, buyer, context) {
    const observations = [];
    const deals = Counters.itemDeals(id);
    if (deals.prices.length) {
        const sorted = [...deals.prices].sort((left, right) => left - right);
        observations.push([Math.log(sorted[Math.floor(sorted.length / 2)]), Math.min(10, deals.deals)]);
    }
    const ask = board.first(id, AfkTrade.SELL, { excludeOwner: buyer.characterId, enchant: 0 });
    const bid = board.first(id, AfkTrade.BUY, { excludeOwner: buyer.characterId, enchant: 0 });
    if (ask?.price > 0) observations.push([Math.log(ask.price), 1]);
    if (bid?.price > 0) observations.push([Math.log(bid.price), 1]);
    const first = Counters.firstPrice(id, 1000);
    const counter = Counters.counterOf(id);
    const index = Counters.counter(counter, 1000).index;
    if (first > 0 && index !== null) observations.push([Math.log(first) + index, 0.5]);
    const demand = PriceBelief.demandValue(id, 1000);
    if (demand > 0) observations.push([Math.log(demand), 0.3]);
    if (first > 0) observations.push([Math.log(first), 0.3]);
    assert(observations.length > 0, 'the selected item has a public price input');
    const understanding = Math.max(0, Math.min(1, Number(context.persona.understanding ?? 0.3)));
    const experience = Math.max(0, Number(buyer.marketTrades?.[counter]) || 0);
    const error = 0.03 + 0.17 * (1 - understanding) * 0.5 ** (experience / 3);
    const bias = Learning.knowledgeEnabled()
        ? (2 * keyedRoll(`n45e:${buyer.characterId}:${id}`) - 1) * error : 0;
    const weight = observations.reduce((sum, row) => sum + row[1], 0);
    const mu = observations.reduce((sum, row) => sum + row[0] * row[1], 0) / weight + Math.log1p(bias);
    const belief = PriceBelief.prior(id, {
        characterId: buyer.characterId, understanding, marketTrades: buyer.marketTrades,
        knowledgeEnabled: Learning.knowledgeEnabled(), board, timestamp: 1000
    });
    close(belief.K, weight, 'public observation weights');
    close(belief.bias, bias, 'personal price error');
    close(belief.mu, mu, 'public log centre');
    return Math.exp(mu);
}

// E1: an SoE plus the actual missing one-hour kit, not a wallet percentage.
function kitReserve(buyer, context) {
    const escape = context.price(736) * Math.max(0, 1 - Number(buyer.inventory?.[736]?.amount || 0));
    return ['shots', 'potions'].reduce((sum, kind) => {
        const stock = context.stock(kind);
        const held = Number(buyer.inventory?.[stock.itemId]?.amount || 0);
        return sum + Math.max(0, stock.usePerHour - held) * stock.unitPrice;
    }, escape);
}

// E3's consumer equation over a genuine producer packet. A selected item's
// own ratio allows only wallet - R - the higher-ratio cumulative cost.
function itemBudget(buyer, itemId) {
    const packet = buyer.stats.money;
    let ratio = 0;
    for (let index = 4; index + 2 < packet.length; index += 3) {
        if (packet[index + 2] === itemId) {
            ratio = packet[index];
            break;
        }
    }
    if (ratio < packet[1]) return 0;
    let earlier = 0;
    for (let index = 4; index + 2 < packet.length; index += 3) {
        if (packet[index] > ratio) earlier = packet[index + 1];
    }
    return Math.max(0, buyer.adena - packet[2] - earlier);
}

// This is the real hot producer. The original synthetic state has no cold
// phase, and no supplied material wish is accepted as a native decision.
function purchaseFor(buyer) {
    const before = structuredClone(buyer);
    const economy = Economy.forState(buyer, { timestamp: 1000, spot: { id: 'field' } });
    const goals = Needs.evaluate(buyer, { spot: { id: 'field' }, now: 1000, economy });
    const goal = goals.find((row) => row.type === 'upgrade_gear');
    assert(goal, 'the original funded hot gear profile must produce a genuine gear purchase');
    assert.strictEqual(economy.network.activity.activity, 'shopping');
    const id = goal.target.itemId;
    const expectedPrice = publicPrice(id, buyer, economy);
    close(goal.target.adena, expectedPrice, 'selected native leaf unit price');
    close(goal.plan.estimatedCost, expectedPrice * goal.target.amount, 'selected native purchase cost');
    assert.strictEqual(goal.target.amount, 1, 'this gear purchase needs one physical copy');
    assert(economy.network.queue.some((wish) => wish.key === goal.plan.wishKey && wish.funded),
        'a native shopping leaf comes from the funded queue');
    assert.strictEqual(goal.plan.requiredAdena, 0, 'a funded shopping leaf has no funding shortfall');
    const reserve = kitReserve(buyer, economy);
    close(economy.survivalReserve, reserve, 'one-hour survival reserve');
    assert.strictEqual(economy.statsPacket.money[2], Math.round(reserve), 'native saved reserve rounding');
    const funded = { ...buyer, stats: { ...buyer.stats, ...economy.statsPacket } };
    const allowed = itemBudget(funded, id);
    assert.strictEqual(Funding.spendable(funded, 0, { itemId: id }), allowed);
    assert(allowed >= goal.plan.estimatedCost, 'the funded native leaf remains affordable at the consumer');
    assert.deepStrictEqual(buyer, before, 'pricing and capture do not rewrite the original inputs');
    return { buyer: funded, goal, economy, allowed };
}

function checkBid(decision, buyer = decision.buyer, goal = decision.goal, positive = false) {
    const bid = BuyStore.bidFor(buyer, goal, { economy: decision.economy });
    const budget = itemBudget(buyer, goal.target.itemId);
    assert.strictEqual(Funding.spendable(buyer, 0, { itemId: goal.target.itemId }), budget);
    const id = goal.target.itemId;
    const baseValue = decision.economy.network.demands.get(`item:${id}`)
        || decision.economy.projection.values.get(id) || 0;
    const usefulness = baseValue * (Learning.knowledgeEnabled()
        ? 1 + (1 - Number(decision.economy.persona.understanding ?? 0.3))
            * (2 * keyedRoll(`usefulness:${buyer.characterId}:${id}`) - 1) : 1);
    const worth = usefulness / decision.economy.moneyPrice;
    close(decision.economy.worth(id), worth, 'native marginal item value in adena');
    if (positive) assert(bid && bid.price > 0, 'a funded native buyer can publish a positive bid');
    if (bid) {
        assert(bid.price > 0 && bid.count === 1);
        assert(bid.price <= Math.floor(Math.min(worth, budget)), 'bid stays inside marginal value and E3 budget');
        assert(bid.price * bid.count <= budget, 'the kit and higher-valued wishes retain their money');
    }
    return bid;
}

function publishQuote(recordId, id, price, count) {
    board.put({ id: recordId, kind: 'shop', storeType: AfkTrade.SELL,
        ownerId: 2004012, town: 'Giran', botOwned: true, revision: 1,
        lines: [{ lineId: recordId, selfId: id, count, price, enchant: 0 }] });
    const line = board.first(id, AfkTrade.SELL, { excludeOwner: 2004011, enchant: 0 });
    assert(line && line.recordId === recordId && line.price === price && line.count === count,
        'declared quotes enter the actual native board index');
}

function withIncome(buyer, perKill) {
    let next = buyer;
    for (let index = 0; index < 3; index += 1) {
        next = { ...next, stats: { ...next.stats, huntEfficiency: Efficiency.record(next, { spotId: 'field',
            exp: 1000, cycleMs: 60000, adena: perKill * 8, loot: perKill * 2, kills: 10, timestamp: 1000 }) } };
    }
    return next;
}

// Cash-only public quote planning for an unbuilt state, E3's stated no-packet
// fallback. This is not an accepted native material wish or a paid transaction.
function materialQuote(buyer, amount) {
    const before = structuredClone(buyer);
    assert.strictEqual(buyer.stats.money, undefined);
    const basics = Economy.basics(buyer);
    const reserve = kitReserve(buyer, basics);
    const budget = Math.max(0, buyer.adena - reserve);
    close(Funding.spendable(buyer, 0, { upperBound: true }), budget, 'no-packet quote prefilter keeps the real kit');
    const quote = OfferQuery.cheapestTown(board, 2068, {
        amount, money: budget, excludeOwner: buyer.characterId, npcOffers: []
    });
    if (quote) {
        assert(quote.cost <= budget, 'cash-only fill never spends the reserve');
        assert(quote.units <= amount, 'cash-only fill never enlarges the request');
        assert.strictEqual(quote.npc, 0);
        assert.strictEqual(quote.town, 'Giran');
    }
    assert.deepStrictEqual(buyer, before, 'a quote query cannot change money or stock');
    return quote;
}

function noAuthoredComponentWish(buyer) {
    const before = structuredClone(buyer);
    const economy = Economy.forState(buyer, { timestamp: 1000 });
    assert.strictEqual(Needs.evaluate(buyer, { now: 1000, economy }).some((goal) =>
        goal.type === 'buy_craft_material' && goal.target.itemId === 2068), false,
    'recipe 1 and class 0 do not author a Stick of Faith Shaft wish');
    const decided = { ...buyer, stats: { ...buyer.stats, ...economy.statsPacket } };
    assert.strictEqual(itemBudget(decided, 2068), 0, 'this native packet earmarks no funded shaft purchase');
    assert.strictEqual(Funding.spendable(decided, 0, { itemId: 2068 }), 0,
        'a public cash quote is not permission to spend for an unselected native material');
    assert.deepStrictEqual(buyer, before, 'the unauthored plan does not manufacture inventory or funding');
}

try {
    for (const rate of ['x1', 'x10', 'x50']) {
        process.env.L2NODE_PROGRESSION_RATE = rate;
        const rich = { ...state, adena: 1000000000 };
        const native = purchaseFor(rich);
        const item = pricingItem(439);
        assert.strictEqual(Pricing.referencePrice(item), Math.floor(item.basePrice
            * invoke('GameServer/ProgressionRates').profile().adena), `${rate}: the separate reference API follows the server rate`);
        checkBid(native, native.buyer, native.goal, true);

        const npcItem = pricingItem(178);
        const npcPrice = Math.min(...Market.npcOffersAll(178).map((offer) => offer.price));
        assert.strictEqual(Pricing.npcPrice(npcItem), npcPrice);
        const preferred = Disposition.priceFor(rich, npcItem, template(178));
        assert(preferred < npcPrice, 'the initial sale valuation must also account for NPC alternatives');
    }

    process.env.L2NODE_PROGRESSION_RATE = 'x10';
    const native = purchaseFor(state);
    assert.strictEqual(Pricing.referencePrice(pricingItem(439)), 3790000,
        'Karmian Tunic reference has no ordinary NPC alternative');
    // ARCH-NOTE: E1/E3 and the one-leaf goal rule replace the 10% reserve and
    // saved target/quote priority. All native bids below consume a real hot
    // packet; this test never supplies a selected leaf or money numbers.
    const bid = checkBid(native, native.buyer, native.goal, true);
    const legacyGoal = { ...native.goal, target: { ...native.goal.target, adena: 379000 },
        plan: { estimatedCost: 379000, marketTown: null } };
    const legacyBid = checkBid(native, native.buyer, legacyGoal, true);
    assert.strictEqual(legacyBid.price, bid.price, 'a saved estimate does not override the native marginal value');
    assert.strictEqual(legacyBid.count, bid.count);
    checkBid(native, { ...native.buyer, adena: 2000000 });
    const reserved = checkBid(native, native.buyer, {
        ...native.goal, plan: { ...native.goal.plan, reserve: 1000000 }
    }, true);
    assert.strictEqual(reserved.price, bid.price, 'an old plan reserve cannot replace E1/E3 packet funding');
    assert.strictEqual(reserved.count, bid.count);

    const quotedState = { ...state, stats: { ...state.stats, equipmentPlan: {
        ...state.stats.equipmentPlan, market: { price: 2500000, town: 'Giran', reserve: 50000 }
    } } };
    publishQuote(quoteIds[0], 439, 2500000, 1);
    const nativeQuoted = purchaseFor(quotedState);
    publicPrice(439, quotedState, nativeQuoted.economy);
    const quote = OfferQuery.bestSellOffer(board, 439, { budget: quotedState.adena, excludeOwner: quotedState.characterId });
    assert.strictEqual(quote.selfId, 439);
    assert.strictEqual(quote.price, 2500000, 'a published concrete quote is not multiplied by the server rate');
    assert.strictEqual(quote.town, 'Giran');
    assert.strictEqual(quote.sourceType, 'afk_bot_store');
    checkBid(nativeQuoted, nativeQuoted.buyer, nativeQuoted.goal, true);

    const materialBuyer = withIncome({ characterId: 2004011, level: 50, adena: 10000000,
        inventory: {}, stats: { equipmentPlan: { status: 'active', strategy: 'craft',
            recipeId: 1, marketFallback: false, clanGoal: { clanId: 1 }, materials: [
                { selfId: 2068, amount: 3, missing: 3, farmEffort: 1000 }
            ], next: { itemId: 2068 } } } }, 12500);
    const authored = Recipes.resolveByRecipeId(materialBuyer.stats.equipmentPlan.recipeId);
    assert.strictEqual(authored.productId, 17, 'recipe 1 is the authored Wooden Arrow recipe');
    assert.deepStrictEqual(authored.materials.map((row) => [row.selfId, row.amount]), [[1864, 4], [1869, 2]]);
    assert(!authored.materials.some((row) => row.selfId === 2068));
    assert.strictEqual(materialBuyer.stats.classId, undefined, 'the original implicit class 0 is retained');
    assert.strictEqual(materialBuyer.stats.money, undefined);
    const highIncome = Efficiency.huntIncome(materialBuyer, 1000);
    const lowIncomeBuyer = withIncome({ ...materialBuyer,
        stats: { ...materialBuyer.stats, huntEfficiency: [] } }, 1250);
    const lowIncome = Efficiency.huntIncome(lowIncomeBuyer, 1000);
    assert.strictEqual(highIncome.source, 'own');
    assert.strictEqual(lowIncome.source, 'own');
    assert.strictEqual(highIncome.perKill, 12500);
    assert.strictEqual(lowIncome.perKill, 1250);
    assert.strictEqual(highIncome.perHour, 10 * 12500 / 60000 * 3600000);
    assert.strictEqual(lowIncome.perHour, 10 * 1250 / 60000 * 3600000);
    assert.strictEqual(3000000 * 3 / lowIncome.perHour, 10 * (3000000 * 3 / highIncome.perHour),
        'the same public lot costs ten times as many measured hunt-hours to the poorer earner');

    // ARCH-NOTE: option B preserves the unauthored recipe1/2068x3/class0
    // input. The positive control below proves native public pricing and
    // missing-quantity/cash fills, not a synthetic native material decision.
    publishQuote(quoteIds[1], 2068, 3000000, 3);
    noAuthoredComponentWish(materialBuyer);
    noAuthoredComponentWish(lowIncomeBuyer);
    const materialContext = Economy.basics(materialBuyer, { timestamp: 1000 });
    const cheapPrice = publicPrice(2068, materialBuyer, materialContext);
    const full = materialQuote(materialBuyer, 3);
    assert(full && full.whole && full.units === 3);
    assert.strictEqual(full.cost, 3 * 3000000);
    assert.strictEqual(full.lines.length, 1);
    assert.strictEqual(full.lines[0].count, 3);

    publishQuote(quoteIds[1], 2068, 7000000, 3);
    noAuthoredComponentWish(materialBuyer);
    const costlyPrice = publicPrice(2068, materialBuyer, materialContext);
    assert(costlyPrice > cheapPrice, 'the published higher ask raises the fresh public prior without a fictitious deal');
    const costly = materialQuote(materialBuyer, 3);
    assert(costly && !costly.whole && costly.units === 1);
    assert.strictEqual(costly.cost, 7000000, 'an unfundable whole lot stays a partial public fill');
    const partial = { ...materialBuyer, inventory: { 2068: { selfId: 2068, amount: 2 } } };
    const missing = Planner.missingMaterials({ materials: materialBuyer.stats.equipmentPlan.materials }, partial.inventory);
    assert.deepStrictEqual(missing.map((row) => [row.selfId, row.amount, row.owned, row.missing]), [[2068, 3, 2, 1]],
        'the bounded original request is three copies, two held, one missing');
    noAuthoredComponentWish(partial);
    const expensiveRemainder = materialQuote(partial, missing[0].missing);
    assert(expensiveRemainder && expensiveRemainder.whole && expensiveRemainder.units === 1);
    assert.strictEqual(expensiveRemainder.cost, 7000000);
    publishQuote(quoteIds[1], 2068, 3000000, 3);
    const cheapRemainder = materialQuote(partial, missing[0].missing);
    assert(cheapRemainder && cheapRemainder.whole && cheapRemainder.units === 1);
    assert.strictEqual(cheapRemainder.cost, 3000000, 'the quote requests only the missing copy at its actual unit price');
    assert.strictEqual(partial.inventory[2068].amount, 2, 'a quote never manufactures the missing copy');
    const poor = { ...materialBuyer, adena: 200000 };
    noAuthoredComponentWish(poor);
    assert.strictEqual(materialQuote(poor, 3), null, 'the original 200k wallet cannot fill a 3M component quote');
    noAuthoredComponentWish({ ...materialBuyer, stats: { ...materialBuyer.stats, marketRetryAfter: 1001 } });

    // The material profile has no authored wish to travel for. Exercise the
    // actual retry consumer with the same timestamp and a genuine native hot
    // gear goal instead; this is a refusal, not a successful-trip claim.
    const retryBuyer = { ...native.buyer, stats: { ...native.buyer.stats, marketRetryAfter: 1001 } };
    const retryBefore = structuredClone(retryBuyer);
    assert.strictEqual(GoalExecutor.beginMarketTravel(retryBuyer, native.goal, 1000), null,
        'a genuine native purchase respects a future retry deadline');
    assert.deepStrictEqual(retryBuyer, retryBefore, 'retry refusal spends no money or inventory');

    const enchanted = { ...pricingItem(178), enchant: 3 };
    assert.strictEqual(Pricing.npcPrice(enchanted), Infinity, 'ordinary NPC stock must not cap enchanted gear');
    const inventoryState = { ...state, stats: {}, inventory: { 178: {
        selfId: 178, amount: 2, equipped: true, equippedCount: 1, enchant: null,
        instances: [{ equipped: true, enchant: 0 }, { equipped: false, enchant: 3 }]
    } } };
    const inventoryBefore = structuredClone(inventoryState);
    const saleable = Disposition.saleCandidates(inventoryState).filter((item) => item.selfId === 178);
    assert.strictEqual(saleable.length, 1, 'the equipped +0 copy is not a sale lot');
    const candidate = saleable[0];
    assert.strictEqual(candidate.npcComparable, false, 'enchanted saleable stock must not be capped by ordinary NPC stock');
    // Native sale lots group only unequipped copies of the same enchant.
    // The original input has exactly one available +3 copy, not a mixed lot.
    assert.strictEqual(candidate.enchant, 3, 'the sale lot preserves the only unequipped copy enchant');
    assert.strictEqual(candidate.count, 1, 'one equipped copy leaves one physical copy for sale');
    assert.deepStrictEqual(inventoryState, inventoryBefore, 'sale valuation cannot mutate either physical copy');
    assert.strictEqual(inventoryState.inventory[178].instances[0].equipped, true, 'the equipped +0 copy stays equipped');
    assert.strictEqual(Pricing.npcPrice(candidate), Infinity);
    assert(candidate.price > Pricing.npcPrice(pricingItem(178)));

    // Gear the NPC also sells is the market's like any other: the NPC price is
    // one more offer the buyers weigh, not a clamp (group E).
    const npcItem = pricingItem(178);
    const decision = Listings.classify(state, { ...npcItem, price: 3394700, count: 1, kind: 'Weapon.Blunt', rank: 'd' });
    assert.strictEqual(decision.action, 'market');

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
    for (const id of quoteIds) board.remove(id);
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
