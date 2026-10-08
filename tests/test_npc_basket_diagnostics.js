'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
const { execFileSync } = require('node:child_process');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('npc-basket-diagnostics');
// Identical fresh databases and command identities make parity an exact check.
const crypto = require('node:crypto'), uuid = crypto.randomUUID;
crypto.randomUUID = () => '11111111-1111-4111-8111-111111111111';
let clock = process.argv[2] === '--parity' ? 1900000000000 : Date.now();
const nativeDate = Date.now, nativeRandom = Math.random;
let randomCalls = 0;
if (process.argv[2] === '--parity') Math.random = () => { randomCalls++; return .375; };
Date.now = () => clock;
require('../src/Global'); fixture.assertConfigured(options.default);
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Goals = invoke('GameServer/Bot/Goals/GoalState');
const Basket = require('../src/GameServer/Bot/Economy/NpcPurchaseBasket');
const Restock = require('../src/GameServer/Bot/Economy/NpcRestockPlan');
const Diagnostics = require('../src/GameServer/Bot/Economy/EconomyDiagnostics');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
const seller = Basket.sellerFor(2509, 'Dion', 18);
const lines = [{ selfId: 2509, amount: 100, unitPrice: 18 }, { selfId: 1060, amount: 2, unitPrice: 108 }];
const rows = [];
function selected(id) {
    clock += 2000;
    Config.economyDiagnosticsBotIds = String(id);
}
async function seed(id, wallet = 5000, stats = {}, phase = 'cold') {
    selected(id);
    await Native.character(DB, id, `Diagnostic${id}`, `bot_basket_diag_${id}`);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: wallet });
    return Life.upsertState({ characterId: id, name: `Diagnostic${id}`, accountName: `bot_basket_diag_${id}`,
        phase, activity: 'shopping', level: 1, adena: wallet, currentRegion: 'Dion', loc: seller,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        stats: { classId: 0, money: [0, 0, 0, 0], decisionSeq: 17, activityLeaf: 9, ...stats } }, 'diagnostics_fixture');
}
const read = async sql => DB.execute([sql]);
const amount = async (id, item) => Native.amount(await DB.fetchItems(id), item);
const counter = key => Diagnostics.metrics().counts?.[key] || 0;
const successes = () => ['native:native_quantity:npc_filled', 'native:npc_goal:applied', 'native:native_result:completed'].map(counter);
async function parity(on) {
    Config.developerDiagnostics = on; Config.economyDiagnostics = true;
    const state = await seed(9600, 5000, { money: [1000, .001, 1000, 0, .003, 2000, 999] });
    const goal = await Goals.set(9600, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    const chosen = [{ ...lines[0], funding: { r: .003 }, goal: { expectedGoal: goal.current, updatedAt: goal.updatedAt, units: 100 } }];
    const hooks = {};
    if (!on) for (const key of ['enabled', 'count', 'push', 'duration', 'noteDropped']) {
        hooks[key] = Diagnostics[key]; Diagnostics[key] = () => { throw Error('disabled hook ' + key); };
    }
    let result;
    try {
        const plan = Restock.collect(state, { potions: false, shots: false, scrolls: false, extras: [{
            ...chosen[0], offer: { ...seller, price: 18 } }] })[0];
        result = await Basket.purchase(state, plan);
    }
    finally { Object.assign(Diagnostics, hooks); }
    const digest = { randomCalls, items: await read('SELECT * FROM items WHERE characterId=9600 ORDER BY id'),
        life: await read('SELECT * FROM bot_life_state WHERE characterId=9600'),
        goal: await read('SELECT * FROM bot_goal_state WHERE characterId=9600'),
        result: { units: result.units, spent: result.spent, lines: result.lines, state: result.state } };
    console.log('PARITY:' + JSON.stringify(digest));
}
async function scenarios() {
    Config.developerDiagnostics = true; Config.economyDiagnostics = true;
    Diagnostics.connect(batch => { rows.push(...batch.records.map(JSON.parse)); Diagnostics.ack(batch.id, batch.records.length); return true; });
    const errand = { selfId: 2509, town: 'Dion', amount: 120, at: clock, purpose: 'shots', money: 2160 };
    const state = await seed(9601, 5000, { marketErrands: [errand], marketErrand: errand });
    const goal = await Goals.set(9601, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    const chosen = lines.map(line => ({ ...line }));
    chosen[0].errands = [{ errand, units: 100, spent: 1800 }];
    chosen[0].goal = { expectedGoal: goal.current, updatedAt: goal.updatedAt, units: 100 };
    const result = await Basket.purchase(state, { seller, lines: chosen });
    assert.equal(result.units, 102); assert.equal(result.spent, 2016); assert.equal(await amount(9601, 57), 2984);
    const recorded = rows.filter(row => row.owner === 9601 && row.commandId === result.economyCommand[0]);
    for (const line of chosen) {
        assert(recorded.some(row => row.phase === 'native_quantity' && row.reason === 'npc_requested'
            && row.item === line.selfId && row.requested === line.amount && row.planned === line.amount && row.npcId === seller.sourceId));
        assert(recorded.some(row => row.phase === 'native_quantity' && row.reason === 'npc_filled'
            && row.item === line.selfId && row.actual === line.amount && row.spent === line.amount * line.unitPrice));
    }
    assert(recorded.some(row => row.phase === 'npc_basket' && row.planned === 102 && row.cost === 2016));
    assert(recorded.some(row => row.phase === 'npc_goal' && row.goalApplied === 1 && row.goalRevision === goal.updatedAt && row.remaining === 20));
    const partial = recorded.find(row => row.phase === 'npc_errand');
    assert.equal(partial.requested, 120); assert.equal(partial.actual, 100); assert.equal(partial.remaining, 20);
    assert.equal(partial.errandAt, errand.at); assert(partial.errandKey.length <= 96);
    assert(recorded.some(row => row.phase === 'npc_admission' && row.requested === 102));
    assert(recorded.some(row => row.phase === 'npc_delivery' && row.reason === 'state_accepted'));
    const beforeReplay = successes();
    const start = rows.length; clock += 2000;
    const replay = await Basket.purchase(result.state, { seller: { ...seller, sourceId: 1, town: 'Wrong' }, lines: [], original: result.economyCommand });
    assert.deepEqual(successes(), beforeReplay, 'replay does not count saved effects as new success');
    assert(replay.replayed); assert.equal(await amount(9601, 57), 2984);
    const replayRows = rows.slice(start).filter(row => row.commandId === result.economyCommand[0]);
    assert(replayRows.some(row => row.receiptUnits === 102 && row.receiptSpent === 2016 && row.actual === 0 && row.spent === 0));
    assert(replayRows.every(row => row.npcId === undefined && row.item === undefined && row.town === undefined && row.lineId === undefined),
        'a saved aggregate receipt cannot identify historical seller or lines from new arguments');

    const protectedState = await seed(9602, 5000, { money: [0, .001, 1000, 0, .003, 3000, 999] });
    await assert.rejects(Basket.purchase(protectedState, { seller, lines: [{ ...lines[0], funding: { r: .002 } }] }), /funding_changed/);
    assert.equal(await amount(9602, 57), 5000);
    const funding = rows.find(row => row.owner === 9602 && row.phase === 'native_funding');
    assert.equal(funding.wallet, 5000); assert.equal(funding.reserve, 1000); assert.equal(funding.priorityReserve, 3000);
    assert.equal(funding.budget, 1000); assert.equal(funding.actual, 0); assert.equal(funding.spent, 0);
    assert(rows.some(row => row.owner === 9602 && row.phase === 'npc_refusal' && row.reason === 'economy_funding_changed'));

    const staleState = await seed(9603);
    const oldGoal = await Goals.set(9603, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    await Goals.set(9603, { type: 'progress_level', status: 'active', target: { level: 20 } });
    assert((await Basket.purchase(staleState, { seller, lines: [{ ...lines[0], goal: { expectedGoal: oldGoal.current,
        updatedAt: oldGoal.updatedAt, units: 100 } }] })).ok);
    assert(rows.some(row => row.owner === 9603 && row.phase === 'npc_goal' && row.goalApplied === 0 && row.actual === 0));
    assert.equal(Goals.snapshot(9603).current.type, 'progress_level');

    // Fail after the real goal CAS and before the transaction publishes its receipt.
    const rollbackState = await seed(9604);
    const rollbackGoal = await Goals.set(9604, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    await DB.execute(["CREATE TEMP TRIGGER fail_diagnostic_receipt BEFORE UPDATE ON bot_life_state WHEN NEW.characterId=9604 AND json_extract(NEW.statsJson,'$.economyCommit[1]')=1 BEGIN SELECT RAISE(ABORT,'diagnostic rollback'); END"]);
    const beforeRollback = successes(), rollbacks = counter('native:transaction:rolled_back');
    await assert.rejects(Basket.purchase(rollbackState, { seller, lines: [{ ...lines[0], goal: {
        expectedGoal: rollbackGoal.current, updatedAt: rollbackGoal.updatedAt, units: 100 } }] }), /diagnostic rollback/);
    assert.deepEqual(successes(), beforeRollback, 'rolled-back filled/goal/result facts never increment success');
    assert.equal(counter('native:transaction:rolled_back'), rollbacks + 1);
    assert(counter('native_rollback:native_result:completed') > 0);
    const rolled = rows.filter(row => row.owner === 9604 && row.outcome === 'rolled_back');
    assert(rolled.length); assert(rolled.every(row => row.actual === 0 && row.spent === 0 && (row.goalApplied === undefined || row.goalApplied === 0)));
    assert(rolled.some(row => row.phase === 'npc_goal' && row.reason === 'diagnostic rollback' && row.goalApplied === 0));
    assert.equal(await amount(9604, 57), 5000); assert.equal(await amount(9604, 2509), 0);
    assert.equal(JSON.parse((await read('SELECT goalJson FROM bot_goal_state WHERE characterId=9604'))[0].goalJson).target.amount, 120);
    for (const [id, detail] of [[9610, false], [9611, true]]) {
        const probe = await seed(id);
        Config.economyDiagnostics = detail;
        if (detail) Config.economyDiagnosticsBotIds = '999999';
        const before = successes(), beforeRows = rows.length, beforeCount = counter('native:transaction:rolled_back');
        await DB.execute([`CREATE TEMP TRIGGER fail_diagnostic_${id} BEFORE UPDATE ON bot_life_state WHEN NEW.characterId=${id} AND json_extract(NEW.statsJson,'$.economyCommit[1]')=1 BEGIN SELECT RAISE(ABORT,'diagnostic rollback'); END`]);
        await assert.rejects(Basket.purchase(probe, { seller, lines }), /diagnostic rollback/);
        assert.deepEqual(successes(), before, 'aggregate-only and unselected rollbacks preserve successes');
        assert.equal(counter('native:transaction:rolled_back'), beforeCount + 1);
        assert.equal(rows.length, beforeRows, 'aggregate collection does not bypass detail selection');
        assert.equal(await amount(id, 57), 5000);
        await DB.execute([`DROP TRIGGER fail_diagnostic_${id}`]);
        // Direct native call confirms subsequent transactions do not inherit scratch state.
        await DB.purchaseNpcInventoryBasket(id, { lines });
        assert.equal(counter('native:native_quantity:npc_filled'), before[0] + lines.length);
    }
    Config.economyDiagnostics = true;
    // Collector exceptions before/after COMMIT must never reject a paid purchase.
    await seed(9612);
    const savedHooks = { count: Diagnostics.count, push: Diagnostics.push };
    try {
        Diagnostics.count = Diagnostics.push = () => { throw Error('diagnostic sink failed'); };
        assert((await DB.purchaseNpcInventoryBasket(9612, { lines })).ok);
    } finally { Object.assign(Diagnostics, savedHooks); }
    assert.equal(await amount(9612, 57), 2984);
    const hotState = await seed(9605, 5000, {}, 'hot');
    const Actor = invoke('GameServer/Model/Actor'), Backpack = invoke('GameServer/Actor/Backpack');
    const actor = new Actor({ id: 9605, name: 'Diagnostic9605', classId: 0, race: 0, level: 1,
        hp: 100, maxHp: 100, mp: 100, maxMp: 100, locX: seller.locX, locY: seller.locY, locZ: seller.locZ });
    actor.backpack = new Backpack({ paperdoll: {}, items: [] });
    for (const item of await DB.fetchItems(9605)) actor.backpack.insertItem(item.id, item.selfId, { ...item });
    actor.session = { actor, coldLifeState: hotState, plan: 'shopping', botSession: true };
    const nativePurchase = DB.purchaseNpcInventoryBasket;
    const requestSeller = { ...seller };
    DB.purchaseNpcInventoryBasket = async (...args) => {
        const committed = await nativePurchase.apply(DB, args);
        // Simulate reuse of the caller's mutable argument after SQL captured it.
        args[1].seller.sourceId = 1; args[1].seller.town = 'Wrong';
        return committed;
    };
    let delivered;
    try { delivered = await Basket.purchaseForActor(actor, { seller: requestSeller, lines }); }
    finally { DB.purchaseNpcInventoryBasket = nativePurchase; }
    assert(rows.some(row => row.owner === 9605 && row.phase === 'npc_result' && row.npcId === seller.sourceId && row.town === seller.town),
        'post-await traces retain the known request seller');
    assert(rows.some(row => row.owner === 9605 && row.phase === 'npc_delivery' && row.reason === 'actor_accepted' && row.npcId === seller.sourceId));
    assert(delivered.ok);
    assert.equal(actor.backpack.fetchItemFromSelfId(2509).fetchAmount(), 100);
    assert(rows.some(row => row.owner === 9605 && row.phase === 'npc_delivery' && row.reason === 'actor_accepted' && row.actual === 102));
    clock += 2000;
    const fetch = DB.fetchItems;
    DB.fetchItems = async () => { throw Error('lost diagnostic actor delivery'); };
    try {
        const saved = await Basket.purchaseForActor(actor, { seller: { ...seller, sourceId: 1 }, lines: [], original: delivered.economyCommand });
        assert(saved.ok && saved.replayed, 'a delivery error keeps the committed receipt');
    } finally { DB.fetchItems = fetch; }
    assert(rows.some(row => row.owner === 9605 && row.phase === 'npc_delivery' && row.reason === 'actor_deferred'
        && row.actual === 0 && row.receiptUnits === 102 && row.npcId === undefined));
    assert.equal(await amount(9605, 57), 2984);
    await assert.rejects(Basket.purchaseForActor(actor, { lines }), /invalid npc basket/);
    assert(Diagnostics.metrics().durations.npc_basket.count >= 5);
    const poor = await seed(9606, 180);
    const poorPlans = Restock.collect(poor, { shots: false, potions: false, scrolls: false,
        extras: [{ selfId: 2509, amount: 120, offer: { ...seller, price: 18 } }] });
    assert.equal(poorPlans[0].lines[0].amount, 10);
    const poorPlan = rows.find(row => row.owner === 9606 && row.phase === 'npc_plan');
    assert.equal(poorPlan.requested, 120); assert.equal(poorPlan.planned, 10); assert.equal(poorPlan.budget, 180);
    assert.equal(poorPlan.reason, 'partial'); assert.equal(poorPlan.npcId, seller.sourceId);
    const poorReceipt = await Basket.purchase(poor, poorPlans[0]);
    assert.equal(poorReceipt.units, 10); assert.equal(poorReceipt.spent, 180);
    const rich = await seed(9607);
    const richPlans = Restock.collect(rich, { shots: false, potions: false, scrolls: false,
        extras: [{ selfId: 2509, amount: 120, offer: { ...seller, price: 18 } }] });
    assert.equal(richPlans[0].lines[0].amount, 120);
    assert(rows.some(row => row.owner === 9607 && row.phase === 'npc_plan' && row.requested === 120 && row.planned === 120 && row.reason === 'funded'));
    const merged = Restock.collect(rich, { shots: false, potions: false, scrolls: false, extras: [
        { selfId: 2509, amount: 120, offer: { ...seller, price: 18 } },
        { selfId: 2509, amount: 120, offer: { ...seller, price: 19 } }] });
    assert.equal(merged[0].lines[0].amount, 120);
    assert(rows.some(row => row.owner === 9607 && row.phase === 'npc_plan' && row.reason === 'line_changed' && row.planned === 0));
    assert(Diagnostics.metrics().durations.npc_plan.count >= 2);
    // Every existing invalid-purchase branch keeps its generic API error while
    // emitting a precise bounded reason and JSON-safe input classification.
    const bad = await seed(9620);
    const cases = [
        [{ selfId: NaN }, 'invalid_item', 'selfId:number:NaN'],
        [{ amount: NaN }, 'invalid_count', 'amount:number:NaN'],
        [{ amount: Infinity }, 'invalid_count', 'amount:number:Infinity'],
        [{ amount: 1.5 }, 'invalid_count', 'amount:number:fractional'],
        [{ unitPrice: 'oops' }, 'invalid_price', 'unitPrice:string:NaN'],
        [{ unitPrice: 0 }, 'invalid_price', 'unitPrice:number:nonpositive'],
        [{ amount: Number.MAX_SAFE_INTEGER }, 'invalid_line_total', 'total:number:unsafe_integer'],
        [{ stackable: false, amount: 10001 }, 'nonstackable_limit', 'amount:number:finite']
    ];
    for (const [patch, reason, trigger] of cases) {
        clock += 2000;
        const startRows = rows.length, before = counter(`native:native_refusal:${reason}`);
        await assert.rejects(DB.purchaseNpcInventoryItem(9620, { ...lines[0], ...patch }), { message: 'invalid npc purchase' });
        assert.equal(counter(`native:native_refusal:${reason}`), before + 1);
        const row = rows.slice(startRows).find(row => row.phase === 'native_refusal');
        assert(row, reason); assert.equal(row.reason, reason); assert.equal(row.trigger, trigger);
        assert.equal(row.caller, 'purchaseNpcInventoryItem'); assert.equal(row.outcome, 'rolled_back');
        assert.equal(row.actual, 0); assert.equal(row.spent, 0);
        assert(Object.values(row).every(value => typeof value !== 'number' || Number.isFinite(value)));
    }
    clock += 2000;
    await assert.rejects(DB.purchaseNpcInventoryBasket(9620, { lines: [lines[0], lines[0]] }), { message: 'invalid npc purchase' });
    assert(rows.some(row => row.owner === 9620 && row.phase === 'native_refusal' && row.reason === 'duplicate_item' && row.lineId === 1));
    clock += 2000;
    await assert.rejects(DB.purchaseNpcInventoryBasket(9620, { lines: [
        { ...lines[0], amount: Number.MAX_SAFE_INTEGER, unitPrice: 1 },
        { ...lines[1], amount: 1, unitPrice: 1 }
    ] }), { message: 'invalid npc basket total' });
    assert(rows.some(row => row.owner === 9620 && row.reason === 'invalid_basket_total'));
    clock += 2000;
    const invalidCommandStart = rows.length;
    await assert.rejects(Basket.purchase(bad, { seller, lines: [{ ...lines[0], amount: NaN }] }), { message: 'invalid npc purchase' });
    const commandRefusal = rows.slice(invalidCommandStart).find(row => row.phase === 'native_refusal');
    assert(commandRefusal.commandId); assert.equal(commandRefusal.source, 'cold');
    assert.equal(commandRefusal.commandKind, require('../src/GameServer/Bot/Economy/EconomyCommit').KINDS.npcBuy);
    assert.equal(await amount(9620, 57), 5000); assert.equal(await amount(9620, 2509), 0);
    Config.economyDiagnosticsBotIds = '999999'; clock += 2000;
    const noDetailRows = rows.length, invalidBefore = counter('native:native_refusal:invalid_count');
    await assert.rejects(DB.purchaseNpcInventoryItem(9620, { ...lines[0], amount: NaN }), { message: 'invalid npc purchase' });
    assert.equal(counter('native:native_refusal:invalid_count'), invalidBefore + 1);
    assert.equal(rows.length, noDetailRows, 'invalid detail obeys existing owner selection');
    await seed(9621);
    await DB.setItem(9621, { selfId: 2509, name: 'Spirits', amount: Number.MAX_SAFE_INTEGER });
    await assert.rejects(DB.purchaseNpcInventoryItem(9621, { ...lines[0], amount: 1 }), { message: 'invalid npc stack total' });
    assert(rows.some(row => row.owner === 9621 && row.reason === 'invalid_stack_total'
        && row.trigger === 'amount:number:unsafe_integer' && row.after === Number.MAX_SAFE_INTEGER + 1));
    assert.equal(await amount(9621, 57), 5000);
    assert.equal(await amount(9621, 2509), Number.MAX_SAFE_INTEGER);
    Config.developerDiagnostics = false;
    const hooks = {};
    try {
        for (const key of ['enabled', 'count', 'push', 'noteDropped']) {
            hooks[key] = Diagnostics[key]; Diagnostics[key] = () => { throw Error('disabled diagnostic hook'); };
        }
        await assert.rejects(DB.purchaseNpcInventoryItem(9620, { ...lines[0], amount: NaN }), { message: 'invalid npc purchase' });
    } finally { Object.assign(Diagnostics, hooks); Config.developerDiagnostics = true; }
    assert.equal(DB.stats().pending, 0);
}
(async () => {
    await DB.init();
    if (process.argv[2] === '--parity') await parity(process.argv[3] === 'true');
    else await scenarios();
    await DB.close(); Diagnostics.stop();
    if (process.argv[2] !== '--parity') {
        const probe = value => {
            const output = execFileSync(process.execPath, [__filename, '--parity', String(value)], { env: process.env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
            return JSON.parse(output.split('\n').find(row => row.startsWith('PARITY:')).slice(7));
        };
        assert.deepEqual(probe(true), probe(false), 'master off/on preserves exact physical rows, life packet, goal, result and RNG use');
        console.log('NPC basket diagnostics: actual quantities, seller, protected wallet, goal CAS, errand partial, replay omission, rollback and exact off/on data/RNG passed');
    }
})().catch(async error => { console.error(error); try { await DB.close(); } catch { /* Keep the original test failure. */ } process.exitCode = 1; })
.finally(() => { Date.now = nativeDate; Math.random = nativeRandom; crypto.randomUUID = uuid; fs.rmSync(fixture.directory, { recursive: true, force: true }); });
