const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const PartyPulling = invoke('GameServer/Bot/AI/PartyPulling');

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

console.info('party pull pause tests passed');
