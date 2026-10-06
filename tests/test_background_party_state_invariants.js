const assert = require('assert');

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'party-store-invariants-'));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = path.join(directory, 'default.ini');
fs.writeFileSync(process.env.L2NODE_CONFIG_FILE, `[Database]\npath=${directory}/world.sqlite\nhistoryPath=${directory}/history.sqlite\n`);
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
        return Promise.resolve({ affectedRows: 1 });
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

    const dissolved = await BackgroundPartyState.createOrUpdate({
        partyId: 'bgp_empty_dissolved',
        status: 'dissolved',
        memberIds: []
    });
    assert(dissolved, 'an empty dissolved party must remain persistable for orphan cleanup');
    assert.strictEqual(dissolved.status, 'dissolved');
    assert.deepStrictEqual(dissolved.memberIds, []);
    assert.strictEqual(queries.length, 2, 'dissolved orphan cleanup should perform its persistence write');
    assert.strictEqual(queries[1][0][1][8], 'dissolved', 'the cleanup write must preserve dissolved status');

    const baseline = (BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total);
    for (let index = 0; index < 1000; index++) {
        const partyId = `bgp_write_cycle_${index}`;
        await BackgroundPartyState.createOrUpdate({ partyId, memberIds: [101, 102], status: 'active' });
        await BackgroundPartyState.setStatus(partyId, 'dissolved');
    }
    assert.equal((BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total), baseline);
    for (let index = 0; index < 1000; index++) {
        const partyId = `bgp_accept_cycle_${index}`;
        BackgroundPartyState.acceptRow({ partyId, memberIdsJson: '[101,102]', status: 'active' });
        BackgroundPartyState.acceptRow({ partyId, memberIdsJson: '[101,102]', status: 'dissolved' });
    }
    assert.equal((BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total), baseline);
    assert.equal(BackgroundPartyState.counts().total, baseline);
    const publications = [];
    const unsubscribe = BackgroundPartyState.subscribeChanges((party, previous) => publications.push({ party, previous }));
    const row = { partyId: 'bgp_stamp_probe', memberIdsJson: '[101,102]', status: 'active', updatedAt: 10 };
    const crypto = require('node:crypto'), oldHash = crypto.createHash;
    crypto.createHash = () => { throw new Error('party accept must not compute sha256'); };
    try {
        BackgroundPartyState.acceptRow(row);
        BackgroundPartyState.acceptRow(row);
        assert.equal(publications.length, 1, 'an identical accepted snapshot publishes once');
        BackgroundPartyState.acceptRow({ ...row, status: 'dissolved' });
        assert.equal(publications.length, 2);
        assert.equal(publications[1].party.status, 'dissolved');
        assert.equal(publications[1].previous.status, 'active');
        assert.equal(BackgroundPartyState.find(row.partyId), null);
    } finally { crypto.createHash = oldHash; unsubscribe(); }
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const oldForget = Economy.forgetGroup;
    const forgotten = [];
    Economy.forgetGroup = id => { forgotten.push(id); oldForget(id); };
    try {
        BackgroundPartyState.acceptRow({ ...row, partyId: 'bgp_hot_probe' });
        invoke('GameServer/DataCache').init();
        const { BoardIndex } = invoke('GameServer/AfkTrade/BoardIndex');
        const deps = { spots: [], board: new BoardIndex(), timestamp: 1e12 };
        const member = id => ({ characterId: id, phase: 'cold', activity: 'hunting', level: 30, adena: 100,
            inventory: {}, stats: { classId: 0 }, timing: {}, loc: { locX: 0, locY: 0 } });
        Economy.forGroup({ partyId: 'bgp_hot_probe', adena: 200 }, [member(101), member(102)], deps);
        assert.equal(Economy.size().groups, 1);
        await BackgroundPartyState.setStatus('bgp_hot_probe', 'hot');
        assert.deepEqual(forgotten, [], 'hot is live and retains its group context');
        assert.equal(Economy.size().groups, 1);
        BackgroundPartyState.acceptRow({ ...row, partyId: 'bgp_hot_probe', status: 'dissolved' });
        assert.deepEqual(forgotten, ['bgp_hot_probe'], 'the worker dissolve removes the group context once');
        assert.equal(Economy.size().groups, 0);
    } finally { Economy.forgetGroup = oldForget; }
    for (let index = 0; index < 71; index++) BackgroundPartyState.acceptRow({ ...row, partyId: `bgp_live_${index}` });
    assert.equal((BackgroundPartyState.size?.() ?? BackgroundPartyState.counts().total), 72);
    const started = performance.now();
    for (let index = 0; index < 10000; index++) assert.equal(BackgroundPartyState.admitted().length, 72);
    const perCallMs = (performance.now() - started) / 10000;
    assert.ok(perCallMs <= .05, `72-party admission took ${perCallMs} ms/call`);
    console.log(`Background party membership/store checks passed: admission ${perCallMs.toFixed(4)} ms/call`);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    BackgroundPartyState.init = originalInit;
    Database.execute = originalExecute;
    fs.rmSync(directory, { recursive: true, force: true });
});
