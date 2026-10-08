process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const isolated = require('./helpers/isolatedSocialDatabase')('test_clan_planning_worker');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Database = invoke('Database');
Database.init();
const Runtime = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const { ClanPlanningCoordinator } = Runtime;
const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');

async function sharedModulesStayPure() {
    DataCache.init();
    const Persona = invoke('GameServer/Bot/AI/BotPersona');
    const Death = invoke('GameServer/Progression/DeathExperience');
    const state = { characterId: 990001, level: 20, exp: DataCache.experience[19],
        stats: { classId: 4 }, inventory: {}, phase: 'cold' };
    const context = { timestamp: 123456 };
    const personaRow = Persona.tableRow(Persona.generate(state));
    const coldDeath = Death.applyColdDeath(state, context);
    const restoration = Death.restoreCold(coldDeath.state, { restoreExpPercent: 30 });
    const worker = new Worker(`
        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const { parentPort, workerData } = require('node:worker_threads');
        const root = workerData.root;
        require(path.join(root, 'tests/helpers/databaseIsolation'));
        const isolated = require(path.join(root, 'tests/helpers/isolatedSocialDatabase'))('clan-pure-modules');
        try {
            require(path.join(root, 'src/Global'));
            isolated.assertConfigured(options.default);
            invoke('GameServer/DataCache').init();
            const originalInvoke = global.invoke;
            global.invoke = name => {
                if (name === 'Database') throw new Error('pure-worker forbidden dependency: Database');
                return originalInvoke(name);
            };
            const Persona = invoke('GameServer/Bot/AI/BotPersona');
            const Death = invoke('GameServer/Progression/DeathExperience');
            assert.equal(Persona.of(workerData.state), null);
            Persona.useRowSource(id => id === workerData.state.characterId ? workerData.personaRow : null);
            const persona = Persona.of(workerData.state);
            const coldDeath = Death.applyColdDeath(workerData.state, workerData.context);
            const restoration = Death.restoreCold(coldDeath.state, { restoreExpPercent: 30 });
            assert.equal(Object.keys(require.cache).some(file => /[\\/]src[\\/]Database\\.js$/.test(file)), false);
            assert.throws(() => Persona.init(), /pure-worker forbidden dependency: Database/);
            assert.throws(() => Death.load({ fetchId: () => workerData.state.characterId }),
                /pure-worker forbidden dependency: Database/);
            assert.equal(fs.existsSync(isolated.world) || fs.existsSync(isolated.history), false);
            parentPort.postMessage({ persona, coldDeath, restoration });
        } finally {
            fs.rmSync(isolated.directory, { recursive: true, force: true });
        }
    `, { eval: true, workerData: { root: path.resolve(__dirname, '..'), state, context, personaRow } });
    try {
        const result = await new Promise((resolve, reject) => {
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`pure module worker exited before its result: ${code}`)));
        });
        assert.deepEqual(result.persona, Persona.fromTableRow(personaRow), 'native persona rows must retain exact values');
        assert.deepEqual(result.coldDeath, coldDeath, 'native cold death valuation must stay exact without Database');
        assert.deepEqual(result.restoration, restoration, 'native cold restoration must stay exact without Database');
    } finally {
        await worker.terminate();
    }
    console.log('Shared persona/death modules retain native pure-worker values and reject SQL access');
}

async function parityAndIntegration() {
    DataCache.init();
    const context = await Runtime.context();
    const worker = new ClanPlanningCoordinator();
    try {
        for (const [classId, level] of [[4, 20], [15, 40], [55, 52], [21, 61]]) {
            const member = { characterId: 990001, classId, level, phase: 'cold',
                stats: { classId }, inventory: {}, adena: 100000, currentRegion: 'Giran' };
            const payload = { member, spots: [], warehouseRows: [], context, options: { maxExpectedKills: 1500 } };
            const expected = planForMember(member, [], [], payload.options);
            assert.deepEqual(await worker.plan(payload, DataCache), expected,
                `worker must preserve planning for class ${classId}, level ${level}`);
        }
        assert.equal(worker.metrics().completed, 4);
        // The offers are board records: a cold buyer never buys from a live
        // private store (E14).
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        const record = (id, ownerId, ownerName, town, line, account = 'test-seller') => AfkTrade.refreshRecord({
            id, ownerId, ownerName, ownerAccount: account, kind: 'sell_ad', storeType: 1, status: 'active', town,
            title: '', revision: 1, expiresAt: 0, locX: 0, locY: 0, locZ: 0, lines: [{ id, name: ownerName, ...line }]
        });
        try {
            record(990110, 990010, 'Test Seller', 'Giran', { selfId: 123, price: 10, count: 1 });
            record(990102, 990002, 'Own Seller', 'Giran', { selfId: 123, price: 1, count: 1 }, 'bot_own');
            const member = { characterId: 990002, level: 20, classId: 4, phase: 'cold', inventory: {}, adena: 100000,
                stats: { classId: 4, equipmentPlan: { status: 'active', strategy: 'market', rateModelVersion: 0,
                    target: { selfId: 123, slot: 7 } } } };
            const marketContext = await Runtime.context();
            const expected = planForMember(member);
            assert.equal(expected.market.sourceType, 'afk_player_store');
            assert.equal(expected.market.price, 10, 'a buyer must not plan to buy from its own cheaper listing');
            assert.deepEqual(await worker.plan({ member, spots: [], warehouseRows: [], options: {}, context: marketContext }, DataCache), expected);

            const swordLine = { selfId: 79, price: 78600000, count: 1 };
            AfkTrade._resetForTests();
            record(990111, 990011, 'Sword Seller', 'Heine', swordLine);
            const swordMember = { characterId: 990003, level: 55, classId: 21, phase: 'cold',
                adena: 20000000, inventory: {}, stats: { classId: 21, equipmentPlan: {
                    status: 'active', strategy: 'market', target: { selfId: 79, slot: 7 },
                    market: { town: 'Heine', price: 78600000, sourceType: 'afk_player_store' },
                    clanGoal: { clanId: 77, goalKey: 'clan-equipment:77:990003:79:7' }
                } } };
            const swordContext = await Runtime.context();
            const unfunded = planForMember(swordMember);
            assert.notEqual(unfunded.strategy === 'market' && unfunded.target?.selfId === 79, true,
                'an unaffordable listing must release a retained clan market goal');
            assert.deepEqual(await worker.plan({ member: swordMember, spots: [], warehouseRows: [],
                options: {}, context: swordContext }, DataCache), unfunded);

            // A repriced or sold-out record reaches the worker through the
            // board table before the next plan (ClanPlanningCoordinator.plan).
            swordLine.price = 10000000;
            record(990111, 990011, 'Sword Seller', 'Heine', swordLine);
            const affordableContext = swordContext;
            const repriced = planForMember(swordMember);
            assert.equal(repriced.strategy, 'market');
            assert.equal(repriced.target.selfId, 79, 'the funded listing must retain the requested sword');
            assert.equal(repriced.market.price, swordLine.price,
                'a funded listing must update the retained target price');
            assert.deepEqual(await worker.plan({ member: swordMember, spots: [], warehouseRows: [],
                options: {}, context: affordableContext }, DataCache), repriced);

            swordLine.count = 0;
            record(990111, 990011, 'Sword Seller', 'Heine', swordLine);
            const soldOutContext = swordContext;
            const soldOut = planForMember(swordMember);
            assert.notEqual(soldOut.strategy === 'market' && soldOut.target?.selfId === 79, true,
                'a sold-out listing must release the clan goal');
            assert.deepEqual(await worker.plan({ member: swordMember, spots: [], warehouseRows: [],
                options: {}, context: soldOutContext }, DataCache), soldOut);
        } finally {
            AfkTrade._resetForTests();
        }
        const oldRate = process.env.L2NODE_PROGRESSION_RATE;
        try {
            process.env.L2NODE_PROGRESSION_RATE = 'x10';
            const member = { characterId: 990002, level: 40, classId: 4, phase: 'cold', stats: { classId: 4 }, inventory: {} };
            const rateContext = await Runtime.context();
            const result = await worker.plan({ member, spots: [], warehouseRows: [], options: {},
                context: { ...rateContext, progressionRate: 'x10' } }, DataCache);
            assert.deepEqual(result, planForMember(member), 'resolved runtime rates must be refreshed in an already running worker');
        } finally {
            if (oldRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
            else process.env.L2NODE_PROGRESSION_RATE = oldRate;
        }
        await assert.rejects(worker.plan({ context: null }, DataCache));
        assert.equal(worker.metrics().failures, 1, 'worker calculation failures must be observable');
    } finally { await worker.shutdown(); }

    const clan = { id: 99, level: 3, leaderId: 990001, state: { mode: 'autonomous', updatedAt: 123, warehouseRevision: 1 },
        members: [{ characterId: 990001, level: 40, classId: 4, phase: 'cold', simulationOwner: 'legacy_main',
            inventory: {}, adena: 100000, stats: { classId: 4 } }] };
    clan.members.push({ ...structuredClone(clan.members[0]), characterId: 990003 });
    const originalWarehouse = Database.fetchClanWarehouseItems;
    const originalProjection = Goals.clanProjectionById;
    const originalPlanner = Gear.planFor;
    Database.fetchClanWarehouseItems = async () => [];
    let current = structuredClone(clan);
    Goals.clanProjectionById = async () => current;
    Runtime.start();
    try {
        Gear.planFor = () => { throw new Error('main-thread planner must never execute'); };
        const planning = await Equipment.planningForClan(clan, null, { spots: [], occupancy: {} });
        assert(planning.selection, 'enabled runtime must actually calculate a usable worker plan');
        assert(Runtime.metrics().completed > 0);
        await Equipment.validatePlanning(clan, planning);
        const beneficiaryId = planning.selection.member.characterId;
        const other = current.members.find((member) => member.characterId !== beneficiaryId);
        other.inventory[1868] = { selfId: 1868, amount: 1 };
        other.adena++;
        await Equipment.validatePlanning(clan, planning, planning.selection);
        current.members.find((member) => member.characterId === beneficiaryId).adena++;
        await assert.rejects(Equipment.validatePlanning(clan, planning, planning.selection), { code: 'clan_planning_deferred' },
            'beneficiary resource changes must invalidate a plan, unrelated loot must not starve it');
        for (const mutate of [
            (c) => { c.members[0].phase = 'hot'; },
            (c) => { c.members[0].partyId = 'new-party'; },
            (c) => { c.members[0].inventory = { 123: { selfId: 123, amount: 1, equipped: true } }; },
            (c) => { c.state.warehouseRevision++; },
            (c) => { c.state.mode = 'player_managed'; },
            (c) => { c.members = []; }
        ]) {
            current = structuredClone(clan);
            mutate(current);
            await assert.rejects(Equipment.validatePlanning(clan, planning), { code: 'clan_planning_deferred' });
            await assert.rejects(Equipment.resolveClan(clan, null, { planning }), { code: 'clan_planning_deferred' });
        }
        await Runtime.shutdown();
        assert.equal(Runtime.enabled(), true, 'shutdown/failure must not enable synchronous fallback');
        await assert.rejects(Equipment.planningForClan(clan, null, { spots: [], occupancy: {} }),
            { code: 'clan_planning_deferred' });
    } finally {
        Gear.planFor = originalPlanner;
        Database.fetchClanWarehouseItems = originalWarehouse;
        Goals.clanProjectionById = originalProjection;
        await Runtime.shutdown();
    }
}

async function workerLifecycle() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clan-planning-worker-'));
    const workerFile = path.join(directory, 'worker.cjs');
    fs.writeFileSync(workerFile, `const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => {
    if (m.payload?.crash) process.exit(1);
    if (m.payload?.hang) return;
    if (m.payload?.busyMs) {
        const end = performance.now() + m.payload.busyMs;
        while (performance.now() < end) {}
    }
    parentPort.postMessage({ id: m.id, result: m.type === 'plan' ? { plan: { ok: true }, durationMs: 1 } : true });
});`);
    const worker = new ClanPlanningCoordinator({ workerFile, timeoutMs: 1000, maxPending: 1, restartDelayMs: 0 });
    try {
        const timedOut = assert.rejects(worker.plan({ hang: true }, {}), /timed out/);
        await new Promise((resolve) => setImmediate(resolve));
        await assert.rejects(worker.plan({}, {}), /queue full/);
        await timedOut;
        assert.equal(worker.metrics().pending, 0);
        assert.equal(worker.metrics().timeouts, 1);
        await assert.rejects(worker.plan({ crash: true }, {}), /exited/);
        assert.deepEqual(await worker.plan({}, {}), { ok: true }, 'worker must restart after a crash');

        let ticks = 0;
        const timer = setInterval(() => ticks++, 5);
        try { await worker.plan({ busyMs: 200 }, {}); }
        finally { clearInterval(timer); }
        assert(ticks >= 5, 'CPU-bound worker calculation must allow the game thread to keep processing timers');

        const stopped = assert.rejects(worker.plan({ hang: true }, {}), /stopped/);
        await new Promise((resolve) => setImmediate(resolve));
        await worker.shutdown();
        await stopped;
        assert.equal(worker.metrics().pending, 0);
        await assert.rejects(worker.plan({}, {}), /stopped/);
    } finally {
        await worker.shutdown();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

(async () => {
    await sharedModulesStayPure();
    await parityAndIntegration();
    await workerLifecycle();
    console.log('Clan planning worker parity, stale snapshots, isolation and recovery checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { Database.close(); require('node:fs').rmSync(isolated.directory, { recursive: true, force: true }); });
