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
    const fixture = await createWorld([{ id: seller, name: 'BoardSeller' }, { id: buyer, name: 'BoardBuyer' },
        { id: supplier, name: 'BoardSupply' }], 'player-board-sale');
    try {
        World.user = { sessions: [], revision: 0 };
        for (const id of [seller, buyer, supplier]) {
            const account = id === buyer ? 'bot_board_sale_buyer' : id === supplier ? 'bot_board_sale_supplier' : 'board_sale_seller';
            await Database.createAccount(account, 'test');
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', [account, id]]);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: id === buyer ? 1000000 : 100000 });
        }
        await Database.setItem(seller, { selfId: 48, name: 'Short Gloves', amount: 1, slot: 9 });
        await Database.setItem(supplier, { selfId: 48, name: 'Short Gloves', amount: 1, slot: 9 });
        await Database.setItem(seller, { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
        await Database.setItem(buyer, { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
        for (const selfId of [1869, 1870]) await Database.setItem(buyer, { selfId, name: 'Material', amount: 1000000 });
        await Life.init();
        const village = invoke('GameServer/Bot/Economy/MarketTownPolicy').NO_GRADE_MARKETS.find(row => row.name === 'Elven Village');
        const spot = invoke('GameServer/Bot/Population/SpotProfiles').ensure().filter(row => row.center).sort((a, b) =>
            Math.hypot(a.center.locX - village.locX, a.center.locY - village.locY)
            - Math.hypot(b.center.locX - village.locX, b.center.locY - village.locY))[0];
        await Life.upsertState({ characterId: buyer, name: 'BoardBuyer', level: 20, exp: Number(Data.experience[19]),
            phase: 'cold', activity: 'hunting', loc: point, currentRegion: 'Giran', spotId: String(spot.id), adena: 1000000,
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(buyer)),
            vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
            stats: { classId: 0, generatedCold: true, classProgressionClassId: 0, classProgressionLevel: 20,
                money: [100, 0, 1000, 0] },
            timing: { lastResolvedAt: Date.now(), nextResolveAt: Date.now() + 3600000 } }, 'board_buyer_fixture');
        await Afk.init();
        // A cheap, real market alternative makes these gloves a current power
        // wish instead of an NPC purchase. The worker must certify that wish.
        const alternative = (await Database.fetchItems(supplier)).find(row => row.selfId === 48);
        const supply = await Database.createAfkTradeShop(supplier, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: alternative.id, selfId: 48, count: 1, price: 1 }] });
        Afk.refreshRecord(supply.shop);
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
        await Meetings.init();
        Coordinator.pauseReasons.add('fixture'); await Coordinator.start();
        await waitFor(() => Coordinator.ready && Coordinator.snapshotsLoaded, 'buyer worker startup');
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
            lines: [{ selfId: 48, count: 1, price: 1 }] });
        Afk.refreshRecord(bid.shop); Board.show(session, { side: 3, town: 'Giran', selfId: 48 });
        const sell = /action="bypass -h (board answer buy_ad [^"]+)"><font[^>]*>Sell<\/font>/.exec(html());
        assert(sell, html()); await click(sell[1]);
        assert(html().includes('Sell items'), html());
        await click('board quantity 1'); assert(html().includes('1 a'), html());
        await click('board agree');
        await waitFor(() => !session.playerBoardAgreePending, 'sale agreement');
        assert(/Trade agreed|Trade completed/.test(html()), html());
        await waitFor(async () => await fixture.amount(seller, 57) === 100001 && await fixture.amount(buyer, 48) === 1,
            'native player sale delivery');
        await waitFor(() => texts().some(text => /Trade completed/.test(text)), 'seller completion notification');
        assert.equal(await fixture.amount(seller, 48), 0); assert.equal(await fixture.amount(buyer, 57), 999999);
        assert.equal(await fixture.amount(supplier, 48), 1, 'the alternative market source is not consumed by the player sale');
        const cash = session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 30);
        assert.equal(cash.length, 1); assert.equal(cash[0].readInt32LE(9), 3); assert.equal(cash[0].readInt32LE(13), 57);
        assert.equal(texts().filter(text => /Trade completed/.test(text)).length, 1);
        assert.equal(session.actor.backpack.fetchItems().filter(item => item.fetchSelfId() === 57)
            .reduce((n, item) => n + item.fetchAmount(), 0), 100001);
        await click('board agree');
        assert.equal(await fixture.amount(seller, 57), 100001); assert.equal(await fixture.amount(seller, 48), 0);
        assert.equal(texts().filter(text => /Trade completed/.test(text)).length, 1, 'old agreement does not sell another batch');
        const wornBid = await Database.createAfkTradeShop(buyer, { kind: 'buy_ad', storeType: 3, town: 'Giran', ...point,
            lines: [{ selfId: 1, count: 1, price: 100 }] });
        Afk.refreshRecord(wornBid.shop); Board.show(session, { side: 3, town: 'Giran', selfId: 1 });
        await click(/action="bypass -h (board answer buy_ad [^"]+)"><font[^>]*>Sell<\/font>/.exec(html())[1]);
        assert(html().includes('enough unequipped items'), html());
        assert.equal(await fixture.amount(seller, 1), 1); assert.equal(await fixture.amount(seller, 57), 100001);
        console.log('PASS actual player Sell/quantity/agree HTML, native item and money direction, seller adena pickup, repeat and worn-item rejection');
    } finally { Meetings.reset(); if (Coordinator.started) await Coordinator.stop(); Afk._resetForTests(); await fixture.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
