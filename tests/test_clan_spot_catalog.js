'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.

const assert = require('node:assert/strict'), fs = require('node:fs'), v8 = require('node:v8');
require('./helpers/databaseIsolation');
const isolated = require('./helpers/isolatedSocialDatabase')('clan-spot-catalog');
require('../src/Global');
isolated.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache');
Data.init();
const Database = invoke('Database');
Database.init();
const { SpotCatalogWriter, SpotCatalogReader, MAX_PAGE_ROWS, MAX_CATALOG_ROWS } = require('../src/GameServer/Clan/ClanSpotCatalog');
const { ClanPlanningCoordinator, context } = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');
const nativeRows = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').all();
assert(nativeRows.length > MAX_PAGE_ROWS, 'authored native raid catalog must cover multiple bounded pages');
assert.equal(invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor, require('../src/GameServer/Bot/Economy/CraftEligibility').craftLevelFor, 'main shop re-exports the exact shared native function');
assert.equal(Data.experience.length, 80, 'the full authored upper experience boundary must reach the worker');
const workers = [];

function keys(value) {
    if (!value || typeof value !== 'object') return null;
    if (value instanceof Map) return ['Map', [...value].map(([key, row]) => [keys(key), keys(row)])];
    if (value instanceof Set) return ['Set', [...value].map(keys)];
    return Object.keys(value).map(key => [key, keys(value[key])]);
}
function exact(actual, expected, message) {
    assert.deepEqual(actual, expected, message);
    assert.deepEqual(keys(actual), keys(expected), 'complete output property order must remain exact');
}

function codecBoundaries() {
    const writer = new SpotCatalogWriter(1, nativeRows), reader = new SpotCatalogReader();
    const unknown = structuredClone(nativeRows[0]);
    unknown.raidRosterSize = 7;
    unknown.raidEstimate = { metadata: { zero: -0, optional: undefined }, value: Math.PI };
    const repeated = [nativeRows[1], unknown, nativeRows[0], nativeRows[1]];
    const payload = { member: { characterId: 991010 }, spots: repeated,
        warehouseRows: [], options: { occupancy: {}, allowRaidSources: true }, context: { actual: true }, deadlineAt: 99 };
    const packed = writer.pack(payload);
    assert.deepEqual(packed.spotOrder.map(row => row[0]), [1, 0, 1, 1]);
    assert(!Object.hasOwn(packed, 'spots'), 'static rows cannot recur in a member request');
    assert.equal(packed.spotOrder[1][1], unknown, 'same-ID decorated rows retain complete values');
    assert.throws(() => reader.restore(packed), /stale clan spot generation/);
    const pages = [...writer.pages()];
    assert(pages.every(page => page.rows.length <= MAX_PAGE_ROWS));
    reader.apply(pages[0]);
    assert.throws(() => reader.restore(packed), /stale clan spot generation/);
    for (const page of pages.slice(1)) reader.apply(page);
    assert.deepEqual(reader.restore(packed), payload, 'ordered subsets, duplicates, metadata and dynamic raids remain complete');
    exact(reader.restore(packed).spots, repeated, 'complete native row keys keep their ordering');
    assert.throws(() => reader.restore({ ...packed, spotCatalogGeneration: 2 }), /stale clan spot generation/);
    assert.throws(() => reader.restore({ ...packed, spotOrder: [[1, nativeRows.length]] }), /missing clan spot reference/);
    assert.throws(() => reader.apply(pages[0]), /stale clan spot page/);
    const nextRows = [...nativeRows].reverse(), next = new SpotCatalogWriter(2, nextRows);
    const nextPages = [...next.pages()];
    reader.apply(nextPages[0]);
    assert.deepEqual(reader.restore(packed), payload, 'an incomplete replacement cannot replace the active catalog');
    assert.throws(() => reader.restore(next.pack(payload)), /stale clan spot generation/);
    assert.throws(() => reader.apply({ ...nextPages[1], offset: nextPages[1].offset + 1 }), /invalid|incomplete clan spot/);
    for (const page of nextPages.slice(1)) reader.apply(page);
    assert.deepEqual(reader.restore(next.pack(payload)), payload);
    assert.throws(() => reader.restore(packed), /stale clan spot generation/);
    assert.throws(() => reader.apply({ generation: 3, offset: 0, total: MAX_CATALOG_ROWS + 1, rows: [], done: false }), /invalid clan spot page/);
    const empty = new SpotCatalogWriter(3, []);
    for (const page of empty.pages()) reader.apply(page);
    exact(reader.restore(empty.pack({ spots: [], options: {} })), { options: {}, spots: [] });
}

async function genuineWorker() {
    const worker = new ClanPlanningCoordinator({ restartDelayMs: 0 }); workers.push(worker);
    const catalogs = { ...Data, spots: nativeRows };
    let firstThread;
    const original = { maxLevel: options.default.General.maxLevel, contentCap: options.default.Progression?.contentCap,
        rate: process.env.L2NODE_PROGRESSION_RATE };
    try {
        for (const [maxLevel, contentCap, rate] of [[78, 78, 'x1'], [76, 72, 'x10']]) {
            options.default.General.maxLevel = maxLevel;
            options.default.Progression = { ...options.default.Progression, contentCap };
            process.env.L2NODE_PROGRESSION_RATE = rate;
            const captured = await context();
            assert.equal(captured.general.maxLevel, maxLevel);
            assert.equal(captured.progression.contentCap, contentCap);
            for (const [classId, level] of [[4, 20], [21, 61], [55, 76]]) {
                const member = { characterId: 991000 + classId, classId, level, exp: Data.experience[level - 1], phase: 'cold',
                    stats: { classId }, inventory: {}, adena: 100000, currentRegion: 'Giran' };
                const assessment = invoke('GameServer/Clan/ClanRaidPolicy').assessment({ id: 991, members: [member] }, nativeRows[0]);
                const dynamic = { ...nativeRows[0], raidRosterSize: assessment.eligible.length, raidEstimate: assessment.raidEstimate };
                const spots = [nativeRows[2], dynamic, ...nativeRows.slice(3).reverse(), nativeRows[2]];
                const payload = { member, spots, warehouseRows: [], context: captured,
                    options: { maxExpectedKills: 1500, allowRaidSources: true, capacityUnits: 7, clanShare: 100000 } };
                const expected = planForMember(member, spots, [], payload.options);
                exact(await worker.plan(payload, catalogs), expected, 'genuine worker retains the complete native plan');
                firstThread ||= worker.worker.threadId;
            }
        }
        const member = { characterId: 991015, level: 40, phase: 'cold', stats: { classId: 15 }, inventory: {}, adena: 200000 };
        const payload = { member, spots: nativeRows.slice(0, 5), warehouseRows: [], options: {}, context: await context() };
        const generation = worker.spotWriter.generation;
        exact(await worker.plan(payload, catalogs), planForMember(member, payload.spots));
        assert.equal(worker.spotWriter.generation, generation, 'unchanged catalog is published only once');
        const replaced = nativeRows.map(row => ({ ...row, center: { ...row.center } })).reverse();
        const refreshed = { ...payload, spots: replaced.slice(0, 8) };
        exact(await worker.plan(refreshed, { ...Data, spots: replaced }), planForMember(member, refreshed.spots));
        assert.equal(worker.spotWriter.generation, generation + 1, 'replacement identity gets a fresh generation');
        const stale = new SpotCatalogWriter(generation, nativeRows).pack(payload);
        await assert.rejects(worker.send('plan', { payload: stale }), /stale clan spot generation/);
        const missing = { ...worker.spotWriter.pack(refreshed), spotOrder: [[1, replaced.length]] };
        await assert.rejects(worker.send('plan', { payload: missing }), /missing clan spot reference/);
        const partial = new SpotCatalogWriter(worker.spotWriter.generation + 1, nativeRows);
        await worker.send('spot_catalog', { page: [...partial.pages()][0] });
        await assert.rejects(worker.send('plan', { payload: partial.pack(payload) }), /stale clan spot generation/);
        exact(await worker.plan(refreshed, { ...Data, spots: replaced }), planForMember(member, refreshed.spots),
            'partial refresh retains the active generation for valid requests');
        await worker.worker.terminate();
        exact(await worker.plan(payload, catalogs), planForMember(member, payload.spots), 'restart rebuilds catalogs before planning');
        assert.notEqual(worker.worker.threadId, firstThread);
        assert.equal(worker.metrics().pending, 0);
        assert(worker.metrics().restarts >= 2);
    } finally {
        options.default.General.maxLevel = original.maxLevel;
        options.default.Progression = { ...options.default.Progression, contentCap: original.contentCap };
        if (original.rate === undefined) delete process.env.L2NODE_PROGRESSION_RATE; else process.env.L2NODE_PROGRESSION_RATE = original.rate;
    }
}

(async () => {
    codecBoundaries();
    await genuineWorker();
    console.log('Native clan spot catalog whole-plan parity, ordered fallbacks, atomic pages, cap refresh and worker restart checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Promise.all(workers.map(worker => worker.shutdown()));
    Database.close();
    fs.rmSync(isolated.directory, { recursive: true, force: true });
});
