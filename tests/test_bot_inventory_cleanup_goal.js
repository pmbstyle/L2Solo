const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('inventory_cleanup_goal', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');

require('../src/Global');
isolated.assertConfigured(options.default);
async function runInventoryCleanup() {

const DataCache = invoke('GameServer/DataCache');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

DataCache.init();

const spellbook = DataCache.items.find((item) => item?.template?.kind === 'Other.Spellbook');
assert(spellbook, 'the datapack must contain a spellbook fixture');
const dEnchantScroll = DataCache.items.find((item) => Number(item?.selfId) === 956);
assert(dEnchantScroll?.template?.kind === 'Other.Scroll', 'the datapack must contain the D-grade armor enchant scroll fixture');
const escapeScroll = DataCache.items.find((item) => Number(item?.selfId) === 736);
const resurrectionScroll = DataCache.items.find((item) => Number(item?.selfId) === 737);
assert(escapeScroll?.template?.kind === 'Other.Scroll' && resurrectionScroll?.template?.kind === 'Other.Scroll',
    'the datapack must contain ordinary consumable scroll fixtures');

// The market decision includes the timestamp in its tendency roll. Pin this
// fixture's decision point so its warehouse case cannot choose a rare NPC sale.
const now = 1791228120000;
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

// NPC-only junk (a recipe no bot lists or learns) forces a trip at 20 slots (user, 2026-10-03; the author's 3).
const junkRecipes = (amount) => ({
    999001: {
        selfId: 999001, name: 'Recipe: Junk', kind: 'Other.Recipe', stackable: false, amount,
        instances: Array.from({ length: amount }, (_, index) => ({ id: 9400000 + index, amount: 1, equipped: false, slot: 0 }))
    }
});
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: junkRecipes(19) }, { now }), null,
'NPC-only junk below the threshold must not interrupt farming');
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: junkRecipes(20) }, { now }),
    { reason: 'npc_only_inventory', slots: 20, npcOnlySlots: 20, limit: ItemDisposition.INVENTORY_SLOT_LIMIT },
'twenty NPC-only slots form one NPC cleanup trip');

// A half-full bag (40 of 80 slots) sends the bot to sell whatever it carries (user, 2026-10-03).
const mixedBag = (slots) => Object.fromEntries(Array.from({ length: slots }, (_, index) => {
    const selfId = 1864 + index;
    return [selfId, { selfId, name: `Material ${selfId}`, kind: 'Other.Material', stackable: true, amount: 1 }];
}));
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(39) }, { now }), null,
'a bag below half must not interrupt farming');
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(40) }, { now }),
    { reason: 'inventory_half_full', slots: 40, npcOnlySlots: 0, limit: ItemDisposition.INVENTORY_SLOT_LIMIT },
'a half-full bag forms one market trip');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(40),
    stats: { marketSellRetryAfter: now + 60 * 60 * 1000 } }, { now }), null,
'the half-full trip respects the market retry cooldown');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(40), party: { partyId: 5 } }, { now }), null,
'a party member sells from the field: no half-full trip');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(40), level: 9,
    stats: { generatedCold: true } }, { now }), null,
'a generated bot below level 10 makes no half-full trip');
const unsellableBag = (slots) => Object.fromEntries(Array.from({ length: slots }, (_, index) => {
    const selfId = 990000 + index;
    // Quest items: no sale rule takes them (potions are NPC junk for a bot since H12).
    return [selfId, { selfId, name: `Quest item ${selfId}`, kind: 'Other.Quest', stackable: true, amount: 1 }];
}));
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: unsellableBag(40) }, { now }), null,
'a half-full bag with nothing to sell makes no trip');

const boneHelmet = DataCache.items.find((item) => Number(item.selfId) === 45);
const surplusInventory = (amount) => ({
    [boneHelmet.selfId]: {
        selfId: boneHelmet.selfId, name: boneHelmet.template.name,
        kind: boneHelmet.template.kind, rank: boneHelmet.etc.rank,
        stackable: false, amount,
        instances: Array.from({ length: amount }, (_, index) => ({
            id: 9300000 + index, amount: 1, equipped: false, enchant: 0
        }))
    }
});
// A forced trip starts at 20 surplus pieces (user, 2026-10-03; the author's 6
// sent a young world's bots to town every 40-60 minutes).
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state,
    inventory: surplusInventory(19) }, { now }), null,
'surplus drops below the threshold must not interrupt farming');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state,
    inventory: surplusInventory(20) }, { now }), null,
'the first useful helmet stays available for equipment');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state,
    inventory: surplusInventory(21) }, { now })?.reason, 'market_surplus_inventory',
'twenty surplus pieces should form one NPC cleanup trip');

const stagedArmor = {
    ...state, level: 47, adena: 1000000,
    inventory: {
        1101: { selfId: 1101, amount: 1, equipped: true, slot: 10, rank: 'none', kind: 'Armor.Fabric' },
        1104: { selfId: 1104, amount: 1, equipped: true, slot: 11, rank: 'none', kind: 'Armor.Fabric' },
        44: { selfId: 44, amount: 1, equipped: true, slot: 6, rank: 'none', kind: 'Armor.Wear' },
        432: { selfId: 432, amount: 2, equipped: false, slot: 10, rank: 'd', kind: 'Armor.Fabric' },
        465: { selfId: 465, amount: 1, equipped: false, slot: 11, rank: 'd', kind: 'Armor.Fabric' },
        45: { selfId: 45, amount: 1, equipped: false, slot: 6, rank: 'd', kind: 'Armor.Wear' }
    },
    stats: { generatedCold: true, classId: 30,
        equipmentPlan: { status: 'active', strategy: 'market', target: {
            selfId: 432, name: 'Cursed Tunic', slot: 10
        } } }
};
assert.strictEqual(LifeState.reconcileEquipmentInventory(stagedArmor).inventory[432].equipped, false,
    'the complete Devotion set can remain stronger than a single D-grade piece');
assert.strictEqual(ItemDisposition.reservedEquipmentAmounts(stagedArmor)[432], 1);
assert.strictEqual(ItemDisposition.reservedEquipmentAmounts(stagedArmor)[465], 1);
assert.strictEqual(ItemDisposition.reservedEquipmentAmounts(stagedArmor)[45], 1);
assert.strictEqual(ItemDisposition.saleCandidates(stagedArmor, { unlimited: true })
    .find((item) => item.selfId === 432)?.count, 1,
    'only duplicate tunics can be sold while one is staged for the next armor kit');
assert.strictEqual(ItemDisposition.warehouseCandidates(stagedArmor)
    .find((item) => item.selfId === 432)?.amount, 1);
assert.strictEqual(BuyStoreService.bidFor(stagedArmor, {
    type: 'upgrade_gear', target: { itemId: 432, itemName: 'Cursed Tunic', adena: 100000 }, plan: {}
}), null, 'an owned piece must not receive another AFK buy order');
assert.strictEqual(GearAcquisitionPlanner.staticNpcUpgradePlan(stagedArmor, {
    findMarketOffer: (item) => Number(item.selfId) === 432
        ? { sourceType: 'npc', selfId: 432, price: 10000, town: 'Gludio' } : null
}), null, 'the NPC bridge must not buy an already staged armor piece again');

const goal = NeedsEvaluator.evaluate(state, { now, spot: { id: 'cruma', name: 'Cruma Tower' } })
    .find((candidate) => candidate.type === 'sell_inventory' && candidate.target.cleanupReason === 'no_slot');
assert(goal, 'inventory pressure must create a sell_inventory goal');
// The exact 81 occupied native C4 slots reach the mandatory unload floor.
assert.strictEqual(goal.priority, 100);
assert.strictEqual(goal.target.itemCount, 81);
assert.strictEqual(invoke('GameServer/Bot/Population/SurvivalFloor').inventoryLimit(0), 80);

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
assert.deepStrictEqual(proposalTravel.cleanup, {
    itemCount: need.slots,
    npcOnlySlots: need.npcOnlySlots,
    cleanupReason: 'inventory_capacity'
}, 'forced cleanup keeps the independently evaluated physical bag intent');

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
// Enchant scrolls are valuable market goods, not NPC-only junk. The
// unchanged cold input has native own worth above today's NPC sale utility,
// even before this kind has buyers. Its fixed decision point keeps the stock.
const MarketCounters = invoke('GameServer/Bot/Economy/MarketCounters');
const PriceBelief = invoke('GameServer/Bot/Economy/PriceBelief');
const PriceDecision = invoke('GameServer/Bot/Economy/PriceDecision');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');
MarketCounters.reset();
const scrollBefore = structuredClone(scrollState);
const scrollContext = MarketListingPolicy.traderContext(scrollState, { now });
const scrollPrior = PriceBelief.prior(dEnchantScroll.selfId, scrollContext);
assert(scrollPrior, 'the authored public first price supplies a real belief');
const npcPrice = NpcSellRules.npcBuyPrice(Number(dEnchantScroll.template.price));
const npcUtility = PriceDecision.saleUtility(npcPrice, Math.exp(scrollPrior.mu), scrollContext.trader.caution);
assert(scrollContext.economy.worth(dEnchantScroll.selfId) > npcUtility,
    'the native own value is stronger than immediately selling this valuable stock');
const originalScrollDisposition = MarketListingPolicy.evaluate(scrollState, { now });
assert.deepStrictEqual(MarketListingPolicy.classify(scrollState, originalScrollDisposition.candidates[0]),
    { action: 'market', reason: 'market' }, 'an enchant scroll never inherits the NPC-only hard rule');
assert.strictEqual(originalScrollDisposition.decisions[0].reason, 'expected_value');
assert.strictEqual(originalScrollDisposition.decisions[0].priced.market.known, false,
    'absent supported item demand remains unknown rather than proving there are no buyers');
assert(Number.isNaN(originalScrollDisposition.decisions[0].priced.market.buyersPerHour));
assert.strictEqual(originalScrollDisposition.decisions[0].priced.market.buyback, npcPrice);
assert.strictEqual(originalScrollDisposition.warehouse[0]?.selfId, dEnchantScroll.selfId,
    'the original native choice retains the valuable enchant scroll');
assert.strictEqual(originalScrollDisposition.warehouse[0].count, 81, 'all original scrolls are retained');
assert.deepStrictEqual(originalScrollDisposition.npc, [], 'no forced NPC liquidation is invented');
assert.deepStrictEqual(scrollState, scrollBefore, 'a disposition quote never mutates the bag');
for (let deal = 0; deal < 12; deal++) MarketCounters.deal(dEnchantScroll.selfId, 6000, 1, now - (12 - deal) * 300000, 999999);
assert.strictEqual(MarketListingPolicy.evaluate(scrollState, { now, slots: 0 }).warehouse[0]?.selfId, dEnchantScroll.selfId,
    'scroll cleanup must choose warehouse retention when the board has buyers but no slot');
MarketCounters.reset();
// Native town travel reserves ten Scrolls of Escape (H13); only its surplus
// is NPC junk. A party resurrection remains a cast without an item.
for (const consumable of [escapeScroll, resurrectionScroll]) {
    const consumableItem = {
        selfId: consumable.selfId,
        name: consumable.template.name,
        kind: consumable.template.kind,
        stackable: true,
        amount: 13
    };
    const consumableState = { ...state, inventory: { [consumable.selfId]: consumableItem } };
    assert.deepStrictEqual(MarketListingPolicy.evaluate(consumableState, { states: [] }).npc.map((item) => item.selfId),
        [consumable.selfId], `${consumable.template.name} surplus is sold to the NPC`);
    const sale = MarketListingPolicy.evaluate(consumableState, { states: [] }).npc[0];
    const expectedKept = consumable.selfId === escapeScroll.selfId ? 10 : 0;
    assert.strictEqual(invoke('GameServer/Bot/Travel/ScrollStock').TARGET_AMOUNT, 10);
    assert.strictEqual(sale.count, 13 - expectedKept, 'the actual travel stock is protected from liquidation');
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
    return !kind.startsWith('Weapon.') && !kind.startsWith('Armor.')
        && (kind.startsWith('Other.Spellbook') || name.includes('spellbook') || /^amulet\b/.test(name));
});
assert(skillBooks.length > 100, 'the datapack must expose the full C4 skill-book catalog');
// FX-E6 preserves books present in the authored C4 skill catalogue for
// market/training. Unmapped books remain NPC junk; the original full item
// list and quantities are unchanged. Expected ids come from the catalogue,
// independently of ItemDisposition's classification helper.
const mappedBookIds = new Set(require('../data/Skills/c4-skill-books.json').skills.map(row => Number(row[1])));
let mappedBooks = 0, unmappedBooks = 0;
for (const item of skillBooks) {
    const mapped = mappedBookIds.has(Number(item.selfId));
    if (mapped) mappedBooks++; else unmappedBooks++;
    assert.strictEqual(ItemDisposition.isNpcOnlyItem({
        selfId: item.selfId, name: item.template.name, kind: item.template.kind, amount: 1
    }), !mapped, `original book ${item.selfId} follows the authored C4 training catalogue`);
}
assert(mappedBooks > 0 && unmappedBooks > 0, 'the unchanged catalogue must exercise both preserved and NPC-only books');
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
assert(mappedBookIds.has(Number(chantOfRevenge.selfId)), 'the unchanged Chant of Revenge is a mapped C4 book');
const chantBefore = structuredClone(chantState);
const chantDisposition = MarketListingPolicy.evaluate(chantState);
assert.strictEqual(chantDisposition.candidates.length, 1);
assert.strictEqual(chantDisposition.candidates[0].count, 1, 'the original single book reaches disposition unchanged');
assert.deepStrictEqual(MarketListingPolicy.classify(chantState, chantDisposition.candidates[0]),
    { action: 'market', reason: 'market' }, 'the original mapped amulet remains available to the native market decision');
assert(chantDisposition.decisions.every(row => ['expected_value', 'no_board_slot'].includes(row.reason)),
    'market value and the native roll choose disposition; mapped books never inherit the NPC-only hard rule');
assert.strictEqual(ItemDisposition.npcOnlySlotCount(chantState), 0);
assert.strictEqual(ItemDisposition.inventoryCleanupNeed(chantState, { now }), null,
    'one preserved training book does not mandate an NPC cleanup trip');
assert.deepStrictEqual(chantState, chantBefore, 'classification and listing cannot alter the original book');
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
const expectedNpcBookFixtures = npcFixtures.filter(item => !mappedBookIds.has(Number(item.selfId)));
assert(expectedNpcBookFixtures.length > 0 && expectedNpcBookFixtures.length < npcFixtures.length,
    'the unchanged 21-item mixed bag contains both NPC junk and mapped training books');
// This quotation helper also exposes cheap goods, including mapped books,
// while the actual listing policy applies their native expected-value choice.
assert(npcFixtures.every(item => Number(item.template.price) <= ItemDisposition.NPC_LIQUIDATION_MAX_UNIT_PRICE),
    'all original 21 items satisfy the independent authored cheap-price bound');
assert.strictEqual(ItemDisposition.npcLiquidationCandidates(npcState).length, npcFixtures.length);
const mixedBookDisposition = MarketListingPolicy.evaluate(npcState);
for (const item of expectedNpcBookFixtures) {
    assert(mixedBookDisposition.npc.some(row => Number(row.selfId) === Number(item.selfId)),
        `original NPC junk ${item.selfId} retains its liquidation route`);
}
for (const item of npcFixtures.filter(item => mappedBookIds.has(Number(item.selfId)))) {
    const candidate = mixedBookDisposition.candidates.find(row => Number(row.selfId) === Number(item.selfId));
    assert(candidate, 'an original mapped book remains a market candidate');
    assert.deepStrictEqual(MarketListingPolicy.classify(npcState, candidate), { action: 'market', reason: 'market' });
    assert(mixedBookDisposition.decisions.filter(row => Number(row.item.selfId) === Number(item.selfId))
        .every(row => row.reason !== 'npc_only_item'), 'native expected value decides the mapped book disposition');
}
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
await PopulationService.resolveColdState(state).then((rejected) => {
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

// Apprentice's Spellbook is a caster weapon, not a disposable skill book.
const bookWeapon = DataCache.items.find(item => item.selfId === 99);
assert.strictEqual(bookWeapon.template.kind, 'Weapon.Etc');
for (const kind of ['Weapon.Etc', undefined, 'Other.Spellbook']) {
    assert.strictEqual(ItemDisposition.isSkillBookItem({ selfId: 99, name: bookWeapon.template.name, kind }), false,
        'the canonical equipment type must override a missing or stale summary kind');
}
const equippedBook = { selfId: 99, name: bookWeapon.template.name, kind: 'Weapon.Etc', amount: 1,
    equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, stackable: false,
    instances: [{ id: 99, equipped: true, slot: 7 }] };
const bookHunter = { ...state, inventory: { 99: equippedBook }, stats: {
    ...state.stats, equipment: [{ ...equippedBook, rank: 'none' }], marketSellRetryAfter: now + 60000
} };
assert.strictEqual(ItemDisposition.inventoryCleanupNeed(bookHunter, { now }), null);
assert.deepStrictEqual(ItemDisposition.npcLiquidationCandidates(bookHunter), []);
assert.strictEqual(NeedsEvaluator.evaluate(bookHunter, { now }).some(goal => goal.type === 'sell_inventory'), false,
    'an equipped weapon must not interrupt hunting with forced cleanup');
const spareBook = { ...bookHunter, inventory: { 99: { ...equippedBook, amount: 2,
    instances: [...equippedBook.instances, { id: 100, equipped: false, slot: 7 }] } } };
assert.strictEqual(ItemDisposition.skillBookSlotCount(spareBook), 0);
assert.strictEqual(ItemDisposition.npcLiquidationCandidates(spareBook).find(item => item.selfId === 99)?.count, 1,
    'a spare low-grade weapon remains ordinary sellable equipment');
assert.strictEqual(ItemDisposition.isSkillBookItem({ selfId: 999999, name: 'Spellbook: Missing Kind' }), true);
assert.strictEqual(ItemDisposition.isSkillBookItem({ selfId: 999999, name: 'Amulet: Missing Kind' }), true);

}
runInventoryCleanup().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await invoke('Database').close();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
