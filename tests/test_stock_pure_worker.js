'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, isMainThread, parentPort, workerData, threadId } = require('node:worker_threads');
require('./helpers/databaseIsolation');
const isolatedSocialDatabase = require('./helpers/isolatedSocialDatabase');

const root = path.resolve(__dirname, '..');
const clock = 1791353711029;
const forbiddenLoaded = () => Object.keys(require.cache).filter(filename =>
    /[\\/]src[\\/]Database\.js$|[\\/]World[\\/]World\.js$|[\\/]Bot[\\/]BotManager\.js$|[\\/]Network[\\/]|[\\/]Persistence[\\/]/.test(filename));

// Structured cloning preserves the numbers, but a tagged comparison also
// checks every native key/list order, prototype name and undefined/-0 value.
function exact(value) {
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (value instanceof Map) return ['Map', [...value].map(([key, row]) => [exact(key), exact(row)])];
    if (value instanceof Set) return ['Set', [...value].map(exact)];
    if (Array.isArray(value)) return ['Array', value.map(exact), Object.keys(value)];
    return [Object.getPrototypeOf(value)?.constructor?.name || null,
        Object.keys(value).map(key => [key, exact(value[key])])];
}

const digest = value => crypto.createHash('sha256').update(JSON.stringify(exact(value))).digest('hex');

function actorFor(state, Shot, mutations = { count: 0 }, current = true) {
    const weapon = Object.values(state.inventory).find(row => Number(row.slot) === 7 && row.equipped);
    const stock = Shot.planForState(state);
    const held = { adena: state.adena, stockAmount: current ? 100 : 0, inserted: [] };
    const item = { fetchId: () => 990700, fetchAmount: () => held.stockAmount,
        setAmount(amount) { mutations.count++; held.stockAmount = amount; } };
    const wallet = { fetchId: () => 990701, fetchAmount: () => held.adena,
        setAmount(amount) { mutations.count++; held.adena = amount; } };
    return {
        snapshot: () => structuredClone(held),
        actor: {
            fetchId: () => state.characterId,
            fetchClassId: () => state.stats.classId,
            backpack: {
                fetchEquippedWeapon: () => weapon ? { fetchSelfId: () => weapon.selfId } : null,
                fetchItemFromSelfId: id => Number(id) === 57 ? wallet
                    : current && Number(id) === stock.selfId ? item : null,
                insertItem(...args) { mutations.count++; held.inserted.push(args); }
            }
        }
    };
}

function pure(Shot, Restock, states, lines) {
    const rows = states.map((state, index) => {
        const { actor } = actorFor(state, Shot);
        const own = Shot.planForState(state);
        return {
            state: Shot.planForState(state),
            rows: Shot.planForRows(Object.values(state.inventory), state.stats.classId),
            actor: Shot.planForActor(actor),
            kinds: ['soulshot', 'spiritshot', 'blessedSpiritshot'].map(kind => ({
                actor: Shot.planForActorKind(kind, actor), rank: Shot.planForKind(kind, own.rank)
            })),
            chosen: Shot.planFor({ classId: state.stats.classId, rank: own.rank }),
            amount: Shot.shotAmount(actor),
            compatible: Shot.isCompatibleWithActor(own.kind, own.selfId, actor),
            kind: Shot.kindForSelfId(own.selfId),
            description: Shot.describe(own),
            potion: Restock.coldPatch(state, lines[index])
        };
    });
    return {
        rows,
        authoredShotIds: Shot.SHOT_IDS.map(id => ({ id, kind: Shot.kindForSelfId(id) })),
        actions: [[true, 0], [false, 0], [false, 1], [false, 2]]
            .map(([magic, boost]) => Shot.actionShotKind(magic, boost))
    };
}

function nativeInputs(Data, Potions) {
    const ranks = ['none', 'd', 'c', 'b', 'a', 's'];
    const weapons = ranks.map(rank => Data.items.filter(item => item.template?.kind?.startsWith('Weapon.')
        && Number(item.etc?.slot) === 7 && (item.etc.rank || 'none') === rank)
        .sort((a, b) => a.selfId - b.selfId)[0]);
    assert(weapons.every(Boolean), 'all grades must use actual authored weapon templates');
    assert.deepEqual(weapons.map(weapon => weapon.selfId), [1, 69, 72, 79, 80, 82]);
    const states = [{ characterId: 990100, phase: 'cold', level: 1, exp: Data.experience[0],
        adena: 100000, stats: { classId: 0 }, inventory: {} }, ...weapons.map((weapon, index) => ({
        characterId: 990101 + index, phase: 'cold', level: [20, 40, 40, 52, 61, 76][index],
        exp: Data.experience[[19, 39, 39, 51, 60, 75][index]], adena: 100000,
        stats: { classId: index % 2 ? 10 : 4 }, inventory: {
            [weapon.selfId]: { selfId: weapon.selfId, name: weapon.template.name,
                equipped: true, slot: 7, amount: 1 }
        }
    }))];
    const lines = states.map(state => {
        const potion = Potions.purchasePotionFor(state);
        const item = Data.items.find(item => item.selfId === potion.selfId);
        assert.equal(potion.price, item.template.price);
        const stock = Potions.restockPlan(state);
        assert(stock.amount >= 0 && Number.isInteger(stock.amount));
        assert.equal(stock.cost, stock.amount * stock.unitPrice);
        return { selfId: potion.selfId, name: potion.name, currentAmount: stock.currentAmount,
            amount: stock.amount, unitPrice: stock.unitPrice, cost: stock.cost, adena: stock.adena };
    });
    const positiveLineIndex = states.findIndex(state => state.level === 52);
    assert.deepEqual({ selfId: lines[positiveLineIndex].selfId, amount: lines[positiveLineIndex].amount,
        unitPrice: lines[positiveLineIndex].unitPrice, cost: lines[positiveLineIndex].cost },
    { selfId: 1061, amount: 7, unitPrice: 330, cost: 2310 },
    'the real SQL-refusal control uses the native funded level-52 potion line');
    return { states, lines, positiveLineIndex };
}

async function guardedWorker(Data, sqlOpens, isolated) {
    const originalInvoke = global.invoke;
    const denied = [];
    try {
        // The native planning-worker boundary permits authored catalogue
        // helpers and rejects live runtime/persistence, without a whitelist.
        global.invoke = name => {
            if (name === 'Database' || name === 'Server'
                || /GameServer\/(World\/World$|Bot\/BotManager|Network|Persistence)/.test(name)) {
                denied.push(name);
                throw new Error(`pure-worker forbidden dependency: ${name}`);
            }
            return originalInvoke(name);
        };
        assert.deepEqual(forbiddenLoaded(), []);
        const Shot = invoke('GameServer/Inventory/ShotStock');
        const Restock = invoke('GameServer/Inventory/ConsumableRestock');
        const inputHash = digest({ states: workerData.states, lines: workerData.lines });
        const output = pure(Shot, Restock, workerData.states, workerData.lines);
        assert.equal(digest({ states: workerData.states, lines: workerData.lines }), inputHash);
        assert.deepEqual(denied, [], 'pure imports/calculations must never request persistence');
        const mutations = { count: 0 };
        const state = workerData.states[workerData.positiveLineIndex];
        const existing = actorFor(state, Shot, mutations, true);
        const missing = actorFor(state, Shot, mutations, false);
        const buyer = actorFor(state, Shot, mutations);
        const calls = [
            ['ensureCharacterStock', () => Shot.ensureCharacterStock(state.characterId)],
            ['ensureActorStock existing item', () => Shot.ensureActorStock(existing.actor)],
            ['ensureActorStock absent item', () => Shot.ensureActorStock(missing.actor)],
            ['buyForActor native potion line', () => Restock.buyForActor(buyer.actor,
                workerData.lines[workerData.positiveLineIndex])]
        ];
        const actorSnapshots = [existing, missing, buyer].map(row => row.snapshot());
        for (const [name, call] of calls) {
            await assert.rejects(async () => call(), /pure-worker forbidden dependency: Database/, name);
            assert.equal(mutations.count, 0, `${name}: SQL refusal must precede actor mutations`);
            assert.deepEqual([existing, missing, buyer].map(row => row.snapshot()), actorSnapshots);
            assert.deepEqual(forbiddenLoaded(), [], `${name}: Database must remain unloaded`);
            assert.equal(sqlOpens(), 0, `${name}: no native SQLite constructor may run`);
        }
        assert.deepEqual(denied, ['Database', 'Database', 'Database', 'Database']);
        assert.equal(fs.existsSync(isolated.world) || fs.existsSync(isolated.history), false);
        return { exact: exact(output), inputHash, catalogHash: catalogHash(Data),
            sqlRefusals: calls.map(([name]) => name), actorMutations: mutations.count,
            sqlOpens: sqlOpens(), forbiddenLoaded: forbiddenLoaded(), threadId };
    } finally {
        global.invoke = originalInvoke;
        assert.equal(global.invoke, originalInvoke);
    }
}

function catalogHash(Data) {
    return digest({ general: options.default.General, progression: options.default.Progression,
        items: Data.items, experience: Data.experience, classTemplates: Data.classTemplates });
}

async function main(Data, sqlOpens, isolated) {
    const Shot = invoke('GameServer/Inventory/ShotStock');
    const Restock = invoke('GameServer/Inventory/ConsumableRestock');
    const inputs = nativeInputs(Data, invoke('GameServer/Bot/AI/HealingPotionStock'));
    const inputHash = digest({ states: inputs.states, lines: inputs.lines });
    const expected = pure(Shot, Restock, inputs.states, inputs.lines);
    assert.equal(digest({ states: inputs.states, lines: inputs.lines }), inputHash);
    const worker = new Worker(__filename, { workerData: inputs });
    let result;
    try {
        result = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`pure stock worker exited without a result: ${code}`)));
        });
    } finally {
        await worker.terminate();
    }
    assert.equal(result.catalogHash, catalogHash(Data), 'worker must load the same authored native/default catalog');
    assert.deepEqual(result.exact, exact(expected), 'all pure values/types/prototypes/key and list order must match main');
    assert.equal(result.inputHash, inputHash);
    assert.equal(result.sqlRefusals.length, 4);
    assert.equal(result.actorMutations, 0);
    assert.equal(result.sqlOpens, 0);
    assert.deepEqual(result.forbiddenLoaded, []);
    assert.equal(result.restoredDateClock, true);
    assert.equal(result.restoredSqlConstructor, true);
    assert.equal(sqlOpens(), 0);
    assert.equal(fs.existsSync(isolated.world) || fs.existsSync(isolated.history), false);
    console.log('Pure stock worker:', JSON.stringify({ states: inputs.states.length,
        exactMainWorker: true, outputHash: digest(expected), inputHash,
        catalogHash: result.catalogHash, sqlRefusals: result.sqlRefusals,
        actorMutations: result.actorMutations, nativeSqlOpens: result.sqlOpens,
        nativeThreadId: result.threadId, positiveNativeLevel: 52, positiveNativeCost: 27390 }));
}

async function run() {
    const savedEnv = Object.fromEntries(['L2NODE_CONFIG_FILE', 'L2NODE_SHARED_CONFIG_FILE', 'L2NODE_PROGRESSION_RATE']
        .map(name => [name, process.env[name]]));
    const originalNow = Date.now;
    const sqlite = require('node:sqlite');
    const isolatedConstructor = sqlite.DatabaseSync;
    let opens = 0;
    let result;
    const isolated = isolatedSocialDatabase('stock-pure-worker', root);
    try {
        delete process.env.L2NODE_PROGRESSION_RATE;
        Date.now = () => clock;
        // Count actual constructor attempts without replacing SQL results or
        // bypassing the existing databaseIsolation constructor protection.
        sqlite.DatabaseSync = class extends isolatedConstructor {
            constructor(...args) { opens++; super(...args); }
        };
        require('../src/Global');
        isolated.assertConfigured(options.default);
        const Data = invoke('GameServer/DataCache');
        Data.init();
        if (isMainThread) await main(Data, () => opens, isolated);
        else result = await guardedWorker(Data, () => opens, isolated);
    } finally {
        Date.now = originalNow;
        sqlite.DatabaseSync = isolatedConstructor;
        fs.rmSync(isolated.directory, { recursive: true, force: true });
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        assert.equal(Date.now, originalNow);
        assert.equal(sqlite.DatabaseSync, isolatedConstructor);
    }
    return result && { ...result, restoredDateClock: Date.now === originalNow,
        restoredSqlConstructor: sqlite.DatabaseSync === isolatedConstructor };
}

run().then(result => { if (!isMainThread) parentPort.postMessage(result); }).catch(error => {
    if (isMainThread) { console.error(error.stack); process.exitCode = 1; }
    else throw error;
});
