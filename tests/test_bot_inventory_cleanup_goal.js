const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

DataCache.init();

const spellbook = DataCache.items.find((item) => /spellbook/i.test(item?.template?.name || ''));
assert(spellbook, 'the datapack must contain a spellbook fixture');
const dEnchantScroll = DataCache.items.find((item) => Number(item?.selfId) === 956);
assert(dEnchantScroll?.template?.kind === 'Other.Scroll', 'the datapack must contain the D-grade armor enchant scroll fixture');
const escapeScroll = DataCache.items.find((item) => Number(item?.selfId) === 736);
const resurrectionScroll = DataCache.items.find((item) => Number(item?.selfId) === 737);
assert(escapeScroll?.template?.kind === 'Other.Scroll' && resurrectionScroll?.template?.kind === 'Other.Scroll',
    'the datapack must contain ordinary consumable scroll fixtures');

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

const capacityOnlyState = {
    ...state,
    inventory: {
        1: {
            selfId: 1,
            name: 'Short Sword',
            kind: 'Weapon.Sword',
            stackable: false,
            amount: 81,
            instances: Array.from({ length: 81 }, (_, index) => ({
                id: 9050000 + index,
                amount: 1,
                equipped: false,
                slot: 0
            }))
        }
    },
    stats: { marketSellRetryAfter: now + 60 * 60 * 1000 }
};
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed(capacityOnlyState, { now }), {
    reason: 'inventory_capacity',
    slots: 81,
    npcOnlySlots: 0,
    limit: ItemDisposition.INVENTORY_SLOT_LIMIT
}, 'an over-capacity inventory must bypass the market retry cooldown even without NPC-only items');

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
assert.strictEqual(proposalTravel.stats.forcedMarketCleanup.cleanupReason, 'inventory_capacity',
    'worker cleanup travel must carry durable intent through arrival');

const staleRecoverIntent = PopulationService.marketListingIntent({
    ...proposalTravel,
    activity: 'shopping',
    stats: { ...proposalTravel.stats, travel: null }
}, { type: 'recover', status: 'active' });
assert.strictEqual(staleRecoverIntent.shouldOpen, true,
    'forced cleanup arrival must open the sale lifecycle even when goal metadata still says recover');
assert.strictEqual(staleRecoverIntent.state.stats.forcedMarketCleanup, null,
    'consuming forced cleanup intent must prevent the marker itself from starting another town loop');
assert.strictEqual(staleRecoverIntent.cleanup.cleanupReason, 'inventory_capacity',
    'forced cleanup intent must retain its reason for the dedicated pre-trade path');

const scrollState = {
    ...state,
    inventory: {
        [dEnchantScroll.selfId]: {
            selfId: dEnchantScroll.selfId,
            name: dEnchantScroll.template.name,
            kind: dEnchantScroll.template.kind,
            stackable: false,
            amount: 81,
            instances: Array.from({ length: 81 }, (_, index) => ({
                id: 9200000 + index,
                amount: 1,
                equipped: false,
                slot: 0
            }))
        }
    }
};
assert(ItemDisposition.saleCandidates(scrollState).some((item) => Number(item.selfId) === Number(dEnchantScroll.selfId)),
    'valuable scroll surplus must enter the sale/disposition lifecycle');
assert.strictEqual(ItemDisposition.isWarehouseCandidate(scrollState.inventory[dEnchantScroll.selfId]), true,
    'valuable scrolls without demand must be removable from the backpack into the warehouse');
assert.strictEqual(MarketListingPolicy.evaluate(scrollState).warehouse[0]?.selfId, dEnchantScroll.selfId,
    'scroll cleanup must choose warehouse retention when no buyer demand exists');
for (const consumable of [escapeScroll, resurrectionScroll]) {
    const consumableItem = {
        selfId: consumable.selfId,
        name: consumable.template.name,
        kind: consumable.template.kind,
        stackable: true,
        amount: 10
    };
    const consumableState = { ...state, inventory: { [consumable.selfId]: consumableItem } };
    assert.strictEqual(ItemDisposition.saleCandidates(consumableState).length, 0,
        `${consumable.template.name} must remain available to bot runtime instead of entering market cleanup`);
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(consumableItem), false,
        `${consumable.template.name} must not be parked in the warehouse`);
}

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
const skillBooks = DataCache.items.filter((item) => {
    const name = String(item?.template?.name || '').toLowerCase();
    const kind = String(item?.template?.kind || '');
    return kind.startsWith('Other.Spellbook') || name.includes('spellbook') || /^amulet\b/.test(name);
});
assert(skillBooks.length > 100, 'the datapack must expose the full C4 skill-book catalog');
assert(skillBooks.every((item) => ItemDisposition.isNpcOnlyItem({
    selfId: item.selfId,
    name: item.template.name,
    kind: item.template.kind,
    amount: 1
})), 'every spellbook and Orc amulet must be NPC-only for every class');
const orcAmulets = DataCache.items.filter((item) => /^amulet\b/i.test(item?.template?.name || ''));
assert(orcAmulets.length > 40, 'the datapack must expose the C4 Orc amulet catalog');
assert(orcAmulets.every((item) => ItemDisposition.isSkillBookItem({
    selfId: item.selfId,
    name: item.template.name,
    kind: item.template.kind,
    amount: 1
})), 'colon and hyphen named Orc amulets must all be treated as skill books');
const chantOfRevenge = skillBooks.find((item) => item.template.name === 'Amulet: Chant of Revenge');
assert(chantOfRevenge, 'Amulet: Chant of Revenge must exist in the datapack fixture');
const chantState = {
    ...state,
    inventory: {
        [chantOfRevenge.selfId]: {
            selfId: chantOfRevenge.selfId,
            name: chantOfRevenge.template.name,
            kind: chantOfRevenge.template.kind,
            stackable: false,
            amount: 1,
            instances: [{ id: 9199999, amount: 1, equipped: false, slot: 0 }]
        }
    }
};
const chantDisposition = MarketListingPolicy.evaluate(chantState);
assert.strictEqual(chantDisposition.npc[0]?.selfId, chantOfRevenge.selfId,
    'Amulet: Chant of Revenge must route to NPC liquidation');
assert.deepStrictEqual(chantDisposition.warehouse, [], 'skill books must never be warehoused');
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed(chantState, { now }), {
    reason: 'npc_only_inventory',
    slots: 1,
    npcOnlySlots: 1,
    limit: ItemDisposition.INVENTORY_SLOT_LIMIT
}, 'one skill book must immediately schedule an NPC cleanup trip');
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
const preTradeNpcState = {
    ...npcState,
    level: 9,
    stats: { generatedCold: true },
    inventory: Object.fromEntries(npcFixtures.slice(0, 3).map((item, index) => [String(item.selfId), {
        selfId: item.selfId,
        name: item.template.name,
        kind: item.template.kind,
        stackable: false,
        amount: 1,
        instances: [{ id: 9150000 + index, amount: 1, equipped: false, slot: 0 }]
    }]))
};
assert.strictEqual(
    ItemDisposition.inventoryCleanupNeed(preTradeNpcState, { now }),
    null,
    'pre-trade NPC-only inventory must not create a standalone market trip'
);
assert.strictEqual(
    ItemDisposition.npcLiquidationCandidates(preTradeNpcState).length,
    0,
    'ordinary NPC liquidation must retain the pre-trade market boundary'
);
assert.strictEqual(
    ItemDisposition.npcLiquidationCandidates(preTradeNpcState, { allowPreTradeCleanup: true }).length,
    3,
    'forced pre-trade cleanup must still expose NPC-only candidates'
);
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

const originalUpsertState = LifeState.upsertState;
LifeState.upsertState = async () => null;
PopulationService.resolveColdState(state).then((rejected) => {
    assert.strictEqual(rejected.ok, false, 'a fenced cleanup write must not be reported as a successful resolve');
    assert.strictEqual(rejected.reason, 'state_write_rejected');
    assert.strictEqual(rejected.state, state, 'the rejected result must retain the authoritative pre-write state');
    console.log('Bot inventory cleanup goal checks passed');
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    LifeState.upsertState = originalUpsertState;
});
