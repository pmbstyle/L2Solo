'use strict';
process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // The integration fixture verifies actual worker queue progress.
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
const workerFaults = [];
const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 30000;
    while (!await predicate()) {
        if (Date.now() > deadline) {
            const { worker, queue, snapshots } = Coordinator.snapshot();
            console.error(JSON.stringify({ worker, queue, snapshots }));
            throw Error('timeout: ' + label);
        }
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
        await Database.execute([`WITH RECURSIVE stock(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM stock WHERE n<4160)
            INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId)
            SELECT 952,'Magic Ring',1,n%7,0,0,? FROM stock`, [seller]]);
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
        const rings = Life.cachedState(seller).inventory[952];
        assert.equal(rings.instances.length, 4160);
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
        Coordinator.worker.on('message', message => { if (message.type === 'fault') workerFaults.push(message.payload.reason); });
        await waitFor(() => Coordinator.ready && Coordinator.snapshotsLoaded, 'worker startup');
        const html = () => session.packets.filter(packet => packet[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
        const tells = () => session.packets.filter(packet => packet[0] === 0x4a).map(packet => ({
            sender: packet.readInt32LE(1), kind: packet.readInt32LE(5),
            name: packet.subarray(9).toString('utf16le').split('\0')[0],
            text: packet.subarray(9).toString('utf16le').split('\0')[1]
        }));
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
        await waitFor(async () => (await fixture.amount(buyer, 20)) === 1
            && (await fixture.amount(seller, 57)) === 1000000 + 4079, 'completed player purchase');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079);
        assert.equal(await fixture.amount(seller, 57), 1000000 + 4079);
        assert.equal(await fixture.amount(seller, 20), 0);
        assert.deepEqual(tells(), [], 'a merchant already at the point does not claim to be on the way');
        assert.deepEqual(Life.cachedState(seller).inventory[952], rings, 'large physical bags survive worker consent and native custody publication');
        assert.equal(Meetings.counters().preparations, 0);
        Board.show(session, { side: 1, town: 'Giran' });
        const buyBoots = /action="bypass -h (board answer sell_ad \d+ \d+ 62 [^"]+)">/.exec(html())[1];
        await click(buyBoots);
        assert(html().includes('Worn items cannot be sold'), html());
        assert.deepEqual(tells(), [], 'rejected stock sends no private promise');
        assert.equal(await Database.fetchAfkTradeShop(bootSale.shop.id), null, 'stale worn-item advertisement is removed');
        assert.equal((await Database.fetchItems(seller)).find(row => row.id === boots.id).equipped, 1);
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079, 'a rejected worn-item offer moves no adena');

        // An accepted remote merchant finishes an overdue rest through the
        // actual worker, starts the native leg and delivers to the waiting player.
        const closed = await Database.closeBoardRecord(seller, sale.shop.id);
        Afk.refreshRecord(closed.record);
        await Database.setItem(seller, { selfId: 20, name: 'Buckler', amount: 1, slot: 8 });
        const remoteStock = (await Database.fetchItems(seller)).find(row => row.selfId === 20);
        const remoteSale = await Database.createAfkTradeShop(seller, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: remoteStock.id, selfId: 20, count: 1, price: 4080 }] });
        Afk.refreshRecord(remoteSale.shop);
        const recoveredAt = Date.now() - 1000;
        await Life.upsertState({ ...Life.cachedState(seller), activity: 'resting',
            loc: { ...point, locX: point.locX + 400 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(seller)),
            vitals: { hp: 10, maxHp: 187, mp: 74, maxMp: 74 },
            stats: { ...Life.cachedState(seller).stats, restUntil: recoveredAt },
            timing: { lastResolvedAt: recoveredAt - 3600000, nextResolveAt: recoveredAt } }, 'resting_merchant_fixture');
        Board.show(session, { side: 1, town: 'Giran' });
        const remoteBuy = new RegExp('action="bypass -h (board answer sell_ad ' + remoteSale.shop.id + ' [^"]+)"').exec(html())[1];
        await click(remoteBuy); await click('board agree');
        await waitFor(() => !session.playerBoardAgreePending, 'resting merchant agreement');
        assert(html().includes('Trade agreed'), html());
        assert.equal(Meetings.isPlayerWaiting(seller), true, 'accepted custody prioritizes the merchant while the human waits at the point');
        assert.equal(Coordinator.contextFor(Life.cachedState(seller)).playerWaiting, true,
            'the real coordinator carries waiting-player priority into the worker context');
        assert.equal(tells().length, 1, 'the accepted remote merchant privately acknowledges the reservation');
        assert.equal(tells()[0].sender, seller);
        assert.equal(tells()[0].kind, 2, 'meeting acknowledgement uses the private C4 chat channel');
        assert.equal(tells()[0].name, 'MeetingSeller');
        assert.match(tells()[0].text, /recover first.*Wait at the meeting point.*About/);
        const [remoteMeeting] = await Database.fetchTradeMeetingsForOwner(buyer);
        await Meetings.receipt(remoteMeeting.token, buyer);
        await Meetings.receipt(remoteMeeting.token, buyer);
        assert.equal(tells().length, 1, 'receipt retries and quantity-window refreshes never repeat the acknowledgement');
        Coordinator.setPauseReason('fixture', false);
        await waitFor(async () => (await fixture.amount(buyer, 20)) === 2
            && (await fixture.amount(seller, 57)) === 1000000 + 4079 + 4080, 'rest, native travel and delivery');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079 - 4080);
        assert.equal(await fixture.amount(seller, 57), 1000000 + 4079 + 4080);
        await waitFor(() => !Meetings.isPlayerWaiting(seller), 'retired waiting-player priority');
        assert.equal(tells().length, 1, 'worker lifecycle transitions do not spam the waiting player');
        assert.deepEqual(Life.cachedState(seller).inventory[952], rings);

        Coordinator.setPauseReason('fixture', true);
        const remoteClosed = await Database.closeBoardRecord(seller, remoteSale.shop.id);
        Afk.refreshRecord(remoteClosed.record);
        await Database.setItem(seller, { selfId: 20, name: 'Buckler', amount: 1, slot: 8 });
        const merchantArrival = Date.now() + 150000;
        await Life.upsertState({ ...Life.cachedState(seller), activity: 'traveling',
            loc: { ...point, locX: point.locX + 400 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(seller)),
            stats: { ...Life.cachedState(seller).stats, restUntil: null, travel: {
                from: { ...point, locX: point.locX + 400 }, to: point,
                reason: 'market_sale_inventory', method: 'walk', arrivalActivity: 'shopping',
                arrivalEvent: 'arrived_town', startedAt: Date.now(), arrivalAt: merchantArrival
            } },
            timing: { lastResolvedAt: Date.now(), nextResolveAt: merchantArrival } }, 'cancelled_merchant_fixture');
        const cancelStock = (await Database.fetchItems(seller)).find(row => row.selfId === 20);
        const cancelSale = await Database.createAfkTradeShop(seller, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...point,
            lines: [{ objectId: cancelStock.id, selfId: 20, count: 1, price: 4081 }] });
        Afk.refreshRecord(cancelSale.shop);
        Board.show(session, { side: 1, town: 'Giran' });
        await click(new RegExp('action="bypass -h (board answer sell_ad ' + cancelSale.shop.id + ' [^"]+)"').exec(html())[1]);
        await click('board agree');
        await waitFor(() => !session.playerBoardAgreePending, 'cancellable merchant agreement');
        assert.equal(Meetings.isPlayerWaiting(seller), true);
        assert.equal(tells().length, 2, 'a separate accepted trade receives its own private acknowledgement');
        assert.match(tells()[1].text, /on my way.*About 3 min/, 'an existing trip reports its remaining time rather than restarting the route estimate');
        await click('board cancel');
        await waitFor(() => !Meetings.isPlayerWaiting(seller), 'cancelled waiting-player priority');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079 - 4080, 'cancelling the priority transition refunds native escrow');
        assert.equal(await fixture.amount(seller, 20), 1, 'cancellation returns the reserved item');
        console.log('PASS player HTML links, large native bag, worker consent, rest, native travel, conserved delivery and cancelled priority');
    } finally {
        Meetings.reset();
        if (Coordinator.started) await Coordinator.stop();
        Afk._resetForTests();
        await fixture.close();
        assert.deepEqual(workerFaults, [], 'large bags must not fault the worker during consent, travel or the next lifecycle command');
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
