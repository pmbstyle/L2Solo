const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const BotEconomyPricing = invoke('GameServer/Bot/Economy/BotEconomyPricing');

DataCache.init();

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
const lowGradeDecision = MarketListingPolicy.classify(seller, saleItem(lowGradeGear), { states: [], now });
assert.strictEqual(lowGradeDecision.action, 'npc', 'all gear below C-grade must go to the NPC shop');
assert.strictEqual(lowGradeDecision.reason, 'low_grade_gear');

const targetId = Number(usefulWeapon.selfId);
const buyer = {
    characterId: 20,
    name: 'Buyer',
    adena: 100000,
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

const saturatedStates = [buyer, {
    characterId: 30,
    activity: 'merchant',
    stats: { marketStore: { storeType: 1, town: 'Gludio', items: [{ selfId: targetId, count: 3, price: 8000 }] } }
}];
const saturated = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, 9000), { states: saturatedStates, now });
assert.strictEqual(saturated.action, 'warehouse', 'supply above the demand ceiling must not create another store');
assert.strictEqual(saturated.reason, 'saturated');

const staleWanted = {
    characterId: 40,
    currentRegion: 'Giran',
    stats: { marketWanted: { itemId: targetId, lastMissingAt: now - MarketDemandIndex.WANTED_TTL_MS - 1 } }
};
assert.strictEqual(MarketDemandIndex.demandFor(targetId, { states: [staleWanted], now }).bots, 0, 'expired WTB memory must not count as demand');
assert.strictEqual(MarketDemandIndex.timestampForWanted(null), 0, 'a fulfilled WTB clears demand with null and must remain safe to index');

console.log('Bot market listing policy checks passed');
