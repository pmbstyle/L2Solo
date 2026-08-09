const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const World = invoke('GameServer/World/World');

function actor(id, x = 0, y = 0) {
    return {
        fetchId: () => id,
        fetchIsOnline: () => true,
        fetchLocX: () => x,
        fetchLocY: () => y,
        state: { fetchDead: () => false }
    };
}

const originalUsers = World.user;
try {
    const leader = actor(1, 100);
    const caster = actor(2);
    const companion = actor(3, 900);
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
        fetchSemantic: () => ({ target: 'party', radius: 1000 })
    };
    const targets = new Attack().resolveSkillTargets(casterSession, caster, leader, partyBuff);
    assert.deepStrictEqual(targets.map((target) => target.fetchId()), [1, 2, 3], 'a party buff should fan out to every active companion-party member');

    const newMember = actor(4, 500);
    World.user.sessions.push({
        actor: newMember,
        partyCompanion: true,
        followPlayerSession: leaderSession
    });
    const updatedTargets = new Attack().resolveSkillTargets(casterSession, caster, leader, partyBuff);
    assert.deepStrictEqual(updatedTargets.map((target) => target.fetchId()), [1, 2, 3, 4], 'a party buff should include a member added after the party was formed');

    const distantMember = actor(5, 1001);
    World.user.sessions.push({
        actor: distantMember,
        partyCompanion: true,
        followPlayerSession: leaderSession
    });
    const rangedTargets = new Attack().resolveSkillTargets(casterSession, caster, leader, partyBuff);
    assert.deepStrictEqual(rangedTargets.map((target) => target.fetchId()), [1, 2, 3, 4], 'a C4 party aura must not affect party members beyond its native radius');
} finally {
    World.user = originalUsers;
}

console.log('Party buff target checks passed');
