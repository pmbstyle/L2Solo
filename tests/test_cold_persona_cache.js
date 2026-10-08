'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
require('./helpers/databaseIsolation');

async function main() {
    const isolated = require('./helpers/isolatedSocialDatabase')('cold-persona-cache');
    let worker;
    try {
        require('../src/Global');
        isolated.assertConfigured(options.default);
        const Persona = invoke('GameServer/Bot/AI/BotPersona'), Database = invoke('Database');
        const rows = Array.from({ length: 400 }, (_, index) => Persona.tableRow(
            Persona.generate({ characterId: 5000 + index, classId: index % 58, stats: { generatedIndex: index } })));
        const stored = rows.map(row => {
            const persona = Persona.fromTableRow(row);
            return { ...persona, textCard: 'the stored card',
                traitsJson: JSON.stringify(persona.traits), inclinationsJson: JSON.stringify(persona.inclinations) };
        });
        const execute = Database.execute;
        Database.execute = () => Promise.resolve(stored);
        try { assert.equal(await Persona.loadAll(), 400); } finally { Database.execute = execute; }
        assert.equal(Persona.size(), 400, 'main keeps every stored persona for population shares and publication');
        assert.equal(Persona.forget(rows[0][0]), false, 'worker handoff must not delete the main row');
        assert.equal(Persona.of(rows[0][0]).textCard, 'the stored card');
        assert.equal(Object.values(Persona.typeCounts()).reduce((sum, count) => sum + count, 0), 400);
        worker = new Worker(__filename, { workerData: rows });
        const result = await new Promise((resolve, reject) => {
            worker.once('message', resolve); worker.once('error', reject);
            worker.once('exit', code => { if (code) reject(Error(`persona worker exited ${code}`)); });
        });
        assert.deepEqual(result, { rows: 400, bound: 64, released: 10, retained: 0 });
        console.log('test_cold_persona_cache: ok', result);
        Persona.reset();
    } finally {
        await worker?.terminate();
        fs.rmSync(isolated.directory, { recursive: true, force: true });
    }
}

function inWorker() {
    require('../src/Global');
    const Persona = invoke('GameServer/Bot/AI/BotPersona');
    const rows = new Map(workerData.map(row => [row[0], row]));
    const Database = invoke('Database');
    Database.execute = () => { throw Error('a derived worker persona never accesses the database'); };
    Persona.useRowSource(id => rows.get(id));
    const first = Persona.of(workerData[0][0]);
    for (const row of workerData.slice(1, 64)) Persona.of(row[0]);
    assert.equal(Persona.of(first.characterId), first, 'a hit refreshes the least-recently-used order');
    Persona.of(workerData[64][0]);
    assert.equal(Persona.snapshot(workerData[1][0]), null, 'the oldest untouched row is evicted');
    assert.equal(Persona.snapshot(first.characterId), first);
    for (const row of workerData) assert.deepEqual(Persona.of(row[0]), Persona.fromTableRow(row));
    assert.equal(Persona.size(), 64);
    assert.deepEqual(Persona.of(first.characterId), first, 'eviction restores exact traits, talents and voice from the same row');
    assert.notEqual(Persona.of(first.characterId), first, 'the evicted derived object was released');
    const attached = Persona.generate({ characterId: first.characterId, classId: 57 });
    assert.equal(Persona.of({ characterId: first.characterId, persona: attached }), attached);
    assert.equal(Persona.of(99999), null); assert.equal(Persona.size(), 64);

    Persona.reset(); Persona.useRowSource(id => rows.get(id));
    const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
    const kernel = new ColdSimulationKernel({ now: () => 1e12, resolveSolo: () => { throw Error('release test must not resolve'); } });
    for (const [index, row] of workerData.slice(0, 10).entries()) {
        const state = { characterId: row[0], phase: 'cold', activity: 'hunting', level: 20,
            stats: { classId: 1 }, inventory: {}, timing: { nextResolveAt: 1e12 + 60000 },
            loc: { locX: 1, locY: 2, locZ: 3 }, party: index >= 8 ? { partyId: 'persona-release' } : {} };
        kernel.upsert({ state }); Persona.of(state);
    }
    assert.equal(Persona.size(), 10);
    for (const [index, row] of workerData.slice(0, 10).entries()) {
        if (index % 2) kernel.fence(row[0]); else kernel.remove(row[0]);
        assert.equal(Persona.snapshot(row[0]), null, 'native release and hot handoff delete the derived persona in the same call');
    }
    assert.equal(Persona.size(), 0);
    assert.equal(kernel.states.size, 0);
    parentPort.postMessage({ rows: workerData.length, bound: 64, released: 10, retained: Persona.size() });
}

if (isMainThread) main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
else { inWorker(); }
