'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('competition-owner-storage');
require('../src/Global');
isolated.assertConfigured(options.default);
const Database = invoke('Database');
assert.equal(Database.isReady(), false);
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(isolated.world);
const Rows = require('../src/GameServer/Social/InteractionMemoryRows');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const { ColdCompetitionMonitor } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const Candidates = require('../src/GameServer/Bot/Population/ColdCompetitionCandidates');
const { StableOwnerSet } = require('../src/GameServer/Bot/Population/StableOwnerSet');
const base = 1800000000000;

db.exec('CREATE TABLE characters(id INTEGER PRIMARY KEY); CREATE TABLE bot_interaction_memory(ownerId INTEGER, snapshotJson TEXT);');
Rows.install(db);
const sql = {
    one: (query, values) => db.prepare(query).get(...values),
    all: (query, values) => db.prepare(query).all(...values),
    write: (query, values) => db.prepare(query).run(...values),
    now: () => base
};
const ids = [Number.MAX_SAFE_INTEGER, 2000007, Number.MAX_SAFE_INTEGER - 1,
    ...Array.from({ length: 697 }, (_, index) => 2000100 + index)];
const relation = targetId => ({ kind: 'character', targetId, at: base,
    affinity: 0, trust: 0, hostility: 0, fear: 0, familiarity: 0, reasons: [] });
function setup(reference) {
    const kernel = new ColdSimulationKernel({ now: () => base,
        resolveSolo: () => { throw Error('unexpected resolve'); }, emit() {} });
    const monitor = new ColdCompetitionMonitor({ capacityForSpot: spot => spot.capacity,
        personaFor: () => ({ traits: {} }) });
    const candidates = new Candidates({ records: id => kernel.states.locationIndex.getSource(id, 'state'),
        packets: id => kernel.states.get(id), memory: kernel.interactionMemory, monitor, deadlines: kernel });
    // The original native Set consumer is the reference for order/generations.
    if (reference) candidates.relationOwners = new Map();
    kernel.decisionEvents = candidates;
    return { kernel, candidates };
}
const before = setup(true), after = setup(false);
const index = candidates => [...candidates.relationOwners].map(([target, owners]) => [target, [...owners]]);
function compare() {
    assert.deepEqual(index(after.candidates), index(before.candidates));
    assert.deepEqual([...after.candidates.pendingActors], [...before.candidates.pendingActors]);
    assert.deepEqual([...after.candidates.pendingSpots], [...before.candidates.pendingSpots]);
}
function packet(id, snapshot) {
    return { state: { characterId: id, name: `Owner${id}`, phase: 'cold', activity: 'resting',
        level: 40, loc: { locX: 0, locY: 0, locZ: 0 }, vitals: { hp: 100 }, stats: {},
        timing: { nextResolveAt: base + 3600000 }, simulation: { revision: 1 } },
    context: { interactionMemory: snapshot } };
}
try {
    for (const id of ids) {
        db.prepare('INSERT INTO characters(id) VALUES (?)').run(id);
        const snapshot = { ...Policy.empty(id), revision: 1, relations: [relation(77), relation(88)] };
        Rows.save(sql, Policy.empty(id), snapshot);
        const loaded = Rows.load(sql, id);
        for (const fixture of [before, after]) fixture.kernel.upsert(packet(id, loaded));
    }
    assert.deepEqual([...after.candidates.relationOwners.get(77)], ids, 'MAX_SAFE ids retain native insertion order');
    compare();
    for (const fixture of [before, after]) {
        fixture.kernel.states.values = fixture.kernel.states.entries = () => { throw Error('population scan'); };
    }
    // Accepted persisted revisions and repeated same-version pages detach then
    // append in exactly the original order, including pending queue generations.
    for (let round = 0; round < 3; round++) for (const id of ids) {
        const snapshot = Rows.load(sql, id);
        const event = { key: `owner-storage:${round}:${id}`, sourceId: id, targetId: 77,
            type: 'party_formed', at: base };
        const result = Policy.apply(snapshot, event, base);
        assert.equal(result.status, 'applied');
        Rows.save(sql, snapshot, result.snapshot);
        const loaded = Rows.load(sql, id);
        for (const fixture of [before, after]) {
            fixture.kernel.upsert(packet(id, loaded));
            fixture.kernel.upsert(packet(id, loaded));
        }
        compare();
    }
    for (const id of ids) {
        for (const fixture of [before, after]) fixture.kernel.remove(id);
        compare();
        const snapshot = Rows.load(sql, id);
        for (const fixture of [before, after]) fixture.kernel.upsert(packet(id, snapshot));
        compare();
    }
    for (const id of ids) for (const fixture of [before, after]) fixture.kernel.remove(id);
    compare();
    assert.equal(after.candidates.relationOwners.size, 0, 'native release drops every reverse bucket');
    assert.deepEqual(after.kernel.interactionMemory.size(), { snapshots: 0, views: 0, fastLayers: 0, loading: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM interaction_owners').get().count, 700);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM interaction_relations').get().count, 1400);
    assert.equal(Database.isReady(), false);

    for (const values of [[0, -0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 1, 2, 1],
        [1, NaN, Infinity, '1', {}, null, undefined]]) {
        const actual = new StableOwnerSet(), expected = new Set();
        for (const value of values) {
            assert.equal(actual.add(value), actual); expected.add(value);
            assert.equal(actual.has(value), expected.has(value));
            assert.deepEqual([...actual], [...expected]);
        }
        for (const value of values) {
            assert.equal(actual.delete(value), expected.delete(value));
            assert.deepEqual([...actual], [...expected]);
            actual.add(value); expected.add(value);
            assert.deepEqual([...actual], [...expected]);
        }
    }
    console.log('PASS native SQLite 700 owners/MAX_SAFE ids: persisted revisions, exact inverse/queue order, reinsert/release, no population scans');
} finally { db.close(); fs.rmSync(isolated.directory, { recursive: true, force: true }); }
