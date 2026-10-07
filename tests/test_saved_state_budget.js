'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('l2-saved-state-budget');
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Bot/Goals/GoalState');
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const Gear = invoke('GameServer/Bot/AI/GearPlanSelection');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Errands = require('../src/GameServer/Bot/Population/CombinedErrandPolicy');
const id = 719112, buyerId = 719113;

async function workerPacketSurvivesMainPreparation(source, { huntSpot = null, heldPacket = null } = {}) {
    const { Worker } = require('node:worker_threads');
    const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
    const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
    const timestamp = Date.now();
    const activity = huntSpot ? 'hunting' : 'shopping';
    const { money, ...statsWithoutMoney } = { ...source.stats, ...(heldPacket || {}) };
    let huntingState = {};
    if (huntSpot) {
        const combat = invoke('GameServer/Bot/Population/ColdCombatProfile').profileFor(source, timestamp);
        const vitals = { hp: combat.maxHp, maxHp: combat.maxHp, mp: combat.maxMp, maxMp: combat.maxMp };
        await Database.updateCharacterVitals(source.characterId, vitals.hp, vitals.maxHp, vitals.mp, vitals.maxMp);
        // This existing errand routes a real hunting state through the kernel's lifecycle command.
        statsWithoutMoney.warehouseWorkflow = { kind: 'release' };
        huntingState = { spotId: huntSpot.id, loc: huntSpot.center, vitals };
    }
    const state = await Life.upsertState({ ...source, ...huntingState, activity, stats: statsWithoutMoney,
        timing: { ...source.timing, nextResolveAt: timestamp - 1 } }, 'worker_packet_source');
    assert(state && !state.stats.money, 'the native saved input has no old money packet');
    const epoch = 'saved-budget-money-packet', messages = [];
    let workerError, joined = false;
    const worker = new Worker(path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js'), {
        workerData: { workerEpoch: epoch }, resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    worker.on('message', message => messages.push(message));
    worker.on('error', error => { workerError = error; });
    const exit = new Promise(resolve => worker.once('exit', code => { joined = true; resolve(code); }));
    async function reply(predicate) {
        const deadline = Date.now() + 15000;
        while (!messages.some(predicate)) {
            if (workerError) throw workerError;
            const fault = messages.find(message => message.type === 'fault');
            if (fault) throw Error('native packet producer fault: ' + JSON.stringify(fault.payload));
            if (Date.now() >= deadline || joined) throw Error('native packet producer did not return a command');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return messages.find(predicate);
    }
    function send(type, payload, msgId) {
        const message = Protocol.envelope(type, epoch, payload, msgId);
        assert.equal(Protocol.validateEnvelope(message, 'main', { workerEpoch: epoch }).ok, true);
        worker.postMessage(message);
    }
    try {
        const loaded = await reply(message => message.type === 'ready' && message.payload.phase === 'loaded');
        assert.equal(loaded.payload.forbiddenDependencies, 0);
        const spots = invoke('GameServer/Bot/Population/SpotProfiles').ensure();
        for (let offset = 0; offset < spots.length; offset += Protocol.MAX_BATCH) {
            send('catalog_page', { catalog: 'spots', rows: spots.slice(offset, offset + Protocol.MAX_BATCH) });
        }
        send('init', { config: { loopIntervalMs: 20, maxInFlight: 1, maxBatch: 1 } }, 'packet-init');
        await reply(message => message.type === 'ready' && message.msgId === 'packet-init');
        send('snapshot_page', { rows: [{ state, context: huntSpot ? { spot: huntSpot } : {} }], initial: true, done: true }, 'packet-state');
        const message = await reply(value => value.type === 'command_request'
            && value.payload.requests.some(request => request.characterId === state.characterId));
        const request = message.payload.requests.find(value => value.characterId === state.characterId);
        const packet = request.precomputedPlan.statsPacket;
        assert(Array.isArray(packet.money) && packet.money.length >= 4 && packet.money[1] > 0,
            'the actual worker economy produces a positive money floor');
        assert(request.precomputedPlan.economyDecision, 'the packet comes with the native worker economy decision');
        assert(!request.precomputedPlan.plannedState.stats.money, 'money travels in the packet, not in the old planned state');
        if (huntSpot) {
            assert.equal(request.state.activity, 'hunting');
            assert.equal(request.precomputedPlan.plannedState.activity, 'hunting');
            assert.equal(request.precomputedResult.debug.spotId, huntSpot.id);
            assert(request.precomputedResult.debug.fights > 0 && request.precomputedResult.debug.combatActions > 0,
                'the actual command fights at the authored spot, without a clan-hall shortcut');
            assert.equal(request.precomputedResult.patch.activity, 'hunting');
            assert(request.precomputedResult.patch.stats.coldCombat && request.precomputedResult.patch.vitals,
                'the native result carries the actual combat patch');
            assert(Number.isFinite(request.precomputedResult.materialize.adena)
                && Array.isArray(request.precomputedResult.materialize.items), 'the native result has a materialization');
            if (heldPacket) {
                assert.equal(packet.wishFocus[0], heldPacket.wishFocus[0], 'the native held-focus case stays on its wish');
                assert.equal(packet.decisionSeq, request.state.stats.decisionSeq, 'held focus adds no event');
            } else {
                assert.notEqual(packet.wishFocus[0], request.state.stats.wishFocus[0], 'the native producer really changes focus');
                assert.equal(packet.decisionSeq, Number(request.state.stats.decisionSeq || 0) + 1, 'changed focus adds its event');
            }
        } else assert.equal(request.precomputedResult.debug.activity, 'shopping');
        assert(Protocol.sameCommandCheckpoint(state, request.commandCheckpoint));
        const applyInput = request.precomputedPlan.plannedState;
        const originalInput = JSON.stringify(applyInput), originalForState = Economy.forState;
        let preparations = 0, admissionChecks = 0, capturedOptions;
        const admission = { characterId: state.characterId, commandId: request.commandId,
            commandCheckpoint: request.commandCheckpoint, check: () => { admissionChecks++; return null; } };
        const receiver = {
            serializeClanLevelUp(characterId, operation) { assert.equal(characterId, state.characterId); return operation(); },
            prepareResolve(input, result, options) {
                preparations++; capturedOptions = options;
                // Exercise native main projection while keeping this observer away from all SQL writers.
                return Life.prepareResolve(input, result, { ...options, persist: false,
                    projectClassProgression: true, timestamp });
            }
        };
        Economy.forState = () => { throw Error('main must consume the worker packet without rebuilding wishes'); };
        try {
            const prepared = await Life.applyResolve.call(receiver, applyInput, request.precomputedResult,
                { statsPacket: packet, workerAdmission: admission });
            assert(prepared, 'native main prepare returns the functional projected state');
            assert.deepEqual(prepared.stats.money, packet.money, 'the real money queue survives main preparation');
            for (const [key, value] of Object.entries(packet)) {
                if (!huntSpot || !['decisionSeq', 'activityLeaf'].includes(key)) assert.deepEqual(prepared.stats[key], value);
            }
            const materializedMoney = Number(request.precomputedResult.materialize.adena)
                + request.precomputedResult.materialize.items.filter(row => row.selfId === 57)
                    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
            assert.equal(prepared.adena, request.state.adena + materializedMoney, 'preparation retains exactly the native wallet award');
            assert.equal(prepared.inventory[57]?.amount, prepared.adena);
            assert.equal(capturedOptions.workerAdmission, admission);
            assert.equal(admissionChecks, 1);
            if (huntSpot) {
                assert.equal(prepared.stats.decisionSeq,
                    Math.max(Number(request.state.stats.decisionSeq) || 0, Number(packet.decisionSeq) || 0) + 1,
                    'main retains the focus event and adds exactly one completed-round event');
                assert.equal(prepared.stats.activityLeaf, 0, 'a completed hunting round reopens activity selection');
                const retried = await Life.applyResolve.call(receiver, applyInput, request.precomputedResult,
                    { statsPacket: packet, workerAdmission: admission });
                assert.equal(retried.stats.decisionSeq, prepared.stats.decisionSeq, 'retrying one input cannot raise another event');
                assert.equal(retried.stats.activityLeaf, 0);
                assert.deepEqual(retried.stats.money, packet.money);
            }
            const beforeMissing = Funding.summary().moneyPacketMissing;
            assert.equal(Funding.spendable(prepared, 0, { r: 0 }), 0,
                'a value rate below the real worker floor cannot spend the wallet');
            assert.equal(Funding.summary().moneyPacketMissing, beforeMissing, 'postprepare funding consumes the real packet');
            await assert.rejects(async () => Life.applyResolve.call(receiver, applyInput, request.precomputedResult,
                { statsPacket: packet, workerAdmission: { ...admission, check: () => ({ reason: 'stale_worker_source' }) } }),
            error => error.code === 'BOT_WORKER_COMMAND_ADMISSION_REFUSED' && error.message === 'stale_worker_source');
            assert.equal(preparations, huntSpot ? 2 : 1, 'a stale worker cannot prepare, merge or write its packet');
            assert.equal(JSON.stringify(applyInput), originalInput, 'the old canonical input stays unchanged');
            console.log(`Native ${activity}/${heldPacket ? 'held_focus' : 'changed_focus'} packet survives main projection/admission; unfunded spend and stale source refused`);
        } finally { Economy.forState = originalForState; }
        send('shutdown', {}, 'packet-shutdown');
        await reply(value => value.type === 'drained' && value.msgId === 'packet-shutdown');
        assert.equal(await exit, 0);
        return packet;
    } finally { if (!joined) await worker.terminate(); }
}

async function run() {
    invoke('GameServer/DataCache').init();
    const seed = new DatabaseSync(fixture.world);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('quests','test')");
    const insert = seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'quests',?,0,0,60,0,0,187,74,187,74,0,0,0,0,0,0,0,-1,0)`);
    for (const characterId of [id, buyerId]) insert.run(characterId, `Quest${characterId}`);
    seed.close();
    await Database.init();
    const sale = Market.saleDecision;
    try {
        await Database.createAccount('bot_budget_probe', 'test');
        await Database.execute(["UPDATE characters SET username='bot_budget_probe'"]);
        await Life.init();
        for (const characterId of [id, buyerId]) await Database.setItem(characterId,
            { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        for (let i = 0; i < 60; i++) await Database.setItem(id,
            { selfId: 1864 + i, name: `Probe${i}`, amount: 30, slot: 0 });
        const focus = ['gear:1', 1234.56789, 100000];
        const dormant = [['gear:2', 3, 4, 5, 1234.56789, 6]];
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_budget_probe', name: 'BudgetProbe',
            level: 60, phase: 'cold', activity: 'hunting', adena: 1000000, currentRegion: 'Giran',
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {},
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            stats: { classId: 0, playedHours: 1234.56789, wishFocus: focus, dormantWishes: dormant,
                marketTrades: { material: 3 }, priceBeliefs: { old: 1 },
                equipmentPlan: { strategy: 'farm', economyInputKey: 'legacy'.repeat(400), inputKey: 'legacy' },
                huntEfficiency: [{ exp: 1234.56789, kills: 12.34567, adena: 123.456, loot: 78.901,
                    cycleMs: 1234.56789, at: 1791200000000 }] } }, 'saved_budget_seed');
        const planned = Gear.selectAcquisitionPlan(state, state.stats.equipmentPlan);
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: planned.acquisitionPlan } }, 'saved_budget_plan');
        // Main consumes a real worker-shaped decision for the same native plan.
        const Decisions = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
        const coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
        coordinator.economyDecisions.accept(id, Decisions.capture(planned.economy, state));
        const goal = await GoalService.review(state);
        assert(goal?.current, 'the native plan receives a native goal review');

        for (let i = 0; i < 30; i++) await Database.execute([
            'INSERT INTO warehouse_items(characterId,selfId,name,amount,enchant) VALUES(?,1864,\'Stem\',1,0)', [id]]);
        Market.saleDecision = () => ({ listings: [{ selfId: 1864, count: 60 }], npc: [], answers: [] });
        assert(invoke('GameServer/Bot/Economy/BotImprovementService').inTown(state), 'withdrawal uses a real town location');
        const withdrawal = await Warehouse.releaseCold(state, { inTown: true });
        Market.saleDecision = sale;
        assert(withdrawal.released && withdrawal.items.length === 30);
        state = withdrawal.state;
        const candidates = Array.from({ length: 20 }, (_, i) => ({ selfId: 1864 + i, count: i + 1, npcPrice: 2 }));
        state = await Life.applyNpcLiquidation(state, candidates);
        assert(state);

        const item = (await Database.fetchItems(id)).find(row => row.selfId === 1864);
        const { shop } = await Database.createAfkTradeShop(id, { kind: 'sell_ad', storeType: 1, town: 'Giran',
            lines: [{ objectId: item.id, selfId: 1864, name: 'Stem', count: 3, price: 100, stackable: true }] });
        for (let i = 0; i < 3; i++) {
            const result = await Database.buyFromAfkTradeShop(buyerId,
                { shopId: shop.id, ownerId: id, lineId: shop.lines[0].id, amount: 1 });
            assert(result && !result.error);
            for (const [characterId, counts] of Object.entries(result.marketTrades)) Life.acceptMarketTrades(characterId, counts);
        }
        assert.equal((await Database.fetchBotMarketCounts()).find(row => row.characterId === id).deals, 3);

        let pending = Life.cachedState(id);
        for (let i = 0; i < 20; i++) pending = Errands.enqueue(pending,
            { selfId: i + 1, amount: 1, town: 'Giran', at: Date.now() });
        assert.equal(Errands.pending(pending).length, 8);
        await Life.upsertState(pending, 'saved_budget_errands');
        const [row] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=?', [id]]);
        const [goalRow] = await Database.execute(['SELECT goalJson FROM bot_goal_state WHERE characterId=?', [id]]);
        const stats = JSON.parse(row.statsJson);
        for (const [record, field] of [[stats.lastNpcLiquidation, 'sold'], [stats.lastWarehouseWithdrawal, 'items']]) {
            assert(record[field].length <= 8 && Buffer.byteLength(JSON.stringify(record)) <= 120);
            assert(record[field].every(tuple => tuple.length === 3 && tuple.every(Number.isFinite)));
            assert(Object.values(record).filter(value => !Array.isArray(value)).every(Number.isFinite));
        }
        assert.equal(stats.playedHours, 1234.56789);
        assert.deepEqual(stats.wishFocus, focus); assert.deepEqual(stats.dormantWishes, dormant);
        assert.equal(stats.huntEfficiency[0].exp, 1230);
        assert.equal(stats.huntEfficiency[0].adena, 123);
        assert.equal(stats.huntEfficiency[0].at, 1791200000000);
        assert.equal(stats.huntEfficiency[0].cycleMs, 1234.56789);
        const serialized = row.statsJson + goalRow.goalJson;
        for (const key of ['economyInputKey', 'inputKey', 'marketTrades', 'inputHash', 'priceBeliefs'])
            assert(!serialized.includes('"' + key + '"'), key + ' must not be saved');
        assert.notEqual(options.default.Database.path, require('node:path').resolve('tmp/nodel2.sqlite'));
        await workerPacketSurvivesMainPreparation(Life.cachedState(id));
        const world = { user: { sessions: [] }, npc: { spawns: [], grid: {}, nextId: 1000000,
            periodMode: 'day', periodRevision: 0, periodDefinitions: [], raidBossRespawnTimers: new Map(),
            raidBossState: new Map(), gridKeys: new WeakMap() }, items: { spawns: [], nextId: 5000000 },
            addNpcToGrid() {}, indexSpawnsInGrid() {} };
        // Native authored actors provide a real hunt without starting World or a server.
        invoke('GameServer/World/Generics/SpawnNpcs').call(world);
        const World = invoke('GameServer/World/World'); World.npc = world.npc; World.user = world.user;
        invoke('GameServer/Bot/AI/SpotService').reset();
        const Profiles = invoke('GameServer/Bot/Population/SpotProfiles'); Profiles.reset();
        const huntSpot = Profiles.ensure().find(spot => !spot.raidBoss && spot.npcSelfIds?.length && spot.minLevel <= 5
            && invoke('GameServer/Bot/AI/BotHuntingGroundPolicy').evaluate(spot, Life.cachedState(id)).allowed);
        assert(huntSpot, 'the native catalogue includes an ordinary hunt spot');
        const heldPacket = await workerPacketSurvivesMainPreparation(Life.cachedState(id), { huntSpot });
        await workerPacketSurvivesMainPreparation(Life.cachedState(id), { huntSpot, heldPacket });
        console.log('Saved budget: native gear/goal, 60-item bag, 30 withdrawals, 20 NPC sales and 3 board deals passed');
    } finally {
        Market.saleDecision = sale; Goals.reset(); await Database.close();
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
