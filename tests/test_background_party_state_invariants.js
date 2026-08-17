const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');

const originalInit = BackgroundPartyState.init;
const originalExecute = Database.execute;

(async () => {
    const queries = [];
    BackgroundPartyState.init = () => Promise.resolve(true);
    Database.execute = (...args) => {
        queries.push(args);
        return Promise.resolve([]);
    };

    const saved = await BackgroundPartyState.createOrUpdate({
        partyId: 'bgp_stale_leader',
        leaderId: 999,
        memberIds: [101, 101, 102],
        status: 'active'
    });
    assert(saved, 'a valid party should still be persisted');
    assert.strictEqual(saved.leaderId, 101, 'the persisted leader must belong to the normalized member list');
    assert.deepStrictEqual(saved.memberIds, [101, 102], 'party membership must be deduplicated before persistence');
    assert.strictEqual(queries.length, 1, 'the invariant check should perform one persistence write after init is supplied');
    assert.strictEqual(queries[0][0][1][1], 101, 'the SQL leader id must use the normalized attached leader');
    assert.strictEqual(queries[0][0][1][2], '[101,102]', 'the SQL member list must use normalized ids');

    console.log('Background party membership invariant checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    BackgroundPartyState.init = originalInit;
    Database.execute = originalExecute;
});
