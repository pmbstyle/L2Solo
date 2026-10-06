const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const gameRoot = path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const clone = value => JSON.parse(JSON.stringify(value));
const failures = [];
let directory, serial = 0;

function facts(id) {
    const db = new DatabaseSync(options.default.Database.path, { readOnly: true });
    try {
        const result = {};
        for (const table of ['bot_life_state', 'characters', 'skills', 'items', 'warehouse_items', 'afk_trade_shops', 'afk_trade_lines']) {
            result[table] = clone(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
        }
        result.cache = clone(Life.cachedState(id));
        return result;
    } finally { db.close(); }
}

async function seed() {
    const account = `bot_publication_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const id = Number((await Database.createCharacter(account, {
        name: `Publication${serial}`, race: 0, classId: 0, sex: 0, face: 0, hair: 0,
        hairColor: 0, maxHp: 100, maxMp: 100, locX: 83000, locY: 148000, locZ: -3400
    })).insertId);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000, equipped: false, enchant: 0, slot: 0 });
    await Database.setItem(id, { selfId: 1869, name: 'Iron Ore', amount: 2, equipped: false, enchant: 0, slot: 0 });
    const time = Date.now();
    assert(await Life.upsertState({ characterId: id, accountName: account, name: `Publication${serial}`,
        phase: 'cold', activity: 'resting', level: 7, exp: Number(Data.experience[6]) + 1, sp: 120, adena: 1000,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        loc: { locX: 83000, locY: 148000, locZ: -3400 }, vitals: { hp: 85, maxHp: 100, mp: 70, maxMp: 100 },
        timing: { lastResolvedAt: time - 45000, nextResolveAt: time + 30000 },
        stats: { classId: 0, classProgressionLevel: 7, classProgressionClassId: 0, restUntil: time + 30000 }
    }, 'publication_seed'));
    return id;
}

async function run(mode) {
    const id = await seed(), state = Life.snapshot(id), originalCache = Life.cachedState(id), time = Date.now();
    const itemId = facts(id).items.find(row => row.characterId === id && row.selfId === 1869).id;
    const request = { kind: 'lifecycle', characterId: id, commandId: `publication:${serial}`,
        commandCheckpoint: Protocol.commandCheckpoint(state), state, context: {},
        precomputedResult: {
            patch: { activity: 'resting', vitals: { ...state.vitals, hp: 90 }, stats: { restUntil: time + 60000 } },
            events: [], materialize: { exp: 13, sp: 0, adena: 0,
                items: [{ selfId: 1869, name: 'Iron Ore', amount: 3 }] }, nextResolveAt: time + 60000
        }
    };
    const c = new ColdSimulationCoordinator(), sent = [], publications = [];
    const worker = label => ({ postMessage(message) { sent.push({ label, message: clone(message) }); }, terminate: async () => {} });
    c.ready = true; c.worker = worker('A'); c.workerEpoch = `publication:${serial}`;
    const originalWorker = c.worker, originalEpoch = c.workerEpoch;
    let admission, observer, observerCalls = 0, before, committed;
    c.population = { executeWorkerLifecycleCommand(...args) {
        admission = args[2]?.workerAdmission;
        return Population.executeWorkerLifecycleCommand(...args);
    } };
    c.contextIndex = () => ({}); c.contextFor = () => ({});
    const unsubscribe = Life.subscribeChanges((snapshot, reason) => {
        if (snapshot.characterId === id && reason === 'resolve') publications.push(snapshot);
    });
    const syncInventory = Database.syncInventorySummary;
    Database.syncInventorySummary = function (...args) {
        const originalPromise = syncInventory.apply(this, args);
        if (args[0] === id && args[2] === 'resolve') {
            // Observe the committed original transaction before its caller's
            // continuation. Return its exact Promise; add no gate or result.
            observer = originalPromise.then(result => {
                observerCalls++;
                assert.equal(result.characterId, id);
                assert(c.commandInflight.has(id), 'whole original command is still owned');
                assert.equal(admission?.check(), null, 'own durable output has not replaced the original cached checkpoint');
                assert.equal(Life.cachedState(id), originalCache);
                committed = facts(id);
                const physical = committed.characters.find(row => row.id === id);
                const life = committed.bot_life_state.find(row => row.characterId === id);
                const item = committed.items.find(row => row.characterId === id && row.selfId === 1869);
                assert.equal(life.hp, 90); assert.equal(physical.hp, 90);
                assert.equal(life.exp, state.exp + 13); assert.equal(physical.exp, state.exp + 13);
                assert.equal(item.amount, 5, 'real inventory transaction has already committed');
                assert.equal(item.id, itemId, 'original physical item identity survives');
                assert.equal(committed.cache.vitals.hp, 85); assert.equal(committed.cache.inventory['1869'].amount, 2);
                assert(Protocol.sameCommandCheckpoint(request.commandCheckpoint, committed.cache));
                assert.equal(publications.length, 0, 'publication has not happened at the committed boundary');
                if (mode === 'replace') {
                    c.worker = worker('B'); c.workerEpoch = `publication:replacement:${serial}`;
                    assert.deepEqual(admission.check(), { reason: 'stale_worker_source' });
                }
                before = facts(id);
            });
            // Join the original observer below; never hide its assertion error.
            observer.catch(() => {});
        }
        return originalPromise;
    };
    try {
        await c.onMessage(Protocol.envelope('command_request', originalEpoch, { requests: [request] }, `publication-msg:${serial}`), originalWorker, originalEpoch);
        await c.commandTail;
        assert(observer, 'real resolve inventory writer was called');
        await observer;
        assert.equal(observerCalls, 1);
        const after = facts(id), receipts = sent.filter(row => row.message.type === 'command_ack');
        const changed = Object.keys(before).filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
        console.log(JSON.stringify({ mode, observerCalls, itemId,
            committedPhysicalHp: committed.characters.find(row => row.id === id).hp,
            committedPhysicalItems: committed.items.find(row => row.id === itemId).amount,
            inputCacheHp: committed.cache.vitals.hp, inputCacheItems: committed.cache.inventory['1869'].amount,
            afterCacheHp: after.cache.vitals.hp, afterCacheItems: after.cache.inventory['1869'].amount,
            publications: publications.length, receipts: receipts.map(row => row.label), changed }));
        assert.equal(c.commandInflight.size, 0, 'whole command finishes cleanup');
        if (mode === 'current') {
            assert.equal(after.cache.vitals.hp, 90); assert.equal(after.cache.inventory['1869'].amount, 5);
            assert.equal(publications.length, 1); assert.equal(publications[0], Life.cachedState(id));
            assert.equal(receipts.length, 1); assert.equal(receipts[0].label, 'A');
            assert.equal(receipts[0].message.payload.results[0].ok, true);
            assert.deepEqual(receipts[0].message.payload.results[0].commandCheckpoint, request.commandCheckpoint);
        } else {
            assert.equal(receipts.length, 0, 'retired source cannot reply to its replacement');
            assert.deepEqual(after, before, 'retired source must preserve the committed partial before-image without publishing');
            assert.equal(publications.length, 0, 'retired source must not notify a new cached snapshot');
            assert.equal(Life.cachedState(id), originalCache);
        }
    } finally {
        await c.commandTail.catch(() => null);
        // Cleanup still joins observer failure if an earlier operation failed.
        await observer?.catch(() => null);
        Database.syncInventorySummary = syncInventory;
        unsubscribe();
    }
}

async function check(name, work) {
    try { await work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}

(async () => {
    directory = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'publication-native-'));
    options.default.Database.path = path.join(directory, 'world.sqlite');
    options.default.Database.historyPath = path.join(directory, 'history.sqlite');
    Database.init(); assert(Database.isReady()); Data.init(); await Life.init();
    console.log('source', gameRoot, 'controlled Worker; actual generated SQLite');
    await check('healthy publication after actual inventory commit', () => run('current'));
    await check('retired source after actual inventory commit before publication', () => run('replace'));
    if (failures.length) throw Error('resolve publication contracts failed: ' + failures.join(', '));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
