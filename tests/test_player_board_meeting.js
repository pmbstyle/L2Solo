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
const seller = 730501, buyer = 730502, follower = 730503;
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const point = { locX: 83396, locY: 147904, locZ: -3404 };
const workerFaults = [];
const waitFor = async (predicate, label, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
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
        { id: buyer, name: 'MeetingPlayer', level: 20 }, { id: follower, name: 'MeetingCompanion', level: 20 }], 'player-board-meeting');
    let session;
    try {
        World.user = { sessions: [], revision: 0 };
        await Database.createAccount('bot_board_meeting', 'test');
        await Database.execute(["UPDATE characters SET username='bot_board_meeting' WHERE id IN (?,?)", [seller, follower]]);
        for (const id of [seller, buyer]) await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 1000000, slot: 0 });
        await Database.setItem(seller, { selfId: 20, name: 'Buckler', amount: 1, slot: 8 });
        await Database.setItem(seller, { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7 });
        await Database.execute([`WITH RECURSIVE stock(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM stock WHERE n<4160)
            INSERT INTO items(selfId,name,amount,enchant,equipped,slot,characterId)
            SELECT 952,'Magic Ring',1,n%7,0,0,? FROM stock`, [seller]]);
        await Life.init();
        await PartyState.init();
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
        const restoreLegacyParty = async reason => {
            const member = Life.cachedState(seller), dueAt = member.timing.nextResolveAt || Date.now();
            await Life.upsertState({ characterId: follower, name: 'MeetingCompanion', phase: 'cold', activity: 'grouped',
                level: 20, adena: 0, inventory: {}, loc: member.loc, currentRegion: member.currentRegion,
                party: { partyId: 'retained-meeting-party', leaderId: seller, role: 'dps' },
                vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
                stats: { classId: 0, generatedCold: true, role: 'dps', leaderId: seller },
                timing: { lastResolvedAt: Date.now(), nextResolveAt: dueAt } }, reason + '_follower');
            await Life.upsertState({ ...Life.cachedState(seller),
                party: { partyId: 'retained-meeting-party', leaderId: seller, role: 'dps' },
                stats: { ...Life.cachedState(seller).stats, leaderId: seller } }, reason);
            await PartyState.createOrUpdate({ partyId: 'retained-meeting-party', leaderId: seller,
                memberIds: [seller, follower], status: 'active', spotId: 'meeting-fixture',
                nextResolveAt: dueAt, roleCoverage: { dps: 2 }, stats: {} });
        };
        const html = () => session.packets.filter(packet => packet[0] === 0x0f).at(-1)?.subarray(5).toString('utf16le') || '';
        const tells = () => session.packets.filter(packet => packet[0] === 0x4a).map(packet => ({
            sender: packet.readInt32LE(1), kind: packet.readInt32LE(5),
            name: packet.subarray(9).toString('utf16le').split('\0')[0],
            text: packet.subarray(9).toString('utf16le').split('\0')[1]
        }));
        const status = () => session.packets.filter(packet => packet[0] === 0x64 && packet.readInt32LE(1) === 614)
            .map(packet => packet.subarray(13).toString('utf16le').replace(/\0$/, ''));
        const pickups = () => session.packets.filter(packet => packet[0] === 0x64 && [28, 29, 30].includes(packet.readInt32LE(1)));
        const boughtBucklers = () => pickups().filter(packet => packet.readInt32LE(1) === 30
            && packet.readInt32LE(9) === 3 && packet.readInt32LE(13) === 20).length;
        const click = async command => {
            const before = session.packets.filter(packet => packet[0] === 0x0f).length;
            HtmlLink(session, Buffer.concat([Buffer.from([0x21]), Buffer.from(command + '\0', 'utf16le')]));
            await waitFor(() => session.packets.filter(packet => packet[0] === 0x0f).length > before, command);
        };
        Board.show(session, { side: 1, town: 'Giran' });
        const buy = /action="bypass -h (board answer [^"]+)"><font[^>]*>Buy<\/font>/.exec(html())[1];
        await Life.upsertState({ ...Life.cachedState(seller), party: { partyId: 'new-party' } }, 'grouped_offer_fixture');
        await click(buy);
        assert(html().includes('This bot is hunting with a party'), html());
        assert.equal(Meetings.counters().preparations, 0);
        assert.equal(await fixture.amount(buyer, 57), 1000000, 'same-point group refusal reserves no payment');
        assert.equal(await fixture.amount(seller, 20), 1, 'same-point group refusal reserves no goods');
        await Life.upsertState({ ...Life.cachedState(seller), party: { partyId: null } }, 'solo_offer_fixture');
        await click(buy);
        assert(html().includes('Agree and wait'), html());
        assert.equal(Meetings.counters().preparations, 0, 'reading the quantity form must not hold a bot preparation');
        // Ordinary hunting can advance the bot while the human reads the form.
        assert.equal(Coordinator.commandInflight.size, 0, 'the form must not start a worker approval');
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [seller]]);
        Life.acceptLifecycleRow(await Database.fetchTradeMeetingOwnerState(seller));
        await click('board agree');
        assert(html().includes('Checking the trade'), html());
        assert(status().some(text => /Trade in progress.*Checking goods/.test(text)), 'the pending approval reaches system chat immediately');
        await waitFor(() => !session.playerBoardAgreePending, 'agreement result');
        assert(/Trade agreed|Trade completed/.test(html()), html());
        await waitFor(async () => (await fixture.amount(buyer, 20)) === 1
            && (await fixture.amount(seller, 57)) === 1000000 + 4079, 'completed player purchase');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079);
        assert.equal(await fixture.amount(seller, 57), 1000000 + 4079);
        assert.equal(await fixture.amount(seller, 20), 0);
        await waitFor(() => boughtBucklers() === 1, 'standard item receipt after native delivery');
        assert.equal(status().filter(text => /Trade completed/.test(text)).length, 1);
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
        assert.equal(boughtBucklers(), 1, 'a rejected offer does not emit a pickup receipt');

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
            party: { partyId: null },
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
        // Restore a pre-update overlap only after native consent; new grouped
        // deals are prohibited, but saved custody must still reach its buyer.
        await restoreLegacyParty('legacy_meeting_party_fixture');
        assert.equal(Meetings.isPlayerWaiting(seller), true, 'accepted custody prioritizes the merchant while the human waits at the point');
        assert.equal(Coordinator.contextFor(Life.cachedState(seller)).playerWaiting, true,
            'the real coordinator carries waiting-player priority into the worker context');
        assert.equal(tells().length, 1, 'the accepted remote merchant privately acknowledges the reservation');
        assert.equal(tells()[0].sender, seller);
        assert.equal(tells()[0].kind, 2, 'meeting acknowledgement uses the private C4 chat channel');
        assert.equal(tells()[0].name, 'MeetingSeller');
        assert.match(tells()[0].text, /recover first.*Wait at the meeting point.*About/);
        const [remoteMeeting] = await Database.fetchTradeMeetingsForOwner(buyer);
        const beforeReplay = session.packets.length;
        await Meetings.receipt(remoteMeeting.token, buyer);
        await Meetings.receipt(remoteMeeting.token, buyer);
        assert.equal(tells().length, 1, 'receipt retries and quantity-window refreshes never repeat the acknowledgement');
        assert.equal(session.packets.slice(beforeReplay).filter(packet => packet[0] === 0x64).length, 0,
            'native receipt retries repeat neither system status nor pickup packets');
        assert.equal(boughtBucklers(), 1, 'reserved goods do not emit pickup text before arrival');
        assert.equal(status().filter(text => /Goods and payment are reserved/.test(text)).length, 2);
        Coordinator.setPauseReason('fixture', false);
        await waitFor(async () => (await fixture.amount(buyer, 20)) === 2
            && (await fixture.amount(seller, 57)) === 1000000 + 4079 + 4080, 'rest, native travel and delivery');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079 - 4080);
        assert.equal(await fixture.amount(seller, 57), 1000000 + 4079 + 4080);
        assert.equal(Life.cachedState(seller).party.partyId, 'retained-meeting-party',
            'real worker claims and commits finish the individual obligation without erasing party membership');
        await waitFor(() => !Meetings.isPlayerWaiting(seller), 'retired waiting-player priority');
        await waitFor(() => boughtBucklers() === 2, 'second delivered item receipt');
        assert.equal(status().filter(text => /Trade completed/.test(text)).length, 2);
        assert.equal(pickups().length, 2, 'receiving one more Buckler reports one item, not the bag total of two');
        assert.equal(tells().length, 1, 'worker lifecycle transitions do not spam the waiting player');
        assert.deepEqual(Life.cachedState(seller).inventory[952], rings);

        Coordinator.setPauseReason('fixture', true);
        const remoteClosed = await Database.closeBoardRecord(seller, remoteSale.shop.id);
        Afk.refreshRecord(remoteClosed.record);
        await Database.setItem(seller, { selfId: 20, name: 'Buckler', amount: 1, slot: 8 });
        const merchantArrival = Date.now() + 150000;
        await Life.upsertState({ ...Life.cachedState(seller), activity: 'traveling',
            party: { partyId: null },
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
        await waitFor(() => status().some(text => /Trade cancelled/.test(text)), 'cancelled trade system message');
        assert.equal(status().filter(text => /Trade cancelled/.test(text)).length, 1);
        assert.equal(pickups().length, 2, 'returning reserved payment on cancellation is not new loot');
        assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079 - 4080, 'cancelling the priority transition refunds native escrow');
        assert.equal(await fixture.amount(seller, 20), 1, 'cancellation returns the reserved item');

        // The reported field merchant retained a party while its paid SoE
        // was due. Exercise that same route with authored C4 gatekeepers.
        const oldNpc = World.npc;
        const npcIndex = require('../src/GameServer/World/NpcObjectIndex');
        World.npc = { spawns: [7848, 7233].map(selfId => {
            const loc = Data.npcSpawns.flatMap(zone => zone.spawns || [])
                .find(spawn => spawn.selfId === selfId).coords[0];
            return { fetchId: () => selfId, fetchSelfId: () => selfId,
                fetchLocX: () => loc.locX, fetchLocY: () => loc.locY, fetchLocZ: () => loc.locZ };
        }) };
        npcIndex.reset(World); World.npc.spawns.forEach(npc => npcIndex.add(World, npc));
        try {
            await Database.setItem(seller, { selfId: 736, name: 'Scroll of Escape', amount: 2, slot: 0 });
            await Life.upsertState({ ...Life.cachedState(seller), activity: 'hunting',
                party: { partyId: null },
                loc: { locX: 120937, locY: -5280, locZ: -3784 }, currentRegion: 'Aden',
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(seller)),
                stats: { ...Life.cachedState(seller).stats, restUntil: null, travel: null },
                timing: { lastResolvedAt: Date.now(), nextResolveAt: Date.now() + 3600000 } }, 'field_merchant_fixture');
            Board.show(session, { side: 1, town: 'Giran' });
            await click(new RegExp('action="bypass -h (board answer sell_ad ' + cancelSale.shop.id + ' [^"]+)"').exec(html())[1]);
            await click('board agree');
            await waitFor(() => !session.playerBoardAgreePending, 'field merchant agreement');
            await restoreLegacyParty('legacy_field_party_fixture');
            await waitFor(() => Life.cachedState(seller).stats.travel?.meetingId, 'native SoE leg');
            const [fieldMeeting] = await Database.fetchTradeMeetingsForOwner(buyer);
            assert.equal(JSON.parse(fieldMeeting.legA).scroll, true);
            assert.equal(await fixture.amount(seller, 736), 1, 'native custody consumes the held scroll once');
            assert.equal(await fixture.amount(buyer, 20), 2, 'goods stay reserved while the merchant is travelling');
            Coordinator.setPauseReason('fixture', false);
            await waitFor(async () => await fixture.amount(buyer, 20) === 3
                && await fixture.amount(seller, 57) === 1000000 + 4079 + 4080 + 4081 - 20400,
            'SoE, two gatekeepers and native delivery', 45000);
            assert.equal(await fixture.amount(seller, 736), 1, 'later legs never consume another scroll');
            assert.equal(await fixture.amount(buyer, 57), 1000000 - 4079 - 4080 - 4081);
            assert.equal(await fixture.amount(seller, 57), 1000000 + 4079 + 4080 + 4081 - 20400,
                'each authored gatekeeper fee is charged once and custody pays the seller once');
            await waitFor(() => boughtBucklers() === 3, 'field purchase standard receipt');
            assert.equal(status().filter(text => /Trade completed/.test(text)).length, 3);
            assert.equal(Life.cachedState(seller).party.partyId, 'retained-meeting-party');
        } finally {
            World.npc = oldNpc;
            npcIndex.reset(World); oldNpc?.spawns?.forEach(npc => npcIndex.add(World, npc));
        }
        console.log('PASS player HTML links, large native bag, worker consent, rest, native travel, conserved delivery and cancelled priority');
    } finally {
        Meetings.reset();
        if (Coordinator.started) await Coordinator.stop();
        Afk._resetForTests();
        await fixture.close();
        assert.deepEqual(workerFaults, [], 'large bags must not fault the worker during consent, travel or the next lifecycle command');
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
