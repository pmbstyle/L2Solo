const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');

DataCache.init();

// The party requirement refresh re-plans members between resolves. It must
// finalize those plans like every other planning path: a failed drop target
// keeps its cooldown ("Keep the failure on the acquisition plan so it survives
// travel, idle ticks and restarts"), and an unchanged route keeps its start
// time and progression baseline.
const weapon = DataCache.items.find((item) => String(item.etc?.rank) === 'd'
    && Number(item.etc?.slot) === 7 && String(item.template?.kind) === 'Weapon.Sword');
assert(weapon, 'fixture: a D-grade sword');
const npcId = 20001;
// Both members hold a usable weapon: an unarmed bot gets the weapon bridge first.
const held = (name) => {
    const item = DataCache.items.find((entry) => entry.template?.name === name);
    assert(item, `fixture: ${name}`);
    return { [item.selfId]: { selfId: Number(item.selfId), amount: 1, equipped: true, equippedSlots: [Number(item.etc.slot)], slot: Number(item.etc.slot) } };
};
const now = Date.now();
const failingMember = {
    characterId: 9200001, phase: 'cold',
    name: 'FailingDropMember',
    level: 30,
    inventory: held('Short Sword'),
    party: { partyId: 'bgp-refresh-context' },
    stats: {
        classId: 0,
        role: 'dps',
        targetCombat: { populationTargets: { [npcId]: { resolves: 10, targetKills: 0 } } },
        equipmentPlan: {
            status: 'active',
            strategy: 'direct_drop',
            grade: 'd',
            target: { selfId: Number(weapon.selfId), name: weapon.name, slot: 7 },
            next: { spotId: 'drop-spot', npcId, itemId: Number(weapon.selfId) },
            targetProgress: { npcId, resolves: 0, targetKills: 0 },
            expectedKills: 400,
            startedAt: now - 60 * 60 * 1000,
            plannedForLevel: 30,
            progressionBaseline: { level: 30, exp: 0 }
        }
    }
};
const craftStartedAt = now - 3 * 60 * 60 * 1000;
const craftBaseline = { level: 41, exp: 123456 };
const craftPlan = {
    status: 'component_ready',
    strategy: 'craft',
    grade: 'c',
    recipeId: 189,
    target: { selfId: 9301, name: 'Craft Target', slot: 7 },
    next: { spotId: 'material-spot', npcId: 20002, itemId: 1879 },
    startedAt: craftStartedAt,
    plannedForLevel: 41,
    progressionBaseline: craftBaseline
};
const craftMember = {
    characterId: 9200002, phase: 'cold',
    name: 'CraftMember',
    level: 41,
    exp: 200000,
    inventory: held("Apprentice's Rod"),
    party: { partyId: 'bgp-refresh-context' },
    stats: { classId: 10, role: 'mage', equipmentPlan: craftPlan }
};

const originals = {
    replacementPlanFor: GearAcquisitionPlanner.replacementPlanFor,
    planFor: GearAcquisitionPlanner.planFor,
    cachedStatesForParties: LifeState.cachedStatesForParties,
    cachedState: LifeState.cachedState,
    upsertState: LifeState.upsertState,
    leaveParty: LifeState.leaveParty,
    createOrUpdate: PartyState.createOrUpdate,
    recordMany: LifeEvents.recordMany,
    ensure: SpotProfiles.ensure,
    currentOccupancy: SpotProfiles.currentOccupancy
};

async function main() {
    const replacementOptions = [];
    const saved = new Map();
    const events = [];
    LifeEvents.recordMany = async (characterId, entries) => { events.push(...entries.map((entry) => ({ characterId, ...entry }))); };
    GearAcquisitionPlanner.replacementPlanFor = (_state, _previous, _spots, options) => {
        replacementOptions.push(options);
        return { status: 'active', strategy: 'market', grade: 'd',
            target: { selfId: 9302, name: 'Market Target', slot: 7 },
            market: { town: 'Giran', price: 1000, sourceType: 'npc' },
            next: { kind: 'market', town: 'Giran', itemId: 9302 } };
    };
    GearAcquisitionPlanner.planFor = () => ({
        status: 'active',
        strategy: 'craft',
        grade: 'c',
        recipeId: 189,
        target: { ...craftPlan.target },
        next: { ...craftPlan.next },
        partyNeed: 'required',
        requiresParty: true,
        materials: []
    });
    const current = new Map([[failingMember.characterId, failingMember], [craftMember.characterId, craftMember]]);
    LifeState.cachedState = id => current.get(Number(id));
    LifeState.cachedStatesForParties = parties => new Map(parties.map(party => [party.partyId, party.memberIds.map(id => current.get(Number(id)))]));
    LifeState.upsertState = async (state) => {
        saved.set(Number(state.characterId), state.stats.equipmentPlan);
        current.set(Number(state.characterId), state);
        return state;
    };
    LifeState.leaveParty = async () => null;
    PartyState.createOrUpdate = async (party) => party;
    SpotProfiles.ensure = () => [];
    SpotProfiles.currentOccupancy = () => ({});

    const party = { partyId: 'bgp-refresh-context', status: 'active', leaderId: failingMember.characterId,
        memberIds: [failingMember.characterId, craftMember.characterId], spotId: 'drop-spot',
        stats: { lastRequirementRefreshAt: 0, objective: null } };
    await PopulationService.refreshBackgroundPartyRequirements([party]);
    assert.strictEqual(replacementOptions.length, 0, 'marking a refresh does not plan on main');
    // MVP-1: a gear wish without a prepared route is never the money activity,
    // so the failing member's economy is pinned to its gear wish (the fixture
    // has no spots or quotes); the craft member keeps its own review.
    const gearEconomy = (state) => {
        const economy = invoke('GameServer/Bot/Economy/EconomyContext').forState(state, { spots: [], occupancy: {}, timestamp: now });
        const gear = economy.network.queue.find(wish => wish.object?.slot);
        assert(gear, 'fixture: the failing member wishes for gear');
        return { ...economy, network: { ...economy.network,
            activity: { ...economy.network.activity, activity: 'hunting', kind: 'money', rootKey: gear.key } } };
    };
    const selections = [failingMember, craftMember].map(state => ({ characterId: state.characterId,
        plan: require('../src/GameServer/Bot/Population/PartyRequirementRefresh').plan(state,
            { spots: [], occupancy: {}, timestamp: now,
                ...(state === failingMember ? { preparedEconomy: gearEconomy(state) } : {}) }).acquisitionPlan }));
    await PopulationService.applyWorkerPartyRequirements(party, { memberPlans: selections, requirementRefreshedAt: now });

    assert.strictEqual(replacementOptions.length, 1, 'fixture: the failing drop route must be replaced');
    assert((replacementOptions[0].excludedTargetIds || []).includes(Number(weapon.selfId)),
        'the replacement must exclude the drop target that just failed');
    const failedPlan = saved.get(failingMember.characterId);
    assert(failedPlan, 'the changed requirement must be saved');
    assert((failedPlan.recoveryTargets || []).some((entry) => (
        Number(entry.targetId) === Number(weapon.selfId) && entry.reason === 'combat_unviable'
        && Array.isArray(entry.wake) && entry.wake.every(Number.isFinite) && entry.until === undefined
    )), 'the saved plan must carry the failed target dormant wake inputs');

    const refreshedCraft = saved.get(craftMember.characterId);
    assert(refreshedCraft, 'fixture: the craft route requirement changed and must be saved');
    assert.strictEqual(refreshedCraft.startedAt, craftStartedAt,
        'the same craft route must keep its start time');
    assert.deepStrictEqual(refreshedCraft.progressionBaseline, craftBaseline,
        'the same craft route must keep its progression baseline');
    assert.strictEqual(refreshedCraft.plannedForLevel, craftMember.level,
        'a refreshed plan must be stamped for the member level');
    console.log('Party requirement refresh plan context checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(GearAcquisitionPlanner, {
        replacementPlanFor: originals.replacementPlanFor, planFor: originals.planFor
    });
    Object.assign(LifeState, {
        cachedStatesForParties: originals.cachedStatesForParties, cachedState: originals.cachedState, upsertState: originals.upsertState, leaveParty: originals.leaveParty
    });
    PartyState.createOrUpdate = originals.createOrUpdate;
    LifeEvents.recordMany = originals.recordMany;
    Object.assign(SpotProfiles, { ensure: originals.ensure, currentOccupancy: originals.currentOccupancy });
});
