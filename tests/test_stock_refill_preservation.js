'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const token = require('node:crypto').randomUUID();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), `l2-stock-refill-${token}-`));
const worldPath = path.join(directory, `${token}-world.sqlite`), historyPath = path.join(directory, `${token}-history.sqlite`);
const configPath = path.join(directory, `${token}.ini`);
fs.writeFileSync(configPath, fs.readFileSync(path.resolve(__dirname, '../config/default.ini'), 'utf8')
    .replace(/^path\s*=.*$/m, `path = ${worldPath}\nhistoryPath = ${historyPath}`));
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = configPath;
require('../src/Global');
assert.equal(options.default.Database.path, worldPath);
assert.equal(options.default.Database.historyPath, historyPath);
assert(path.isAbsolute(worldPath) && worldPath.includes(token));
const { DatabaseSync } = require('node:sqlite');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Shot = invoke('GameServer/Inventory/ShotStock');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Npc = invoke('GameServer/Bot/Economy/NpcRestockPlan');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const Response = invoke('GameServer/Network/Response');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const id = 719911, SHOT = 1835, SWORD = 1;

function actorItem(row) {
    const template = Data.items.find(item => Number(item.selfId) === Number(row.selfId));
    return { ...row, fetchId() { return this.id; }, fetchSelfId() { return this.selfId; },
        fetchAmount() { return this.amount; }, setAmount(value) { this.amount = value; },
        fetchEquipped() { return !!this.equipped; }, fetchSlot() { return this.slot; },
        fetchEnchantLevel() { return this.enchant || 0; }, fetchRank() { return template?.etc?.rank || 'none'; },
        fetchStackable() { return template?.etc?.stackable; }, fetchKind() { return template?.template?.kind || ''; },
        fetchPrice() { return Number(template?.template?.price || 0); }, fetchName() { return template?.template?.name || ''; } };
}
async function run() {
    Data.init();
    const seed = new DatabaseSync(worldPath);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES('bot_stock_refill','test')");
    seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,
        sex,face,hair,hairColor,locX,locY,locZ,newbie,newbieShotsReceived)
        VALUES(?,'bot_stock_refill','StockRefill',1,0,40,0,0,187,74,187,74,0,0,0,0,83396,147904,-3400,-1,0)`).run(id);
    seed.close();
    await Database.init();
    await Life.init();
    const responseOriginals = { speak: Response.speak, itemsList: Response.itemsList, userInfo: Response.userInfo };
    try {
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 10000000, slot: 0 });
        await Database.setItem(id, { selfId: SWORD, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
        // The actor adapter exposes actual SQLite item rows to the native
        // restock and SellJunk handlers; neither stock nor sale is replaced.
        const backpack = { items: (await Database.fetchItems(id)).map(actorItem),
            fetchItems() { return this.items; }, fetchItemFromSelfId(selfId) { return this.items.find(row => row.selfId === selfId); },
            fetchEquippedWeapon() { return this.items.find(row => row.equipped && row.slot === 7); },
            insertItem(objectId, selfId, attributes) { this.items.push(actorItem({ id: objectId, selfId, ...attributes })); } };
        const actor = { fetchId: () => id, fetchLevel: () => 40, fetchClassId: () => 1, fetchName: () => 'StockRefill', backpack,
            fetchLocX: () => 83396, fetchLocY: () => 147904, fetchLocZ: () => -3400,
            fetchExp: () => Data.experience[39], fetchSp: () => 0,
            fetchHp: () => 187, fetchMaxHp: () => 187, fetchMp: () => 74, fetchMaxMp: () => 74 };
        const session = { accountId: 'bot_stock_refill', actor, coldLifeState: { phase: 'hot', activity: 'shopping', stats: { classId: 1 } },
            dataSendToMe() {} };
        actor.session = session;
        session.coldLifeState = await Life.upsertState({ ...Economy.stateForActor(actor), characterId: id,
            accountName: 'bot_stock_refill', name: 'StockRefill', phase: 'hot', activity: 'shopping', currentRegion: 'Giran',
            level: 40, adena: 10000000, stats: { classId: 1, money: [1, 0, 0, 0] },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, timing: {} }, 'stock_native_actor');
        assert(Life.hotRow(id), 'the fixture has retained native hot authority before the purchase');
        const empty = Economy.stateForActor(actor), before = Economy.basics(empty).stock('shots');
        assert.equal(before.itemId, SHOT);
        assert(before.usePerHour > 0 && before.target > 1000);
        const unitPrice = Npc.quoteFor(SHOT, 'Giran').price;
        assert(Number.isSafeInteger(unitPrice) && unitPrice > 0);
        console.log('NATIVE_STOCK_TARGET', JSON.stringify({ characterId: id, level: 40, classId: 1, weaponId: SWORD,
            target: before.target, targetHours: before.targetHours, usePerHour: before.usePerHour,
            perAction: Shot.planForState(empty).perAction, unitPrice }));
        // MVP-1: the stock wish is funded over the shot's survival kit only by a
        // path with a step now, the NPC quote over prepared town routes (the
        // worker prepares them before a review; here the bot's own rows).
        const EconomicTrip = require('../src/GameServer/Bot/Economy/EconomicTrip');
        const steps = EconomicTrip.prepare(empty); let prepared;
        do prepared = steps.next(); while (!prepared.done);
        Economy.forState(Economy.stateForActor(actor), { routeRows: prepared.value });
        const purchase = await Shot.purchaseActorRestock(actor, { town: 'Giran', potionUnitPrice: 0 });
        assert.equal(purchase.ok, true);
        assert.equal(purchase.delta, before.target, 'the paid physical purchase reaches the native target from an absent stack');
        assert.equal(purchase.cost / purchase.delta, Npc.quoteFor(SHOT, 'Giran').price,
            'the default direct actor adapter pays the current NPC quote after native economy preparation');
        const rowsAfterPurchase = await Database.fetchItems(id);
        assert.equal(rowsAfterPurchase.find(row => row.selfId === SHOT).amount, before.target);
        assert.equal(rowsAfterPurchase.find(row => row.selfId === 57).amount, 10000000 - purchase.cost);
        const after = Economy.stateForActor(actor), afterStock = Economy.basics(after).stock('shots');
        const coldSales = ItemDisposition.saleCandidates(after, { unlimited: true }).filter(row => row.selfId === SHOT);
        const liquidation = ItemDisposition.npcLiquidationCandidates(after).filter(row => row.selfId === SHOT);
        Response.speak = Response.itemsList = Response.userInfo = () => Buffer.alloc(0);
        await SellJunk(session, ['sell-junk']);
        await new Promise(resolve => setImmediate(resolve));
        const rowsAfterHotSale = await Database.fetchItems(id);
        // The normal hot market can retain surplus for the board. Forced
        // cold NPC cleanup uses its native liquidation set and real writer.
        const saved = await Life.upsertState({ ...after, accountName: 'bot_stock_refill', name: 'StockRefill',
            inventory: Life.inventorySummaryFromItems(rowsAfterHotSale), physicalInventory: undefined }, 'stock_refill_preservation');
        assert(saved, 'native inventory summaries must persist before the cold liquidation');
        if (liquidation.length) await Life.applyNpcLiquidation(saved, liquidation);
        const rowsAfterSale = await Database.fetchItems(id);
        const physicalSold = before.target - Number(rowsAfterSale.find(row => row.selfId === SHOT)?.amount || 0);
        const payout = rowsAfterSale.find(row => row.selfId === 57).amount - rowsAfterPurchase.find(row => row.selfId === 57).amount;
        console.log(JSON.stringify({ bought: purchase.delta, spent: purchase.cost, emptyHours: before.targetHours,
            filledHours: afterStock.targetHours, filledTarget: afterStock.target, coldSale: coldSales.reduce((sum, row) => sum + row.count, 0),
            hotSold: before.target - Number(rowsAfterHotSale.find(row => row.selfId === SHOT)?.amount || 0), physicalSold, payout }));
        assert.equal(afterStock.targetHours, before.targetHours);
        assert.equal(afterStock.target, before.target, 'creating the physical stack cannot shorten its planned interval');
        assert.deepEqual(coldSales, []);
        assert.deepEqual(liquidation, []);
        assert.deepEqual(rowsAfterSale, rowsAfterPurchase, 'the real hot junk-sale handler sells none of the purchased stock');
        console.log(`PASS native empty stack -> paid SQLite refill ${purchase.delta} shots/${purchase.cost} adena -> hot/cold sale0; T=${before.targetHours}`);
    } finally {
        Object.assign(Response, responseOriginals);
        await Database.close();
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
