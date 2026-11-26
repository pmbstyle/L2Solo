'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Actor/Actor');
const Data = invoke('GameServer/DataCache');
const Board = require('../src/GameServer/AfkTrade/PlayerBoardWindow');
const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
const HtmlLink = invoke('GameServer/Network/Request/HtmlLink');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const NativeChoice = require('./helpers/nativeMarketChoice');
const seller = 730702, buyer = 730703, supplier = 730704;
const point = { locX: 83396, locY: 147904, locZ: -3404 };
const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 30000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw Error('timeout: ' + label);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};
(async () => {
    const fixture = await createWorld([{ id: seller, name: 'BoardSeller' }, { id: buyer, name: 'BoardBuyer', level: 30 },
        { id: supplier, name: 'BoardSupply' }], 'player-board-sale');
    try {
        World.user = { sessions: [], revision: 0 };
        for (const id of [seller, buyer, supplier]) {
            const account = id === buyer ? 'bot_board_sale_buyer' : id === supplier ? 'bot_board_sale_supplier' : 'board_sale_seller';
            await Database.createAccount(account, 'test');
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', [account, id]]);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: id === buyer ? 1000000 : 100000 });
        }
        await Database.setItem(seller, { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
        const originalWornSword = (await Database.fetchItems(seller)).find(row => row.selfId === 1);
        assert(originalWornSword.equipped && originalWornSword.slot === 7);
        const kit = require('./fixtures/profitable_stock_state').kitFor(0, 30);
        const lookup = invoke('GameServer/Bot/Population/ColdNpcPlanningCatalog').createLookup(Coordinator.npcPlanningCatalogRows());
        const missing = kit.entries.find(item => [6, 9, 12].includes(Number(item.slot))
            && kit.inventory[item.selfId].amount === 1 && lookup.offersFor(item.selfId).length > 0);
        assert(missing, 'the buyer has a native D kit with one canonical wearable gap');
        for (const item of kit.entries.filter(item => item.selfId !== missing.selfId)) {
            const template = Data.items.find(row => Number(row.selfId) === Number(item.selfId));
            await Database.setItem(buyer, { selfId: Number(item.selfId), name: template.template.name,
                amount: 1, equipped: true, slot: Number(item.slot), enchant: 0 });
        }
        // It holds its shot stock, so its one gear gap is what it buys.
        await Database.setItem(buyer, { selfId: 1463, name: 'Soulshot: D-grade', amount: 10000, stackable: true, slot: 0 });
        await Database.execute(['UPDATE characters SET exp=?,locX=?,locY=?,locZ=?,hp=1000,maxHp=1000,mp=1000,maxMp=1000 WHERE id=?',
            [Number(Data.experience[29]), point.locX, point.locY, point.locZ, buyer]]);
        await Life.init();
        await Life.upsertState({ characterId: buyer, name: 'BoardBuyer', level: 30, exp: Number(Data.experience[29]),
            phase: 'cold', activity: 'hunting', loc: point, currentRegion: 'Giran', spotId: '7_20', adena: 1000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(buyer)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            persona: { primaryDrive: 'wealth', traits: {} },
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 30 },
            timing: { lastResolvedAt: Date.now(), nextResolveAt: Date.now() + 3600000 } }, 'board_buyer_fixture');
        await Afk.init();
        const initial = await NativeChoice.capture(Life.cachedState(buyer), { nativeRoutes: true }, 'board_native_wanted');
        const wanted = initial.captured.queue.find(row => row.key === initial.read.activity?.rootKey && row.object?.slot);
        assert(wanted?.funded && !initial.read.activity?.funding, 'the actual native buyer funds its selected gear wish');
        const itemId = wanted.object.itemId;
        const itemTemplate = Data.items.find(row => Number(row.selfId) === itemId);
        assert(itemTemplate);
        assert.equal(await fixture.amount(buyer, itemId), 0, 'the native wanted item is absent from the buyer physical bag');
        for (const owner of [seller, supplier]) await Database.setItem(owner,
            { selfId: itemId, name: itemTemplate.template.name, amount: 1,
                equipped: owner === seller, slot: owner === seller ? wanted.object.slot : 0 });
        const originalWornGoods = (await Database.fetchItems(seller)).find(row => row.selfId === itemId);
        assert(originalWornGoods.equipped && originalWornGoods.slot === wanted.object.slot);
        // This physical alternative is the native selected item, at the
        // original price. The meeting worker still creates its own certificate.
        const alternative = (await Database.fetchItems(supplier)).find(row => row.selfId === itemId);
        const supply = await Database.createAfkTradeShop(supplier, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: alternative.id, selfId: itemId, count: 1, price: 1 }] });
        Afk.refreshRecord(supply.shop);
        const budgetState = await Life.upsertState(initial.state, 'board_native_budget_publication');
        assert.deepEqual(budgetState.stats.money, initial.captured.statsPacket.money, 'the database publication retains the actual initial native budget');
        const budgetChoice = await NativeChoice.capture(Life.cachedState(buyer), { nativeRoutes: true }, 'board_current_native_budget');
        const currentWanted = budgetChoice.captured.queue.find(row => row.key === budgetChoice.read.activity?.rootKey);
        assert(currentWanted?.object?.itemId === itemId && currentWanted.funded && !budgetChoice.read.activity?.funding
            && Array.isArray(budgetChoice.captured.statsPacket.money),
        `current published buyer funds the same native wanted item: ${JSON.stringify({ activity: budgetChoice.read.activity,
            queue: budgetChoice.captured.queue, money: budgetChoice.captured.statsPacket.money })}`);
        const sessions = new Map();
        for (const id of [seller]) {
            const [row] = await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]);
            const session = { accountId: row.username, packets: [], socket: { write() {} }, fetchAccountId() { return this.accountId; },
                dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
            const template = Data.classTemplates.find(row => row.classId === 0);
            session.actor = new Actor(session, { ...row, ...utils.crushOb(template), ...point,
                items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
            session.actor.setIsOnline(true); World.insertUser(session); sessions.set(id, session);
        }
        const session = sessions.get(seller);
        const html = () => session.packets.filter(packet => packet[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
        const texts = () => session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 614)
            .map(packet => packet.subarray(13).toString('utf16le').split('\0')[0]);
        const click = async command => {
            const before = session.packets.filter(packet => packet[0] === 0x0f).length;
            HtmlLink(session, Buffer.concat([Buffer.from([0x21]), Buffer.from(command + '\0', 'utf16le')]));
            await waitFor(() => session.packets.filter(packet => packet[0] === 0x0f).length > before, command);
        };
        const bid = await Database.createAfkTradeShop(buyer, { kind: 'buy_ad', storeType: 3, town: 'Giran', ...point,
            lines: [{ selfId: itemId, count: 1, price: 1 }] });
        Afk.refreshRecord(bid.shop);
        const requireIntent = choice => assert(choice.captured.tradeIntents.some(row => row.itemId === itemId
            && row.amount >= 1 && row.worth >= 1), `actual native player-supply intent: ${JSON.stringify({
            wanted: itemId, activity: choice.read.activity, intents: choice.captured.tradeIntents, queue: choice.captured.queue })}`);
        const publicChoice = await NativeChoice.capture(Life.cachedState(buyer), { nativeRoutes: true }, 'board_public_supply');
        requireIntent(publicChoice);
        const published = await Life.upsertState(publicChoice.state, 'board_native_packet_publication');
        const currentChoice = await NativeChoice.capture(Life.cachedState(buyer), { nativeRoutes: true }, 'board_published_current');
        assert.strictEqual(currentChoice.state.updatedAt, published.updatedAt);
        requireIntent(currentChoice);
        await Meetings.init();
        Coordinator.pauseReasons.add('fixture'); await Coordinator.start();
        await waitFor(() => Coordinator.ready && Coordinator.snapshotsLoaded, 'buyer worker startup');
        Board.show(session, { side: 3, town: 'Giran', selfId: itemId });
        const sell = /action="bypass -h (board answer buy_ad [^"]+)"><font[^>]*>Sell<\/font>/.exec(html());
        assert(sell, html()); await click(sell[1]);
        assert(html().includes('enough unequipped items'), html());
        const rejectedGoods = (await Database.fetchItems(seller)).find(row => row.selfId === itemId);
        assert.equal(rejectedGoods.id, originalWornGoods.id, 'rejection retains the same physical worn item');
        assert.equal(rejectedGoods.equipped, originalWornGoods.equipped);
        assert.equal(rejectedGoods.slot, originalWornGoods.slot);
        assert.equal(await fixture.amount(seller, itemId), 1);
        assert.equal(await fixture.amount(seller, 57), 100000);
        assert.equal(await fixture.amount(buyer, 57), 1000000);
        assert.equal(await fixture.amount(buyer, itemId), 0);
        assert.equal(await fixture.amount(supplier, itemId), 1);
        const wornGoods = session.actor.backpack.fetchItems().find(item => item.fetchId() === originalWornGoods.id);
        assert(wornGoods.fetchEquipped(), 'the live actor also wears the rejected physical item');
        session.actor.backpack.unequipGear(session, wornGoods.fetchSlot());
        assert.equal(wornGoods.fetchEquipped(), false);
        await waitFor(async () => (await Database.fetchItems(seller)).some(row => row.id === originalWornGoods.id
            && !row.equipped && row.slot === 0 && row.amount === 1), 'native unequip persistence');
        assert(session.actor.backpack.fetchItems().find(item => item.fetchId() === originalWornSword.id).fetchEquipped(),
            'removing the sale item leaves the original sword worn');
        const stillWornSword = (await Database.fetchItems(seller)).find(row => row.selfId === 1);
        assert.equal(stillWornSword.id, originalWornSword.id);
        assert.equal(stillWornSword.equipped, originalWornSword.equipped);
        assert.equal(stillWornSword.amount, 1);
        Board.show(session, { side: 3, town: 'Giran', selfId: itemId });
        const resumedSell = /action="bypass -h (board answer buy_ad [^"]+)"><font[^>]*>Sell<\/font>/.exec(html());
        assert(resumedSell, html());
        assert.equal(resumedSell[1], sell[1], 'unequipped goods use the same native funded bid');
        await click(resumedSell[1]);
        assert(html().includes('Sell items'), html());
        await click('board quantity 1'); assert(html().includes('1 a'), html());
        await click('board agree');
        await waitFor(() => !session.playerBoardAgreePending, 'sale agreement');
        assert(/Trade agreed|Trade completed/.test(html()), html());
        await waitFor(async () => await fixture.amount(seller, 57) === 100001 && await fixture.amount(buyer, itemId) === 1,
            'native player sale delivery');
        await waitFor(() => texts().some(text => /Trade completed/.test(text)), 'seller completion notification');
        assert.equal(await fixture.amount(seller, itemId), 0); assert.equal(await fixture.amount(buyer, 57), 999999);
        assert.equal(await fixture.amount(supplier, itemId), 1, 'the alternative market source is not consumed by the player sale');
        const cash = session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 30);
        assert.equal(cash.length, 1); assert.equal(cash[0].readInt32LE(9), 3); assert.equal(cash[0].readInt32LE(13), 57);
        assert.equal(texts().filter(text => /Trade completed/.test(text)).length, 1);
        assert.equal(session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 57)
            .reduce((n, item) => n + item.fetchAmount(), 0), 100001);
        await click('board agree');
        assert.equal(await fixture.amount(seller, 57), 100001); assert.equal(await fixture.amount(seller, itemId), 0);
        assert.equal(texts().filter(text => /Trade completed/.test(text)).length, 1, 'old agreement does not sell another batch');
        assert.equal(await fixture.amount(seller, 1), 1); assert.equal(await fixture.amount(seller, 57), 100001);
        const rejectedWornSword = (await Database.fetchItems(seller)).find(row => row.selfId === 1);
        assert.equal(rejectedWornSword.id, originalWornSword.id, 'the seller retains the same physical worn sword');
        assert.equal(rejectedWornSword.equipped, originalWornSword.equipped);
        assert.equal(rejectedWornSword.slot, originalWornSword.slot);
        assert.equal(await fixture.amount(buyer, 57), 999999);
        console.log('PASS actual player Sell/quantity/agree HTML, native item and money direction, seller adena pickup, repeat and worn-item rejection');
    } finally { Meetings.reset(); if (Coordinator.started) await Coordinator.stop(); Afk._resetForTests(); await fixture.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
