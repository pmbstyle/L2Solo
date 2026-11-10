'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('standing-sale-quantity');
require('../src/Global'); fixture.assertConfigured(options.default);
const Data = invoke('GameServer/DataCache'), Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Listing = invoke('GameServer/Bot/Economy/MarketListingPolicy');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Response = invoke('GameServer/Network/Response');
const SellJunk = invoke('GameServer/World/Generics/NpcBypasses/SellJunk');
const Native = require('./helpers/nativeMarketFixture');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const original = { context: Pricing.traderContext, disposition: Pricing.disposition,
    lineState: Pricing.lineState, town: Town.targetTownForItems,
    itemsList: Response.itemsList, userInfo: Response.userInfo, speak: Response.speak };
const id = 938051, point = { locX: 83396, locY: 147904, locZ: -3400 };
let residualBuyer = false, keepEnchanted = true;
const calls = [];
function summary(selfId, count, start = 1, enchant = 0) {
    return { selfId, amount: count, stackable: false, equippedCount: 0,
        instances: Array.from({ length: count }, (_, at) => ({ id: start + at, amount: 1, enchant, equipped: false })) };
}
function base(inventory) {
    return { characterId: id, name: 'QuantitySeller', accountName: 'bot_quantity_seller', level: 43,
        phase: 'cold', activity: 'shopping', currentRegion: 'Giran', loc: point,
        adena: 1000, stats: { classId: 51 }, timing: {}, inventory: {
            347: { selfId: 347, amount: 1, equipped: true, equippedCount: 1, slot: 10, stackable: false },
            ...inventory } };
}
function boardLine(board, { selfId = 21, count = 1, enchant = 0, custodyPolicy = 1, record = 80, line = 81, price = 189 } = {}) {
    board.put({ id: record, ownerId: id, storeType: 1, kind: custodyPolicy ? 'sell_ad' : 'shop',
        custodyPolicy, town: 'Giran', lines: [{ lineId: line, selfId, count, enchant, price }] });
}
function evaluate(state, board, extra = {}, project = true) {
    const deps = { board, keptAmounts: {}, preparedReservations: {}, ...extra };
    const input = project ? Listing.ownSaleInputs(state, board.ownerLines(id), deps) : { state, options: deps };
    return Listing.evaluate(input.state, input.options);
}
const units = rows => rows.reduce((sum, row) => sum + row.count, 0);
async function seed(owner, name) {
    await Native.character(Database, owner, name, `bot_quantity_${owner}`, point);
    await Database.execute(['UPDATE characters SET classId=51,level=43 WHERE id=?', [owner]]);
    await Database.setItem(owner, { selfId: 57, name: 'Adena', amount: 1000 });
    await Database.setItem(owner, { selfId: 347, name: 'Ring Mail Breastplate', amount: 1, equipped: true, slot: 10 });
    const copies = [];
    for (const enchant of [0, 0, 0, 6]) copies.push(Number((await Database.setItem(owner,
        { selfId: 21, name: 'Shirt', amount: 1, enchant, equipped: false, slot: 0 })).insertId));
    return { copies, state: await Life.upsertState({ ...base({}), characterId: owner,
        accountName: `bot_quantity_${owner}`, name,
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(owner)) }, 'quantity_fixture') };
}
async function run() {
    try {
        Data.init(); await Database.init(); await Life.init();
        // Isolate valuation outcomes while using the real reservation, lot,
        // publication and NPC mutation paths below.
        Pricing.traderContext = (state, deps = {}) => ({ characterId: state.characterId,
            timestamp: 1800000000000, board: deps.board || Afk.boardIndex(), economy: { craftReservations: {} } });
        Town.targetTownForItems = () => 'Giran';
        Pricing.lineState = () => null;
        Pricing.disposition = (item, _ctx, deps) => {
            calls.push({ count: item.count, quote: deps.stockQuote, room: deps.room });
            if (residualBuyer && !deps.stockQuote) return { action: 'ad', gain: 0,
                answer: { count: item.count, receipts: item.count * 200,
                    line: { recordId: 90, lineId: 91, town: 'Giran' } } };
            return { action: deps.stockQuote || keepEnchanted && item.enchant === 6 ? 'list' : 'npc', gain: 0,
                priced: { ask: { price: 189, npc: !deps.stockQuote, stockQuote: deps.stockQuote }, market: { buyback: 73 } } };
        };
        const board = new BoardIndex(); boardLine(board);
        const state = base({ 21: summary(21, 3) });
        let sale = evaluate(state, board);
        assert.equal(units(sale.listings), 1, 'one conditional ad retains one of three copies');
        assert.equal(units(sale.npc), 2, 'unadvertised copies independently reach NPC valuation');
        assert.deepEqual(sale.npc[0].objectIds, [2, 3]);
        assert.deepEqual(calls.at(-1), { count: 2, quote: false, room: 0 }, 'an occupied line cannot quote phantom extra units');
        residualBuyer = true;
        sale = evaluate(state, board);
        assert.equal(sale.answers[0].count, 2, 'the residual can choose a real buyer instead of mandatory NPC liquidation');
        assert.equal(units(sale.listings), 1);
        residualBuyer = false;
        assert.equal(units(evaluate(state, board, { preparedReservations: { 21: 2 } }).npc), 0,
            'equipment-project inputs remain reserved before listed amounts are allocated');
        const stale = new BoardIndex(); boardLine(stale, { count: 10 });
        assert.equal(units(evaluate(state, stale).listings), 3, 'an old quantity is clamped to actual free stock');
        const fresh = evaluate(state, new BoardIndex());
        assert.equal(units(fresh.listings), 1, 'a new non-stackable line nominates one physical instance');
        assert.equal(units(fresh.npc), 2, 'a new quote cannot defer all additional copies either');
        const materials = base({ 1869: { selfId: 1869, amount: 100, stackable: true } });
        const materialBoard = new BoardIndex(); boardLine(materialBoard, { selfId: 1869, count: 30 });
        const partial = evaluate(materials, materialBoard);
        assert.equal(units(partial.listings), 100, 'a standing stack line takes the further units at its price');
        assert.equal(units(partial.npc), 0, 'none of a listed material goes to the NPC at half price');
        assert.equal(units(evaluate(materials, new BoardIndex()).listings), 100, 'a new stack line can physically list the entire stack');
        const shopBoard = new BoardIndex(); boardLine(shopBoard, { custodyPolicy: 0 });
        const backed = evaluate(state, shopBoard);
        assert.equal(units(backed.listings), 1);
        assert.deepEqual(backed.npc[0].objectIds, [1, 2, 3], 'escrow is accounted once and the free bag copies remain sellable');
        assert.equal(units(evaluate(state, shopBoard, {}, false).npc), 3,
            'a backed shop does not reserve additional bag copies when escrow is absent from the projection');
        const twoLines = new BoardIndex();
        twoLines.put({ id: 82, ownerId: id, storeType: 1, kind: 'shop', custodyPolicy: 0, town: 'Giran',
            lines: [{ lineId: 83, selfId: 21, count: 1, enchant: 0, price: 189 },
                { lineId: 84, selfId: 21, count: 1, enchant: 0, price: 189 }] });
        const twoHeld = evaluate(state, twoLines);
        assert.equal(units(twoHeld.listings), 2, 'counts from separate physical lines of the same type are added');
        assert.deepEqual(twoHeld.npc[0].objectIds, [1, 2, 3], 'two escrow lines still leave exactly the three bag copies free');
        const enchanted = base({ 21: { ...summary(21, 2), amount: 4,
            instances: [...summary(21, 2).instances, ...summary(21, 2, 3, 6).instances] } });
        const enchantedSale = evaluate(enchanted, board);
        assert.deepEqual(enchantedSale.listings.map(row => [row.enchant, row.count]), [[0, 1], [6, 1]],
            'the standing +0 quote cannot retain the separate +6 stock');

        const first = await seed(id, 'QuantityAd');
        await Afk.openBotRecords(id, 'sell_ad', [{ storeType: 1, title: 'Shirt', town: 'Giran', ...point,
            lines: [{ objectId: first.copies[0], selfId: 21, name: 'Shirt', count: 1, price: 189, enchant: 0, stackable: false }] }]);
        let live = Life.snapshot(id) || first.state;
        sale = Market.saleDecision(live, { keptAmounts: {}, preparedReservations: {} });
        assert.equal(units(sale.npc), 2, 'the real board routes only the two extra +0 copies to the NPC');
        live = await Life.applyNpcLiquidation(live, sale.npc);
        const price = invoke('GameServer/Items/NpcSellRules').npcBuyPrice(Data.items.find(row => row.selfId === 21).template.price);
        assert.equal(live.adena, 1000 + 2 * price);
        let rows = await Database.fetchItems(id);
        assert.deepEqual(rows.filter(row => row.selfId === 21).map(row => [row.id, row.enchant]),
            [[first.copies[0], 0], [first.copies[3], 6]], 'native liquidation preserves the held and differently enchanted instances');
        assert.equal(Afk.boardIndex().ownerLines(id).find(row => row.selfId === 21).count, 1);
        const [saved] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
        assert.equal(Life.acceptLifecycleRow(saved).inventory[21].amount, 2, 'the residual sale survives a saved-state reload');

        const second = await seed(id + 1, 'QuantityShop');
        const [character] = await Database.execute(['SELECT * FROM characters WHERE id=?', [id + 1]]);
        await Afk.publishBot(id + 1, { storeType: 1, title: 'Shirt', town: 'Giran', ...point,
            appearance: { model: character }, lines: [{ objectId: second.copies[0], selfId: 21,
                name: 'Shirt', count: 1, price: 189, enchant: 0, stackable: false }] });
        const shopState = Life.snapshot(id + 1);
        const shopSale = Market.saleDecision(shopState, { keptAmounts: {}, preparedReservations: {} });
        assert.equal(units(shopSale.npc), 2, 'the real shop retains its escrow copy without shielding the bag');
        const cleaned = await Life.applyNpcLiquidation(shopState, shopSale.npc);
        assert.equal(cleaned.inventory[21].amount, 1);
        assert.equal(cleaned.inventory[21].instances[0].enchant, 6);
        assert.equal(cleaned.adena, 1000 + 2 * price);
        assert.equal(Afk.findOwnerProjection(id + 1).shop.lines[0].count, 1, 'NPC cleanup cannot consume backed stock');

        // Exercise the hot NPC handler with the real native item rows as well.
        keepEnchanted = false;
        for (let at = 0; at < 2; at++) await Database.setItem(id,
            { selfId: 21, name: 'Shirt', amount: 1, enchant: 0, equipped: false, slot: 0 });
        rows = await Database.fetchItems(id);
        const actorItem = row => ({
            fetchId: () => row.id, fetchSelfId: () => row.selfId, fetchAmount: () => row.amount,
            fetchEquipped: () => !!row.equipped, fetchEnchantLevel: () => row.enchant, fetchSlot: () => row.slot,
            fetchPrice: () => Data.items.find(item => item.selfId === row.selfId).template.price,
            fetchName: () => row.name, setAmount: value => { row.amount = value; }
        });
        const backpack = { items: rows.map(actorItem), fetchItems: () => backpack.items,
            stackableExists: async () => backpack.items.find(item => item.fetchSelfId() === 57) };
        Response.itemsList = Response.userInfo = Response.speak = () => Buffer.alloc(0);
        const session = { accountId: `bot_quantity_${id}`, coldLifeState: live, dataSendToMe() {}, actor: {
            fetchId: () => id, fetchLevel: () => 43, fetchClassId: () => 51, backpack } };
        await SellJunk(session);
        rows = await Database.fetchItems(id);
        assert.deepEqual(rows.filter(row => row.selfId === 21).map(row => [row.id, row.enchant]),
            [[first.copies[0], 0]], 'hot cleanup independently executes both +0 and +6 residual sales');
        assert.equal(Native.amount(rows, 57), 1000 + 5 * price, 'hot cleanup pays exactly for the three selected copies');
        for (let at = 0; at < 3; at++) await Database.setItem(id,
            { selfId: 21, name: 'Shirt', amount: 1, enchant: 0, equipped: false, slot: 0 });
        rows = await Database.fetchItems(id); backpack.items = rows.map(actorItem);
        session.coldLifeState = { ...live, stats: { ...live.stats, equipmentPlan: {
            status: 'active', target: { selfId: 1 }, combine: { requirements: [{ selfId: 21, amount: 2 }] } } } };
        await SellJunk(session);
        rows = await Database.fetchItems(id);
        assert.equal(Native.amount(rows, 21), 3, 'hot cleanup leaves two project inputs and one advertised copy');
        assert.equal(Native.amount(rows, 57), 1000 + 6 * price, 'a project reserve is subtracted once, regardless of bag order');
        // The advertised goods sold to an NPC or a fixed buyer: the conditional ad that kept
        // them in the bag no longer offers what the bot does not hold (the board's init
        // subscribes this to the owner's state changes).
        Life.subscribePublications(Afk.reconcileOwnStock);
        const third = await seed(id + 2, 'QuantitySold');
        await Afk.openBotRecords(id + 2, 'sell_ad', [{ storeType: 1, title: 'Shirt', town: 'Giran', ...point,
            lines: [{ objectId: third.copies[0], selfId: 21, name: 'Shirt', count: 1, price: 189, enchant: 0, stackable: false }] }]);
        assert.equal(Afk.boardIndex().ownerLines(id + 2).filter(row => row.selfId === 21).length, 1);
        await Life.applyNpcLiquidation(Life.snapshot(id + 2) || third.state, [{ selfId: 21, count: 3, enchant: 0, npcPrice: price,
            objectIds: third.copies.slice(0, 3) }]);
        for (let turn = 0; turn < 20 && Afk.boardIndex().ownerLines(id + 2).some(row => row.selfId === 21); turn++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(Afk.boardIndex().ownerLines(id + 2).filter(row => row.selfId === 21).length, 0,
            'an ad of goods sold to an NPC is trimmed at the owner\'s bag change');
        // A reserve keeps units of an item whatever their enchant: the owner's lines of it at
        // two enchant levels share its free units (bag less reserve) and offer no more than
        // the accept would let it part with.
        const fourth = await seed(id + 3, 'QuantityReserved');
        await Afk.openBotRecords(id + 3, 'sell_ad', [{ storeType: 1, title: 'Shirt', town: 'Giran', ...point,
            lines: [{ objectId: fourth.copies[0], selfId: 21, name: 'Shirt', count: 1, price: 189, enchant: 0, stackable: false }] },
        { storeType: 1, title: 'Shirt +6', town: 'Giran', ...point,
            lines: [{ objectId: fourth.copies[3], selfId: 21, name: 'Shirt', count: 1, price: 900, enchant: 6, stackable: false }] }]);
        await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.clanMaterialDemand',json('{\"21\":3}')) WHERE characterId=?", [id + 3]]);
        await Database.reconcileConditionalSellAds(id + 3);
        const offered = (await Database.fetchAfkTradeShops(id + 3)).flatMap(ad => ad.status === 'active' ? ad.lines : [])
            .filter(line => line.selfId === 21).reduce((sum, line) => sum + Number(line.count), 0);
        assert.equal(offered, 1, 'four shirts less a reserve of three: one offered over both enchant lines');
        console.log('PASS standing sale quantities: conditional, escrow, stacks, enchant, reservations, residual buyer, native cold/hot NPC sales');
    } finally {
        Pricing.traderContext = original.context; Pricing.disposition = original.disposition;
        Pricing.lineState = original.lineState; Town.targetTownForItems = original.town;
        Response.itemsList = original.itemsList; Response.userInfo = original.userInfo; Response.speak = original.speak;
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
