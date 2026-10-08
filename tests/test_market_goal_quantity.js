'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('market-goal-quantity');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Native = require('./helpers/nativeMarketFixture');
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Goals = invoke('GameServer/Bot/Goals/GoalState');
const Market = invoke('GameServer/Bot/Economy/ColdMarketService');
const Opportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
// Run the same native cases with telemetry enabled: it must not affect fills,
// funding, goal progress or stale-goal protection.
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
Config.developerDiagnostics = true; Config.economyDiagnostics = true; Config.economyDiagnosticsBotIds = '9101,9102,9103,9105,9107';
Data.init();

async function buyer(id, wallet, held = 0, itemId = 2509) {
    await Native.character(Database, id, `Quantity${id}`, `bot_quantity_${id}`);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: wallet, stackable: true });
    await Database.setItem(id, { selfId: 736, name: 'Scroll of Escape', amount: 2, stackable: true });
    if (held) await Database.setItem(id, { selfId: 2509, name: 'Spiritshot', amount: held, stackable: true });
    return Life.upsertState({ characterId: id, name: `Quantity${id}`, accountName: `bot_quantity_${id}`,
        phase: 'cold', activity: 'shopping', level: 42, adena: wallet,
        currentRegion: 'Dion', homeRegion: 'Dion', loc: { locX: 19000, locY: 145000, locZ: -3100 },
        stats: { classId: 12, money: [36000, 0.001, 0, 0, 0.001, wallet, itemId] },
        vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
        inventory: { 57: { selfId: 57, amount: wallet }, 736: { selfId: 736, amount: 2 }, ...(held ? { 2509: { selfId: 2509, amount: held } } : {}) },
        simulation: { ownerId: 'legacy_main', revision: 0 }, updatedAt: Date.now() }, 'quantity_fixture');
}
async function goal(id, amount, itemId = 2509) {
    return (await Goals.set(id, { type: 'buy_craft_material', status: 'active',
        target: { itemId, amount }, plan: { expectedBenefit: 'market_buy_craft_material',
            marketTown: 'Dion', purpose: 'supply', r: 0.001 }, createdAt: id })).current;
}
async function run() {
    Database.init();
    const npc = Opportunity.npcOffersAll(2509).find(offer => offer.town === 'Dion');
    assert(npc?.price > 0, 'real catalog supplies a concrete NPC Spiritshot quote');
    const price = Number(npc.price);
    const state = await buyer(9101, price * 2000, 100);
    const fullGoal = await goal(9101, 1000);
    const result = await Market.tryPurchase(state, fullGoal);
    assert.equal(result.units, 1000, 'remaining goal is not the whole bag target or default one');
    assert.equal(Native.amount(await Database.fetchItems(9101), 2509), 1100);
    assert.equal(Native.amount(await Database.fetchItems(9101), 57), price * 1000);
    assert.equal(Goals.snapshot(9101).current.status, 'completed');
    assert.equal((await Market.tryPurchase(result.state, fullGoal)).reason, 'stale_purchase_goal');
    assert.equal(Native.amount(await Database.fetchItems(9101), 2509), 1100, 'a stale goal cannot buy another full stack');

    const partial = await Market.tryPurchase(await buyer(9102, price * 200), await goal(9102, 1000));
    assert.equal(partial.units, 200);
    assert.equal(Native.amount(await Database.fetchItems(9102), 2509), 200);
    assert.equal(Native.amount(await Database.fetchItems(9102), 57), 0);
    assert.equal(Goals.snapshot(9102).current.status, 'active');
    assert.equal(Goals.snapshot(9102).current.target.amount, 800);
    await buyer(9103, price * 2000);
    const accepted = await goal(9103, 1000);
    const purchase = Database.purchaseNpcInventoryBasket;
    try {
        Database.purchaseNpcInventoryBasket = async (...args) => {
            const result = await purchase.apply(Database, args);
            await Goals.set(9103, { type: 'progress_level', status: 'active', target: { level: 50 } });
            return result;
        };
        assert.equal((await Market.tryPurchase(Life.cachedState(9103), accepted)).units, 1000);
        assert.equal(Goals.snapshot(9103).current.type, 'progress_level', 'a newer goal survives the old purchase reply');
    } finally { Database.purchaseNpcInventoryBasket = purchase; }
    await buyer(9104, price * 2000);
    const replayGoal = await goal(9104, 1000);
    await Goals.applyPurchase(9104, replayGoal, 600);
    assert.equal(await Goals.applyPurchase(9104, replayGoal, 600), null, 'repeated progress cannot subtract twice');
    assert.equal(Goals.snapshot(9104).current.target.amount, 400);
    const gearGoal = (await Goals.set(9104, { type: 'upgrade_gear', status: 'active', target: { itemId: 2 } })).current;
    await Goals.applyPurchase(9104, gearGoal, 1);
    assert.equal(Goals.snapshot(9104).current.status, 'completed', 'legacy individual gear still means one');
    const refusedState = await buyer(9105, price * 2000), refusedGoal = await goal(9105, 1000);
    try {
        Database.purchaseNpcInventoryBasket = async () => ({ ok: false, lines: [] });
        assert.equal((await Market.tryPurchase(refusedState, refusedGoal)).units, 0);
        assert.equal(Native.amount(await Database.fetchItems(9105), 57), price * 2000);
        assert.equal(Goals.snapshot(9105).current.target.amount, 1000);
    } finally { Database.purchaseNpcInventoryBasket = purchase; }
    const unknown = await Market.tryPurchase(refusedState, { ...refusedGoal, target: { itemId: 2509 } });
    assert.equal(unknown.reason, 'purchase_quantity_unknown');
    await Native.character(Database, 9106, 'QuantitySeller', 'bot_quantity_seller');
    await Database.setItem(9106, { selfId: 1864, name: 'Stem', amount: 600, stackable: true });
    await Afk.openBotRecords(9106, 'sell_ad', [{ storeType: 1, town: 'Dion', title: 'Stem',
        lines: [{ selfId: 1864, name: 'Stem', count: 600, price: 10, enchant: 0, stackable: true }] }]);
    const finite = await Market.tryPurchase(await buyer(9107, 20000, 0, 1864), await goal(9107, 1000, 1864));
    assert.equal(finite.units, 600, 'finite public stock leaves the actual unmet need');
    assert.equal(Native.amount(await Database.fetchItems(9107), 1864), 600);
    assert.equal(Goals.snapshot(9107).current.target.amount, 400);
    console.log('Native goal quantities: full/partial stock and funds, existing bag, changed goal, replay, refusal and unknown amount passed');
}
run().then(async () => {
    await Database.close();
    const lines = fs.readFileSync(require('node:path').join(fixture.directory, 'logs/economy-diagnostics.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].type, 'economy_diagnostics_header');
    assert.match(lines[0].build, /^[0-9a-f]{40}$/); assert(lines[0].world); assert(lines[0].run);
    const partial = lines.find(row => row.owner === 9102 && row.phase === 'purchase_commit');
    assert.equal(partial.need, 1000); assert.equal(partial.actual, 200); assert.equal(partial.remaining, 800);
    assert(partial.goalRevision > 0); assert(!Object.hasOwn(partial, 'name'));
    assert(lines.every(row => Buffer.byteLength(JSON.stringify(row)) + 1 <= 1024));
    assert.equal(invoke('HistoryDatabase').stats().economyDiagnostics.queued, 0);
    console.log('Native quantity telemetry: existing history worker, exact build/world/run, committed partial quantity and bounded shutdown passed');
}).catch(async error => {
    console.error(error); process.exitCode = 1; await Database.close();
});
