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

async function resolveTimes(state, owner, count) {
    let next = state;
    for (let index = 0; index < count; index++) {
        next = await LifeState.prepareResolve(next, {
            patch: {},
            events: [],
            materialize: { exp: 0, sp: 0, adena: 0, items: [] },
            nextResolveAt: at + index + 1,
            debug: {
                aggregate: true,
                populationTelemetryOwner: owner,
                targetNpcId: npcId,
                defeatedNpcIds: [otherNpcId]
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
    console.log('Party member drop route failure checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
