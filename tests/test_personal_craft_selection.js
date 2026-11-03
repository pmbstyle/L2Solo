// A personal craft of any grade survives plan selection: the wish network's craft plan names a workshop provider, which
// the native planner cannot see (it reads station recipes only). Fresh and saved plans alike.
'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('./helpers/isolatedSocialDatabase')('personal-craft-selection');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const Index = invoke('GameServer/Item/ItemTemplateIndex');
const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
const timestamp = 1791813240000;

function equipped(inv, selfId, slot) {
    const row = inv[selfId], slots = [...(row?.equippedSlots || []), slot];
    inv[selfId] = { selfId, amount: slots.length, equipped: true, equippedCount: slots.length, equippedSlots: slots, slot };
}
function base(classId, level, adena) {
    const state = { characterId: 990410, name: 'CraftBuyer', level, classId, phase: 'cold', activity: 'hunting',
        currentRegion: 'Giran', adena, loc: { locX: 81100, locY: 148000, locZ: -3466 },
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, inventory: {},
        stats: { classId, exp: Data.experience[level - 1] + 1,
            persona: { primaryDrive: 'progression', understanding: 1, traits: { ambition: 0, commitment: 0, caution: 0, empathy: 0, sociability: 0 } } } };
    for (const row of Gear.planFor({ classId, level: 30 }).items) equipped(state.inventory, row.selfId, row.slot);
    for (const id of [invoke('GameServer/Inventory/ShotStock').planForState(state).selfId, 1061, 736]) state.inventory[id] = { selfId: id, amount: 100000 };
    return state;
}
function build(state) {
    const service = id => ({ characterId: 990412, recipeId: id, price: 1000, entryPrice: 1000, capacityBatches: 1,
        townName: 'Giran', loc: { locX: 83400, locY: 148600, locZ: -3400 }, publicStation: false });
    return Economy.forState(state, { timestamp, board: new BoardIndex(), spots: [], npcOffersFor: () => [], workshop: null,
        knownRecipes: [], withNodes: true, knowledgeEnabled: false,
        routeRows: invoke('GameServer/Bot/Economy/EconomicTrip').towns.map(() => [true, 0, 0]),
        workshops: id => [service(id)], caller: 'meeting_prepare' });
}

const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure() || [];
const planningOptions = { findNpcOffer: () => null, findMarketOffer: () => null, buyOrderEscrow: 0 };
const root = build(base(3, 45, 20000000)).network.queue.find(wish => wish.key.startsWith('power:'));
const productId = Number(root.key.split(':')[1]);
const variants = Recipes.resolveVariantsByProductId(productId);
const recipe = variants.find(row => row.successRate === 100) || variants[0];
assert.equal(Index.find(Data.items, productId)?.etc?.rank, 'c', 'the fixture is a C piece');
const state = base(3, 45, 20000000);
for (const material of recipe.materials) state.inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };

const context = build(state);
const prepared = Providers.personalCraftPlan(state, context);
assert.equal(prepared?.strategy, 'craft', 'the wish network plans the C craft');
const fresh = Selection.selectAcquisitionPlan(state, null, { preparedEconomy: context, spots, timestamp, planningOptions }).acquisitionPlan;
assert.equal(fresh.strategy, 'craft', 'a fresh selection keeps the C craft');
assert.equal(Number(fresh.target?.selfId), productId);

const resumed = { ...state, stats: { ...state.stats, equipmentPlan: prepared } };
const saved = Selection.selectAcquisitionPlan(resumed, prepared, { preparedEconomy: build(resumed), spots, timestamp, planningOptions }).acquisitionPlan;
assert.equal(saved.strategy, 'craft', 'a saved C craft survives its next build');
assert.equal(saved.status, 'active');
console.log('personal craft selection ok');
process.exit(0);
