const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const EquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const CandidateService = invoke('GameServer/Clan/ClanGoalCandidateService');
const BackgroundDropResolver = invoke('GameServer/Bot/Population/BackgroundDropResolver');

function plan(itemId, expectedKills = 10, kind = 'drop') {
    return {
        status: 'active',
        strategy: 'direct_drop',
        grade: 'c',
        expectedKills,
        partyNeed: 'required',
        requiresParty: true,
        target: { selfId: itemId, name: `Item ${itemId}`, slot: 7 },
        next: { spotId: 'spoil-test', npcId: 99001, itemId, kind }
    };
}

async function main() {
    const originalRewards = DataCache.npcRewards;
    const originalNpcs = DataCache.npcs;
    const originalItems = DataCache.items;
    const originalPlanningForClan = EquipmentService.planningForClan;
    const originalPlanFor = GearPlanner.planFor;
    const originalBestSourceForPlan = GearPlanner.bestSourceForPlan;
    const originalRate = process.env.L2NODE_PROGRESSION_RATE;
    try {
        DataCache.items = [{
            selfId: 99101,
            template: { name: 'Spoil Test Sword', kind: 'Weapon.Sword' },
            etc: { rank: 'c', slot: 7, stackable: false }
        }];
        DataCache.npcs = [{ selfId: 99001, template: { name: 'Spoil Test Mob', level: 40, kind: 'Monster' } }];
        DataCache.npcRewards = [{
            selfId: 99001,
            template: { name: 'Spoil Test Mob' },
            rewards: [],
            spoils: [{ overall: 100, items: [{ selfId: 99101, name: 'Spoil Test Sword', chance: 100, min: 1, max: 1 }] }]
        }];
        const spots = [{
            id: 'spoil-test', avgLevel: 40, capacity: 9,
            npcEntries: [{ selfId: 99001, name: 'Spoil Test Mob', count: 1 }],
            npcSelfIds: [99001], npcNames: ['Spoil Test Mob']
        }];
        const state = { level: 40, stats: { classId: 4, role: 'tank' }, inventory: {}, adena: 0 };
        assert.deepStrictEqual(GearPlanner.sourceForItem(99101, spots, state), [],
            'spoil-only gear must not be offered when no spoiler can execute the route');
        const spoilSources = GearPlanner.sourceForItem(99101, spots, state, { spoilCapable: true });
        assert.strictEqual(spoilSources.length, 1);
        assert.strictEqual(spoilSources[0].kind, 'spoil');
        const spoilLoot = BackgroundDropResolver.rollSpoilForFight({
            spot: spots[0], killerLevel: 40, npcSelfId: 99001, rng: () => 0
        });
        assert.deepStrictEqual(spoilLoot.map((item) => item.selfId), [99101],
            'a planner-visible spoil route must have a matching cold reward execution path');

        process.env.L2NODE_PROGRESSION_RATE = 'x1';
        const retailSignature = GearPlanner.rateProfileSignature();
        process.env.L2NODE_PROGRESSION_RATE = 'x50';
        assert.notStrictEqual(GearPlanner.rateProfileSignature(), retailSignature,
            'persisted acquisition estimates must be invalidated when the active rate profile changes');
        assert.strictEqual(GearPlanner.withinExpectedKillLimit(plan(99101, 1500), 1500), true);
        assert.strictEqual(GearPlanner.withinExpectedKillLimit(plan(99101, 1501), 1500), false);
        const persistedLimitPlan = {
            ...plan(99101, 1400),
            expectedKillsLimit: 1500,
            clanGoal: { clanId: 7, goalKey: 'gear:7:1:99101', beneficiaryId: 1 }
        };
        const overLimitRetarget = GearPlanner.retargetPlanSource(state, persistedLimitPlan, {
            spotId: 'spoil-test', npcId: 99001, kind: 'drop', expectedYield: 1 / 2000
        });
        assert.strictEqual(overLimitRetarget.status, 'blocked');
        assert.strictEqual(overLimitRetarget.reason, 'equipment_effort_limit');
        assert.strictEqual(GearPlanner.clanGoalPlanLocked({ inventory: {} }, overLimitRetarget), true,
            'cold replanning must leave an over-budget clan route locked for deterministic clan rotation');

        let excludedTargets = [];
        GearPlanner.bestSourceForPlan = () => ({
            spotId: 'spoil-test', npcId: 99001, kind: 'drop', expectedYield: 1 / 2000
        });
        GearPlanner.planFor = (_state, options) => {
            excludedTargets = options.excludedTargetIds || [];
            return plan(99102, 20);
        };
        const expensive = { ...plan(99101, 2000), clanGoal: { clanId: 7, beneficiaryId: 1 } };
        const replacement = EquipmentService.planForMember({
            characterId: 1, phase: 'cold', level: 40, inventory: {}, stats: { equipmentPlan: expensive }
        }, spots, [], { spoilCapable: true, maxExpectedKills: 1500 });
        assert.strictEqual(replacement.target.selfId, 99102);
        assert(excludedTargets.includes(99101), 'an over-budget locked target must be excluded before replacement planning');

        const members = Array.from({ length: 10 }, (_, index) => ({
            characterId: index + 1,
            phase: 'cold',
            level: 40 - index,
            stats: { classId: index === 9 ? 54 : index === 0 ? 4 : index === 1 ? 15 : index === 2 ? 17 : 1 }
        }));
        const roster = EquipmentService.equipmentRoster({ members }, members[0], null, plan(99101, 10, 'spoil'));
        assert(roster.includes(10), 'a spoil-backed clan goal must explicitly reserve a spoiler in its operation roster');

        const currentPlan = plan(99101, 100);
        const alternatePlan = { ...plan(99102, 20), target: { selfId: 99102, name: 'Alternative', slot: 10 } };
        const clan = {
            id: 7,
            level: 3,
            state: { updatedAt: 1 },
            members: [
                { characterId: 1, name: 'Current', level: 40, phase: 'cold', inventory: {}, stats: { classId: 4 } },
                { characterId: 2, name: 'Alternative', level: 40, phase: 'cold', inventory: {}, stats: { classId: 15 } }
            ]
        };
        EquipmentService.planningForClan = async () => ({
            plans: new Map([[1, currentPlan], [2, alternatePlan]]),
            selection: { member: clan.members[0], plan: currentPlan },
            previousFulfilled: false,
            occupancy: {}, spots: []
        });
        CandidateService.reset();
        const now = Date.now();
        const snapshot = await CandidateService.snapshotFor(clan, {
            type: 'equipment', status: 'executing', goalKey: 'stalled-goal',
            target: { memberId: 1, itemId: 99101, slot: 7 },
            createdAt: now - 8 * 60 * 60 * 1000,
            updatedAt: now - 8 * 60 * 60 * 1000
        }, { occupancy: {}, now, hardStallMs: 6 * 60 * 60 * 1000 });
        assert.strictEqual(snapshot.stall.reason, 'goal_hard_stalled');
        assert.strictEqual(snapshot.candidates.some((candidate) => candidate.assessment.current), false,
            'a hard-stalled current target must leave the decision set when an executable alternative exists');
        assert.strictEqual(snapshot.deterministicCandidateId, 'equipment:7:2:99102:10');
        console.log('Clan gear stall and spoil checks passed');
    } finally {
        DataCache.npcRewards = originalRewards;
        DataCache.npcs = originalNpcs;
        DataCache.items = originalItems;
        EquipmentService.planningForClan = originalPlanningForClan;
        GearPlanner.planFor = originalPlanFor;
        GearPlanner.bestSourceForPlan = originalBestSourceForPlan;
        CandidateService.reset();
        if (originalRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = originalRate;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
