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
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const HtmlLink = invoke('GameServer/Network/Request/HtmlLink');
const seller = 730501, buyer = 730502;
const point = { locX: 83396, locY: 147904, locZ: -3404 };
const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 30000;
    while (!await predicate()) {
        if (Date.now() > deadline) throw Error('timeout: ' + label);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};
(async () => {
    const fixture = await createWorld([{ id: seller, name: 'MeetingSeller', level: 20 },
        { id: buyer, name: 'MeetingPlayer', level: 20 }], 'player-board-meeting');
    let session;
    try {
        World.user = { sessions: [], revision: 0 };
        await Database.createAccount('bot_board_meeting', 'test');
        await Database.execute(["UPDATE characters SET username='bot_board_meeting' WHERE id=?", [seller]]);
        for (const id of [seller, buyer]) await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        await Database.setItem(seller, { selfId: 20, name: 'Buckler', amount: 1, slot: 8 });
        await Database.setItem(seller, { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
        await Life.init();
        await Life.upsertState({ characterId: seller, name: 'MeetingSeller', phase: 'cold', activity: 'hunting',
            level: 20, adena: 1000000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(seller)),
            loc: point, currentRegion: 'Giran', vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            stats: { classId: 0, generatedCold: true, money: [100, 0, 1000, 0] },
            timing: { lastResolvedAt: Date.now(), nextResolveAt: Date.now() + 3600000 } }, 'meeting_fixture');
        await Afk.init();
        const stock = (await Database.fetchItems(seller)).find(row => row.selfId === 20);
        const sale = await Database.createAfkTradeShop(seller, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: stock.id, selfId: 20, count: 1, price: 4079 }] });
        Afk.refreshRecord(sale.shop);
        await Database.setItem(seller, { selfId: 62, name: 'Mithril Boots', amount: 1, slot: 12 });
        const boots = (await Database.fetchItems(seller)).find(row => row.selfId === 62);
        const bootSale = await Database.createAfkTradeShop(seller, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: boots.id, selfId: 62, count: 1, price: 519498 }] });
        Afk.refreshRecord(bootSale.shop);
        await Database.execute(['UPDATE items SET equipped=1 WHERE id=?', [boots.id]]);
        await Life.upsertState({ ...Life.cachedState(seller),
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(seller)) }, 'meeting_worn_item');
        const [row] = await Database.execute(['SELECT * FROM characters WHERE id=?', [buyer]]);
        session = { accountId: 'quests', packets: [], socket: { write() {} }, fetchAccountId() { return this.accountId; },
            dataSendToMe(packet) { this.packets.push(packet); }, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
        const template = Data.classTemplates.find(row => row.classId === 0);
        session.actor = new Actor(session, { ...row, ...utils.crushOb(template), ...point,
            items: await Database.fetchItems(buyer), paperdoll: utils.tupleAlloc(16, {}) });
        session.actor.setIsOnline(true); World.insertUser(session);
        await Meetings.init();
        Coordinator.pauseReasons.add('fixture');
        await Coordinator.start();
        await waitFor(() => Coordinator.ready && Coordinator.snapshotsLoaded, 'worker startup');
        const html = () => session.packets.filter(packet => packet[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
        const click = async command => {
            const before = session.packets.filter(packet => packet[0] === 0x0f).length;
            HtmlLink(session, Buffer.concat([Buffer.from([0x21]), Buffer.from(command + '\0', 'utf16le')]));
            await waitFor(() => session.packets.filter(packet => packet[0] === 0x0f).length > before, command);
        };
        Board.show(session, { side: 1, town: 'Giran' });
        const buy = /action="bypass -h (board answer [^"]+)"><font[^>]*>Buy<\/font>/.exec(html())[1];
        await click(buy);
        assert(html().includes('Agree and wait'), html());
        assert.equal(Meetings.counters().preparations, 0, 'reading the quantity form must not hold a bot preparation');
        // Ordinary hunting can advance the bot while the human reads the form.
        assert.equal(Coordinator.commandInflight.size, 0, 'the form must not start a worker approval');
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [seller]]);
        Life.acceptLifecycleRow(await Database.fetchTradeMeetingOwnerState(seller));
        await click('board agree');
        assert(html().includes('Checking the trade'), html());
        await waitFor(() => !session.playerBoardAgreePending, 'agreement result');
        assert(/Trade agreed|Trade completed/.test(html()), html());
        await waitFor(async () => (await fixture.amount(buyer, 20)) === 1, 'completed player purchase');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079);
        assert.equal(await fixture.amount(seller, 57), 1000000 + 4079);
        assert.equal(await fixture.amount(seller, 20), 0);
        assert.equal(Meetings.counters().preparations, 0);
        Board.show(session, { side: 1, town: 'Giran' });
        const buyBoots = /action="bypass -h (board answer sell_ad \d+ \d+ 62 [^"]+)">/.exec(html())[1];
        await click(buyBoots);
        assert(html().includes('Worn items cannot be sold'), html());
        assert.equal(await Database.fetchAfkTradeShop(bootSale.shop.id), null, 'stale worn-item advertisement is removed');
        assert.equal((await Database.fetchItems(seller)).find(row => row.id === boots.id).equipped, 1);
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079, 'a rejected worn-item offer moves no adena');
        console.log('PASS player HTML links, actual worker consent, native reservation and delivery conserve goods and adena');
    } finally {
        Meetings.reset();
        if (Coordinator.started) await Coordinator.stop();
        Afk._resetForTests();
        await fixture.close();
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
