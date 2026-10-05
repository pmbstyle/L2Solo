const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');

DataCache.init();

// A competitor's supply is a board sell ad (the bots' stalls are gone, step 3.3).
let supplyRecordId = 995000;
function boardSupply(ownerId, selfId, count, price, town = 'Giran') {
    const id = ++supplyRecordId;
    AfkTrade.refreshRecord({ id, ownerId, ownerName: `Seller${ownerId}`, ownerAccount: `bot_${ownerId}`, kind: 'sell_ad',
        storeType: 1, status: 'active', town, title: '', revision: 1, expiresAt: 0, locX: 0, locY: 0, locZ: 0,
        lines: [{ id, selfId, name: `Item ${selfId}`, count, price }] });
}

const starterWeapon = (DataCache.newbieItems || [])
    .flatMap((row) => row.items || [])
    .map((item) => DataCache.items.find((entry) => Number(entry.selfId) === Number(item.selfId)))
    .find((item) => item?.template?.kind?.startsWith('Weapon.'));
const usefulWeapon = DataCache.items.find((item) => (
    item?.template?.kind?.startsWith('Weapon.') &&
    ItemDisposition.gradeIndex(item.etc?.rank) >= ItemDisposition.gradeIndex('c') &&
    Number(item.template.price || 0) > MarketListingPolicy.MARKET_GEAR_MIN_BASE_PRICE
));
const ordinaryGear = DataCache.items.find((item) => (
    (item?.template?.kind?.startsWith('Weapon.') || item?.template?.kind?.startsWith('Armor.')) &&
    ItemDisposition.gradeIndex(item.etc?.rank) >= ItemDisposition.gradeIndex('c') &&
    !MarketListingPolicy.starterItemIds().has(Number(item.selfId))
));

assert(starterWeapon, 'the newbie templates must include a starter weapon');
assert(usefulWeapon, 'the datapack must include market-worthy gear');
assert(ordinaryGear, 'the datapack must include non-starter C-grade-or-better gear');

function saleItem(item, count = 1, price = 1000) {
    return {
        selfId: Number(item.selfId),
        name: item.template.name,
        kind: item.template.kind,
        rank: item.etc?.rank || 'none',
        count,
        price,
        basePrice: Number(item.template.price || 0)
    };
}

const seller = { characterId: 10, name: 'Seller' };
const now = 100000;
const originalProgressionRate = process.env.L2NODE_PROGRESSION_RATE;

function classifyAtRate(rate, state, item, options) {
    process.env.L2NODE_PROGRESSION_RATE = rate;
    try {
        return MarketListingPolicy.classify(state, item, options);
    } finally {
        if (originalProgressionRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = originalProgressionRate;
    }
}

const pricedItem = { price: BotEconomyPricing.scalePrice(800), basePrice: 1000 };
const priceFloor = BotEconomyPricing.scalePrice(600);
assert.strictEqual(MarketListingPolicy.listingFloor(pricedItem), priceFloor, 'the listing floor must track the active Adena rate');
assert.strictEqual(
    MarketListingPolicy.listingPrice(pricedItem, { market: { supply: { minimumPrice: BotEconomyPricing.scalePrice(750) } } }),
    Math.floor(BotEconomyPricing.scalePrice(750) * 0.98),
    'healthy competition should still be undercut by two percent'
);
assert.strictEqual(
    MarketListingPolicy.listingPrice(pricedItem, { market: { supply: { minimumPrice: 1 } } }),
    null,
    'a collapsed competitor price must route the item away from an uncompetitive private listing'
);
let repeatedPrice = pricedItem.price;
for (let index = 0; index < 500 && repeatedPrice !== null; index++) {
    repeatedPrice = MarketListingPolicy.listingPrice(pricedItem, { market: { supply: { minimumPrice: repeatedPrice } } });
}
assert.strictEqual(repeatedPrice, null, 'repeated undercutting must stop listing once the price floor is no longer competitive');

const starterDecision = MarketListingPolicy.classify(seller, saleItem(starterWeapon), { states: [], now });
assert.strictEqual(starterDecision.action, 'npc', 'free starter gear must never enter a private store');
assert.strictEqual(starterDecision.reason, 'starter_kit');

const lowGradeGear = DataCache.items.find((item) => (
    (item?.template?.kind?.startsWith('Weapon.') || item?.template?.kind?.startsWith('Armor.')) &&
    ItemDisposition.gradeIndex(item.etc?.rank) < ItemDisposition.gradeIndex('c') &&
    !MarketListingPolicy.starterItemIds().has(Number(item.selfId))
));
assert(lowGradeGear, 'the datapack must contain non-starter low-grade gear');
const lowGradeItem = saleItem(lowGradeGear, 1, 1000);
const lowGradeBuyer = {
    characterId: 19,
    name: 'LowGradeBuyer',
    adena: 1000000,
    currentRegion: 'Gludio',
    stats: {
        equipmentPlan: {
            status: 'active',
            strategy: 'market',
            target: { selfId: Number(lowGradeGear.selfId), name: lowGradeGear.template.name }
        }
    }
};
const lowGradeWithoutDemand = classifyAtRate('x1', seller, lowGradeItem, { states: [], now });
assert.strictEqual(lowGradeWithoutDemand.action, 'npc', 'low-grade stock must not create an idle WTS without demand');
assert.strictEqual(lowGradeWithoutDemand.reason, 'low_grade_no_funded_demand');
['x1', 'x10'].forEach((rate) => {
    const decision = classifyAtRate(rate, seller, lowGradeItem, { states: [lowGradeBuyer], now });
    assert.strictEqual(decision.action, 'list', `${rate} must allow NG/D gear against funded exact demand`);
    assert.strictEqual(decision.reason, 'active_demand');
});
const highRateLowGrade = classifyAtRate('x50', seller, lowGradeItem, { states: [lowGradeBuyer], now });
assert.strictEqual(highRateLowGrade.action, 'npc', 'x50 must liquidate NG/D gear instead of opening bot stores');
assert.strictEqual(highRateLowGrade.reason, 'low_grade_high_rate');

const targetId = Number(usefulWeapon.selfId);
const buyer = {
    characterId: 20,
    name: 'Buyer',
    adena: Math.max(100000, MarketListingPolicy.listingFloor(saleItem(usefulWeapon))),
    currentRegion: 'Gludio',
    stats: {
        equipmentPlan: {
            status: 'active',
            strategy: 'market',
            target: { selfId: targetId, name: usefulWeapon.template.name }
        }
    }
};
const demand = MarketDemandIndex.demandFor(targetId, { states: [buyer], now });
assert.strictEqual(demand.bots, 1);
assert.strictEqual(demand.readyBots, 1);
assert.strictEqual(demand.fundedBots, 1);

const demandedDecision = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, 9000), { states: [buyer], now });
assert.strictEqual(demandedDecision.action, 'list', 'useful gear with an active buyer must enter WTS');
assert.strictEqual(demandedDecision.listCount, 1, 'a seller must not list more units than buyers can fund now');

const belowFloor = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, 1), {
    states: [{ ...buyer, adena: MarketListingPolicy.listingFloor(saleItem(usefulWeapon)) - 1 }], now
});
assert.strictEqual(belowFloor.reason, 'unfunded_demand', 'funding must be checked at the actual ask, including its floor');

const competitiveFloor = MarketListingPolicy.listingFloor(saleItem(usefulWeapon));
const competingPrice = Math.floor(competitiveFloor * 1.25);
const competingBuyer = { ...buyer, adena: Math.floor(competingPrice * 0.98) };
boardSupply(24, targetId, 1, competingPrice);
const discounted = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, competitiveFloor * 1.5), {
    states: [competingBuyer, { ...competingBuyer, characterId: 23 }], now
});
AfkTrade._resetForTests();
assert.strictEqual(discounted.action, 'list', 'buyers who can fund the competitive ask must count even below the preferred ask');

const unfundedBuyer = { ...buyer, characterId: 21, adena: 100 };
const unfunded = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, 9000), { states: [unfundedBuyer], now });
assert.strictEqual(unfunded.action, 'warehouse', 'ready demand without enough Adena must not open WTS');
assert.strictEqual(unfunded.reason, 'unfunded_demand');

const latentBuyer = {
    ...buyer,
    characterId: 22,
    stats: { equipmentPlan: { status: 'active', strategy: 'drop', target: { selfId: targetId, name: usefulWeapon.template.name } } }
};
const speculative = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 4, 9000), { states: [latentBuyer], now });
assert.strictEqual(speculative.action, 'list', 'valuable gear may use one bounded speculative slot');
assert.strictEqual(speculative.reason, 'speculative_demand');
assert.strictEqual(speculative.listCount, 1);

const ordinaryLatentItem = { ...saleItem(ordinaryGear, 1, 3000), basePrice: 3000 };
const ordinaryLatent = MarketListingPolicy.classify(seller, ordinaryLatentItem, {
    states: [{ ...latentBuyer, stats: { equipmentPlan: { status: 'active', strategy: 'drop', target: { selfId: ordinaryGear.selfId } } } }],
    now
});
assert.strictEqual(ordinaryLatent.action, 'warehouse', 'ordinary gear must not be listed against latent progression demand');
assert.strictEqual(ordinaryLatent.reason, 'latent_demand');

boardSupply(30, targetId, 3, 8000, 'Gludio');
const saturated = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, 9000), { states: [buyer], now });
AfkTrade._resetForTests();
assert.strictEqual(saturated.action, 'warehouse', 'supply above the demand ceiling must not create another store');
assert.strictEqual(saturated.reason, 'saturated');

const activeLowGrade = saleItem(lowGradeGear, 1, Math.floor(Number(lowGradeGear.template.price) * 0.8));
boardSupply(31, activeLowGrade.selfId, 2, activeLowGrade.price);
const recentMarket = { states: [], now, buyerActivity: new Map([[activeLowGrade.selfId, 3]]) };
assert.strictEqual(MarketListingPolicy.classify(seller, activeLowGrade, recentMarket).action, 'list',
    'distinct recent buyers should support one more competitive low-grade listing');
const crowdedMarket = { ...recentMarket, buyerActivity: new Map([[activeLowGrade.selfId, 1]]) };
const crowded = MarketListingPolicy.classify(seller, activeLowGrade, crowdedMarket);
assert.strictEqual(crowded.action, 'npc', 'common gear with more asks than recent buyers should leave the market');
assert.strictEqual(crowded.reason, 'market_oversupply');
assert.strictEqual(MarketListingPolicy.classify(seller, {
    ...activeLowGrade, npcComparable: false
}, crowdedMarket).action, 'warehouse', 'enchanted gear should be retained instead of dumped at NPC');

const staleWanted = {
    characterId: 40,
    currentRegion: 'Giran',
    stats: { marketWanted: { itemId: targetId, lastMissingAt: now - MarketDemandIndex.WANTED_TTL_MS - 1 } }
};
assert.strictEqual(MarketDemandIndex.demandFor(targetId, { states: [staleWanted], now }).bots, 0, 'expired WTB memory must not count as demand');
assert.strictEqual(MarketDemandIndex.timestampForWanted(null), 0, 'a fulfilled WTB clears demand with null and must remain safe to index');

const recipeTemplate = DataCache.items.find((item) => Number(item.selfId) === 1804);
const heldRecipe = saleItem(recipeTemplate, 3, 40000);
assert(ItemDisposition.isMarketRecipeItem(heldRecipe), 'Recipe: Soulshot: D-Grade must be a market recipe');
const otherRecipeSeller = new Map([[1804, [{ characterId: 11, town: 'Dion', count: 1, price: 40000 }]]]);
[
    ['no demand', []],
    ['unfunded demand', [{ characterId: 12, currentRegion: 'Dion', stats: { shotRecipeDemand: { itemId: 1804, amount: 1, maxSpend: 1, at: now } } }]]
].forEach(([label, states]) => {
    const decision = MarketListingPolicy.classify(seller, heldRecipe, { states, supplyByItem: otherRecipeSeller, now });
    // The warehouse does not take recipes, so "warehouse" would do nothing.
    assert.strictEqual(decision.action, 'keep', `${label}: an unlisted market recipe stays in the bag for crafters' recipe requests`);
});
assert.strictEqual(MarketListingPolicy.classify(seller, heldRecipe, { states: [], supplyByItem: new Map(), now }).action, 'list',
    'a recipe nobody offers still gets one scarce listing');
const fundedRecipeBuyer = { characterId: 13, currentRegion: 'Dion', adena: 1000000,
    stats: { shotRecipeDemand: { itemId: 1804, amount: 3, maxSpend: 100000, at: now } } };
const underFloor = MarketListingPolicy.classify(seller, heldRecipe, { states: [fundedRecipeBuyer],
    supplyByItem: new Map([[1804, [{ characterId: 11, town: 'Dion', count: 1, price: 1 }]]]), now });
assert.deepStrictEqual([underFloor.action, underFloor.reason], ['keep', 'non_competitive_floor'],
    'a recipe that cannot be listed above its floor stays in the bag');

console.log('Bot market listing policy checks passed');
