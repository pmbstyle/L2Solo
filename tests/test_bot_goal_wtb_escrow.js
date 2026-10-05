const assert = require('assert');

require('../src/Global');

const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

const originalProjection = AfkTrade.ownerRecords;
const spot = { id: 'starter', risk: 1, route: { id: 'starter_route' } };
const timestamp = 100000;
const item = (DataCache.items || []).find((entry) => (
    String(entry.etc?.rank || '').toLowerCase() === 'd'
    && String(entry.template?.kind || '').startsWith('Armor.')
    && entry.template?.kind !== 'Armor.Jewel'
    && Number(entry.etc?.slot) === 10
    && Number(entry.template?.price || 0) > 0
));
assert(item, 'the datapack must expose a D-grade chest fixture');

const price = Number(item.template.price);
const reserve = 5000;
const escrow = Math.floor(price * 0.85);

function gearGoal(adena) {
    return NeedsEvaluator.evaluate({
        characterId: 7,
        phase: 'cold',
        level: 20,
        adena,
        vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 },
        party: {},
        stats: {
            classId: 0,
            build: { grade: 'd', classId: 0, level: 20 },
            equipment: [{ selfId: 1, slot: 7, rank: 'none', name: 'Short Sword' }],
            equipmentPlan: {
                status: 'active',
                strategy: 'market',
                target: { selfId: item.selfId, slot: 10 },
                market: { town: 'Gludio', price, reserve, sourceType: 'npc' }
            }
        }
    }, { spot, now: timestamp }).find((candidate) => candidate.type === 'upgrade_gear');
}

try {
    // Posting the remote WTB moves the bid out of the wallet into the shop's
    // escrow. The same bot must still see its purchase as funded, otherwise
    // the next review withdraws the order, refunds it and posts it again.
    const walletAfterPosting = price + reserve - escrow;
    AfkTrade.ownerRecords = () => [{ kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: escrow, lines: [] }];
    const withOrder = gearGoal(walletAfterPosting);
    assert.strictEqual(withOrder.plan.requiredAdena, 0, 'the WTB escrow counts toward the purchase budget');
    assert.strictEqual(withOrder.plan.expectedBenefit, 'market_search_for_gear');

    // Only a buy order holds Adena; a sell shop does not fund a purchase.
    AfkTrade.ownerRecords = () => [{ kind: 'shop', storeType: AfkTrade.SELL, escrowAdena: escrow, lines: [] }];
    const withSellShop = gearGoal(walletAfterPosting);
    assert.strictEqual(withSellShop.plan.requiredAdena, escrow, 'a sell shop does not add purchase budget');
    assert.strictEqual(withSellShop.plan.expectedBenefit, 'adena_for_gear_upgrade');

    AfkTrade.ownerRecords = () => [];
    const noOrder = gearGoal(walletAfterPosting);
    assert.strictEqual(noOrder.plan.requiredAdena, escrow, 'without an order the wallet alone decides');
    assert.strictEqual(noOrder.plan.expectedBenefit, 'adena_for_gear_upgrade');
} finally {
    AfkTrade.ownerRecords = originalProjection;
}

console.log('Bot goal WTB escrow checks passed');
