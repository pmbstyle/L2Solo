const assert = require('assert');
require('../src/Global');
const Policy = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Approach = invoke('GameServer/Bot/AI/TownNpcApproach');
const Slots = invoke('GameServer/Bot/AI/TownNpcSlots');
const Recovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
invoke('GameServer/DataCache').init();
Geodata.loadRegion(22, 22);

const gate = { npcSelfId: 7080, locX: 83396, locY: 147904, locZ: -3404, head: 16384, town: 'Giran' };
function actor(point, id = 9021) {
    return { ...point, fetchId: () => id, fetchLocX() { return this.locX; }, fetchLocY() { return this.locY; }, fetchLocZ() { return this.locZ; },
        state: { fetchHits: () => false, fetchCasts: () => false }, moveTo() {}, automation: { abortAll() {} } };
}
for (const dx of [-60, 60]) {
    const bot = actor({ ...gate, locX: gate.locX + dx });
    assert(Approach.planOpen({}, bot, gate, 'town_gatekeeper').ready, 'already beside the gatekeeper must require no detour');
}
assert(!Approach.planOpen({}, actor({ ...gate, locZ: gate.locZ + 256 }), gate).ready, 'same XY on a different floor is not an interaction');
const ready = actor({ ...gate, locX: gate.locX + 60 });
const interaction = {};
assert.strictEqual(Policy.interact(interaction, ready, true, 1000), false);
assert.strictEqual(Policy.interact(interaction, ready, false, 5000), false, 'leaving the NPC must cancel the pending interaction');
assert.strictEqual(interaction.interactionReadyAt, undefined);

const stuck = {}, stuckBot = actor({ locX: 0, locY: 0, locZ: 0 });
Policy.observeRecovery(stuck, stuckBot, 'gate', false, 1000);
assert.strictEqual(Policy.escapeAfterFailure(stuck, stuckBot, 'gate', 'a', 1000), false);
assert.strictEqual(Policy.escapeAfterFailure(stuck, stuckBot, 'gate', 'a', 61000), false);
assert.strictEqual(stuck.townTravelRecovery.failures, 1, 'one failed attempt cannot count twice');
assert.strictEqual(Policy.escapeAfterFailure(stuck, stuckBot, 'gate', 'b', 61000), false);
assert.strictEqual(Policy.escapeAfterFailure(stuck, stuckBot, 'gate', 'c', 121000), true,
    'three failed recovery cycles and two minutes without progress must retain a final escape');
stuck.townEmergencyEscapeAt = 121000;
assert.strictEqual(Policy.escapeAfterFailure(stuck, stuckBot, 'gate', 'd', 181000), false, 'emergency escapes need a cooldown');
stuckBot.locX += 100;
Policy.observeRecovery(stuck, stuckBot, 'gate', false, 182000);
assert.strictEqual(stuck.townTravelRecovery.failures, 0, 'physical progress resets stuck evidence');
Policy.escapeAfterFailure(stuck, stuckBot, 'gate', 'e', 182000);
Policy.observeRecovery(stuck, stuckBot, 'gate', true, 200000);
assert.strictEqual(stuck.townTravelRecovery.failures, 0, 'queue/slot waiting must not contribute to emergency escape');
assert.strictEqual(Policy.escapeAfterFailure(stuck, stuckBot, 'different-goal', 'f', 400000), false,
    'changing destinations must not inherit escape eligibility');

const inside = actor({ locX: 85832, locY: 153208, locZ: -3496 });
assert.strictEqual(Policy.townAt(inside), 'Giran');
const result = TownTravel.request({}, inside, { getClosestTown: () => ({ name: 'Giran', x: gate.locX, y: gate.locY, z: gate.locZ }) }, null,
    { announce: false, forceScrollOfEscape: true });
assert.strictEqual(result, 'walk', 'an in-town trip must walk even when farther than the former 2500-unit SoE threshold');
for (const town of Object.values(invoke('GameServer/World/TownRespawn').towns)) {
    assert.strictEqual(Policy.townAt(town), town.name, `settlement core ${town.name} must be recognized`);
}
assert.strictEqual(Policy.townAt({ ...gate, locZ: -12000 }), null, 'underground actors are not in the surface town');
assert.strictEqual(Policy.townAt({ locX: 74000, locY: 147904, locZ: -3500 }), null, 'nearby fields must not become town via a large service radius');

const destination = { locX: 1000, locY: 1000, locZ: 0 };
const session = {};
const bot = actor({ locX: 0, locY: 0, locZ: 0 });
for (const error of ['QUEUE_FULL', 'PATH_TIMEOUT', 'PATH_PREEMPTED', 'PATH_BUDGET', 'WORKER_UNAVAILABLE']) {
    session.lastPathfinding = { requestedTo: destination, routeUsable: false, error, at: Date.now() + 100 + (session.companionNavigationRecovery?.lastFailureAt || 0) };
    const recovery = Recovery.move(session, bot, destination, 'town_gatekeeper', { targetActor: null });
    assert.strictEqual(recovery.failures, 0, `${error} must not consume route failure attempts`);
    assert.strictEqual(recovery.reason, 'budget_deferred');
}

const cappedSession = {};
for (let attempt = 1; attempt <= 3; attempt++) {
    cappedSession.lastPathfinding = { requestedTo: destination, routeUsable: false, error: 'PATH_BUDGET', at: Date.now() + attempt };
    const result = Recovery.move(cappedSession, bot, destination, 'shopping', { targetActor: null });
    assert.strictEqual(result.status, attempt < 3 ? 'waiting' : 'exhausted', 'repeated work-budget exhaustion must not retry forever');
    assert.strictEqual(result.failures, 0, 'a work budget is not proof of unreachable geometry');
    if (attempt === 3) assert.strictEqual(result.reason, 'work_budget_exhausted');
}
assert.strictEqual(Recovery.move(cappedSession, bot, destination, 'shopping', { targetActor: null }).status, 'exhausted');
bot.locX += 100;
assert.notStrictEqual(Recovery.move(cappedSession, bot, destination, 'shopping', { targetActor: null }).status, 'exhausted',
    'physical progress must reset work-budget exhaustion');
const queuedSession = {};
for (let attempt = 1; attempt <= 6; attempt++) {
    queuedSession.lastPathfinding = { requestedTo: destination, routeUsable: false, error: 'QUEUE_FULL', at: Date.now() + attempt };
    assert.strictEqual(Recovery.move(queuedSession, bot, destination, 'shopping', { targetActor: null }).status, 'waiting');
}

const first = {}, second = {}, third = {};
const makePoints = () => [{ locX: 1 }, { locX: 2 }];
assert.strictEqual(Slots.reserve(first, 'test-counter', makePoints, 0, 100).locX, 1);
assert.strictEqual(Slots.reserve(second, 'test-counter', makePoints, 0, 100).locX, 2);
assert.strictEqual(Slots.reserve(third, 'test-counter', makePoints, 0, 100), null, 'full counters must wait instead of stacking actors');
Slots.release(first);
assert.strictEqual(Slots.reserve(third, 'test-counter', makePoints, 0, 100).locX, 1);
assert(Slots.reserve({}, 'test-counter', makePoints, 0, 100 + Slots.LEASE_MS + 1), 'abandoned leases must expire without global timers');
console.log('Town transit, interaction, overload and NPC slot checks passed');
