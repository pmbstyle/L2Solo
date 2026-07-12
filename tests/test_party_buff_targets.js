const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const World = invoke('GameServer/World/World');

function actor(id) {
    return {
        fetchId: () => id,
        fetchIsOnline: () => true,
        state: { fetchDead: () => false }
    };
}

const originalUsers = World.user;
try {
    const leader = actor(1);
    const caster = actor(2);
    const companion = actor(3);
    const leaderSession = { actor: leader };
    const casterSession = {
        actor: caster,
        partyCompanion: true,
        followPlayerSession: leaderSession
    };
    const companionSession = {
        actor: companion,
        partyCompanion: true,
        followPlayerSession: leaderSession
    };
    World.user = { sessions: [leaderSession, casterSession, companionSession] };

    const partyBuff = {
        fetchTargetKind: () => 'party',
        fetchSemantic: () => ({ target: 'party' })
    };
    const targets = new Attack().resolveSkillTargets(casterSession, caster, leader, partyBuff);
    assert.deepStrictEqual(targets.map((target) => target.fetchId()), [1, 2, 3], 'a party buff should fan out to every active companion-party member');
} finally {
    World.user = originalUsers;
}

console.log('Party buff target checks passed');
