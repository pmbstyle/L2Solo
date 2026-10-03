const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

DataCache.init();

// A shared party encounter is counted once in the population totals
// (`populationTelemetryOwner`), but every member keeps personal telemetry.
// Drop-route failure detection judges one bot's route, so a party member that
// is not the telemetry owner must see its own resolves at the source NPC.
const weapon = DataCache.items.find((item) => String(item.etc?.rank) === 'd'
    && Number(item.etc?.slot) === 7 && String(item.template?.kind) === 'Weapon.Sword');
assert(weapon, 'fixture: a D-grade sword');
const npcId = 20001;
const otherNpcId = 20002;
const at = 1800000000000;
const plan = {
    status: 'active',
    strategy: 'direct_drop',
    grade: 'd',
    target: { selfId: Number(weapon.selfId), name: weapon.name, slot: 7 },
    next: { spotId: 'drop-spot', npcId, itemId: Number(weapon.selfId) },
    targetProgress: { npcId, resolves: 0, targetKills: 0 },
    expectedKills: 400,
    startedAt: at,
    plannedForLevel: 30,
    progressionBaseline: { level: 30, exp: 0 }
};
const member = (characterId) => ({
    characterId,
    name: `PartyMember${characterId}`,
    level: 30,
    exp: 0,
    inventory: {},
    stats: { classId: 0, role: 'dps', equipmentPlan: plan }
});

async function resolveTimes(state, owner, count, { target = npcId, defeated = [otherNpcId], from = 0 } = {}) {
    let next = state;
    for (let index = from; index < from + count; index++) {
        next = await LifeState.prepareResolve(next, {
            patch: {},
            events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: at + index + 1,
            debug: {
                aggregate: true,
                populationTelemetryOwner: owner,
                targetNpcId: target,
                defeatedNpcIds: defeated
            }
        }, { timestamp: at + index, persist: false, projectClassProgression: true });
    }
    return next;
}

async function main() {
    const owner = await resolveTimes(member(9300001), true, 10);
    const follower = await resolveTimes(member(9300002), false, 10);
    assert.strictEqual(owner.stats.targetCombat.resolves, 10, 'fixture: the owner counts its resolves');
    assert.strictEqual(follower.stats.targetCombat.resolves, 10, 'fixture: a follower keeps personal telemetry');

    const ownerFailure = GearAcquisitionPlanner.replanContextFor(owner, plan, at + 60000).failure;
    assert.strictEqual(ownerFailure?.reason, 'combat_unviable',
        'fixture: ten resolves without a target kill fail the owner route');
    const followerFailure = GearAcquisitionPlanner.replanContextFor(follower, plan, at + 60000).failure;
    assert.strictEqual(followerFailure?.reason, 'combat_unviable',
        'a party member that is not the telemetry owner must see its own failing drop route');
    assert.strictEqual(followerFailure.resolves, 10);

    // Ownership is the first member of the party result; it moves when the
    // roster changes. A former owner must keep counting its own resolves.
    const formerOwner = await resolveTimes(await resolveTimes(member(9300003), true, 3), false, 7);
    assert.strictEqual(formerOwner.stats.targetCombat.resolves, 10,
        'a member that lost telemetry ownership must keep its personal resolve count');
    assert.strictEqual(GearAcquisitionPlanner.replanContextFor(formerOwner, plan, at + 60000).failure?.reason,
        'combat_unviable', 'a former telemetry owner must see its own failing drop route');

    // A follower's counter restarts from the population totals (which grow
    // only on the owner) when its target changes. Back on the plan's NPC it is
    // below the plan's baseline: the route is judged from a new baseline.
    // The fixture resolves carry no exp; finalize reads the level for its
    // de-level check, so it sees the plan's level.
    const atPlanLevel = (state) => ({ ...state, level: 30 });
    const switchPlan = { ...plan, targetProgress: { npcId, resolves: 20, targetKills: 0 } };
    let switched = await resolveTimes(member(9300004), false, 20);
    switched = await resolveTimes(switched, false, 1, { target: otherNpcId, from: 20 });
    switched = await resolveTimes(switched, false, 15, { from: 21 });
    assert.strictEqual(switched.stats.targetCombat.resolves, 15, 'fixture: the counter restarted below the baseline');
    assert.strictEqual(GearAcquisitionPlanner.replanContextFor(switched, switchPlan, at + 60000).failure, null,
        'a restarted counter is not judged against the old baseline');
    const restamped = GearAcquisitionPlanner.finalizePlan(atPlanLevel(switched), switchPlan, switchPlan, {}, at + 60000);
    assert.strictEqual(restamped.targetProgress.resolves, 15, 'the finalize pass stamps the restarted counter as the baseline');
    switched = await resolveTimes(switched, false, 8, { from: 36 });
    assert.strictEqual(GearAcquisitionPlanner.replanContextFor(switched, restamped, at + 120000).failure?.reason,
        'combat_unviable', 'a follower back on its plan NPC sees its failing drop route after a target switch');

    // The kill counter restarts the same way; real kills after the switch are
    // not hidden behind the old kill baseline.
    const killPlan = { ...plan, targetProgress: { npcId, resolves: 20, targetKills: 5 } };
    let killer = await resolveTimes(member(9300005), false, 15, { defeated: [otherNpcId] });
    killer = await resolveTimes(killer, false, 5, { defeated: [npcId], from: 15 });
    killer = await resolveTimes(killer, false, 1, { target: otherNpcId, from: 20 });
    killer = await resolveTimes(killer, false, 10, { defeated: [npcId], from: 21 });
    const killRestamp = GearAcquisitionPlanner.finalizePlan(atPlanLevel(killer), killPlan, killPlan, {}, at + 60000);
    assert.strictEqual(killRestamp.targetProgress.targetKills, 10, 'fixture: the kill baseline is restamped');
    killer = await resolveTimes(killer, false, 8, { defeated: [npcId], from: 31 });
    assert.notStrictEqual(GearAcquisitionPlanner.replanContextFor(killer, killRestamp, at + 120000).failure?.reason,
        'combat_unviable', 'kills after a target switch count toward the route');
    console.log('Party member drop route failure checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
