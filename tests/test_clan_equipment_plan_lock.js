const assert = require('assert');

require('../src/Global');

const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ClanEquipmentPolicy = invoke('GameServer/Clan/ClanEquipmentPolicy');

assert(
    ClanEquipmentPolicy.planPriority({ status: 'active', expectedEffort: 10 })
        > ClanEquipmentPolicy.planPriority({ status: 'active', expectedEffort: 1000 }),
    'equally ready clan equipment routes must prefer lower opportunity cost'
);
const ClanEquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ClanEquipmentPartyPolicy = invoke('GameServer/Bot/Population/ClanEquipmentPartyPolicy');
const BackgroundPartyLifecycle = invoke('GameServer/Bot/Population/BackgroundPartyLifecycle');

const clanPlan = {
    status: 'active',
    strategy: 'direct_drop',
    partyNeed: 'required',
    partyNeedReason: 'underleveled',
    requiresParty: true,
    rateModelVersion: GearAcquisitionPlanner.RATE_MODEL_VERSION,
    rateProfileSignature: GearAcquisitionPlanner.rateProfileSignature(),
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
    const originalBestSourceForPlan = GearAcquisitionPlanner.bestSourceForPlan;
    const originalRetargetPlanSource = GearAcquisitionPlanner.retargetPlanSource;
    const originalStatesForParties = LifeState.statesForParties;
    const originalReleaseDissolvedPartyMembers = LifeState.releaseDissolvedPartyMembers;
    const originalActiveParties = PartyState.active;
    const originalSetPartyStatus = PartyState.setStatus;
    const originalCreateOrUpdate = PartyState.createOrUpdate;
    const originalSpotEnsure = SpotProfiles.ensure;
    const originalCurrentOccupancy = SpotProfiles.currentOccupancy;

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
        const raidParty = {
            partyId: 'bgp-active-clan-raid',
            status: 'active',
            memberIds: [1, 2, 3, 4, 5, 6, 7],
            stats: {
                objective: { clanId: 77, sourceKind: 'raid', raidBoss: true, spotId: 'raid:10029', minPartySize: 7 },
                raidEncounter: { status: 'active' },
                sessionExpiresAt: 1
            }
        };
        PartyState.active = () => [raidParty];
        assert.strictEqual(ClanEquipmentService.activeRaidPartyForClan(77), raidParty,
            'an unresolved raid party must lock its clan equipment target');
        const pinnedRaid = await ClanEquipmentService.resolveClan({ id: 77 }, { goalKey: 'active-raid-goal' });
        assert.deepStrictEqual(
            { skipped: pinnedRaid.skipped, reason: pinnedRaid.reason, partyId: pinnedRaid.partyId },
            { skipped: true, reason: 'raid_in_progress', partyId: raidParty.partyId },
            'equipment replanning must not rotate a clan away from an active raid'
        );
        let activeRaidReads = 0;
        PartyState.active = () => (++activeRaidReads === 1 ? [] : [raidParty]);
        const racedRaid = await ClanEquipmentService.resolveClan(
            { id: 77 },
            { goalKey: 'active-raid-goal' },
            { planning: { plans: new Map(), selection: null } }
        );
        assert.deepStrictEqual(
            { skipped: racedRaid.skipped, reason: racedRaid.reason, partyId: racedRaid.partyId },
            { skipped: true, reason: 'raid_in_progress', partyId: raidParty.partyId },
            'an async equipment plan must recheck the raid lock before applying its stale result'
        );
        PartyState.active = () => [raidParty];
        assert.strictEqual(PopulationService.partySessionExpired(raidParty, Date.now()), false,
            'a started raid must not expire through ordinary party rotation');
        assert.strictEqual(ClanEquipmentPartyPolicy.needsReview(raidParty, [{ level: 99, stats: {} }], Date.now()), false,
            'ordinary route eligibility must not dismantle a raid after preparation or combat starts');
        assert.strictEqual(ClanEquipmentPartyPolicy.needsReview({
            ...raidParty,
            stats: { ...raidParty.stats, objective: {
                ...raidParty.stats.objective,
                raidBossTemplateId: 999999,
                sourceLevel: 50
            } }
        }, [{ level: 59, stats: {} }], Date.now()), true,
        'an overlevel member must be removed even after raid preparation starts because Raid Curse disables combat');
        assert.strictEqual(ClanEquipmentPartyPolicy.needsReview(raidParty, [{
            level: 99,
            stats: { clanHuntBackoffs: [{ spotId: 'raid:10029', until: Date.now() + 60000 }] }
        }], Date.now()), false, 'ordinary hunt backoff must not dismantle a raid already in progress');
        const abandonedLegacyRaid = {
            ...raidParty,
            spotId: 'fallback-farm',
            stats: {
                ...raidParty.stats,
                raidEncounter: { status: 'active', hp: 900, maxHp: 1000 },
                partySpotRisk: { spotBackoffs: [{
                    spotId: 'raid:10029', deaths: 2, attempts: 2, reason: 'death_pressure'
                }] }
            }
        };
        assert.strictEqual(ClanEquipmentPartyPolicy.needsReview(abandonedLegacyRaid,
            [{ level: 50, stats: {} }], Date.now()), true,
        'a legacy raid that already retreated after a decisive failure must release its stale party');
        PartyState.active = () => [abandonedLegacyRaid];
        assert.strictEqual(ClanEquipmentService.activeRaidPartyForClan(77), null,
            'a retreated legacy raid must not keep the clan equipment planner locked');
        const abandonedReview = BackgroundPartyLifecycle.review(abandonedLegacyRaid,
            abandonedLegacyRaid.memberIds.map((characterId) => ({
                characterId,
                level: 50,
                activity: 'grouped',
                party: { partyId: abandonedLegacyRaid.partyId },
                stats: { clanPartyObjective: abandonedLegacyRaid.stats.objective }
            })), Date.now());
        assert.strictEqual(abandonedReview.party.status, 'dissolved',
            'the stale retreated raid roster must dissolve immediately when reviewed');
        assert([...abandonedReview.leaving.values()].every((reason) => reason === 'raid_failed'),
            'legacy raid retreat cleanup must use the same terminal failure reason as current raids');
        const failedRaidParty = {
            ...raidParty,
            stats: { ...raidParty.stats, raidEncounter: { status: 'failed' } }
        };
        PartyState.active = () => [failedRaidParty];
        assert.strictEqual(ClanEquipmentService.activeRaidPartyForClan(77), null,
            'a failed raid must release the equipment planning lock');
        assert.strictEqual(ClanEquipmentPartyPolicy.needsReview(failedRaidParty, [{ level: 50, stats: {} }], Date.now()), true,
            'a failed raid must be reviewed and released immediately');
        PartyState.active = () => [raidParty];
        const raidOutcome = { debug: { fights: 1 }, patch: { deathCount: 1, stats: {} } };
        assert.strictEqual(ClanEquipmentPartyPolicy.recordOutcome(
            { stats: { deaths: 0 } }, raidOutcome, raidParty.stats.objective, Date.now()
        ), raidOutcome, 'raid deaths must not create ordinary hunting-ground backoff');
        assert.deepStrictEqual(await PopulationService.refreshBackgroundPartyRequirements([raidParty]), [],
            'ordinary equipment requirement refresh must not rewrite a started raid objective');
        PartyState.active = () => [{
            ...raidParty,
            partyId: 'bgp-assembling-clan-raid',
            stats: { ...raidParty.stats, raidEncounter: null }
        }];
        assert.strictEqual(ClanEquipmentService.activeRaidPartyForClan(77), null,
            'an unstarted raid must remain replaceable when its roster cannot assemble');
        PartyState.active = () => [{ ...raidParty, memberIds: raidParty.memberIds.slice(0, 6) }];
        assert.strictEqual(ClanEquipmentService.activeRaidPartyForClan(77), null,
            'a started raid below its minimum roster must remain replaceable');
        PartyState.active = () => [];

        assert.strictEqual(
            GearAcquisitionPlanner.clanGoalPlanLocked({ inventory: {} }, clanPlan),
            true,
            'an unequipped clan-owned target must be locked'
        );

        GearAcquisitionPlanner.bestSourceForPlan = () => ({
            spotId: 'alternate-clan-spot', npcId: 0, itemId: clanPlan.target.selfId, expectedYield: 1
        });
        const reroutedClanGoal = ClanEquipmentService.planForMember({
            characterId: 1001,
            name: 'ClanMember',
            level: 35,
            phase: 'cold',
            inventory: {},
            stats: { equipmentPlan: clanPlan }
        }, [], [], { occupancy: { 'clan-spot': { reservedCount: 20, capacity: 2 } }, capacityUnits: 9 });
        assert.strictEqual(reroutedClanGoal.target.selfId, clanPlan.target.selfId,
            'clan planning must keep the goal item while another source for it is available');
        assert.strictEqual(reroutedClanGoal.next.spotId, 'alternate-clan-spot',
            'clan planning must move the whole goal to the available equivalent source');
        assert.strictEqual(plannerCalls, 0,
            'same-item source fallback must not run a full replacement-target plan');

        GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
        const replacementForUnavailableGoal = ClanEquipmentService.planForMember({
            characterId: 1001,
            name: 'ClanMember',
            level: 35,
            phase: 'cold',
            inventory: {},
            stats: { equipmentPlan: clanPlan }
        }, [], [], { occupancy: { 'clan-spot': { reservedCount: 20, capacity: 2 } }, capacityUnits: 9 });
        assert.strictEqual(replacementForUnavailableGoal.target.selfId, 9202,
            'a clan equipment goal with no available source must select the next attainable equipment target');
        assert.strictEqual(plannerCalls, 1,
            'unavailable clan equipment sources must trigger target planning instead of a wait state');
        plannerCalls = 0;

        const marketClanPlan = {
            ...clanPlan,
            strategy: 'market',
            next: { kind: 'market', town: 'Giran', itemId: clanPlan.target.selfId }
        };
        const preservedMarketGoal = ClanEquipmentService.planForMember({
            characterId: 1001,
            name: 'ClanMember',
            level: 35,
            phase: 'cold',
            inventory: {},
            stats: { equipmentPlan: marketClanPlan }
        }, [], [], { occupancy: { 'clan-spot': { reservedCount: 20, capacity: 2 } }, capacityUnits: 9 });
        assert.strictEqual(preservedMarketGoal, marketClanPlan,
            'market clan goals must not be rotated because farming spots are full');
        assert.strictEqual(plannerCalls, 0,
            'market clan goals must remain outside farm capacity planning');

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

        plannerCalls = 0;
        const advancedFromFulfilled = ClanEquipmentService.planForMember({
            characterId: 1001,
            name: 'ClanMember',
            level: 35,
            phase: 'cold',
            inventory: {},
            stats: { equipmentPlan: clanPlan }
        }, [], [], { ignoreExistingPlan: true });
        assert.strictEqual(plannerCalls, 1,
            'a fulfilled clan target must bypass its old goal lock and return to planning');
        assert.strictEqual(advancedFromFulfilled.target.selfId, 9202);
        plannerCalls = 0;

        const staleChestGoal = {
            target: { memberId: 1001, itemId: 347, slot: 10 }
        };
        assert.strictEqual(ClanEquipmentPolicy.targetFulfilled({
            inventory: {
                347: { selfId: 347, amount: 1, equipped: false, slot: 10, rank: 'd' }
            },
            stats: {
                equipment: [
                    { selfId: 60, equipped: true, equippedSlots: [15], slot: 15, rank: 'c' }
                ]
            }
        }, staleChestGoal, GearAcquisitionPlanner.equippedSlotsFor), true,
        'a stronger equipped full-body set must complete a stale weaker chest goal');

        assert.strictEqual(ClanEquipmentPolicy.targetFulfilled({
            inventory: {
                847: { selfId: 847, amount: 1, equipped: true, equippedSlots: [1], slot: 1, rank: 'd' }
            },
            stats: {
                equipment: [
                    { selfId: 847, equipped: true, equippedSlots: [1], slot: 1, rank: 'd' },
                    { selfId: 114, equipped: true, equippedSlots: [2], slot: 2, rank: 'none' }
                ]
            }
        }, {
            target: { memberId: 1001, itemId: 847, slot: 2 }
        }, GearAcquisitionPlanner.equippedSlotsFor), false,
        'one D-grade earring must not fulfill the second earring slot while it still holds no-grade gear');

        const blockedPlan = {
            ...clanPlan,
            status: 'blocked',
            strategy: 'blocked',
            next: null
        };
        assert.strictEqual(ClanEquipmentPolicy.isAcquisitionPlan(blockedPlan), false,
            'a blocked equipment route must not become a durable clan objective');
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

        const currentPlan = {
            ...clanPlan,
            grade: 'c',
            target: { selfId: 9301, name: 'Current Upgrade', slot: 7 },
            clanGoal: { ...clanPlan.clanGoal, beneficiaryId: 1003, goalKey: 'clan-equipment:77:1003:9301:7' }
        };
        const weakHealerPlan = {
            ...clanPlan,
            grade: 'b',
            target: { selfId: 9302, name: 'Healer Upgrade', slot: 10 },
            clanGoal: undefined
        };
        const prioritySelection = ClanEquipmentPolicy.selectTargetMember([
            {
                characterId: 1003,
                level: 45,
                phase: 'cold',
                stats: { role: 'dps', equipment: [{ selfId: 1, slot: 7, rank: 'd' }] },
                inventory: {}
            },
            {
                characterId: 1004,
                level: 45,
                phase: 'cold',
                stats: { role: 'healer', equipment: [] },
                inventory: {}
            }
        ], new Map([
            [1003, currentPlan],
            [1004, weakHealerPlan]
        ]), {
            status: 'executing',
            target: { memberId: 1003, itemId: 9301, slot: 7 }
        });
        assert.strictEqual(prioritySelection.member.characterId, 1004,
            'a materially weaker healer must take over from a lower-priority beneficiary before full dressing');
        assert.strictEqual(prioritySelection.rotated, true);

        const staleLifecycleState = {
            characterId: 1001,
            phase: 'cold',
            inventory: {},
            stats: {
                equipmentPlan: {
                    ...clanPlan,
                    target: { selfId: 9202, name: 'Stale Personal Target', slot: 7 },
                    clanGoal: undefined
                }
            }
        };
        const protectedState = LifeState.preserveClanOwnedEquipmentState(staleLifecycleState, 'market_visit_complete', {
            ...staleLifecycleState,
            stats: { equipmentPlan: clanPlan, clanPartyObjective: { clanGoalKey: clanPlan.clanGoal.goalKey } }
        });
        assert.strictEqual(protectedState.stats.equipmentPlan.target.selfId, clanPlan.target.selfId,
            'a late lifecycle callback must not overwrite a clan-owned equipment plan');
        assert.strictEqual(protectedState.stats.equipmentPlan.clanGoal.goalKey, clanPlan.clanGoal.goalKey);

        const dissolved = [];
        PartyState.active = () => [
            { partyId: 'same-clean', spotId: 'test-spot', memberIds: [1001, 1002], stats: { objective: { clanGoalKey: clanPlan.clanGoal.goalKey, objectiveKey: 'direct_drop:test-spot:701', npcId: 701 } } },
            { partyId: 'same-wrong-route', spotId: 'old-spot', memberIds: [1001, 1002], stats: { objective: { clanGoalKey: clanPlan.clanGoal.goalKey, objectiveKey: 'direct_drop:old-spot:700', npcId: 700 } } },
            { partyId: 'same-mixed', spotId: 'test-spot', memberIds: [1001, 9999], stats: { objective: { clanGoalKey: clanPlan.clanGoal.goalKey, objectiveKey: 'direct_drop:test-spot:701', npcId: 701 } } },
            { partyId: 'wrong-goal', memberIds: [1002, 1003], stats: { objective: { clanGoalKey: 'clan-equipment:78:1002:9202:7' } } }
        ];
        PartyState.setStatus = async (partyId, status) => {
            dissolved.push({ partyId, status });
            return { partyId, status };
        };
        LifeState.releaseDissolvedPartyMembers = async () => 2;
        const reformed = await ClanEquipmentService.releaseConflictingRosterParties(
            [1001, 1002, 1003],
            { goalKey: clanPlan.clanGoal.goalKey },
            { spotId: 'test-spot', objectiveKey: 'direct_drop:test-spot:701', npcId: 701 }
        );
        assert.deepStrictEqual(dissolved.map((entry) => entry.partyId), ['same-wrong-route', 'same-mixed', 'wrong-goal']);
        assert.deepStrictEqual(reformed, { parties: 3, releasedMembers: 6 },
            'a clan equipment review must dissolve wrong-route, mixed, or foreign parties before rebuilding its roster');

        const sharedOccupancy = {
            'shared-clan-spot': {
                count: 0,
                reservedCount: 0,
                capacity: 10,
                retained: new Set(),
                reservedKeys: new Set(),
                reservationKeys: new Set(),
                retainedReservationKeys: new Set()
            }
        };
        SpotProfiles.currentOccupancy = () => sharedOccupancy;
        const stalePlanning = {
            spots: [{ id: 'shared-clan-spot', capacity: 10 }],
            occupancy: {}
        };
        const selectedSpot = stalePlanning.spots[0];
        const firstReservation = ClanEquipmentService.reserveGoalCapacity(
            stalePlanning,
            { id: 77 },
            [1001, 1002, 1003, 1004, 1005],
            selectedSpot
        );
        const secondReservation = ClanEquipmentService.reserveGoalCapacity(
            stalePlanning,
            { id: 78 },
            [2001, 2002, 2003, 2004, 2005],
            selectedSpot
        );
        const overbookedReservation = ClanEquipmentService.reserveGoalCapacity(
            stalePlanning,
            { id: 79 },
            [3001, 3002, 3003, 3004, 3005],
            selectedSpot
        );
        assert.strictEqual(firstReservation.reserved, true);
        assert.strictEqual(secondReservation.reserved, true);
        assert.strictEqual(overbookedReservation.reserved, false,
            'sequential clan reviews must share live reservations instead of overbooking stale planning snapshots');
        assert.strictEqual(sharedOccupancy['shared-clan-spot'].reservedCount, 10,
            'rejected clan reservations must not grow shared spot occupancy beyond capacity');

        console.log('Clan equipment plan lock checks passed');
    } finally {
        GearAcquisitionPlanner.planFor = originalPlanFor;
        GearAcquisitionPlanner.bestSourceForPlan = originalBestSourceForPlan;
        GearAcquisitionPlanner.retargetPlanSource = originalRetargetPlanSource;
        LifeState.statesForParties = originalStatesForParties;
        LifeState.releaseDissolvedPartyMembers = originalReleaseDissolvedPartyMembers;
        PartyState.active = originalActiveParties;
        PartyState.setStatus = originalSetPartyStatus;
        PartyState.createOrUpdate = originalCreateOrUpdate;
        SpotProfiles.ensure = originalSpotEnsure;
        SpotProfiles.currentOccupancy = originalCurrentOccupancy;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
