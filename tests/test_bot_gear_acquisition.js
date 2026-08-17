const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ColdCraftingService = invoke('GameServer/Bot/Economy/ColdCraftingService');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');

DataCache.init();

const stoneGolemSpot = {
    id: 'stone-golem-field',
    avgLevel: 19,
    npcEntries: [{ selfId: 16, name: 'Stone Golem', count: 8 }]
};

const ironSources = GearAcquisitionPlanner.sourceForItem(1869, [stoneGolemSpot]);
assert(ironSources.length > 0, 'known material drops must resolve to their real NPC source');
assert.strictEqual(ironSources[0].spotId, stoneGolemSpot.id, 'source lookup must retain the matching farming spot');
assert(ironSources[0].chance > 0, 'source lookup must retain an expected drop chance');
const handAxe = DataCache.items.find((item) => item.template?.name === 'Hand Axe');
const boneStaff = DataCache.items.find((item) => item.template?.name === 'Bone Staff');
const scallopJamadhr = DataCache.items.find((item) => item.template?.name === 'Scallop Jamadhr');
assert(handAxe && boneStaff && scallopJamadhr,
    'the datapack must expose the Hand Axe, Bone Staff, and Scallop Jamadhr fixtures');
const lyraState = { level: 24, stats: { classId: 47, role: 'dps' } };
assert.strictEqual(GearAcquisitionPlanner.suitable(boneStaff, lyraState, 'dps', 'd'), false,
    'an Orc Monk must not treat the D-grade Bone Staff as a suitable melee weapon');
const lyraInventory = GearAcquisitionPlanner.equipInventoryUpgrades(lyraState, {
    [boneStaff.selfId]: { selfId: boneStaff.selfId, amount: 1, equipped: true, slot: boneStaff.etc.slot },
    [scallopJamadhr.selfId]: { selfId: scallopJamadhr.selfId, amount: 1, equipped: false, slot: scallopJamadhr.etc.slot }
});
assert.strictEqual(lyraInventory[boneStaff.selfId].equipped, false,
    'cold equipment refresh must remove an already equipped caster staff from an Orc Monk');
assert.strictEqual(lyraInventory[scallopJamadhr.selfId].equipped, true,
    'cold equipment refresh must replace the caster staff with the Orc Monk combat fists');
const wereratChiefSpot = {
    id: 'wererat-chief-field',
    avgLevel: 19,
    npcEntries: [{ selfId: 414, name: 'Sukar Wererat Chief', count: 1 }]
};
const handAxeSource = GearAcquisitionPlanner.sourceForItem(handAxe.selfId, [wereratChiefSpot], { level: 20 })
    .find((source) => source.npcId === 414);
assert(handAxeSource, 'a direct equipment source must retain its real dropper');
assert.strictEqual(handAxeSource.npcLevel, 28, 'a direct equipment source must retain its NPC level instead of its mixed-spot average');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 20 }, handAxeSource), false, 'a level-20 bot must not solo a level-28 item target just because its grid also contains lower-level mobs');
const gearedLevel30 = {
    level: 30,
    inventory: Object.fromEntries([7, 10, 11].map((slot) => {
        const item = DataCache.items.find((entry) => Number(entry.etc?.slot) === slot && entry.template?.name && entry.template.name !== '0');
        return [item.selfId, { selfId: item.selfId, amount: 1, equipped: true }];
    }))
};
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource(gearedLevel30, { spotLevel: 28 }), true, 'a geared bot should solo a source below its combat safety margin');
assert.strictEqual(GearAcquisitionPlanner.partyNeedForSource(gearedLevel30, { spotLevel: 32 }), 'preferred', 'a near-level source should advertise a party without blocking progress');
assert.strictEqual(GearAcquisitionPlanner.partyNeedReasonForSource(gearedLevel30, { spotLevel: 32 }), 'tight_level_margin', 'party telemetry must explain a preferred level-margin request');
assert.strictEqual(GearAcquisitionPlanner.partyNeedForSource(gearedLevel30, { spotLevel: 36 }), 'required', 'a materially stronger source must still require a party');
assert.strictEqual(GearAcquisitionPlanner.partyNeedReasonForSource(gearedLevel30, { spotLevel: 36 }), 'underleveled', 'party telemetry must explain a required level-gap request');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource(gearedLevel30, { spotLevel: 30 }), true, 'a normally equipped bot must not wait for a same-level source');
assert.strictEqual(
    GearAcquisitionPlanner.bestSourceForState([{ spotLevel: 32, id: 'dangerous' }, { spotLevel: 27, id: 'safe' }], gearedLevel30).id,
    'safe',
    'material planning must prefer a viable lower-yield solo source over a dangerous one'
);

const previousProgressionRate = process.env.L2NODE_PROGRESSION_RATE;
const caveMaidenSpot = {
    id: 'cave-maiden-field',
    avgLevel: 59,
    npcEntries: [{ selfId: 134, name: 'Cave Maiden', count: 4 }]
};
const caveMaidenSpots = [caveMaidenSpot];
process.env.L2NODE_PROGRESSION_RATE = 'x1';
const steelSourceAtX1 = GearAcquisitionPlanner.sourceForItem(1880, caveMaidenSpots, { level: 52 })[0];
process.env.L2NODE_PROGRESSION_RATE = 'x50';
const steelSourceAtX50 = GearAcquisitionPlanner.sourceForItem(1880, caveMaidenSpots, { level: 52 })[0];
assert(steelSourceAtX50.expectedYield > 1, 'high-rate material plans must include the scaled drop quantity, not only the selection chance');
assert(Math.ceil(220 / steelSourceAtX50.expectedYield) < 300, '220 Steel from Cave Maiden at x50 must not be estimated as thousands of kills');
assert(steelSourceAtX50.expectedYield > steelSourceAtX1.expectedYield, 'source cache keys must preserve progression-rate changes for the same atlas');
if (previousProgressionRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
else process.env.L2NODE_PROGRESSION_RATE = previousProgressionRate;

const originalNpcEntries = NpcShopBuyLists.allEntries;
try {
    NpcShopBuyLists.allEntries = () => [];
    assert.strictEqual(GearAcquisitionPlanner.staticNpcUpgradePlan({
        level: 20,
        adena: 1000000,
        stats: { classId: 0, role: 'dps' },
        inventory: { 57: { selfId: 57, amount: 1000000 } }
    }), null, 'an uninitialized NPC catalog must not produce a shop plan');
} finally {
    NpcShopBuyLists.allEntries = originalNpcEntries;
}

const noGradePlan = GearAcquisitionPlanner.planFor({ level: 10, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot] });
assert(['direct_drop', 'market'].includes(noGradePlan.strategy), 'no-grade bots must choose a drop or market route, never recipes');
assert.strictEqual(noGradePlan.recipeId, null, 'no-grade bots must never receive a crafting recipe');
assert.strictEqual(noGradePlan.rateModelVersion, GearAcquisitionPlanner.RATE_MODEL_VERSION, 'all acquisition plans must persist the drop-rate model used for their estimates');

const preFocusPlan = GearAcquisitionPlanner.planFor({ level: 4, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot] });
assert.strictEqual(preFocusPlan.status, 'deferred', 'starter bots must level naturally before gear acquisition begins');
assert.strictEqual(preFocusPlan.strategy, 'none');

const forcedRecipeBeforeTwenty = GearAcquisitionPlanner.planFor({ level: 19, stats: { classId: 0, role: 'dps' }, inventory: {} }, { spots: [stoneGolemSpot], recipeId: 189 });
assert.notStrictEqual(forcedRecipeBeforeTwenty.strategy, 'craft', 'no-grade bots must never enter a craft route before level twenty');

const marketNoGradePlan = GearAcquisitionPlanner.planFor({ level: 5, stats: { classId: 0, role: 'dps' }, inventory: {} }, {
    spots: [],
    findMarketOffer: (item) => ({ selfId: item.selfId, price: 1, town: 'Giran', sourceType: 'npc' })
});
assert.strictEqual(marketNoGradePlan.strategy, 'market', 'an affordable no-grade market offer must beat an unavailable drop route');
assert.strictEqual(marketNoGradePlan.recipeId, null, 'no-grade market purchases must never request crafting');

const failedDropState = {
    level: 10,
    stats: {
        classId: 0,
        role: 'dps',
        targetCombat: {
            populationTargets: {
                450: { resolves: GearAcquisitionPlanner.DIRECT_FAILURE_RESOLVE_LIMIT, targetKills: 0 }
            }
        }
    },
    inventory: {}
};
const failedTarget = GearAcquisitionPlanner.preferredNoGradeTarget(failedDropState);
const failedDropPlan = {
    status: 'active',
    grade: 'none',
    strategy: 'direct_drop',
    plannedForLevel: 10,
    startedAt: 1000,
    expectedKills: 19,
    target: { selfId: failedTarget.selfId, name: failedTarget.template.name },
    next: { npcId: 450, spotId: 'starter-field', itemId: failedTarget.selfId },
    targetProgress: { npcId: 450, resolves: 0, targetKills: 0 }
};
const failedContext = GearAcquisitionPlanner.replanContextFor(failedDropState, failedDropPlan, 20 * 60 * 1000);
assert.strictEqual(failedContext.failure.reason, 'combat_unviable', 'a cold drop route with repeated resolves and no target kills must expire');
assert.strictEqual(failedContext.planCurrent, true, 'failure detection must work even when the persisted plan still matches the current level');

const partyBlockedPlan = {
    ...failedDropPlan,
    partyNeed: 'required',
    requiresParty: true
};
const partyBlockedState = {
    ...failedDropState,
    stats: {
        ...failedDropState.stats,
        targetCombat: {
            populationTargets: {
                450: { resolves: 0, targetKills: 0 }
            }
        },
        partyRequest: {
            status: 'deferred',
            priority: 'required',
            targetId: failedTarget.selfId,
            npcId: 450,
            attempts: GearAcquisitionPlanner.PARTY_ROUTE_FAILURE_ATTEMPT_LIMIT
        }
    }
};
const partyBlockedContext = GearAcquisitionPlanner.replanContextFor(
    partyBlockedState,
    partyBlockedPlan,
    20 * 60 * 1000
);
assert.strictEqual(partyBlockedContext.failure.reason, 'party_route_unavailable',
    'a repeatedly deferred required party route must become a planner recovery, not an endless direct-drop objective');
const partyBlockedFallback = GearAcquisitionPlanner.planFor(partyBlockedState, {
    spots: [],
    ...partyBlockedContext,
    findMarketOffer: (item) => Number(item.selfId) === Number(failedTarget.selfId)
        ? { selfId: item.selfId, price: 999999, town: 'Gludio', sourceType: 'npc' }
        : null
});
assert.strictEqual(partyBlockedFallback.strategy, 'market',
    'an unavailable party route must use the exact market recovery when it is available');

const craftBlockedPlan = {
    ...partyBlockedPlan,
    strategy: 'craft',
    next: { spotId: 'starter-field', npcId: 450, itemId: failedTarget.selfId }
};
delete craftBlockedPlan.partyNeed;
const craftBlockedContext = GearAcquisitionPlanner.replanContextFor(
    partyBlockedState,
    craftBlockedPlan,
    20 * 60 * 1000
);
assert.strictEqual(craftBlockedContext.failure.reason, 'party_route_unavailable',
    'a repeatedly deferred required craft route must become a planner recovery too');
const craftBlockedFallback = GearAcquisitionPlanner.planFor(partyBlockedState, {
    spots: [],
    ...craftBlockedContext,
    findMarketOffer: (item) => Number(item.selfId) === Number(failedTarget.selfId)
        ? { selfId: item.selfId, price: 999999, town: 'Gludio', sourceType: 'npc' }
        : null
});
assert.strictEqual(craftBlockedFallback.strategy, 'market',
    'an unavailable craft route must use a direct market recovery when the final item is available');

const legacyDropPlan = { ...failedDropPlan };
delete legacyDropPlan.targetProgress;
const legacyContext = GearAcquisitionPlanner.replanContextFor(failedDropState, legacyDropPlan, 20 * 60 * 1000);
assert.strictEqual(legacyContext.failure, null,
    'legacy lifetime counters must not classify a direct-drop plan before a plan-local baseline exists');
const stampedLegacyPlan = GearAcquisitionPlanner.finalizePlan(
    failedDropState,
    legacyDropPlan,
    legacyDropPlan,
    legacyContext,
    20 * 60 * 1000
);
assert.deepStrictEqual(stampedLegacyPlan.targetProgress, {
    npcId: 450,
    resolves: GearAcquisitionPlanner.DIRECT_FAILURE_RESOLVE_LIMIT,
    targetKills: 0
}, 'the next finalize pass must stamp legacy plans with the current combat counters');
const npcFallbackPlan = GearAcquisitionPlanner.planFor(failedDropState, {
    spots: [],
    ...failedContext,
    findMarketOffer: (item) => Number(item.selfId) === Number(failedTarget.selfId)
        ? { selfId: item.selfId, price: 999999, town: 'Gludio', sourceType: 'npc' }
        : null
});
assert.strictEqual(npcFallbackPlan.strategy, 'market', 'a failed direct-drop target must switch to an NPC offer even when its nominal kill effort looked cheaper');
assert.strictEqual(npcFallbackPlan.target.selfId, failedTarget.selfId, 'market recovery should preserve the desired upgrade instead of silently changing slots');
assert.strictEqual(npcFallbackPlan.market.sourceType, 'npc', 'the recovery route must retain the concrete NPC-shop source');
const persistedFallback = GearAcquisitionPlanner.finalizePlan(failedDropState, failedDropPlan, npcFallbackPlan, failedContext, 20 * 60 * 1000);
assert.strictEqual(persistedFallback.recoveryTargets[0].targetId, failedTarget.selfId, 'a failed drop target must remain remembered across subsequent resolver ticks');
const continuedFallback = GearAcquisitionPlanner.replanContextFor(failedDropState, persistedFallback, 21 * 60 * 1000);
assert.strictEqual(continuedFallback.forceMarketTargetId, failedTarget.selfId, 'an in-progress market fallback must not jump straight back to the failed drop route');

const sameSlotAlternative = DataCache.items.find((item) => (
    Number(item.selfId) !== Number(failedTarget.selfId)
    && Number(item.etc?.slot) === Number(failedTarget.etc?.slot)
    && GearAcquisitionPlanner.suitable(item, failedDropState, 'dps', 'none')
));
assert(sameSlotAlternative, 'the datapack must expose a same-slot fallback fixture');
const equivalentNpcFallback = GearAcquisitionPlanner.planFor(failedDropState, {
    spots: [],
    ...failedContext,
    findMarketOffer: (item) => Number(item.selfId) === Number(sameSlotAlternative.selfId)
        ? { selfId: item.selfId, price: 100, town: 'Talking Island', sourceType: 'npc' }
        : null
});
assert.strictEqual(equivalentNpcFallback.strategy, 'market', 'an NPC-sold equivalent in the same slot must be considered when the exact failed drop is not sold');
assert.strictEqual(equivalentNpcFallback.target.selfId, sameSlotAlternative.selfId, 'the fallback must stay in the failed equipment slot instead of abandoning the upgrade class');
const completedRecovery = GearAcquisitionPlanner.marketRecoveryPlanForTarget({
    ...failedDropState,
    inventory: { [failedTarget.selfId]: { selfId: failedTarget.selfId, amount: 1, equipped: true } }
}, failedTarget.selfId, {
    excludedTargetIds: [failedTarget.selfId],
    findMarketOffer: (item) => ({ selfId: item.selfId, price: 1, town: 'Talking Island', sourceType: 'npc' })
});
assert.strictEqual(completedRecovery, null, 'buying the recovery target must finish that fallback instead of chaining same-slot purchases');
assert.strictEqual(GearAcquisitionPlanner.directPlanFailure({
    ...failedDropState,
    inventory: { [failedTarget.selfId]: { selfId: failedTarget.selfId, amount: 1, equipped: true } }
}, failedDropPlan, 20 * 60 * 1000), null, 'an acquired drop target must complete normally even when its old combat counters look unsuccessful');

const alternativeContext = { ...failedContext, forceMarketTargetId: null };
const alternativePlan = GearAcquisitionPlanner.planFor(failedDropState, {
    spots: [],
    ...alternativeContext,
    findMarketOffer: () => null
});
assert.notStrictEqual(Number(alternativePlan.target?.selfId || 0), Number(failedTarget.selfId), 'without a market offer the planner must move to another attainable target');

const gradeChangedContext = GearAcquisitionPlanner.replanContextFor({ ...failedDropState, level: 20 }, failedDropPlan, 21 * 60 * 1000);
assert.strictEqual(gradeChangedContext.planCurrent, false, 'a level-up into a new grade must invalidate an open no-grade plan and party request');
assert.deepStrictEqual(gradeChangedContext.excludedTargetIds, [], 'old no-grade failures must not contaminate the new grade target list');
assert.strictEqual(
    GearAcquisitionPlanner.replanContextFor({ ...failedDropState, level: 11 }, failedDropPlan, 21 * 60 * 1000).planCurrent,
    false,
    'a same-grade level-up must still refresh the target instead of reusing an open party request'
);
const gradeChangedPlan = GearAcquisitionPlanner.planFor({ ...failedDropState, level: 20 }, {
    spots: [],
    ...gradeChangedContext,
    findMarketOffer: (item) => ({ selfId: item.selfId, price: 1, town: 'Giran', sourceType: 'npc' })
});
assert.strictEqual(gradeChangedPlan.grade, 'd', 'a level-20 bot must immediately receive a D-grade objective');
assert.strictEqual(gradeChangedPlan.strategy, 'market', 'the refreshed D-grade objective may use the available NPC shop');

const serviceCrafter = {
    level: 70,
    activity: 'crafting',
    stats: { classId: 57, generatedIndex: 10026, craftStationId: 'resource_core', craftShop: { entries: [] } },
    inventory: {}
};
assert.strictEqual(GearAcquisitionPlanner.isCraftService(serviceCrafter), true, 'public craft stations must be identified as services');
assert.strictEqual(GearAcquisitionPlanner.planFor(serviceCrafter, { spots: [stoneGolemSpot] }).status, 'service', 'public craft stations must never receive a gear-acquisition plan');

const mage = { level: 40, stats: { classId: 10, role: 'mage' }, inventory: {} };
const target = GearAcquisitionPlanner.preferredTarget(mage);
assert(target, 'a C-grade mage without gear must receive a craftable target');
assert(['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'].includes(target.item.template.kind), 'mage target must use a caster weapon family');
const demonFangs = DataCache.items.find((item) => Number(item.selfId) === 321);
assert.strictEqual(GearAcquisitionPlanner.suitable(demonFangs, { level: 33, stats: { classId: 29, role: 'healer' } }, 'healer'), true,
    'caster support acquisition must recognize Demon Fangs as a D-grade equipment target');
assert.strictEqual(GearAcquisitionPlanner.suitable(demonFangs, { level: 33, stats: { classId: 21, role: 'buffer' } }, 'buffer'), false,
    'Sword Singer acquisition must reject caster-only Weapon.Etc gear');
assert.strictEqual(GearAcquisitionPlanner.suitable(demonFangs, { level: 33, stats: { classId: 34, role: 'buffer' } }, 'buffer'), false,
    'Bladedancer acquisition must reject caster-only Weapon.Etc gear');
let targetOfferChecks = 0;
const scoredOnceTarget = GearAcquisitionPlanner.preferredTarget(mage, {
    findMarketOffer: (item) => {
        targetOfferChecks += 1;
        return { selfId: item.selfId, price: Number(item.template?.price || 1), town: 'Giran', sourceType: 'npc' };
    }
});
assert(scoredOnceTarget, 'memoized target scoring must retain a valid preferred item');
assert(targetOfferChecks <= 3, 'each shortlisted target must be evaluated at most once instead of once per sort comparison');

const dMarketPlan = GearAcquisitionPlanner.planFor({ ...mage, level: 20 }, {
    spots: [],
    findMarketOffer: (item) => ({ selfId: item.selfId, price: 1, town: 'Giran', sourceType: 'npc' })
});
assert.strictEqual(dMarketPlan.strategy, 'market', 'D-grade bots must compare a ready market offer with crafting and drops');
const liveNpcFirstPlan = GearAcquisitionPlanner.planFor({
    level: 20,
    adena: 1000000,
    stats: { classId: 0, role: 'dps' },
    inventory: { 57: { selfId: 57, amount: 1000000 } }
}, { spots: [stoneGolemSpot] });
assert.strictEqual(liveNpcFirstPlan.strategy, 'market', 'an ordinary D NPC upgrade must outrank deliberate equipment farming');
assert.strictEqual(liveNpcFirstPlan.market.sourceType, 'npc');
assert.strictEqual(liveNpcFirstPlan.partyNeedReason, 'npc_progression');
assert(liveNpcFirstPlan.market.price + liveNpcFirstPlan.market.reserve <= 1000000, 'an affordable D purchase must preserve its operational reserve');
const atubaMace = DataCache.items.find((item) => item.template?.name === 'Atuba Mace');
const entryDSword = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'd' && item.template?.kind === 'Weapon.Sword');
const noGradeSword = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'none' && item.template?.kind === 'Weapon.Sword');
assert(atubaMace && entryDSword && noGradeSword,
    'the datapack must expose the Atuba Mace and sword progression fixtures');
const overleveledNoGradePlan = GearAcquisitionPlanner.planFor({
    level: 40,
    adena: 1000000,
    stats: { classId: 0, role: 'dps' },
    inventory: {
        57: { selfId: 57, amount: 1000000 },
        [noGradeSword.selfId]: { selfId: noGradeSword.selfId, amount: 1, equipped: true, slot: 7 }
    }
}, { spots: [stoneGolemSpot] });
assert.strictEqual(overleveledNoGradePlan.strategy, 'market', 'a level-40 bot in no-grade must buy an adequate D bridge before chasing C gear');
assert.strictEqual(String(DataCache.items.find((item) => Number(item.selfId) === overleveledNoGradePlan.target.selfId)?.etc?.rank), 'd');
const adequateDInventory = invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 0, level: 20 }).items.reduce((inventory, item) => {
    const current = inventory[item.selfId];
    if (current) {
        current.amount += 1;
        current.equippedCount += 1;
        current.equippedSlots.push(item.slot);
    } else {
        inventory[item.selfId] = {
            selfId: item.selfId,
            name: item.name,
            amount: 1,
            equipped: true,
            equippedCount: 1,
            equippedSlots: [item.slot],
            slot: item.slot
        };
    }
    return inventory;
}, { 57: { selfId: 57, name: 'Adena', amount: 5000000 } });
const cGradeWithAdequateD = {
    level: 40,
    adena: 5000000,
    stats: { classId: 0, role: 'dps' },
    inventory: adequateDInventory
};
assert.strictEqual(
    GearAcquisitionPlanner.staticNpcUpgradePlan(cGradeWithAdequateD, { spots: [stoneGolemSpot] }),
    null,
    'a level-40 bot with an adequate D kit must not invent an ordinary NPC C-grade upgrade'
);
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const wingedSpear = DataCache.items.find((item) => Number(item.selfId) === 93);
const bronzeShield = DataCache.items.find((item) => Number(item.selfId) === 626);
const dwarfDInventory = BotGear.planFor({ classId: 55, level: 20 }).items.reduce((inventory, item) => {
    if ([7, 8, 14].includes(Number(item.slot))) return inventory;
    const current = inventory[item.selfId];
    if (current) {
        current.amount += 1;
        current.equippedCount += 1;
        current.equippedSlots.push(item.slot);
    } else {
        inventory[item.selfId] = {
            selfId: item.selfId,
            name: item.name,
            amount: 1,
            equipped: true,
            equippedCount: 1,
            equippedSlots: [item.slot],
            slot: item.slot
        };
    }
    return inventory;
}, {
    57: { selfId: 57, name: 'Adena', amount: 5000000 },
    [wingedSpear.selfId]: {
        selfId: wingedSpear.selfId,
        name: wingedSpear.template.name,
        amount: 1,
        equipped: true,
        equippedCount: 1,
        equippedSlots: [14],
        slot: 14,
        rank: wingedSpear.etc.rank,
        kind: wingedSpear.template.kind
    }
});
const dwarfPoleState = {
    level: 40,
    adena: 5000000,
    stats: { classId: 55, role: 'dps' },
    inventory: dwarfDInventory
};
assert.strictEqual(
    GearAcquisitionPlanner.staticNpcUpgradePlan(dwarfPoleState, { spots: [stoneGolemSpot] }),
    null,
    'an adequate two-handed D weapon must remove the shield slot from the NPC bridge kit'
);
assert.strictEqual(GearAcquisitionPlanner.suitable(bronzeShield, dwarfPoleState, 'dps', 'd'), false,
    'a shield must not remain a generic acquisition target while a two-handed weapon is equipped');
assert.strictEqual(GearAcquisitionPlanner.suitable(bronzeShield, {
    ...dwarfPoleState,
    inventory: {
        ...dwarfDInventory,
        [wingedSpear.selfId]: { ...dwarfDInventory[wingedSpear.selfId], equipped: false, equippedCount: 0, equippedSlots: [] },
        [handAxe.selfId]: {
            selfId: handAxe.selfId,
            amount: 1,
            equipped: true,
            equippedCount: 1,
            equippedSlots: [7],
            slot: 7,
            rank: handAxe.etc.rank,
            kind: handAxe.template.kind
        }
    }
}, 'dps', 'd'), true, 'the same shield must become eligible after a real transition to a one-handed weapon');
const equippedUpgrade = GearAcquisitionPlanner.equipInventoryUpgrades({ level: 20, stats: { role: 'tank' } }, {
    [noGradeSword.selfId]: { selfId: noGradeSword.selfId, amount: 1, equipped: true, slot: 7 },
    [entryDSword.selfId]: { selfId: entryDSword.selfId, amount: 1, equipped: false, slot: 7 }
});
assert.strictEqual(equippedUpgrade[entryDSword.selfId].equipped, true, 'a useful D drop must equip immediately in the cold inventory');
assert.strictEqual(equippedUpgrade[noGradeSword.selfId].equipped, false, 'the replaced no-grade weapon must be unequipped');
const starterBow = DataCache.items.find((item) => Number(item.selfId) === 274);
const starterShield = DataCache.items.find((item) => Number(item.selfId) === 20);
const bowAndShieldInventory = GearAcquisitionPlanner.equipInventoryUpgrades({ level: 24, stats: { role: 'archer' } }, {
    [starterBow.selfId]: { selfId: starterBow.selfId, amount: 1, equipped: true, slot: 14 },
    [starterShield.selfId]: { selfId: starterShield.selfId, amount: 1, equipped: true, slot: 8 }
});
assert.strictEqual(bowAndShieldInventory[starterBow.selfId].equipped, true, 'the cold inventory should retain its two-handed bow');
assert.strictEqual(bowAndShieldInventory[starterShield.selfId].equipped, false, 'the cold inventory must unequip a shield when a two-handed bow is equipped');
const dEarring = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'd'
    && item.template?.kind === 'Armor.Jewel' && Number(item.etc?.slot) === 1);
const dRing = DataCache.items.find((item) => String(item.etc?.rank).toLowerCase() === 'd'
    && item.template?.kind === 'Armor.Jewel' && Number(item.etc?.slot) === 4);
assert(dEarring && dRing, 'the datapack must expose paired D-grade jewelry fixtures');
const pairedJewelry = GearAcquisitionPlanner.equipInventoryUpgrades({ level: 20, stats: { role: 'dps' } }, {
    [dEarring.selfId]: { selfId: dEarring.selfId, amount: 2, equipped: false, slot: 1 },
    [dRing.selfId]: { selfId: dRing.selfId, amount: 2, equipped: false, slot: 4 }
});
assert.deepStrictEqual(pairedJewelry[dEarring.selfId].equippedSlots, [1, 2], 'two identical cold earrings must occupy both paperdoll sides');
assert.deepStrictEqual(pairedJewelry[dRing.selfId].equippedSlots, [4, 5], 'two identical cold rings must occupy both paperdoll sides');
assert.deepStrictEqual(
    GearAcquisitionPlanner.equippedSlotsFor({ selfId: dRing.selfId, amount: 1, equipped: true, slot: 5 }),
    [5],
    'a single legacy paired item must retain its recorded physical side'
);
assert.strictEqual(pairedJewelry[dEarring.selfId].equippedCount, 2);
assert.strictEqual(pairedJewelry[dRing.selfId].equippedCount, 2);
const entryDTarget = GearAcquisitionPlanner.preferredTarget({ level: 20, stats: { classId: 0, role: 'dps' }, inventory: {} });
assert(entryDTarget, 'a new D-grade bot must receive an attainable equipment target');
assert(Number(entryDTarget.item.template.price) < Number(atubaMace.template.price), 'a fresh D-grade bot must not begin by chasing the top D weapon');
const malformedCatalogWeapon = DataCache.items.find((item) => Number(item.selfId) === 749);
assert(malformedCatalogWeapon, 'the malformed legacy catalog row must remain covered by the target filter');
assert.strictEqual(GearAcquisitionPlanner.isRealCatalogItem(malformedCatalogWeapon), false, 'an anonymous catalog row must never count as a real item');
assert.strictEqual(GearAcquisitionPlanner.suitable(malformedCatalogWeapon, { level: 20, stats: { classId: 0, role: 'dps' } }, 'dps'), false, 'an anonymous catalog row must never enter bot equipment selection');
assert.notStrictEqual(Number(entryDTarget.item.selfId), 749, 'a bot must not set an anonymous catalog row as its D-grade goal');
const entryDArcherTarget = GearAcquisitionPlanner.preferredTarget({ level: 20, stats: { classId: 9, role: 'archer' }, inventory: {} });
assert(entryDArcherTarget, 'an archer must retain a D-grade target when every entry bow is above the early cap');
assert.strictEqual(entryDArcherTarget.item.template.kind, 'Weapon.Bow', 'an archer must keep weapon-first progression even when its entry bow exceeds the cap');
assert(Number.isFinite(GearAcquisitionPlanner.progressionPriceCap('d', 39)), 'D-grade planning must retain an adequate-kit ceiling through the whole grade band');
assert(Number.isFinite(GearAcquisitionPlanner.progressionPriceCap('c', 51)), 'C-grade planning must retain an adequate-kit ceiling through the whole grade band');
const fullLeather = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Armor.Leather' && Number(item.etc?.slot) === 15);
const leatherChest = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Armor.Leather' && Number(item.etc?.slot) === 10);
const leatherLegs = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Armor.Leather' && Number(item.etc?.slot) === 11);
assert(fullLeather && leatherChest && leatherLegs, 'the datapack must expose D leather full and separate body armour for equip arbitration');
const equipInventory = (items) => GearAcquisitionPlanner.equipInventoryUpgrades(
    { level: 20, stats: { role: 'archer' } },
    Object.fromEntries(items.map((item) => [item.selfId, { selfId: item.selfId, amount: 1, slot: item.etc.slot }]))
);
const equippedIds = (inventory) => Object.values(inventory)
    .filter((item) => item.equipped)
    .map((item) => Number(item.selfId))
    .sort((left, right) => left - right);
const fullFirst = equippedIds(equipInventory([fullLeather, leatherChest, leatherLegs]));
const separateFirst = equippedIds(equipInventory([leatherChest, leatherLegs, fullLeather]));
assert.deepStrictEqual(fullFirst, separateFirst, 'full-body and chest/legs equipment must resolve identically regardless of inventory insertion order');
assert(!(fullFirst.includes(fullLeather.selfId) && (fullFirst.includes(leatherChest.selfId) || fullFirst.includes(leatherLegs.selfId))), 'a full-body item must never equip alongside a conflicting chest or legs item');
const lowDSource = { spotLevel: 18 };
const tankReadiness = GearAcquisitionPlanner.combatReadiness({
    level: 20,
    stats: { role: 'tank' },
    inventory: { 1: { selfId: 1, amount: 1, equipped: true }, 10: { selfId: 10, amount: 1, equipped: true } }
});
const healerReadiness = GearAcquisitionPlanner.combatReadiness({ level: 20, stats: { role: 'healer' }, inventory: {} });
assert(tankReadiness.effectiveLevel > healerReadiness.effectiveLevel, 'readiness must recognise that a geared tank can take safer solo routes than an unprepared support');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 20, stats: { role: 'tank' }, inventory: { 1: { selfId: 1, amount: 1, equipped: true } } }, lowDSource), true, 'a tank may solo an entry D route when its actual kit supports it');
assert.strictEqual(GearAcquisitionPlanner.soloSafeForSource({ level: 20, stats: { role: 'healer' }, inventory: {} }, lowDSource), false, 'an unprepared support must wait for party help at the same route');
assert.strictEqual(GearAcquisitionPlanner.partyNeedReasonForSource({ level: 20, stats: { role: 'healer' }, inventory: {} }, lowDSource), 'missing_weapon', 'missing equipment must be visible as the party requirement reason');
assert(Number(target.item.template.price) <= 2290000, 'a new C-grade bot must begin with an entry-tier weapon target');
const station = ColdCraftingService.stationForRecipe(target.recipe.recipeId);
assert(station, 'a selected equipment recipe must be published by a Giran crafting station');
const entryWeaponOnly = {
    [target.item.selfId]: { selfId: target.item.selfId, amount: 1 }
};
const afterEntryWeapon = GearAcquisitionPlanner.preferredTarget({ ...mage, inventory: entryWeaponOnly });
assert(!['Weapon.Etc', 'Weapon.Sword', 'Weapon.Blunt'].includes(afterEntryWeapon.item.template.kind), 'a C-grade mage must gear another slot after its entry weapon instead of crafting alternate weapons');
let entryBandInventory = {};
for (;;) {
    const entryBandTarget = GearAcquisitionPlanner.preferredTarget({ ...mage, inventory: entryBandInventory });
    if (!entryBandTarget) break;
    assert(Number(entryBandTarget.item.template.price) <= 2290000, 'level-40 bots must stop after their entry C band instead of falling through to top C gear');
    entryBandInventory = {
        ...entryBandInventory,
        [entryBandTarget.item.selfId]: { selfId: entryBandTarget.item.selfId, amount: 1 }
    };
}
const midCMageTarget = GearAcquisitionPlanner.preferredTarget({ ...mage, level: 44 });
assert(Number(midCMageTarget.item.template.price) <= 2870000, 'mid-C bots must not skip straight to the expensive endgame C weapons');
const lateCMageTarget = GearAcquisitionPlanner.preferredTarget({ ...mage, level: 48 });
assert(Number(lateCMageTarget.item.template.price) <= 4300000, 'late-C bots must receive a progression target below top C gear');
for (const recipeId of [191, 192, 198, 199, 201, 205, 208, 209, 213, 214, 216, 217, 312, 220, 222, 223, 228, 230, 234, 237, 238, 240]) {
    assert(ColdCraftingService.stationForRecipe(recipeId), `C progression recipe ${recipeId} must be available from a Giran craft station`);
}

const missing = GearAcquisitionPlanner.missingMaterials(target.recipe, {
    [target.recipe.materials[0].selfId]: { selfId: target.recipe.materials[0].selfId, amount: target.recipe.materials[0].amount - 1 }
});
assert.strictEqual(missing[0].missing, 1, 'material planning must account for what the bot already owns');
assert.strictEqual(missing.length, target.recipe.materials.length, 'a plan must retain fulfilled materials so they remain reserved for crafting');

const readyInventory = target.recipe.materials.reduce((inventory, material) => ({
    ...inventory,
    [material.selfId]: { selfId: material.selfId, amount: material.amount }
}), {});
const travel = ColdCraftingService.beginTravel({
    level: mage.level,
    activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    inventory: readyInventory,
    stats: { equipmentPlan: { status: 'active', strategy: 'craft', recipeId: target.recipe.recipeId } }
}, 1000);
assert.strictEqual(travel.stats.travel.stationId, station.id, 'ready materials must route the bot to the station that publishes its recipe');
assert.strictEqual(travel.stats.travel.arrivalActivity, 'crafting', 'arrival must enter the cold manufacture state');
assert.strictEqual(travel.stats.travel.method, 'soe_gatekeeper', 'a remote craft station visit must use SoE and the Giran gatekeeper rather than map-walking');
assert.strictEqual(travel.stats.travel.arrivalAt - travel.stats.travel.startedAt, ColdCraftingService.NATIVE_TRAVEL_MS, 'craft station transit must remain a short native-travel sequence');
assert.strictEqual(travel.stats.craftReturn.spotId, null, 'craft travel must preserve the previous hunting destination for the return trip');
const readyPlan = GearAcquisitionPlanner.planFor({ ...mage, inventory: readyInventory }, { spots: [] });
assert.strictEqual(readyPlan.status, 'ready_to_craft', 'a complete material list must become a station visit, not a blocked farming plan');

const oriharkonRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(27);
const syntheticCokesRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(36);
const atubaMaceRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(189);
const steelRecipe = invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(30);
const crystalSupplement = invoke('GameServer/Bot/Economy/CraftSupplementMaterials');
const atubaWithCokesIngredients = atubaMaceRecipe.materials.reduce((inventory, material) => {
    if (Number(material.selfId) === 1879 || crystalSupplement.isSupplementalMaterial(material.selfId)) return inventory;
    inventory[material.selfId] = { selfId: material.selfId, amount: material.amount };
    return inventory;
}, {
    1870: { selfId: 1870, amount: 3 },
    1871: { selfId: 1871, amount: 3 }
});
const componentPlan = GearAcquisitionPlanner.planFor({
    level: 20,
    stats: { classId: 10, role: 'mage' },
    inventory: atubaWithCokesIngredients
}, { spots: [], recipeId: atubaMaceRecipe.recipeId });
assert.strictEqual(componentPlan.status, 'component_ready', 'a ready Cokes batch must be distinguished from final Atuba Mace readiness');
assert.strictEqual(componentPlan.requiresParty, false, 'a ready component must go to its station instead of waiting for a party for a later farming source');
assert(ColdCraftingService.beginTravel({
    level: 20,
    activity: 'hunting',
    inventory: atubaWithCokesIngredients,
    stats: { equipmentPlan: componentPlan }
}, 1000), 'a component-ready plan must still travel to its crafting station');
const resourceStationRecipeIds = new Set(CraftShopService.stationRecipes(
    CraftShopService.CraftStations.find((entry) => entry.id === 'resource_core'),
    CraftShopService.availableRecipes({ level: 70, stats: { classId: 57 } })
).map((recipe) => Number(recipe.recipeId)));
for (const recipeId of [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]) {
    assert(resourceStationRecipeIds.has(recipeId), `resource station must publish crafted component recipe ${recipeId}`);
}
const resourceProfile = CraftShopService.profileFor({
    level: 70,
    stats: { classId: 57, generatedIndex: 10026, craftStationId: 'resource_core', craftShop: { entries: [{ recipeId: 32 }] } }
});
assert(resourceProfile.entries.some((entry) => Number(entry.recipeId) === 29), 'public resource stations must regenerate their full catalogue instead of retaining stale persisted entries');
assert.strictEqual(resourceProfile.entries.length, 15, 'public resource stations must retain every published base component recipe');
const resourceState = {
    inventory: {
        1879: { selfId: 1879, amount: 3 },
        1874: { selfId: 1874, amount: 1 },
        1873: { selfId: 1873, amount: 12 },
        1872: { selfId: 1872, amount: 4 }
    }
};
assert.strictEqual(crystalSupplement.isSupplementalMaterial(1458), true, 'crystals must be supplemented only at the final manufacture step');
assert.strictEqual(crystalSupplement.isSupplementalMaterial(2130), true, 'gemstones must be supplemented only at the final manufacture step');
assert.strictEqual(crystalSupplement.isSupplementalMaterial(1869), false, 'farmable craft resources must never be supplemented');
assert.strictEqual(
    ColdCraftingService.hasNonSupplementalMaterials([{ selfId: 1869, amount: 5 }], {
        materials: [{ selfId: 1869, amount: 5 }, { selfId: 1458, amount: 99 }]
    }),
    true,
    'missing supplements must not block a final manufacture'
);
assert.strictEqual(
    ColdCraftingService.hasNonSupplementalMaterials([{ selfId: 1869, amount: 4 }], {
        materials: [{ selfId: 1869, amount: 5 }, { selfId: 1458, amount: 99 }]
    }),
    false,
    'supplements must not be granted when a real craft material is missing from the live inventory'
);
assert.strictEqual(
    ColdCraftingService.readyRecipeFor(resourceState, oriharkonRecipe).recipeId,
    syntheticCokesRecipe.recipeId,
    'a ready crafted component must be manufactured before its parent equipment resource'
);
assert.strictEqual(
    ColdCraftingService.stationForRecipe(syntheticCokesRecipe.recipeId).id,
    'resource_core',
    'crafted resources must route bots to the dedicated Giran resource station'
);
assert.strictEqual(
    ColdCraftingService.requiredCraftCount(atubaMaceRecipe, steelRecipe, { inventory: {} }),
    220,
    'a final recipe must request the full missing component batch, not only one Steel'
);
assert.strictEqual(
    ColdCraftingService.craftableBatchCount(steelRecipe.materials.map((material, index) => ({
        id: index + 1,
        selfId: material.selfId,
        amount: Number(material.amount) * 220
    })), steelRecipe, 220),
    220,
    'a station must craft the whole prepared component batch in one exchange'
);

const protectedMaterial = { selfId: 1869, name: 'Iron Ore', amount: 5, kind: 'Other.Material', rank: 'none' };
const sellable = ItemDisposition.saleCandidates({
    characterId: 1,
    inventory: { 1869: protectedMaterial },
    stats: { equipmentPlan: { status: 'active', strategy: 'craft', materials: [{ selfId: 1869, amount: 3, owned: 5 }] } }
});
assert.strictEqual(sellable[0].count, 2, 'market listings must retain the material amount reserved for the active recipe');

const materialGoal = NeedsEvaluator.evaluate({
    level: 40,
    adena: 100000,
    inventory: {},
    stats: {
        equipmentPlan: {
            status: 'active', strategy: 'craft', marketFallback: true, recipeId: target.recipe.recipeId,
            next: { itemId: 1869 }, materials: [{ selfId: 1869, missing: 4 }]
        }
    }
}, { now: 1000 }).find((goal) => goal.type === 'buy_craft_material');
assert.strictEqual(materialGoal.target.itemId, 1869, 'a stalled material route must create a buy-material market goal');

const materialPlan = GearAcquisitionPlanner.planFor(mage, { spots: [stoneGolemSpot] });
if (materialPlan.strategy === 'craft' && materialPlan.next) {
    assert(Number.isFinite(materialPlan.next.itemId), 'a craft route must persist the next farmable material for market fallback');
}

assert.strictEqual(GearAcquisitionPlanner.shouldFinishPreviousPlan(
    { grade: 'd', strategy: 'craft' },
    { grade: 'c', strategy: 'craft', status: 'active', materials: [{ amount: 10, missing: 1 }] }
), true, 'a nearly complete previous-grade recipe should finish before a grade switch');
assert.strictEqual(GearAcquisitionPlanner.shouldFinishPreviousPlan(
    { grade: 'd', strategy: 'craft' },
    { grade: 'c', strategy: 'craft', status: 'active', materials: [{ amount: 10, missing: 5 }, { amount: 10, missing: 5 }] }
), false, 'a largely incomplete previous-grade recipe should yield to the new grade');

assert.strictEqual(GearAcquisitionPlanner.sameObjective(
    { target: { selfId: 100 }, next: { spotId: 'a' } },
    { target: { selfId: 101 }, next: { spotId: 'a' } }
), true, 'bots gathering at the same source must be party-compatible');

SpotProfiles.cache = [
    { id: 'old-spot', avgLevel: 40, minLevel: 38, maxLevel: 42, density: 8, center: {}, npcEntries: [] },
    { ...stoneGolemSpot, minLevel: 17, maxLevel: 21, density: 8, center: {} }
];
const routed = SpotProfiles.findForState({
    level: 20,
    spotId: 'old-spot',
    stats: { equipmentPlan: { status: 'active', next: { spotId: stoneGolemSpot.id } } }
});
assert.strictEqual(routed.id, stoneGolemSpot.id, 'an active equipment plan must override the previous farming spot');
const starterDropSource = {
    ...stoneGolemSpot,
    id: 'starter-drop-source',
    avgLevel: 2,
    minLevel: 1,
    maxLevel: 3
};
const levelingFallback = {
    ...stoneGolemSpot,
    id: 'leveling-fallback',
    avgLevel: 16,
    minLevel: 14,
    maxLevel: 18
};
SpotProfiles.cache = [starterDropSource, levelingFallback];
const outleveledGearSource = SpotProfiles.findForState({
    level: 16,
    spotId: starterDropSource.id,
    stats: { equipmentPlan: { status: 'active', next: { spotId: starterDropSource.id } } }
});
assert.strictEqual(outleveledGearSource.id, levelingFallback.id,
    'an active gear plan must yield to a level-appropriate route when its drop source is a starter camp');
SpotProfiles.cache = [
    { id: 'starter-mixed', avgLevel: 13, minLevel: 9, maxLevel: 22, density: 78, center: {}, npcEntries: [] },
    { id: 'd-grade-field', avgLevel: 30, minLevel: 27, maxLevel: 33, density: 12, center: {}, npcEntries: [] }
];
const outleveledRoute = SpotProfiles.findForState({
    level: 30,
    spotId: 'starter-mixed',
    stats: { equipmentPlan: { status: 'no_grade_drop_only', grade: 'none', strategy: 'direct_drop', next: null } }
});
assert.strictEqual(outleveledRoute.id, 'd-grade-field', 'a completed no-grade plan must not keep a level-30 cold bot in a mixed starter sector');
SpotProfiles.reset();

console.log('Bot gear acquisition checks passed');
