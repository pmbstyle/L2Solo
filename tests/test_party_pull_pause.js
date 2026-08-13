const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');
const BotManager = invoke('GameServer/Bot/BotManager');

function actor(id, classId = 0) {
    return {
        fetchId: () => id,
        fetchName: () => `actor_${id}`,
        fetchClassId: () => classId,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => undefined,
        fetchIsOnline: () => true,
        isDead: () => false,
        state: {
            seated: false,
            combat: false,
            fetchSeated() { return this.seated; },
            fetchDead: () => false,
            fetchCombats() { return this.combat; },
            fetchHits: () => false,
            fetchCasts: () => false
        },
        skillset: { fetchSkills: () => [] }
    };
}

const leaderSession = { actor: actor(1) };
const pullerSession = {
    actor: actor(2, 7),
    partyCompanion: true,
    followPlayerSession: leaderSession
};
const recoveringPlanSession = {
    actor: actor(3, 15),
    partyCompanion: true,
    followPlayerSession: leaderSession,
    plan: 'getting_buffed'
};

World.user = { sessions: [leaderSession, pullerSession, recoveringPlanSession] };
World.npc = { spawns: [] };
World.fetchNpcsInRadius = () => [];

const settings = { pullMode: 'bot', pullerId: pullerSession.actor.fetchId() };

assert.notStrictEqual(
    PartyPulling.current(leaderSession, settings).paused,
    'party_recovering',
    'a standing companion must not pause pull merely because an old support plan remains'
);

recoveringPlanSession.actor.state.seated = true;
assert.notStrictEqual(
    PartyPulling.current(leaderSession, settings).paused,
    'party_recovering',
    'one seated companion in a three-member party must not pause pull'
);

pullerSession.actor.state.seated = true;
assert.strictEqual(
    PartyPulling.current(leaderSession, settings).paused,
    'party_recovering',
    'the puller sitting down must pause pull regardless of party size'
);
pullerSession.actor.state.seated = false;

leaderSession.actor.state.seated = true;
assert.strictEqual(
    PartyPulling.current(leaderSession, settings).paused,
    'party_recovering',
    'more than forty percent of the whole party sitting must pause pull'
);
leaderSession.actor.state.seated = false;
recoveringPlanSession.actor.state.seated = false;

World.npc.spawns = [{
    fetchId: () => 3000099,
    fetchAttackable: () => true,
    isDead: () => false,
    fetchLocX: () => 100,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    fetchDestId: () => undefined
}];
recoveringPlanSession.actor.isDead = () => true;
const revivalPause = PartyPulling.tickBotPuller(
    pullerSession,
    pullerSession.actor,
    leaderSession,
    settings,
    {},
    { executeCombat() { throw new Error('puller must not begin a new encounter while a party member needs resurrection'); } }
);
assert.strictEqual(revivalPause.action, 'party_revival', 'a dead party member must pause a new pull until revival is handled');
recoveringPlanSession.actor.isDead = () => false;
World.npc.spawns = [];

pullerSession.actor.state.combat = true;
assert.notStrictEqual(
    PartyPulling.current(leaderSession, settings).paused,
    'party_under_attack',
    'an old inCombat flag without a living hostile target must not freeze a new pull'
);

World.npc.spawns = [{
    fetchId: () => 3000100,
    fetchAttackable: () => true,
    isDead: () => false,
    fetchLocX: () => 10000,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    fetchDestId: () => undefined,
    state: { fetchCombats: () => false }
}];
leaderSession.partyPullState = { targetId: 3000100, pullerId: 2, phase: 'return' };
assert.strictEqual(
    PartyPulling.current(leaderSession, settings).target,
    null,
    'a target left in another region after the leader relocates must not keep the party pulling'
);
assert.deepStrictEqual(leaderSession.partyPullState, {}, 'clearing an abandoned pull must remove its stale target id');

const unreachableTarget = {
    fetchId: () => 3000101,
    fetchName: () => 'unreachable target',
    fetchAttackable: () => true,
    isDead: () => false,
    fetchLocX: () => 600,
    fetchLocY: () => 0,
    fetchLocZ: () => 0,
    fetchDestId: () => undefined
};
const reachableTarget = {
    ...unreachableTarget,
    fetchId: () => 3000102,
    fetchName: () => 'reachable target',
    fetchLocX: () => 800
};
World.npc.spawns = [unreachableTarget, reachableTarget];
World.fetchNpcsInRadius = () => [unreachableTarget, reachableTarget];
leaderSession.partyPullState = {};
let abortedUnreachableMove = 0;
pullerSession.actor.automation = { abortAll() { abortedUnreachableMove++; } };
pullerSession.actor.moveTo = ({ to }) => {
    pullerSession.lastPathfinding = {
        pathLength: to.locX === unreachableTarget.fetchLocX() ? 1 : 2,
        routeUsable: to.locX !== unreachableTarget.fetchLocX(),
        lowLodWarp: false
    };
};

const reachablePull = PartyPulling.tickBotPuller(
    pullerSession,
    pullerSession.actor,
    leaderSession,
    settings,
    {},
    { executeCombat() {} }
);
assert.strictEqual(reachablePull.action, 'approach', 'the puller should skip an unreachable candidate and begin the reachable route in the same tick');
assert.strictEqual(reachablePull.target.fetchId(), reachableTarget.fetchId(), 'route selection should settle on the reachable target');
assert.strictEqual(abortedUnreachableMove, 1, 'rejecting an unreachable pull target should stop its fallback movement');
assert.strictEqual(leaderSession.partyPullState.targetId, reachableTarget.fetchId(), 'the reachable alternate should own the shared pull slot');

const directFallbackTarget = {
    ...unreachableTarget,
    fetchId: () => 3000104,
    fetchName: () => 'direct fallback target',
    fetchLocX: () => 700
};
leaderSession.partyPullState = {};
let directFallbackMoves = 0;
pullerSession.actor.moveTo = () => {
    directFallbackMoves++;
    pullerSession.lastPathfinding = {
        pathLength: 1,
        routeUsable: true,
        lowLodWarp: false
    };
};
World.npc.spawns = [directFallbackTarget];
World.fetchNpcsInRadius = () => [directFallbackTarget];
const directFallbackPull = PartyPulling.tickBotPuller(
    pullerSession,
    pullerSession.actor,
    leaderSession,
    settings,
    {},
    { executeCombat() {} }
);
assert.strictEqual(directFallbackPull.action, 'approach', 'a clear direct fallback must remain a usable pull route when bounded A* returns no path');
assert.strictEqual(directFallbackPull.target.fetchId(), directFallbackTarget.fetchId(), 'the puller should keep the direct-fallback target');
assert.strictEqual(directFallbackMoves, 2, 'a usable preview should be followed by the actual movement command');

const incomingAdd = {
    ...reachableTarget,
    fetchId: () => 3000103,
    fetchName: () => 'incoming add',
    fetchLocX: () => 900,
    fetchDestId: () => pullerSession.actor.fetchId()
};
pullerSession.actor.fetchLocX = () => 1000;
pullerSession.actor.attack = { abortCast() {}, clearTimers() {} };
let returnDestination = null;
pullerSession.actor.moveTo = ({ to, previewOnly }) => {
    if (!previewOnly) returnDestination = to;
    pullerSession.lastPathfinding = { pathLength: 2, lowLodWarp: false };
};
World.npc.spawns = [reachableTarget, incomingAdd];
World.fetchNpcsInRadius = () => [reachableTarget, incomingAdd];
leaderSession.partyPullState = {
    targetId: reachableTarget.fetchId(),
    pullerId: pullerSession.actor.fetchId(),
    source: 'bot',
    phase: 'approach',
    startedAt: Date.now()
};
const adoptedPull = PartyPulling.tickBotPuller(
    pullerSession,
    pullerSession.actor,
    leaderSession,
    settings,
    {},
    { executeCombat() {} }
);
assert.strictEqual(adoptedPull.action, 'return', 'aggro on a travelling puller must immediately become a return leg');
assert.strictEqual(adoptedPull.target.fetchId(), incomingAdd.fetchId(), 'the mob already attacking the puller should replace the untouched target');
assert.strictEqual(leaderSession.partyPullState.phase, 'return', 'opportunistic pull aggro should be persisted as return state');
assert.strictEqual(returnDestination.locX, leaderSession.actor.fetchLocX(), 'the puller should route back to the leader after opportunistic aggro');

const originalBotPartySay = BotManager.botPartySay;
let noRouteMessage = null;
BotManager.botPartySay = (_session, text) => { noRouteMessage = text; return true; };
try {
    const blockedTargets = Array.from({ length: 5 }, (_, index) => ({
        ...unreachableTarget,
        fetchId: () => 3000200 + index,
        fetchName: () => `blocked_${index}`,
        fetchLocX: () => 600 + index,
        fetchDestId: () => undefined
    }));
    pullerSession.actor.fetchLocX = () => 0;
    pullerSession.actor.moveTo = () => {
        pullerSession.lastPathfinding = { pathLength: 0, routeUsable: false, lowLodWarp: false };
    };
    leaderSession.partyPullState = {};
    leaderSession.partyPullRejectedTargets = {};
    leaderSession.partyPullSearchRetryAt = undefined;
    World.npc.spawns = blockedTargets;
    World.fetchNpcsInRadius = () => blockedTargets;
    const searchResult = PartyPulling.tickBotPuller(
        pullerSession, pullerSession.actor, leaderSession, settings, {}, { executeCombat() {} }
    );
    assert.strictEqual(searchResult.action, 'searching_reachable_target', 'route search should inspect only a bounded candidate batch per tick');
    const exhaustedResult = PartyPulling.tickBotPuller(
        pullerSession, pullerSession.actor, leaderSession, settings, {}, { executeCombat() {} }
    );
    assert.strictEqual(exhaustedResult.action, 'no_reachable_targets', 'exhausted geodata candidates should enter an explicit route cooldown');
    assert.match(noRouteMessage, /safe route|reachable pull target/, 'the puller should tell the party why it is holding position');
} finally {
    BotManager.botPartySay = originalBotPartySay;
}

const protectedRaidBoss = {
    ...reachableTarget,
    fetchId: () => 3000300,
    fetchName: () => 'protected raid boss',
    fetchIsRaidBoss: () => true,
    fetchDestId: () => undefined
};
leaderSession.partyPullState = {};
leaderSession.partyPullRejectedTargets = {};
leaderSession.partyPullSearchRetryAt = undefined;
World.npc.spawns = [protectedRaidBoss];
World.fetchNpcsInRadius = () => [protectedRaidBoss];
assert.strictEqual(
    PartyPulling.observeLeaderTarget(leaderSession, { pullMode: 'leader' }, protectedRaidBoss.fetchId()),
    null,
    'companions must ignore a player-selected raid boss as a pull target'
);
let protectedPullAttacks = 0;
const protectedPull = PartyPulling.tickBotPuller(
    pullerSession,
    pullerSession.actor,
    leaderSession,
    settings,
    {},
    { executeCombat() { protectedPullAttacks++; } }
);
assert.strictEqual(protectedPull.idle, true, 'an automatic puller must see no ordinary target at a raid-only location');
assert.strictEqual(protectedPullAttacks, 0, 'an automatic puller must never open on a raid boss');
assert.deepStrictEqual(leaderSession.partyPullState, {}, 'a rejected raid target must not create persistent pull state');

console.info('party pull pause tests passed');
