const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');

function inventory(entries) {
    return Object.fromEntries(entries.map(([selfId, slots]) => [selfId, {
        selfId, amount: slots.length, equipped: true, equippedSlots: slots, slot: slots[0]
    }]));
}
const heavy = [[47, [6]], [58, [10]], [59, [11]], [606, [9]], [850, [1, 2]],
    [881, [4, 5]], [913, [3]], [1124, [12]]];
const polearm = { level: 55, adena: 15000000, stats: { classId: 3, role: 'dps' },
    inventory: inventory([...heavy, [129, [7]]]) };
const archer = { level: 51, adena: 10000000, stats: { classId: 37, role: 'archer' },
    inventory: inventory([[47, [6]], [393, [10]], [415, [11]], [850, [1, 2]],
        [881, [4, 5]], [914, [3]], [2434, [12]], [2452, [9]], [223, [7]]]) };
for (const [state, kind] of [[polearm, 'Weapon.Pole'], [archer, 'Weapon.Bow']]) {
    assert.strictEqual(Gear.combatReadiness(state).hasWeapon, false);
    const purchase = Gear.staticNpcUpgradePlan(state);
    assert(purchase, 'an incompatible D-grade weapon must not suppress an affordable NPC replacement');
    const item = Data.items.find(item => item.selfId === purchase.target.selfId);
    assert.strictEqual(item.template.kind, kind);
    assert(purchase.market.price < state.adena);
    const equipped = Gear.equipInventoryUpgrades(state, { ...state.inventory,
        [item.selfId]: { selfId: item.selfId, amount: 1, equipped: false, slot: item.etc.slot } });
    assert.strictEqual(Gear.combatReadiness({ ...state, inventory: equipped }).hasWeapon, true,
        'the affordable compatible replacement must actually equip over the old weapon');
}
const staleArcherPlan = {
    status: 'active', strategy: 'direct_drop', grade: 'c', plannedForLevel: archer.level,
    target: { selfId: 282, name: 'Elemental Bow', slot: 14 },
    next: { spotId: 'stale-bow-route', npcId: 20201, itemId: 282 },
    clanGoal: { clanId: 7, goalKey: 'clan-equipment:7:1:282:14' }
};
const bridgePlan = Gear.npcWeaponBridgePlan({ ...archer, stats: {
    ...archer.stats, equipmentPlan: staleArcherPlan
} });
assert.strictEqual(bridgePlan.strategy, 'market',
    'an incompatible inherited weapon must interrupt a stale bow farming plan');
assert.strictEqual(bridgePlan.weaponBridge, true,
    'the bridge remains distinguishable from an ordinary gear upgrade');
assert.strictEqual(bridgePlan.target.selfId, 274,
    'the emergency bridge must use the affordable D-grade Strengthened Bow');
const ownedBridge = { ...archer, inventory: {
    ...archer.inventory,
    274: { selfId: 274, amount: 1, equipped: false, slot: 14 }
} };
assert.strictEqual(Gear.npcWeaponBridgePlan(ownedBridge), null,
    'an owned compatible bridge must be equipped instead of purchased twice');
assert.strictEqual(Gear.equipInventoryUpgrades(ownedBridge, ownedBridge.inventory)[274].equipped, true);
assert.strictEqual(Gear.replacementPlanFor({ ...archer, stats: {
    ...archer.stats, equipmentPlan: staleArcherPlan
} }, staleArcherPlan).target.selfId, 274,
    'route replacement must prefer the D-grade weapon bridge even for a clan-owned plan');
const Safety = invoke('GameServer/Bot/Population/ClanEquipmentPartyPolicy');
const PartyRisk = invoke('GameServer/Bot/Population/PartySpotRiskPolicy');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Policy = invoke('GameServer/Clan/ClanEquipmentPolicy');
const ClanPlanner = invoke('GameServer/Clan/ClanEquipmentPlanner');
const Craft = invoke('GameServer/Bot/Economy/ColdCraftingService');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const at = 1800000000000;
const objective = { clanOperation: 'equipment', clanId: 7, npcId: 1202, spotId: 'tower' };
const members = [33, 56, 60, 61, 66, 67].map((level, i) => ({ characterId: i + 1,
    level, phase: 'cold', stats: { classId: 13, role: 'healer' } }));
assert.strictEqual(Safety.sourceLevel(objective), 66);
assert.deepStrictEqual(members.filter(m => Safety.allowed(m, objective)).map(m => m.level), [61, 66, 67]);
assert(Safety.allowed(members[0], { ...objective, clanOperation: null }), 'ordinary parties retain their existing rules');
const huntPlan = { status: 'active', strategy: 'direct_drop', target: { selfId: 913, slot: 3 }, next: objective };
assert.deepStrictEqual(Equipment.equipmentRoster({ id: 7, members }, members[0], null, huntPlan).sort(), [4, 5, 6],
    'neither healer priority nor being the beneficiary may force an underlevel member into the hunt');

let veteran = { ...members[5], stats: { ...members[5].stats, deaths: 0 } };
for (let attempt = 0; attempt < 2; attempt++) {
    const party = { partyId: `reformed-${attempt}`, memberIds: [veteran.characterId, 99 + attempt],
        spotId: 'tower', stats: { objective } };
    const outcome = PartyRisk.record(party, { debug: { fights: 1, wins: 0, spotId: 'tower' },
        memberResults: [{ state: veteran, result: { patch: { deathCount: attempt + 1 },
            debug: { fights: 1, wins: 0, spotId: 'tower' } } }] }, at + attempt);
    veteran = { ...veteran, stats: { ...veteran.stats, ...outcome.memberResults[0].result.patch.stats, deaths: attempt + 1 } };
}
veteran = JSON.parse(JSON.stringify(veteran));
assert(!Safety.allowed(veteran, objective, at + 2), 'two deaths must survive party and roster replacement and serialization');
assert(!veteran.stats.spotRisk && !veteran.stats.spotBackoffs, 'clan defeats must not prohibit a different solo hunt');
const retryAt = veteran.stats.clanHuntBackoffs[0].until + 1;
assert(Safety.allowed(veteran, objective, retryAt));
const successfulRetry = Safety.recordOutcome(veteran, { patch: {}, debug: { fights: 1, wins: 1 } }, objective, retryAt);
assert(!successfulRetry.patch.stats.clanHuntBackoffs.some(b => b.until > retryAt),
    'an expired ban must permit a real retry rather than revive old death pressure forever');

const debtMembers = [1, 2].map(characterId => ({ characterId, level: 55, phase: 'cold',
    stats: { role: 'dps', equipment: [{ slot: 7, rank: 'd' }] } }));
const basePlan = { status: 'active', strategy: 'craft', grade: 'c', target: { selfId: 2566, slot: 7 } };
const plans = new Map([[1, basePlan], [2, { ...basePlan, status: 'component_ready' }]]);
const previous = { target: { memberId: 1 }, status: 'executing' };
assert.strictEqual(Policy.selectTargetMember(debtMembers, plans, previous).member.characterId, 1,
    'a ready component must not bounce equal-grade beneficiaries');
plans.set(2, { ...basePlan, grade: 'b' });
assert.strictEqual(Policy.selectTargetMember(debtMembers, plans, previous).member.characterId, 2,
    'a whole grade of additional debt can still preempt the current assignment');

const dualPlan = { ...basePlan, recipeId: 902566, status: 'component_ready',
    clanGoal: { clanId: 7, beneficiaryId: 10 } };
const component = Recipes.resolveByProductId(72);
const stock = component.materials.map(m => ({ ...m, kind: Data.items.find(i => i.selfId === m.selfId).template.kind }));
const provider = { characterId: 99, known: true, loc: { locX: 83400, locY: 148600, locZ: -3400 } };
const beneficiary = { characterId: 10, level: 55, clanId: 7, phase: 'cold', activity: 'hunting',
    inventory: {}, loc: provider.loc, stats: { classId: 34, equipmentPlan: dualPlan } };
const originalPlanner = Gear.planFor;
let decorated;
try {
    Gear.planFor = () => ({ ...dualPlan });
    decorated = ClanPlanner.planForMember(beneficiary, [], stock, {
        craftRecipes: [component], craftProviders: { [component.recipeId]: provider }
    });
} finally { Gear.planFor = originalPlanner; }
assert.strictEqual(decorated.componentRecipes[72], component.recipeId, 'dual components retain their chosen recipe');
assert.deepStrictEqual(decorated.craftProviders[component.recipeId], provider, 'dual components retain their clan crafter');
assert(decorated.warehouseMaterials.some(m => m.selfId === 2060 && m.amount === 8),
    'dual warehouse handoff must include materials for missing component swords');
const supplied = { ...beneficiary, stats: { ...beneficiary.stats, equipmentPlan: decorated },
    inventory: Object.fromEntries(decorated.warehouseMaterials.map(m => [m.selfId, m])) };
assert.strictEqual(Craft.beginTravel(beneficiary), null, 'the original stranded plan has nothing to craft');
assert.strictEqual(Craft.beginTravel(supplied).stats.travel.stationId, 'clan_crafter_99',
    'the planned warehouse handoff actually unlocks component crafting at the assigned clan crafter');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
assert.strictEqual(Disposition.reservedCraftAmounts(supplied)[2060], 8,
    'materials withdrawn for dual-sword components must remain reserved until crafting');
assert(!Disposition.saleCandidates(supplied, { unlimited: true }).some(item => item.selfId === 2060),
    'inventory cleanup must not sell the ingredients just delivered by the clan');

async function checkWorkerSafety() {
    const { ColdSimulationKernel } = invoke('GameServer/Bot/Population/ColdSimulationKernel');
    const messages = [];
    const states = members.slice(0, 3).map(m => ({ ...m, activity: 'grouped',
        party: { partyId: 'unsafe', leaderId: 1 },
        timing: { lastResolvedAt: at - 1000, nextResolveAt: at - 1 },
        simulation: { ownerId: 'legacy_main', revision: 3 },
        stats: { ...m.stats, clanPartyObjective: objective } }));
    const party = { partyId: 'unsafe', leaderId: 1, memberIds: [1, 2, 3], spotId: 'tower',
        stats: { objective, sessionExpiresAt: at + 3600000 } };
    const kernel = new ColdSimulationKernel({ now: () => at,
        resolveSolo: () => { throw new Error('party review must not run a solo fight'); },
        resolveParty: () => { throw new Error('an unsafe clan party must be released before combat'); },
        emit: (type, payload) => messages.push({ type, payload }) });
    states.forEach((state, i) => kernel.upsert({ state, context: i === 0
        ? { isPartyLeader: true, party, partyMembers: states, spot: { id: 'tower' } } : {} }));
    kernel.tick();
    const claim = messages.shift();
    assert.strictEqual(claim.type, 'claim_request');
    kernel.onClaimAck({ grants: claim.payload.candidates.map(c => ({ ok: true, characterId: c.characterId,
        ownerId: 'cold_simulation_owner', revision: c.expectedRevision + 1,
        leaseId: `safety-${c.characterId}`, leaseUntil: at + 30000, purpose: c.purpose })) });
    await kernel.resolveChain;
    const proposals = messages.find(m => m.type === 'proposal_batch').payload.proposals;
    assert.strictEqual(proposals.length, 3);
    assert(proposals.every(p => p.atomicGroup.memberIds.length === 3), 'unsafe party release is one atomic group');
    assert(proposals.every(p => !p.nextState.party.partyId && !p.nextState.stats.clanPartyObjective));
    assert(proposals.every(p => p.nextState.stats.partyBreakReason === 'clan_party_unsafe'));
}
async function checkMissingSpotRecovery() {
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Events = invoke('GameServer/Bot/Population/BotLifeEvents');
    const Goals = invoke('GameServer/Bot/Goals/GoalService');
    const originals = { ensure: Spots.ensure, occupancy: Spots.currentOccupancy, find: Spots.findForState,
        save: Life.upsertState, cachedState: Life.cachedState };
    const state = { ...polearm, characterId: 100, phase: 'cold', activity: 'hunting', inventory: {},
        adena: 0, stats: { classId: 3 }, timing: { nextResolveAt: 1 } };
    let savedReason;
    let saves = 0;
    const originalEvents = Events.recordMany;
    const originalReview = Goals.review;
    try {
        Spots.ensure = () => [];
        Spots.currentOccupancy = () => ({});
        Spots.findForState = () => null;
        Life.upsertState = async (next, reason) => { savedReason = reason; saves += 1; return next; };
        Events.recordMany = async () => [];
        const before = Date.now();
        const result = await Population.resolveColdState(state, { precomputedPlan: {
            acquisitionPlan: { status: 'complete', strategy: 'none' }
        } });
        assert(result.ok);
        assert.strictEqual(savedReason, 'missing_spot_recovery');
        assert.strictEqual(result.state.activity, 'resting');
        assert(result.state.timing.nextResolveAt >= before + 30000, 'a missing route must not remain perpetually overdue');
        assert.strictEqual(result.state.stats.equipmentPlan.status, 'complete', 'the recalculated plan is persisted');
        assert.strictEqual(result.state.stats.routeRecovery.attempts, 1);
        const craftResult = await Population.executeWorkerLifecycleCommand(supplied, {
            precomputedPlan: { acquisitionPlan: decorated },
            precomputedResult: { patch: { activity: 'traveling', stats: { travel: {
                reason: 'level_replan', spotId: 'unrelated-hunt', arrivalAt: Date.now() + 25000
            } } } }
        });
        assert(craftResult.ok);
        assert.strictEqual(savedReason, 'cold_craft_travel');
        assert.strictEqual(craftResult.state.stats.travel.stationId, 'clan_crafter_99');
        assert.strictEqual(craftResult.state.stats.travel.reason, 'component_craft',
            'a stale worker hunt must not overwrite an executable component craft trip');
        assert.strictEqual(craftResult.state.timing.nextResolveAt, craftResult.state.stats.travel.arrivalAt);
        Goals.review = async () => ({ current: { type: 'upgrade_gear', target: { itemId: 291 },
            plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' } } });
        const buyer = { ...state, activity: 'party_wait', inventory: polearm.inventory, adena: polearm.adena,
            loc: provider.loc, vitals: { hp: 1000, maxHp: 1000, mp: 100, maxMp: 1000 },
            stats: { ...polearm.stats, equipment: [{ selfId: 129, slot: 7, rank: 'd' }],
                equipmentPlan: Gear.npcWeaponBridgePlan(polearm) } };
        const Needs = invoke('GameServer/Bot/Goals/NeedsEvaluator');
        const bridgeGoal = Needs.evaluate(buyer).sort((left, right) => right.priority - left.priority)[0];
        assert.strictEqual(bridgeGoal.plan.expectedBenefit, 'market_search_for_weapon',
            'a funded weapon bridge must outrank ordinary MP recovery');
        const purchasedTrip = await Population.executeWorkerLifecycleCommand(buyer, {
            precomputedResult: { patch: { activity: 'resting' }, materialize: { exp: 100 } }
        });
        assert(purchasedTrip.ok);
        assert.strictEqual(savedReason, 'goal_market_travel_before_combat');
        assert.strictEqual(purchasedTrip.state.stats.travel.reason, 'market_search_for_weapon',
            'a funded two-handed weapon must leave stale party wait for market before a worker fight can exhaust the buyer again');
        const savesBeforeStaleTrip = saves;
        let current = buyer;
        Life.cachedState = () => current;
        Goals.review = async () => {
            current = { ...buyer, inventory: { ...buyer.inventory, newlyAcquired: { amount: 1 } } };
            return { current: { type: 'upgrade_gear', plan: { expectedBenefit: 'market_search_for_weapon' } } };
        };
        const staleTrip = await Population.executeWorkerLifecycleCommand(buyer, {
            precomputedResult: { patch: { activity: 'resting' } }
        });
        assert.strictEqual(staleTrip.reason, 'state_changed',
            'a concurrent state update during goal review must prevent stale market travel');
        assert.strictEqual(staleTrip.state, current);
        assert.strictEqual(saves, savesBeforeStaleTrip, 'the stale market trip must not write another lifecycle state');
    } finally {
        Spots.ensure = originals.ensure; Spots.currentOccupancy = originals.occupancy;
        Spots.findForState = originals.find; Life.upsertState = originals.save;
        Life.cachedState = originals.cachedState;
        Events.recordMany = originalEvents;
        Goals.review = originalReview;
    }
}
checkWorkerSafety().then(checkMissingSpotRecovery).then(() => console.log('Bot progression audit regressions passed'))
    .catch(error => { console.error(error); process.exitCode = 1; });
