'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
process.env.L2NODE_PROGRESSION_RATE = 'x50';
const isolated = require('./helpers/isolatedSocialDatabase')('clan-equipment-routes');
require('../src/Global');
isolated.assertConfigured(options.default);
try {
    const Data = invoke('GameServer/DataCache');
    Data.init();
    const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Kits = invoke('GameServer/Bot/AI/BotGear');
    const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
    const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');
    const inventory = Life.inventorySummaryFromItems(Kits.planFor({ classId: 36, level: 40 }).items);
    const member = { characterId: 7000001, classId: 36, level: 55, phase: 'cold', adena: 0,
        inventory, stats: { classId: 36 } };
    const raid = { ...Catalog.findById('raid:10050'), raidRosterSize: 9,
        raidEstimate: { fightSeconds: 120, preparationSeconds: 90, recoverySeconds: 60, successChance: 0.9 } };
    const raidSource = { npcId: 10050, npcLevel: 51, spotId: raid.id, expectedYield: 1,
        sourceKind: 'raid', raidBoss: true, raidRosterSize: 9, raidEstimate: raid.raidEstimate };
    const ordinary = { npcId: 1245, npcLevel: 50, spotId: 'ordinary', expectedYield: 0.0001 };
    assert(Gear.soloSafeForSource(member, ordinary));
    assert(Gear.sourceEffort(raidSource, member) < Gear.sourceEffort(ordinary, member));
    assert.equal(Gear.bestSourceForState([raidSource, ordinary], member), ordinary,
        'personal planning retains the safe solo preference');
    assert.equal(Gear.bestSourceForState([raidSource, ordinary], member, { clanCrafting: true }), raidSource,
        'a clan compares the admitted roster cost with the solo route instead of discarding raids');

    // A low grid average cannot hide the actual dropper's level (66).
    const tooHigh = { id: 'high-farm', avgLevel: 45,
        npcEntries: [{ selfId: 707, name: 'Lord Ishka', count: 1 }] };
    const plan = planForMember(member, [tooHigh, raid], [], { craftRecipes: [], allowedRecipeIds: [],
        allowRaidSources: true, maxExpectedKills: 1500 });
    assert.equal(plan.status, 'active', JSON.stringify(plan));
    assert.equal(plan.next.raidBoss, true, JSON.stringify(plan));
    assert([2384, 2388, 2390].includes(plan.target.selfId),
        'an attainable missing armour slot competes with the inaccessible next-grade weapon');
    assert.equal(Gear.acquisitionTargetAllowed(member, plan), true);

    const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(366);
    const normalSpots = Data.npcs.filter(npc => npc.template?.level >= 40 && npc.template?.level <= 60
        && Gear.isBotEligibleSourceNpcId(npc.selfId)).map(npc => ({ id: `npc:${npc.selfId}`,
        avgLevel: npc.template.level, npcEntries: [{ selfId: npc.selfId, name: npc.template.name, count: 1 }] }));
    const routeOptions = { clanCrafting: true, allowRaidSources: true, wishTargetId: 2390,
        craftRecipes: [recipe], allowedRecipeIds: new Set([recipe.recipeId]), findMarketOffer: () => null };
    const supplied = { ...member, inventory: { ...inventory, ...Object.fromEntries([4046, 1459, 2132].map(selfId => {
        const amount = recipe.materials.find(row => row.selfId === selfId).amount;
        return [selfId, { selfId, amount }];
    })) } };
    const craft = Gear.planFor(supplied, { ...routeOptions, spots: normalSpots });
    assert.equal(craft.strategy, 'craft', JSON.stringify(craft));
    assert(Number.isFinite(craft.expectedEffort) && craft.expectedEffort > 0);
    const alternate = invoke('GameServer/Items/C4RecipeItems').resolveVariantsByProductId(recipe.productId)
        .find(row => row.recipeId !== recipe.recipeId);
    assert(alternate, 'the B armour has a second native recipe variant');
    const stale = { ...supplied, stats: { ...supplied.stats, equipmentPlan: { ...craft,
        recipeId: alternate.recipeId, target: { selfId: 2390, slot: 15 } } } };
    const corrected = planForMember(stale, normalSpots, [], { throwOnError: true,
        strategicTarget: { itemId: 2390, slot: 15 }, craftRecipes: [recipe], allowedRecipeIds: [recipe.recipeId] });
    assert.equal(corrected.target?.selfId, 2390, 'an unavailable recipe variant keeps the equipment goal');
    assert.equal(corrected.recipeId, recipe.recipeId, 'the clan chooses the offered recipe variant');
    const stationFirst = planForMember(stale, normalSpots, [], { throwOnError: true,
        strategicTarget: { itemId: 2390, slot: 15 }, craftRecipes: [recipe, alternate],
        allowedRecipeIds: [recipe.recipeId, alternate.recipeId],
        craftProviders: { [alternate.recipeId]: { characterId: 7000002, known: false } } });
    assert.equal(stationFirst.recipeId, recipe.recipeId,
        'a station recipe wins over an unlearned clan recipe even when both are technically available');
    const compared = Gear.planFor(supplied, { ...routeOptions, spots: [...normalSpots, raid] });
    assert.equal(compared.strategy, 'direct_drop', JSON.stringify(compared));
    assert.equal(compared.next.raidBoss, true);
    assert(compared.expectedEffort < craft.expectedEffort,
        'finite B crafting must not hide a cheaper admitted raid');
    const costlyRaid = { ...raid, raidEstimate: { ...raid.raidEstimate, fightSeconds: 3600, successChance: 0.1 } };
    const economical = Gear.planFor(supplied, { ...routeOptions, spots: [...normalSpots, costlyRaid] });
    assert.equal(economical.strategy, 'craft', 'an expensive raid must lose the same cost comparison');
    console.log('Clan equipment route checks passed');
} finally {
    fs.rmSync(isolated.directory, { recursive: true, force: true });
}
