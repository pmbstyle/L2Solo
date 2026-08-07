const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const MarketDemandIndex = invoke('GameServer/Bot/Economy/MarketDemandIndex');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');

DataCache.init();

const starterWeapon = (DataCache.newbieItems || [])
    .flatMap((row) => row.items || [])
    .map((item) => DataCache.items.find((entry) => Number(entry.selfId) === Number(item.selfId)))
    .find((item) => item?.template?.kind?.startsWith('Weapon.'));
const usefulWeapon = DataCache.items.find((item) => (
    item?.template?.kind?.startsWith('Weapon.') &&
    Number(item.template.price || 0) > MarketListingPolicy.MARKET_GEAR_MIN_BASE_PRICE
));

assert(starterWeapon, 'the newbie templates must include a starter weapon');
assert(usefulWeapon, 'the datapack must include market-worthy gear');

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
const starterDecision = MarketListingPolicy.classify(seller, saleItem(starterWeapon), { states: [], now });
assert.strictEqual(starterDecision.action, 'npc', 'free starter gear must never enter a private store');
assert.strictEqual(starterDecision.reason, 'starter_kit');

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

const demandedDecision = MarketListingPolicy.classify(seller, saleItem(usefulWeapon, 1, 9000), { states: [buyer], now });
assert.strictEqual(demandedDecision.action, 'list', 'useful gear with an active buyer must enter WTS');

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
