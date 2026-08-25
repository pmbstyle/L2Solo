const assert = require('assert');

require('../src/Global');

const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ClanEquipmentPolicy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const ClanEquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

const clanPlan = {
    status: 'active',
    strategy: 'direct_drop',
    partyNeed: 'required',
    partyNeedReason: 'underleveled',
    requiresParty: true,
    target: { selfId: 9101, name: 'Clan Blade', slot: 7 },
    next: { spotId: 'clan-spot', npcId: 0, itemId: 9101 },
    clanGoal: {
        clanId: 77,
        goalKey: 'clan-equipment:77:1001:9101:7',
        beneficiaryId: 1001,
        partyNeed: 'required',
        partyPreference: 'clan_first'
    }
};

async function main() {
    const originalPlanFor = GearAcquisitionPlanner.planFor;
    const originalStatesForParties = LifeState.statesForParties;
    const originalCreateOrUpdate = PartyState.createOrUpdate;
    const originalSpotEnsure = SpotProfiles.ensure;

    let plannerCalls = 0;
    let savedParty = null;
    GearAcquisitionPlanner.planFor = () => {
        plannerCalls += 1;
        return {
            ...clanPlan,
            target: { selfId: 9202, name: 'Wrong Replacement', slot: 7 },
            next: { spotId: 'wrong-spot', npcId: 4321, itemId: 9202 },
            clanGoal: undefined
        };
    };
    LifeState.statesForParties = () => Promise.resolve(new Map([
        ['bgp-clan-lock', [{
            characterId: 1001,
            name: 'ClanMember',
            level: 35,
            phase: 'cold',
            activity: 'hunting',
            partyId: 'bgp-clan-lock',
            inventory: {},
            stats: { equipmentPlan: clanPlan }
        }]]
    ]));
    PartyState.createOrUpdate = async (party) => {
        savedParty = party;
        return party;
    };
    SpotProfiles.ensure = () => [];

    try {
        assert.strictEqual(
            GearAcquisitionPlanner.clanGoalPlanLocked({ inventory: {} }, clanPlan),
            true,
            'an unequipped clan-owned target must be locked'
        );

        const refreshed = await PopulationService.refreshBackgroundPartyRequirements([{
            partyId: 'bgp-clan-lock',
            leaderId: 1001,
            memberIds: [1001],
            spotId: 'clan-spot',
            stats: { lastRequirementRefreshAt: 0, objective: { priority: 'required' } }
        }]);

        assert.deepStrictEqual(refreshed, [], 'a locked plan needs no party refresh write');
        assert.strictEqual(plannerCalls, 0, 'party refresh must not invoke the generic planner for clan goals');
        assert(savedParty, 'party refresh should still publish its current party snapshot');
        assert.strictEqual(
            savedParty.stats.acquisitionGoal.target.selfId,
            clanPlan.target.selfId,
            'party refresh must keep the clan target item'
        );
        assert.strictEqual(
            savedParty.stats.acquisitionGoal.clanGoal.goalKey,
            clanPlan.clanGoal.goalKey,
            'party refresh must keep the clan goal ownership metadata'
        );

        const finalized = GearAcquisitionPlanner.finalizePlan(
            { inventory: {} },
            clanPlan,
            {
                ...clanPlan,
                target: { selfId: 9202, name: 'Wrong Replacement', slot: 7 },
                next: { spotId: 'wrong-spot', npcId: 4321, itemId: 9202 },
                clanGoal: undefined
            },
            {},
            Date.now()
        );
        assert.strictEqual(
            finalized.target.selfId,
            clanPlan.target.selfId,
            'normal cold replanning must keep the clan target item'
        );

        const equipped = {
            inventory: {
                '9101': { selfId: 9101, equipped: true, slot: 7 }
            }
        };
        assert.strictEqual(
            GearAcquisitionPlanner.clanGoalPlanLocked(equipped, clanPlan),
            false,
            'an equipped clan target must be allowed to advance'
        );

        const blockedPlan = {
            ...clanPlan,
            status: 'blocked',
            strategy: 'blocked',
            next: null
        };
        assert.strictEqual(
            GearAcquisitionPlanner.clanGoalPlanLocked({ inventory: {} }, blockedPlan),
            false,
            'an unobtainable clan target must not remain locked forever'
        );
        const replannedBlocked = ClanEquipmentService.planForMember({
            characterId: 1001,
            name: 'ClanMember',
            level: 35,
            phase: 'cold',
            inventory: {},
            stats: { equipmentPlan: blockedPlan }
        });
        assert.strictEqual(plannerCalls, 1, 'a blocked clan plan must return to the acquisition planner');
        assert.strictEqual(replannedBlocked.target.selfId, 9202,
            'blocked-plan replanning must exclude the unobtainable target and accept a replacement');

        const replacementMember = {
            characterId: 1002,
            name: 'ReplacementMember',
            level: 35,
            phase: 'cold',
            inventory: {}
        };
        const selected = ClanEquipmentPolicy.selectTargetMember(
            [{ characterId: 1001, phase: 'cold' }, replacementMember],
            new Map([
                [1001, blockedPlan],
                [1002, clanPlan]
            ]),
            {
                status: 'blocked',
                target: { memberId: 1001, itemId: blockedPlan.target.selfId, slot: blockedPlan.target.slot }
            }
        );
        assert.strictEqual(selected.member.characterId, 1002,
            'a blocked previous beneficiary must yield to another member with an actionable plan');

        console.log('Clan equipment plan lock checks passed');
    } finally {
        GearAcquisitionPlanner.planFor = originalPlanFor;
        LifeState.statesForParties = originalStatesForParties;
        PartyState.createOrUpdate = originalCreateOrUpdate;
        SpotProfiles.ensure = originalSpotEnsure;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
