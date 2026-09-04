const assert = require('assert');

require('../src/Global');

const NpcDied = invoke('GameServer/Actor/Generics/NpcDied');
const World = invoke('GameServer/World/World');

const originalWorldUser = World.user;
const originalSetTimeout = global.setTimeout;

let busy = true;
const sweeper = {
    fetchClassId: () => 55,
    fetchLevel: () => 40,
    fetchId: () => 22002,
    fetchMp: () => 100,
    state: { fetchCasts: () => busy },
    skillset: {
        fetchSkill(selfId) {
            if (selfId !== 42) return null;
            return {
                selfId: 42,
                fetchSelfId: () => 42,
                fetchName: () => 'Sweeper',
                fetchConsumedMp: () => 0
            };
        }
    }
};
const session = { accountId: 'bot_sweep_retry', actor: sweeper };
const corpse = {
    fetchId: () => 22003,
    fetchAttackable: () => true,
    isDead: () => true,
    state: { fetchDead: () => true },
    model: { spoil: { spoiled: true, swept: false, spoilerId: 22002 } }
};
const secondCorpse = {
    ...corpse,
    fetchId: () => 22004,
    model: { spoil: { spoiled: true, swept: false, spoilerId: 22002 } }
};
const generics = {
    skills: [],
    skillExec(_session, _actor, data) {
        this.skills.push(data);
    }
};
const pendingTimers = [];

try {
    World.user = { sessions: [session] };
    global.setTimeout = (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        pendingTimers.push(timer);
        return timer;
    };

    assert.strictEqual(NpcDied.autoSweepSpoiledCorpse(corpse, generics), false,
        'a busy spoiler must defer Sweep instead of consuming the attempt');
    assert.strictEqual(NpcDied.autoSweepSpoiledCorpse(secondCorpse, generics), false,
        'each corpse must retain its own deferred Sweep');
    assert.strictEqual(pendingTimers.length, 2, 'busy Sweep retries must be tracked per corpse');
    assert.strictEqual(pendingTimers[0].delay, 250);

    busy = false;
    pendingTimers.shift().callback();
    pendingTimers.shift().callback();
    assert.deepStrictEqual(generics.skills[0], { id: 22003, selfId: 42, ctrl: true },
        'the deferred retry must queue Sweep after the cast finishes');
    assert.deepStrictEqual(generics.skills[1], { id: 22004, selfId: 42, ctrl: true },
        'a second corpse must not be dropped behind the first retry timer');
    assert.strictEqual(session.sweepRetriesByNpcId, undefined,
        'completed corpse retries must release their per-session tracking map');
} finally {
    global.setTimeout = originalSetTimeout;
    World.user = originalWorldUser;
}

console.log('test_bot_sweep_retry: ok');
