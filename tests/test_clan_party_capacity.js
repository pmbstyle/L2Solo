const assert = require('assert');
require('../src/Global');
const Capacity = require('../src/GameServer/Bot/Population/ClanPartyCapacity');
const objective = { status: 'open', priority: 'required', clanId: 77, clanGoalKey: 'clan:77:gear' };
const now = 1000000;
const ordinary = { partyId: 'ordinary', status: 'active', leaderId: 1, memberIds: [1, 2], updatedAt: 123, revision: 4, stats: {} };
const members = [1, 2].map(characterId => ({ characterId, phase: 'cold', activity: 'grouped',
    party: { partyId: 'ordinary' }, simulation: {}, stats: {} }));
(async () => {
    let writes = 0, accepted = 0, commits = [];
    const deps = {
        parties: { active: () => [ordinary], prepareCommit: party => ({ row: party }), acceptRow: () => accepted++ },
        life: { statesForParty: async () => members,
            preparePartyReview: (before, after) => ({ before, snapshot: after }), acceptPartyAssignments: () => accepted++ },
        database: { commitBackgroundPartyMembership: async args => { writes++; commits.push(args); return { ok: true }; } },
        metrics: { recordPartyDissolution() {} }
    };
    assert.strictEqual(await Capacity.reclaim({ ...objective, priority: 'preferred' }, deps, now), false);
    for (const protectedParty of [
        { ...ordinary, status: 'hot' },
        { ...ordinary, stats: { objective } },
        { ...ordinary, stats: { objective: { priority: 'required' } } },
        { ...ordinary, stats: { marketAbsences: { 3: { until: now + 1000 } } } }
    ]) assert.strictEqual(Capacity.elective(protectedParty, now), false);
    for (const override of [{ phase: 'hot' },
        { stats: { pvpEncounter: {} } }, { stats: { clanPartyObjective: objective } }]) {
        assert.strictEqual(Capacity.safeMembers(ordinary, [{ ...members[0], ...override }, members[1]]), false);
    }
    assert.strictEqual(await Capacity.reclaim(objective, deps, now), true);
    assert.strictEqual(writes, 1);
    assert.strictEqual(commits[0].review, true);
    assert.strictEqual(commits[0].preserveClanOperations, true);
    assert.strictEqual(commits[0].expectedPartyRevision, 4);
    assert.strictEqual(commits[0].party.status, 'dissolved');
    assert.deepStrictEqual(commits[0].party.memberIds, []);
    assert.strictEqual(commits[0].party.stats.partyBreakReason, 'clan_priority', 'the ended party names why it ended');
    assert(commits[0].members.every(x => x.snapshot.activity === 'hunting' && !x.snapshot.party.partyId));
    accepted = 0;
    deps.database.commitBackgroundPartyMembership = async () => ({ ok: false, reason: 'membership_conflict' });
    assert.strictEqual(await Capacity.reclaim(objective, deps, now), false);
    assert.strictEqual(accepted, 0, 'a stale eviction cannot change runtime party or member state');
    console.log('Clan capacity: optional parties yield atomically; hot, required, absent, busy and stale groups are protected');
})().catch(error => { console.error(error); process.exitCode = 1; });
