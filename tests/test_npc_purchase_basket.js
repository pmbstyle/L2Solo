'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('npc-basket');
require('../src/Global'); fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const DB = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Goals = invoke('GameServer/Bot/Goals/GoalState');
const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
const Basket = require('../src/GameServer/Bot/Economy/NpcPurchaseBasket');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
const seller = Basket.sellerFor(2509, 'Dion', 18);
assert(seller, 'actual default C4 NPC quote exists');
const lines = [{ selfId: 2509, amount: 100, unitPrice: 18 }, { selfId: 1060, amount: 2, unitPrice: 108 },
    { selfId: 736, amount: 1, unitPrice: 480 }];
async function seed(id, wallet = 5000, stats = {}, phase = 'cold') {
    await Native.character(DB, id, `Basket${id}`, `bot_basket_${id}`);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: wallet });
    return Life.upsertState({ characterId: id, name: `Basket${id}`, accountName: `bot_basket_${id}`,
        phase, activity: 'shopping', level: 1, adena: wallet, currentRegion: 'Dion', loc: seller,
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        stats: { classId: 0, money: [0, 0, 0, 0], ...stats } }, 'basket_fixture');
}
const amount = async (id, item) => Native.amount(await DB.fetchItems(id), item);
async function native(state, settings) {
    const admitted = await Commit.admit(state, Commit.KINDS.npcBuy);
    try { return { admitted, result: await DB.purchaseNpcInventoryBasket(state.characterId,
        { seller, lines, ...settings, coldState: admitted.state, economyCommand: admitted.command }) }; }
    finally { Commit.finish(state.characterId, admitted.command); }
}
async function run() {
    await DB.init();
    const at = Date.now(), first = { selfId: 2509, town: 'Dion', amount: 120, at, purpose: 'shots', money: 2160 };
    const unrelated = { selfId: 736, town: 'Giran', amount: 2, at, purpose: 'scrolls' };
    let state = await seed(9511, 5000, { marketErrands: [first, unrelated], marketErrand: first });
    const goal = await Goals.set(9511, { type: 'buy_craft_material', status: 'active',
        target: { itemId: 2509, amount: 120 }, plan: { purpose: 'shots' } });
    const chosen = lines.map(line => ({ ...line }));
    chosen[0].errands = [{ errand: first, units: 100, spent: 1800 }];
    chosen[0].goal = { expectedGoal: goal.current, updatedAt: goal.updatedAt, units: 100 };
    const purchased = await Basket.purchase(state, { seller, lines: chosen });
    assert(purchased.ok && purchased.purchased);
    assert.equal(await amount(9511, 57), 2504);
    assert.equal(await amount(9511, 2509), 100); assert.equal(await amount(9511, 1060), 2); assert.equal(await amount(9511, 736), 1);
    assert.equal(purchased.state.adena, 2504); assert.equal(purchased.state.inventory[2509].amount, 100);
    assert.equal(purchased.state.stats.marketErrands[0].amount, 20);
    assert.equal(purchased.state.stats.marketErrands[0].money, 360);
    assert.deepEqual(purchased.state.stats.marketErrands[1], unrelated);
    assert.equal(Goals.snapshot(9511).current.target.amount, 20);
    assert(Buffer.byteLength(JSON.stringify(purchased.economyCommit)) <= 384);
    const replay = await Basket.purchase(purchased.state, { seller: { ...seller, sourceId: 1 }, lines: [], original: purchased.economyCommand });
    assert(replay.replayed); assert.equal(await amount(9511, 57), 2504);
    assert.equal(replay.state.stats.marketErrands[0].amount, 20); assert.equal(Goals.snapshot(9511).current.target.amount, 20);
    await DB.close(); await DB.init();
    const restarted = await Basket.purchase(replay.state, { seller, lines: [], original: purchased.economyCommand });
    assert(restarted.replayed); assert.equal(await amount(9511, 2509), 100);

    state = await seed(9512, 5000, { marketErrands: [first], marketErrand: first });
    const rollbackGoal = await Goals.set(9512, { type: 'buy_craft_material', status: 'active',
        target: { itemId: 2509, amount: 120 }, plan: { purpose: 'shots' } });
    const rollbackLines = lines.map(line => ({ ...line }));
    rollbackLines[0].errands = [{ errand: first, units: 100, spent: 1800 }];
    rollbackLines[0].goal = { expectedGoal: rollbackGoal.current, updatedAt: rollbackGoal.updatedAt, units: 100 };
    const admission = await Commit.admit(state, Commit.KINDS.npcBuy);
    await DB.execute(["CREATE TEMP TRIGGER fail_basket BEFORE INSERT ON items WHEN NEW.characterId=9512 AND NEW.selfId=1060 BEGIN SELECT RAISE(ABORT,'basket rollback'); END"]);
    try { await assert.rejects(DB.purchaseNpcInventoryBasket(9512, { seller, lines: rollbackLines,
        economyCommand: admission.command }), /basket rollback/); }
    finally { Commit.finish(9512, admission.command); }
    assert.equal(await amount(9512, 57), 5000); assert.equal(await amount(9512, 2509), 0);
    const row = (await DB.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=9512']))[0];
    assert.equal(JSON.parse(row.statsJson).economyCommit[1], 0);
    assert.equal(JSON.parse(row.statsJson).marketErrands[0].amount, 120);
    assert.equal(JSON.parse((await DB.execute(['SELECT goalJson FROM bot_goal_state WHERE characterId=9512']))[0].goalJson).target.amount, 120);
    await DB.execute(['DROP TRIGGER fail_basket']);
    assert((await DB.purchaseNpcInventoryBasket(9512, { seller, lines: rollbackLines, economyCommand: admission.command })).ok);

    state = await seed(9513, 1000);
    await assert.rejects(Basket.purchase(state, { seller, lines: [
        { selfId: 2509, amount: 50, unitPrice: 18 }, { selfId: 736, amount: 1, unitPrice: 480 }] }), /funding_changed/);
    assert.equal(await amount(9513, 57), 1000); assert.equal(await amount(9513, 2509), 0);
    state = await seed(9514);
    await assert.rejects(native(state, { seller: { ...seller, town: 'Giran' } }), /seller_changed/);
    await assert.rejects(native(Life.cachedState(9514), { lines: [{ selfId: 2508, amount: 1, unitPrice: 300 }] }), /quote_changed/);
    await assert.rejects(native(Life.cachedState(9514), { lines: [{ selfId: 2509, amount: 10001, unitPrice: 18 }] }), /invalid npc purchase/);
    assert.equal(await amount(9514, 57), 5000);

    state = await seed(9515, 5000, { money: [0, .001, 1000, 0, .002, 3000, 999] });
    await assert.rejects(Basket.purchase(state, { seller, lines: [{ selfId: 2509, amount: 100, unitPrice: 18,
        fundingParts: [{ amount: 50, funding: { r: .002 }, order: 0 }, { amount: 50, funding: { r: .001 }, order: 1 }] }] }), /funding_changed/);
    assert.equal(await amount(9515, 2509), 0); assert.equal(await amount(9515, 57), 5000);

    state = await seed(9516, 5000, {}, 'hot');
    const Actor = invoke('GameServer/Model/Actor'), Backpack = invoke('GameServer/Actor/Backpack');
    const actor = new Actor({ id: 9516, name: 'Basket9516', classId: 0, race: 0, level: 1,
        hp: 100, maxHp: 100, mp: 100, maxMp: 100, locX: seller.locX, locY: seller.locY, locZ: seller.locZ });
    actor.backpack = new Backpack({ paperdoll: {}, items: [] });
    for (const item of await DB.fetchItems(9516)) actor.backpack.insertItem(item.id, item.selfId, { ...item });
    actor.session = { actor, coldLifeState: state, plan: 'shopping', botSession: true };
    const hot = await Basket.purchaseForActor(actor, { seller, lines });
    assert(hot.ok); assert.equal(actor.backpack.fetchItemFromSelfId(57).fetchAmount(), 2504);
    assert.equal(actor.backpack.fetchItemFromSelfId(2509).fetchAmount(), 100);
    const stale = Commit.header(hot.economyCommand[0], hot.economyCommand[1], hot.economyCommand[2],
        { ...hot.economyCommand.authority, phase: 'cold' });
    await assert.rejects(DB.purchaseNpcInventoryBasket(9516, { economyCommand: stale }), /owner_changed/);
    const fetch = DB.fetchItems;
    DB.fetchItems = async () => { throw Error('lost actor delivery'); };
    let delivered;
    try { delivered = await Basket.purchaseForActor(actor, { seller, lines: [], original: hot.economyCommand }); }
    finally { DB.fetchItems = fetch; }
    assert(delivered.ok && delivered.replayed, 'postcommit actor failure preserves saved success');
    assert.equal(await amount(9516, 57), 2504);
    const changedErrand = { ...first, amount: 40 };
    state = await seed(9517, 5000, { marketErrands: [changedErrand], marketErrand: changedErrand });
    const oldGoal = await Goals.set(9517, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    const newGoal = await Goals.set(9517, { type: 'progress_level', status: 'active', target: { level: 20 } });
    const changedLines = [{ ...chosen[0], goal: { expectedGoal: oldGoal.current, updatedAt: oldGoal.updatedAt, units: 100 } }];
    const unchanged = await Basket.purchase(state, { seller, lines: changedLines });
    assert.deepEqual(unchanged.state.stats.marketErrands[0], changedErrand);
    assert.deepEqual(Goals.snapshot(9517).current, newGoal.current);
    const actualPurchase = DB.purchaseNpcInventoryBasket;
    state = await seed(9518);
    await Goals.set(9518, { type: 'buy_craft_material', status: 'active', target: { itemId: 2509, amount: 120 } });
    DB.purchaseNpcInventoryBasket = async (...args) => {
        const committed = await actualPurchase.apply(DB, args);
        await Goals.set(9518, { type: 'progress_level', status: 'active', target: { level: 30 } });
        return committed;
    };
    try { assert((await Basket.purchase(state, { seller, lines: [lines[0]] })).ok); }
    finally { DB.purchaseNpcInventoryBasket = actualPurchase; }
    assert.equal(Goals.snapshot(9518).current.type, 'progress_level', 'new goal published after native commit survives old result delivery');
    console.log('Native NPC basket: actual seller, multi-item debit, partial progress, restart/replay, aggregate funding, rollback and hot delivery passed');
}
run().then(() => DB.close()).catch(async error => { console.error(error); process.exitCode = 1; await DB.close(); });
