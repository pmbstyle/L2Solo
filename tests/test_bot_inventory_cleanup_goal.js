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
// The sale retry (stats.marketSellSeen): the last visit tried every kind in this bag, nothing new came since.
const triedAll = (inventory = {}) => ({ items: Object.keys(inventory).map(Number).sort((a, b) => a - b), buyers: null });
const MarketListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

DataCache.init();
// This one synthetic junk-recipe fixture models a reachable dropped item.
const Sources = invoke('GameServer/Items/ItemAcquisitionCatalog');
const originalHasSource = Sources.hasSource;
Sources.hasSource = id => Number(id) === 999001 || originalHasSource(id);
process.on('exit', () => { Sources.hasSource = originalHasSource; });

const spellbook = DataCache.items.find((item) => Number(item.selfId) === 3942); // reachable unmapped C4 book: Party Return
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
    stats: {}
};
capacityOnlyState.stats.marketSellSeen = triedAll(capacityOnlyState.inventory);
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
    stats: { marketSellSeen: triedAll(mixedBag(40)) } }, { now }), null,
'the half-full trip respects the market retry cooldown');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(40), party: { partyId: 5 } }, { now }), null,
'a party member sells from the field: no half-full trip');
assert.strictEqual(ItemDisposition.inventoryCleanupNeed({ ...state, inventory: mixedBag(40), level: 9,
    stats: { generatedCold: true } }, { now })?.reason, 'inventory_half_full',
'a young bot uses the same stock-based cleanup decision');
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
assert.deepStrictEqual(ItemDisposition.warehouseCandidates(stagedArmor), [],
    'ordinary staged armor stays under personal disposition rather than warehouse storage');
const craftStation = invoke('GameServer/Bot/Economy/CraftShopService').stationForSlot(0);
const stationArmor = { ...stagedArmor,
    stats: { ...stagedArmor.stats, craftStationId: craftStation.id } };
assert.strictEqual(ItemDisposition.warehouseCandidates(stationArmor)
    .find((item) => item.selfId === 432)?.amount, 1,
    'a native infrastructure owner can warehouse only the duplicate staged tunic');
assert.strictEqual(BuyStoreService.bidFor(stagedArmor, {
    type: 'upgrade_gear', target: { itemId: 432, itemName: 'Cursed Tunic', adena: 100000 }, plan: {}
}), null, 'an owned piece must not receive another AFK buy order');
assert.strictEqual(GearAcquisitionPlanner.staticNpcUpgradePlan(stagedArmor, {
    findMarketOffer: (item) => Number(item.selfId) === 432
        ? { sourceType: 'npc', selfId: 432, price: 10000, town: 'Gludio' } : null
}), null, 'the NPC bridge must not buy an already staged armor piece again');

const goal = NeedsEvaluator.evaluate(state, { now })
    .find((candidate) => candidate.type === 'sell_inventory' && candidate.target.cleanupReason === 'no_slot');
assert(goal, 'inventory pressure must create a sell_inventory goal');
// The exact 81 occupied native C4 slots reach the mandatory unload floor: it comes first.
assert.strictEqual(NeedsEvaluator.evaluate(state, { now })[0].target.cleanupReason, 'no_slot');
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

const proposalTravel = PopulationService.prepareInventoryCleanupProposal(state, now, { revision: 1 }, state, need);
assert(proposalTravel, 'worker proposal commit must also start a market trip');
assert.strictEqual(proposalTravel.activity, 'traveling');
assert.deepStrictEqual(proposalTravel.simulation, { revision: 1 });
assert.strictEqual(proposalTravel.stats.forcedMarketCleanup.cleanupReason, 'inventory_capacity',
    'worker cleanup travel must carry durable intent through arrival');
assert.strictEqual(proposalTravel.cleanup.itemCount, need.slots,
    'forced cleanup keeps the independently evaluated physical bag intent');
assert.strictEqual(proposalTravel.cleanup.cleanupReason, 'inventory_capacity');

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
    'the scroll itself is eligible for an infrastructure owner\'s warehouse');
// Enchant scrolls are valuable market goods, not NPC-only junk. The
// cold input still has native own worth above today's NPC sale utility and
// unknown demand. Ordinary surplus finances progression through NPC sale;
// the separate infrastructure owner below retains warehouse stock.
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
assert.deepStrictEqual(originalScrollDisposition.warehouse, [],
    'an ordinary adventurer does not warehouse personal surplus');
assert.strictEqual(originalScrollDisposition.npc[0]?.selfId, dEnchantScroll.selfId);
assert.strictEqual(originalScrollDisposition.npc.reduce((sum, item) => sum + item.count, 0), 81,
    'all unreserved ordinary scroll surplus finances personal progression');
const npcScrollIds = originalScrollDisposition.npc.flatMap(item => item.objectIds || []);
assert.strictEqual(npcScrollIds.length, 81, 'the quote and residual batches include every physical scroll');
assert.strictEqual(new Set(npcScrollIds).size, 81, 'no copy is selected twice across quote and residual batches');
assert.deepStrictEqual(scrollState, scrollBefore, 'a disposition quote never mutates the bag');
const stationScrolls = { ...scrollState,
    stats: { ...scrollState.stats, craftStationId: craftStation.id } };
const stationScrollBefore = structuredClone(stationScrolls);
const stationDisposition = MarketListingPolicy.evaluate(stationScrolls, { now });
assert.strictEqual(stationDisposition.warehouse[0]?.selfId, dEnchantScroll.selfId,
    'the separate native infrastructure owner retains valuable scroll stock');
assert.strictEqual(stationDisposition.warehouse.reduce((sum, item) => sum + item.count, 0), 81);
assert.deepStrictEqual(stationDisposition.npc, []);
assert.deepStrictEqual(stationScrolls, stationScrollBefore);
for (let deal = 0; deal < 12; deal++) MarketCounters.deal(dEnchantScroll.selfId, 6000, 1, now - (12 - deal) * 300000, 999999);
assert.deepStrictEqual(MarketListingPolicy.evaluate(scrollState, { now, slots: 0 }).warehouse, [],
    'no board slot does not authorise ordinary warehouse storage');
assert.strictEqual(MarketListingPolicy.evaluate(stationScrolls, { now, slots: 0 }).warehouse[0]?.selfId, dEnchantScroll.selfId,
    'infrastructure scroll cleanup retains stock when the board has no slot');
MarketCounters.reset();
// Every Scroll of Escape a bot holds saves a walk to town:
// none is NPC junk. A party resurrection remains a cast without an item: its
// scrolls are sold.
for (const consumable of [escapeScroll, resurrectionScroll]) {
    const consumableItem = {
        selfId: consumable.selfId,
        name: consumable.template.name,
        kind: consumable.template.kind,
        stackable: true,
        amount: 13
    };
    const consumableState = { ...state, inventory: { [consumable.selfId]: consumableItem } };
    const escape = consumable.selfId === escapeScroll.selfId;
    assert.deepStrictEqual(MarketListingPolicy.evaluate(consumableState, { states: [] }).npc.map((item) => item.selfId),
        escape ? [] : [consumable.selfId], `${consumable.template.name}: ${escape ? 'kept whole' : 'sold to the NPC'}`);
    assert.strictEqual(ItemDisposition.isWarehouseCandidate(consumableItem), false,
        `${consumable.template.name} must not be parked in the warehouse`);
}

const cooldownCleanup = GoalExecutor.beginMarketTravel({
    ...state,
    stats: { marketSellSeen: triedAll(state.inventory) }
}, {
    type: 'sell_inventory',
    target: { cleanupReason: 'inventory_capacity' },
    plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_capacity' }
}, now);
assert(cooldownCleanup, 'forced inventory cleanup must bypass a stale market retry cooldown');
assert.strictEqual(GoalExecutor.beginMarketTravel({
    ...state,
    stats: { marketSellSeen: triedAll(state.inventory) }
}, {
    type: 'sell_inventory',
    plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory' }
}, now), null, 'ordinary market sales must still respect the retry cooldown');

// Weight penalty 1 (half of the max load) only slows the walk: during the sale
// retry it waits like a half-full bag and the bot hunts on; penalty 2 stays the floor.
const SurvivalFloor = invoke('GameServer/Bot/Population/SurvivalFloor');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const maxLoad = invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(state, now).maxLoad;
const heavyStack = DataCache.items.find((item) => item?.etc?.stackable === true
    && Number(item?.template?.mass) >= 10 && item?.template?.kind === 'Other.Material');
assert(maxLoad > 0 && heavyStack, 'the datapack must contain a heavy stackable material');
const loadedBag = (share, retry, extra = {}) => {
    const inventory = { [heavyStack.selfId]: { selfId: heavyStack.selfId, name: heavyStack.template.name,
        kind: heavyStack.template.kind, stackable: true,
        amount: Math.ceil(share * maxLoad / Number(heavyStack.template.mass)) }, ...extra };
    return { ...state, inventory, stats: { marketSellSeen: retry ? triedAll(inventory) : null } };
};
const retryUntil = true; // the bag is behind the sale retry
for (const [share, penalty] of [[0.55, 1], [0.7, 2]]) {
    const floor = SurvivalFloor.forState(loadedBag(share, false), now);
    assert.strictEqual(floor?.reason, 'overweight');
    assert.strictEqual(floor.weightPenalty, penalty, `a ${share} load is weight penalty ${penalty}`);
}
assert.strictEqual(SurvivalFloor.forState(loadedBag(0.55, retryUntil), now), null,
    'a weight penalty 1 bag is no floor during the sale retry');
assert.strictEqual(SurvivalFloor.forState(loadedBag(0.7, retryUntil), now)?.weightPenalty, 2,
    'a weight penalty 2 bag stays the floor during the sale retry');
assert(!NeedsEvaluator.evaluate(loadedBag(0.55, retryUntil), { now }).some((candidate) => candidate.type === 'sell_inventory'),
    'the planner adds no sale goal for a weight penalty 1 bag during the retry');
const npcJunk = { [spellbook.selfId]: { selfId: spellbook.selfId, name: spellbook.template.name,
    kind: spellbook.template.kind, stackable: false, amount: 1,
    instances: [{ id: 9100000, amount: 1, equipped: false, slot: 0 }] } };
assert.strictEqual(ItemDisposition.inventoryCleanupNeed(loadedBag(0.55, retryUntil, npcJunk), { now })?.reason,
    'npc_only_inventory');
const huntSpot = { id: 'starter_gremlin', name: 'Gremlin field', avgLevel: 1, density: 1, npcSelfIds: [1],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 } };
// Level 3: a weaponless level-1 bag holder would end no gremlin fight above its potion line (BotEncounterReadiness).
const hunt = (share) => BackgroundResolver.resolveSolo({ state: { ...loadedBag(share, retryUntil), level: 3, levelBand: '1-3',
    currentRegion: undefined, loc: undefined, party: { role: 'dps' } }, spot: huntSpot, elapsedMs: 60000, timestamp: now, rng: () => 0 });
const slowHunt = hunt(0.55);
assert(slowHunt.debug?.reason !== 'survival_overweight' && slowHunt.debug?.fights > 0,
    `a weight penalty 1 bot hunts during the sale retry: ${JSON.stringify(slowHunt.debug)}`);
assert.strictEqual(hunt(0.7).debug?.reason, 'survival_overweight',
    'a weight penalty 2 bot still stops to unload');

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

const npcFixtures = [DataCache.items.find(item => Number(item.selfId) === 3942), ...DataCache.items
    .filter((item) => /^(recipe:|spellbook)/i.test(item?.template?.name || '')
        && item.template.kind !== 'Other.Quest' && Sources.hasSource(item.selfId) && Number(item.selfId) !== 3942)
    .slice(0, 20)];
assert(npcFixtures.length >= 21, 'the datapack must contain enough recipe/spellbook fixtures');
const skillBooks = DataCache.items.filter((item) => {
    const name = String(item?.template?.name || '').toLowerCase();
    const kind = String(item?.template?.kind || '');
    return !kind.startsWith('Weapon.') && !kind.startsWith('Armor.')
        && (kind.startsWith('Other.Spellbook') || name.includes('spellbook') || /^amulet\b/.test(name));
});
assert(skillBooks.length > 100, 'the datapack must expose the full C4 skill-book catalog');
// Automatic bot skills consume no books. Both mapped and unmapped books
// go to NPC cleanup while quest items retain their native protection.
const mappedBookIds = new Set(require('../data/Skills/c4-skill-books.json').skills.map(row => Number(row[1])));
let mappedBooks = 0, unmappedBooks = 0;
for (const item of skillBooks) {
    const mapped = mappedBookIds.has(Number(item.selfId));
    if (mapped) mappedBooks++; else unmappedBooks++;
    assert.strictEqual(ItemDisposition.isNpcOnlyItem({
        selfId: item.selfId, name: item.template.name, kind: item.template.kind, amount: 1
    }), item.template.kind !== 'Other.Quest', `original book ${item.selfId} needs no paid bot training`);
}
assert(mappedBooks > 0 && unmappedBooks > 0, 'the unchanged catalogue must exercise both mapped and unmapped books');
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
    { action: 'npc', reason: 'npc_only_item' }, 'an ordinary personal owner sells even mapped amulets to the NPC');
assert(chantDisposition.decisions.every(row => row.reason === 'npc_only_item'));
assert.strictEqual(ItemDisposition.npcOnlySlotCount(chantState), 1);
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed(chantState, { now }), {
    reason: 'npc_only_inventory', slots: 1, npcOnlySlots: 1, limit: ItemDisposition.INVENTORY_SLOT_LIMIT
}, 'one ordinary NPC-only training book activates the native book cleanup rule');
assert.deepStrictEqual(chantState, chantBefore, 'classification and listing cannot alter the original book');
const stationChant = { ...chantState, stats: { ...chantState.stats, craftStationId: craftStation.id } };
const stationChantBefore = structuredClone(stationChant);
const stationChantDisposition = MarketListingPolicy.evaluate(stationChant);
assert.strictEqual(stationChantDisposition.candidates[0]?.count, 1);
assert.deepStrictEqual(MarketListingPolicy.classify(stationChant, stationChantDisposition.candidates[0]),
    { action: 'npc', reason: 'npc_only_item' }, 'infrastructure also receives free skills and cleans up mapped amulets');
assert(stationChantDisposition.decisions.every(row => row.reason === 'npc_only_item'));
assert.strictEqual(ItemDisposition.npcOnlySlotCount(stationChant), 1);
assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed(stationChant, { now }), {
    reason: 'npc_only_inventory', slots: 1, npcOnlySlots: 1, limit: ItemDisposition.INVENTORY_SLOT_LIMIT
});
assert.deepStrictEqual(stationChant, stationChantBefore, 'the infrastructure quote retains original physical ownership');
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
assert.deepStrictEqual(
    ItemDisposition.inventoryCleanupNeed(preTradeNpcState, { now }),
    ItemDisposition.inventoryCleanupNeed({ ...preTradeNpcState, level: 10 }, { now }),
    'young characters use the same item-based cleanup rule as older ones'
);
assert.strictEqual(
    ItemDisposition.npcLiquidationCandidates(preTradeNpcState).length,
    3,
    'ordinary NPC liquidation no longer has a character-level boundary'
);
assert.strictEqual(
    ItemDisposition.npcLiquidationCandidates(preTradeNpcState, { allowPreTradeCleanup: true }).length,
    3,
    'forced pre-trade cleanup must still expose NPC-only candidates'
);
const expectedNpcBookFixtures = npcFixtures.filter(item => !mappedBookIds.has(Number(item.selfId)));
assert(expectedNpcBookFixtures.length > 0 && expectedNpcBookFixtures.length < npcFixtures.length,
    'the unchanged 21-item mixed bag contains both NPC junk and mapped training books');
// The quotation helper exposes cheap mapped books too. Both ordinary and
// infrastructure owners clean them up without paid training demand.
assert(npcFixtures.every(item => !mappedBookIds.has(Number(item.selfId))
    || Number(item.template.price) <= ItemDisposition.NPC_LIQUIDATION_MAX_UNIT_PRICE),
    'the reachable bag combines explicit NPC junk and cheap mapped books');
assert.strictEqual(ItemDisposition.npcLiquidationCandidates(npcState).length, npcFixtures.length);
const mixedBookDisposition = MarketListingPolicy.evaluate(npcState);
const stationMixedState = { ...npcState, stats: { ...npcState.stats, craftStationId: craftStation.id } };
const stationMixedBefore = structuredClone(stationMixedState);
const stationMixedDisposition = MarketListingPolicy.evaluate(stationMixedState);
for (const item of expectedNpcBookFixtures) {
    assert(mixedBookDisposition.npc.some(row => Number(row.selfId) === Number(item.selfId)),
        `original NPC junk ${item.selfId} retains its liquidation route`);
}
for (const item of npcFixtures.filter(item => mappedBookIds.has(Number(item.selfId)))) {
    const candidate = mixedBookDisposition.candidates.find(row => Number(row.selfId) === Number(item.selfId));
    assert(candidate, 'an original mapped book remains a physical disposition candidate');
    assert.deepStrictEqual(MarketListingPolicy.classify(npcState, candidate), { action: 'npc', reason: 'npc_only_item' });
    assert(mixedBookDisposition.decisions.filter(row => Number(row.item.selfId) === Number(item.selfId))
        .every(row => row.reason === 'npc_only_item'), 'ordinary mapped books follow the free-skill cleanup policy');
    const stationCandidate = stationMixedDisposition.candidates.find(row => Number(row.selfId) === Number(item.selfId));
    assert(stationCandidate, 'the same mapped stock remains available to the infrastructure owner');
    assert.deepStrictEqual(MarketListingPolicy.classify(stationMixedState, stationCandidate), { action: 'npc', reason: 'npc_only_item' });
    assert(stationMixedDisposition.decisions.filter(row => Number(row.item.selfId) === Number(item.selfId))
        .every(row => row.reason === 'npc_only_item'), 'infrastructure uses the same free-skill cleanup policy');
}
assert.strictEqual(stationMixedDisposition.npc.length, npcFixtures.length, 'all original mixed stock reaches NPC cleanup');
assert.deepStrictEqual(stationMixedState, stationMixedBefore, 'the mixed infrastructure quote preserves physical stock');
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
    stats: { marketSellSeen: triedAll(npcState.inventory) }
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
    ...state.stats, equipment: [{ ...equippedBook, rank: 'none' }], marketSellSeen: triedAll({ 99: equippedBook })
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

// One bag's sale list serves its readers that ask with the same inputs (the
// cleanup need, a listing, the board's sale count): the answer a fresh read
// gives, each reader its own rows, and a fresh answer when the bag, a reserve
// or a price moves on the same bag.
{
    const books = state.inventory[spellbook.selfId];
    const seller = { ...state, characterId: 7010, stats: { shotCraft: { productId: 1463, unitPrice: 20 } }, inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 30, stackable: true },
        1463: { selfId: 1463, name: 'Soulshot: D-grade', amount: 900, stackable: true },
        [spellbook.selfId]: { ...books, amount: 3, instances: books.instances.slice(0, 3) } } };
    // The caller's kept stock (as the listing and the sale count pass it): no forecast read.
    const all = (extra = {}) => ({ unlimited: true, now, keptAmounts: { 1463: 100 }, ...extra });
    const fresh = (value, options) => ItemDisposition.saleCandidates(structuredClone(value), options);
    const read = (value, options = all()) => ItemDisposition.saleCandidates(value, options);
    const row = (rows, id) => rows.find(item => item.selfId === id);
    const first = read(seller), second = read(seller);
    assert(row(first, 1864) && row(first, 1463) && row(first, spellbook.selfId), 'fixture: three stacks to sell');
    for (const rows of [first, second]) rows.forEach(item => { item.count = 0; });
    assert.deepStrictEqual(read(seller), fresh(seller, all()), 'a later reader gets the fresh answer, not an earlier reader\'s rows');
    assert.strictEqual(row(read({ ...seller, stats: { shotCraft: { productId: 1463, unitPrice: 35 } } }), 1463).price, 35,
        'a moved price on the same bag is read');
    assert.deepStrictEqual(ItemDisposition.inventoryCleanupNeed(seller, { now }),
        ItemDisposition.inventoryCleanupNeed(structuredClone(seller), { now }), 'the cleanup need over the shared list is the fresh one');
    assert.deepStrictEqual(read(seller, all({ reserved: { 1864: 10 } })), fresh(seller, all({ reserved: { 1864: 10 } })));
    assert.strictEqual(row(read(seller, all({ reserved: { 1864: 10 } })), 1864).count, 20, 'a reserve on the same bag is read');
    const moved = { ...seller, inventory: { ...seller.inventory, 1864: { ...seller.inventory[1864], amount: 31 } } };
    assert.strictEqual(row(read(moved), 1864).count, 31, 'a moved bag is read');
    assert.strictEqual(row(read(seller), 1463).count, 800, 'fixture: the kept shots stay');
    assert.strictEqual(row(read(seller), 1864).count, 30, 'the first bag keeps its answer');
    assert.strictEqual(ItemDisposition.saleCandidates(seller, { presenceOnly: true, keptAmounts: {} }), true);
    assert.deepStrictEqual(read(seller, all({ unlimited: false, limit: 1 })), fresh(seller, all({ unlimited: false, limit: 1 })),
        'a capped list is its own');
    assert.strictEqual(read(seller, all({ unlimited: false, limit: 1 })).length, 1);
}

}
runInventoryCleanup().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await invoke('Database').close();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
