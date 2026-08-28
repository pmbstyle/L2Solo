const assert = require('assert');

require('../src/Global');

const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');
const DataCache = invoke('GameServer/DataCache');

DataCache.init();

const spot = { id: 'cruma', risk: 2, route: { id: 'cruma_construct_spoil' } };
const base = {
    characterId: 7,
    phase: 'cold',
    level: 40,
    adena: 8000,
    vitals: { hp: 900, maxHp: 1000, mp: 400, maxMp: 500 },
    party: {},
    stats: {}
};

const timestamp = 100000;
const healthy = GoalPlanner.plan(NeedsEvaluator.evaluate(base, { spot, now: timestamp }), timestamp);
assert.strictEqual(healthy.type, 'progress_level');
assert.strictEqual(healthy.plan.spotId, 'cruma');

const poor = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, adena: 50 }, { spot, now: timestamp }), timestamp);
assert.strictEqual(poor.type, 'earn_adena');
assert.strictEqual(poor.target.adena, 4800);

const resting = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    vitals: { hp: 200, maxHp: 1000, mp: 400, maxMp: 500 }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(resting.type, 'recover');
assert.strictEqual(resting.plan.kind, 'rest');

const dead = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, activity: 'dead' }, { spot, now: timestamp }), timestamp);
assert.strictEqual(dead.plan.kind, 'town_return');

const expectedWeapon = invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 7);
const equipmentGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        equipment: [{ selfId: 999, slot: 7, rank: 'd', name: 'Old Weapon' }]
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(equipmentGoal.type, 'upgrade_gear');
assert.strictEqual(equipmentGoal.target.itemId, expectedWeapon.selfId);
assert.strictEqual(equipmentGoal.plan.expectedBenefit, 'adena_for_weapon_upgrade');

const wealthInvestmentGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 1000000000,
    spotId: 'cruma',
    persona: { primaryDrive: 'wealth', traits: {} },
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        equipment: [{ selfId: 999, slot: 7, rank: 'd', name: 'Old Weapon' }],
        deaths: 3,
        fightsResolved: 12,
        spotRisk: { spotId: 'cruma', deathsAtEntry: 1, fightsAtEntry: 2 }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(wealthInvestmentGoal.type, 'upgrade_gear');
assert.strictEqual(wealthInvestmentGoal.priority, 81, 'repeated deaths at the current spot should elevate an affordable wealth investment');
assert.strictEqual(wealthInvestmentGoal.plan.wealthInvestment.reason, 'reduce_deaths_at_profitable_spot');

const expectedChest = invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 0, level: 40 }).items.find((item) => Number(item.slot) === 10);
const expectedChestPrice = Number((DataCache.items || []).find((item) => Number(item.selfId) === Number(expectedChest.selfId))?.template?.price || 0);
const armorGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 1000000,
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        equipment: [{ selfId: expectedWeapon.selfId, slot: 7, rank: 'c', name: expectedWeapon.name }]
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(armorGoal.type, 'upgrade_gear');
assert.strictEqual(armorGoal.target.equipmentSlot, 'chest');
assert.strictEqual(armorGoal.target.itemId, expectedChest.selfId);
assert.strictEqual(armorGoal.plan.expectedBenefit, 'market_search_for_gear');

const npcProgressionItem = (kindPrefix, slot) => (DataCache.items || []).find((item) => (
    String(item.etc?.rank || '').toLowerCase() === 'd'
    && String(item.template?.kind || '').startsWith(kindPrefix)
    && Number(item.etc?.slot) === Number(slot)
    && Number(item.template?.price || 0) > 0
));
const dWeapon = npcProgressionItem('Weapon.', 7);
const dChest = (DataCache.items || []).find((item) => (
    String(item.etc?.rank || '').toLowerCase() === 'd'
    && String(item.template?.kind || '').startsWith('Armor.')
    && item.template?.kind !== 'Armor.Jewel'
    && Number(item.etc?.slot) === 10
    && Number(item.template?.price || 0) > 0
));
const dEarring = npcProgressionItem('Armor.Jewel', 1);
assert(dWeapon && dChest && dEarring, 'the datapack must expose D-grade NPC progression fixtures');

function affordableNpcProgressionGoal(item, slot, equipment) {
    const price = Number(item.template.price);
    return GoalPlanner.plan(NeedsEvaluator.evaluate({
        ...base,
        level: 20,
        adena: price + 1000000,
        inventory: {
            1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
        },
        stats: {
            classId: 0,
            build: { grade: 'd', classId: 0, level: 20 },
            equipment,
            equipmentPlan: {
                status: 'active',
                strategy: 'market',
                partyNeedReason: 'npc_progression',
                target: { selfId: item.selfId, slot },
                market: { town: 'Giran', price, reserve: 50000, sourceType: 'npc' }
            }
        }
    }, { spot, now: timestamp }), timestamp);
}

const affordableNpcWeaponGoal = affordableNpcProgressionGoal(dWeapon, 7, [
    { selfId: 1, slot: 7, rank: 'none', name: 'Short Sword' }
]);
assert.strictEqual(affordableNpcWeaponGoal.type, 'upgrade_gear', 'an affordable NPC weapon must outrank selling surplus inventory');
assert.strictEqual(affordableNpcWeaponGoal.priority, 88);
assert.strictEqual(affordableNpcWeaponGoal.plan.requiredAdena, 0);

const affordableNpcArmorGoal = affordableNpcProgressionGoal(dChest, 10, [
    { selfId: dWeapon.selfId, slot: 7, rank: 'd', name: dWeapon.template.name }
]);
assert.strictEqual(affordableNpcArmorGoal.type, 'upgrade_gear', 'affordable NPC armour must outrank selling surplus inventory');
assert.strictEqual(affordableNpcArmorGoal.priority, 87);

const affordableNpcJewelryGoal = affordableNpcProgressionGoal(dEarring, 1, [
    { selfId: dWeapon.selfId, slot: 7, rank: 'd', name: dWeapon.template.name },
    { selfId: dChest.selfId, slot: 10, rank: 'd', name: dChest.template.name }
]);
assert.strictEqual(affordableNpcJewelryGoal.type, 'upgrade_gear', 'affordable NPC jewellery must still beat an ordinary sale after weapon and armour');
assert.strictEqual(affordableNpcJewelryGoal.priority, 78);

const clanJewelryGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    level: 20,
    adena: Number(dEarring.template.price) + 1000000,
    persona: { primaryDrive: 'wealth', traits: {} },
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    },
    stats: {
        classId: 0,
        build: { grade: 'd', classId: 0, level: 20 },
        equipment: [
            { selfId: dWeapon.selfId, slot: 7, rank: 'd', name: dWeapon.template.name },
            { selfId: dChest.selfId, slot: 10, rank: 'd', name: dChest.template.name }
        ],
        equipmentPlan: {
            status: 'active',
            strategy: 'market',
            partyNeedReason: 'npc_progression',
            target: { selfId: dEarring.selfId, slot: 1 },
            market: { town: 'Giran', price: Number(dEarring.template.price), reserve: 50000, sourceType: 'npc' },
            clanGoal: { clanId: 77, goalKey: 'clan-equipment:77:1:earring:1', priority: 'required' }
        }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(clanJewelryGoal.type, 'upgrade_gear',
    'a funded clan jewellery assignment must outrank a voluntary wealth sale');
assert.strictEqual(clanJewelryGoal.priority, 89);

const recoveringNpcBuyer = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    level: 20,
    adena: Number(dWeapon.template.price) + 1000000,
    vitals: { hp: 200, maxHp: 1000, mp: 400, maxMp: 500 },
    inventory: { 1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' } },
    stats: {
        classId: 0,
        build: { grade: 'd', classId: 0, level: 20 },
        equipment: [{ selfId: 1, slot: 7, rank: 'none', name: 'Short Sword' }],
        equipmentPlan: {
            status: 'active', strategy: 'market', partyNeedReason: 'npc_progression',
            target: { selfId: dWeapon.selfId, slot: 7 },
            market: { town: 'Giran', price: Number(dWeapon.template.price), reserve: 50000, sourceType: 'npc' }
        }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(recoveringNpcBuyer.type, 'recover', 'unsafe vitals must still outrank an affordable NPC purchase');

for (const status of ['active', 'ready_to_craft', 'blocked']) {
    const cCraftCandidates = NeedsEvaluator.evaluate({
        ...base,
        level: 40,
        adena: 1000000000,
        stats: {
            classId: 0,
            build: { grade: 'c', classId: 0, level: 40 },
            equipment: [{ selfId: dWeapon.selfId, slot: 7, rank: 'd', name: dWeapon.template.name }],
            equipmentPlan: {
                status,
                strategy: 'craft',
                target: { selfId: expectedWeapon.selfId, slot: 7 },
                recipeId: 191,
                materials: [{ selfId: 1458, amount: 700, missing: 700 }],
                next: null
            }
        }
    }, { spot, now: timestamp });
    assert(!cCraftCandidates.some((candidate) => candidate.type === 'upgrade_gear'),
        `${status} C-grade crafting must not turn into an unavailable NPC shopping goal`);
    assert.strictEqual(GoalPlanner.plan(cCraftCandidates, timestamp).type, 'progress_level',
        `${status} C-grade crafting must leave ordinary leveling available while no material route is executable`);
}

const completedNoGradeKitCandidates = NeedsEvaluator.evaluate({
    ...base,
    level: 14,
    adena: 1000000,
    stats: {
        classId: 53,
        build: { grade: 'none', classId: 53, level: 14 },
        equipment: [{ selfId: 8, slot: 14, rank: 'none', name: 'Willow Staff' }],
        equipmentPlan: {
            status: 'complete',
            reason: 'npc_adequate_kit',
            strategy: 'none'
        }
    }
}, { spot, now: timestamp });
assert(!completedNoGradeKitCandidates.some((candidate) => candidate.type === 'upgrade_gear'),
    'an adequate no-grade NPC kit must not fall back to an exact BotGear item or open a WTB goal');
assert.strictEqual(GoalPlanner.plan(completedNoGradeKitCandidates, timestamp).type, 'progress_level',
    'a completed no-grade NPC kit must return to normal progression');

const staleMarketPlanGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 1000000,
    stats: {
        classId: 0,
        build: { grade: 'c', classId: 0, level: 40 },
        // The weapon was just purchased. The resolver has not rebuilt the
        // equipment plan yet, so the next goal must use the chest's own
        // template data instead of the completed weapon offer.
        equipment: [{ selfId: expectedWeapon.selfId, slot: 7, rank: 'c', name: expectedWeapon.name }],
        equipmentPlan: {
            status: 'active',
            strategy: 'market',
            target: { selfId: expectedWeapon.selfId },
            market: { town: 'Dion', price: 7 }
        }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(staleMarketPlanGoal.target.itemId, expectedChest.selfId, 'the next build slot must replace a completed market target');
assert.strictEqual(staleMarketPlanGoal.target.adena, expectedChestPrice, 'the next item must use its own price rather than the completed offer');
assert.strictEqual(staleMarketPlanGoal.plan.marketTown, null, 'the next item must be replanned before choosing a market town');

const noSnapshot = GoalPlanner.plan(NeedsEvaluator.evaluate({ ...base, stats: { classId: 0, build: { grade: 'c' } } }, { spot, now: timestamp }), timestamp);
assert.notStrictEqual(noSnapshot.type, 'upgrade_gear', 'missing equipment data must not invent a gear deficit');

const preFocusGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    level: 4,
    stats: {
        classId: 0,
        build: { grade: 'none', classId: 0, level: 4 },
        equipment: []
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(preFocusGoal.type, 'progress_level', 'bots below level five must not abandon starter leveling for equipment goals');

const saleGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(saleGoal.type, 'sell_inventory');
assert.strictEqual(saleGoal.plan.expectedBenefit, 'market_sale_inventory');

const wealthSaleGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    persona: { primaryDrive: 'wealth', traits: {} },
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(wealthSaleGoal.type, 'sell_inventory');
assert.strictEqual(wealthSaleGoal.priority, 86, 'wealth drive should prioritize a real market opportunity');
assert.strictEqual(wealthSaleGoal.plan.personaDrive, 'wealth');
assert.strictEqual(wealthSaleGoal.target.focusItem.itemId, 1864);

const poorSellerGoal = GoalPlanner.plan(NeedsEvaluator.evaluate({
    ...base,
    adena: 50,
    inventory: {
        1864: { selfId: 1864, name: 'Stem', amount: 12, kind: 'Other.Material' }
    }
}, { spot, now: timestamp }), timestamp);
assert.strictEqual(poorSellerGoal.type, 'sell_inventory', 'valuable surplus should fund progress before another low-adena farm loop');

console.log('Bot goal planner checks passed');
