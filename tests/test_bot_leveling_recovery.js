const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const GradePenalty = invoke('GameServer/Items/C4GradePenalty');
const PartyRequests = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
DataCache.init();

const now = Date.now();
const plan = {
    status: 'active', strategy: 'direct_drop', grade: 'c', plannedForLevel: 40,
    plannedForGrade: 'c', startedAt: now - 100000,
    target: { selfId: 192, name: 'Crystal Staff', slot: 14 },
    next: { spotId: 'ghosts', npcId: 636, itemId: 192 },
    partyNeed: 'required', requiresParty: true,
    targetProgress: { npcId: 636, resolves: 8, targetKills: 1 }
};
const state = {
    characterId: 1, level: 40, exp: 14000000, activity: 'hunting', spotId: 'ghosts',
    inventory: { 90: { selfId: 90, amount: 1, equipped: true, slot: 14 } },
    stats: { classId: 28, role: 'mage', equipmentPlan: plan,
        deaths: 2, spotRisk: { version: 2, spotId: 'ghosts', windowFights: 2, windowWins: 0, windowDeaths: 2 },
        targetCombat: { targetNpcId: 636, resolves: 10, targetKills: 1 } }
};
const context = Planner.replanContextFor(state, plan, now);
assert.strictEqual(context.levelingRecovery.reason, 'death_pressure',
    'two deaths must suspend the objective without waiting for eight failed target resolves');
assert.strictEqual(context.routeCurrent, false);
for (const replacement of [
    Planner.planFor(state, { ...context, timestamp: now }),
    Planner.replacementPlanFor(state, plan, [], { ...context, timestamp: now }),
    Planner.finalizePlan(state, plan, plan, context, now)
]) {
    assert.strictEqual(replacement.phase, 'leveling');
    assert.strictEqual(replacement.next, null);
    assert.strictEqual(PartyRequests.partyRequestForPlan(state, replacement, now), null);
}

const afterDelevel = { ...state, level: 39, exp: 13000000,
    stats: { ...state.stats, spotRisk: null,
        deathExperience: { expBeforeDeath: 14000000, expLost: 1000000, penaltyAppliedAt: now } } };
assert.strictEqual(Planner.replanContextFor(afterDelevel, plan, now).levelingRecovery.reason, 'level_regression',
    'one death crossing a level boundary must prioritize regaining the lost level');
const legacyPlan = { ...plan, plannedForLevel: 29, plannedForGrade: 'd' };
const legacy = { ...afterDelevel, level: 29, exp: 4189999, stats: { ...afterDelevel.stats,
    equipmentPlan: legacyPlan, deathExperience: { expBeforeDeath: 4217089, expLost: 27090, penaltyAppliedAt: now } } };
const legacyContext = Planner.replanContextFor(legacy, legacyPlan, now);
assert.strictEqual(legacyContext.levelingRecovery.reason, 'level_regression',
    'a legacy C-grade objective restamped at level 29 must not survive the grade mismatch');
const savedPlan = JSON.parse(JSON.stringify(Planner.finalizePlan(legacy, legacyPlan, legacyPlan, legacyContext, now)));
const saved = { ...legacy, stats: { ...legacy.stats, equipmentPlan: savedPlan } };
const afterCooldown = now + 2 * 3600000;
assert(Planner.replanContextFor(saved, savedPlan, afterCooldown).levelingRecovery,
    'a restart and expired timer must not resume acquisition before lost EXP is recovered');
assert(Planner.replanContextFor({ ...saved, exp: 4217089 }, savedPlan, now + 1).levelingRecovery,
    'instant restoration must not bypass the minimum route cooldown');
assert.strictEqual(Planner.replanContextFor({ ...saved, exp: 4217089 }, savedPlan, afterCooldown).levelingRecovery, null);
const clanRecovery = { ...saved, stats: { ...saved.stats,
    clanPartyObjective: { status: 'open', objectiveKey: 'old-clan-goal', priority: 'required' } } };
assert.strictEqual(PartyRequests.partyRequestForPlan(clanRecovery, savedPlan, now), null);
assert.strictEqual(PartyRequests.partyObjectiveForState(clanRecovery), null,
    'a suspended clan objective must not recruit the recovering bot back into its old route');

const clanPlan = { ...plan, clanGoal: { clanId: 5, goalKey: 'test-equipment' } };
assert.strictEqual(Planner.clanGoalPlanLocked(state, clanPlan), false,
    'ownership must not lock a bot into a losing route');
assert.strictEqual(Planner.finalizePlan(state, clanPlan, clanPlan, context, now).phase, 'leveling');
const healthy = { ...state, level: 41, stats: { ...state.stats, spotRisk: null } };
assert.strictEqual(Planner.replanContextFor(healthy, plan, now).levelingRecovery, null,
    'normal upward progression must not trigger recovery');

const sourceSpot = { id: 'ghosts', avgLevel: 50,
    npcEntries: [{ selfId: 636, name: 'Forest Of Mirrors Ghost', count: 8 }] };
const sources = Planner.sourceForItem(192, [sourceSpot], legacy);
assert(sources.length, 'the reproduction must use a real Crystal Staff source');
assert.strictEqual(Planner.safeFallbackForPlan(legacy, legacyPlan, [sourceSpot]), null,
    'a required-party route must never fall back to another unsafe solo source');
const strong = { ...healthy, level: 78 };
assert.strictEqual(Planner.safeFallbackForPlan(strong, plan, [sourceSpot]), null,
    'a source below the voluntary hot-combat level band must not remain usable just because it is solo-safe');
assert.deepStrictEqual(Planner.retargetPlanSource(healthy, plan, sources[0]).targetProgress, plan.targetProgress,
    'refreshing the same source must not reset its failure counters');
const previousSpots = Spots.cache;
try {
    Spots.cache = [
        { ...sourceSpot, minLevel: 44, maxLevel: 50, density: 8, center: { locX: 145000, locY: 95000, locZ: -3000 } },
        { id: 'leveling', name: 'Leveling field', minLevel: 27, maxLevel: 29, avgLevel: 28,
            density: 8, center: { locX: 45000, locY: 140000, locZ: -3000 } }
    ];
    assert.strictEqual(Spots.findForState(legacy, { timestamp: now, occupancy: {} }).id, 'leveling',
        'worker route projection must ignore a failed goal even before lifecycle finalization');
    assert.strictEqual(Spots.findForState(saved, { timestamp: now, occupancy: {} }).id, 'leveling',
        'persisted recovery must use level-appropriate routing without the old equipment target');
} finally {
    Spots.cache = previousSpots;
}

const learned = Profile.treeSnapshot({ level: 40, stats: { classId: 28 } }, now);
assert.strictEqual(learned.skills.find(skill => skill.selfId === 239).level, 2);
const regrown = Profile.treeSnapshot({ level: 30, stats: { classId: 28, coldCombat: learned } }, now + 1);
for (const skill of learned.skills) {
    assert(regrown.skills.some(next => next.selfId === skill.selfId && next.level >= skill.level),
        `delevel and subsequent level-up must retain learned skill ${skill.selfId}`);
}
assert.strictEqual(GradePenalty.penalty({
    skillset: { fetchSkill: id => ({ fetchLevel: () => regrown.skills.find(skill => skill.selfId === id)?.level }) },
    backpack: { fetchItems: () => [{ fetchEquipped: () => true, fetchRank: () => 'C' }] }
}), 0, 'previously learned C-grade Expertise must still permit equipped C-grade items after delevel');
console.log('Bot leveling recovery checks passed');
