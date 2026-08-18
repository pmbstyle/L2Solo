const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');

DataCache.init();

const spellbook = DataCache.items.find((item) => /spellbook/i.test(item?.template?.name || ''));
assert(spellbook, 'the datapack must contain a spellbook fixture');

const now = Date.now();
const state = {
    characterId: 7002,
    name: 'OverloadedBot',
    phase: 'cold',
    activity: 'hunting',
    level: 48,
    adena: 100000,
    currentRegion: 'Cruma Tower',
    loc: { locX: 14500, locY: 114000, locZ: -2400 },
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
    inventory: {
        [spellbook.selfId]: {
            selfId: spellbook.selfId,
            name: spellbook.template.name,
            kind: spellbook.template.kind,
            stackable: false,
            amount: 81,
            instances: Array.from({ length: 81 }, (_, index) => ({
                id: 9000000 + index,
                amount: 1,
                equipped: false,
                slot: 0
            }))
        }
    },
    stats: {}
};

const need = ItemDisposition.inventoryCleanupNeed(state, { now });
assert.deepStrictEqual(need, {
    reason: 'inventory_capacity',
    slots: 81,
    npcOnlySlots: 81,
    limit: ItemDisposition.INVENTORY_SLOT_LIMIT
});

const goal = NeedsEvaluator.evaluate(state, { now, spot: { id: 'cruma', name: 'Cruma Tower' } })
    .find((candidate) => candidate.type === 'sell_inventory' && candidate.target.cleanupReason === 'inventory_capacity');
assert(goal, 'inventory pressure must create a sell_inventory goal');
assert.strictEqual(goal.priority, 96);

const travel = GoalExecutor.beginMarketTravel(state, {
    type: goal.type,
    plan: goal.plan,
    target: goal.target
}, now);
assert(travel, 'inventory cleanup goal must start a market trip');
assert.strictEqual(travel.activity, 'traveling');
assert.strictEqual(travel.stats.travel.reason, 'market_sale_inventory');
assert.strictEqual(travel.stats.travel.arrivalActivity, 'shopping');

const proposalTravel = PopulationService.prepareInventoryCleanupProposal(state, now, {
    ownerId: 'test-owner',
    revision: 1,
    leaseId: 'test-lease',
    leaseUntil: now + 30000
});
assert(proposalTravel, 'worker proposal commit must also start a market trip');
assert.strictEqual(proposalTravel.activity, 'traveling');
assert.deepStrictEqual(proposalTravel.simulation, {
    ownerId: 'test-owner',
    revision: 1,
    leaseId: 'test-lease',
    leaseUntil: now + 30000
});

const cooldownCleanup = GoalExecutor.beginMarketTravel({
    ...state,
    stats: { marketSellRetryAfter: now + 60 * 60 * 1000 }
}, {
    type: 'sell_inventory',
    target: { cleanupReason: 'inventory_capacity' },
    plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_capacity' }
}, now);
assert(cooldownCleanup, 'forced inventory cleanup must bypass a stale market retry cooldown');
assert.strictEqual(GoalExecutor.beginMarketTravel({
    ...state,
    stats: { marketSellRetryAfter: now + 60 * 60 * 1000 }
}, {
    type: 'sell_inventory',
    plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory' }
}, now), null, 'ordinary market sales must still respect the retry cooldown');

const soldInventoryState = {
    ...state,
    inventory: {
        [spellbook.selfId]: {
            ...state.inventory[spellbook.selfId],
            amount: 0
        }
    },
    stats: {}
};
assert.strictEqual(ItemDisposition.npcOnlySlotCount(soldInventoryState), 0, 'zero-amount non-stackable instances must not count as NPC inventory');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed(soldInventoryState, { now }), null, 'sold NPC-only instances must not create a cleanup goal');

const npcFixtures = DataCache.items
    .filter((item) => /^(recipe:|spellbook)/i.test(item?.template?.name || ''))
    .slice(0, 21);
assert(npcFixtures.length >= 21, 'the datapack must contain enough recipe/spellbook fixtures');
const npcState = {
    ...state,
    inventory: Object.fromEntries(npcFixtures.map((item, index) => [String(item.selfId), {
        selfId: item.selfId,
        name: item.template.name,
        kind: item.template.kind,
        stackable: false,
        amount: 1,
        instances: [{ id: 9100000 + index, amount: 1, equipped: false, slot: 0 }]
    }]))
};
assert.strictEqual(ItemDisposition.npcLiquidationCandidates(npcState).length, npcFixtures.length);
assert.strictEqual(MarketListingPolicy.evaluate(npcState).npc.length, npcFixtures.length);
const protectedNpcState = {
    ...npcState,
    inventory: {
        [String(npcFixtures[0].selfId)]: {
            ...npcState.inventory[String(npcFixtures[0].selfId)],
            starterMobLootAmount: 1
        }
    }
};
assert.strictEqual(ItemDisposition.npcLiquidationCandidates(protectedNpcState)[0].count, 1);
assert(ItemDisposition.inventoryCleanupNeed({
    ...npcState,
    stats: { marketSellRetryAfter: now + 60 * 60 * 1000 }
}, { now }), 'NPC-only cleanup must bypass market retry cooldown');

console.log('Bot inventory cleanup goal checks passed');
