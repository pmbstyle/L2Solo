'use strict';
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [730221, 730222, 730223], point = { locX: 83396, locY: 147904, locZ: -3400 };
(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'same-point-meetings');
    try {
        await Database.createAccount('bot_same_point_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_same_point_fixture' WHERE id IN (?,?,?)", ids]);
        await Life.init();
        for (const id of ids) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 100, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: point,
                currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        let token = 0;
        const prepare = async (seller = ids[1], amount = 2, destination = point) => {
            const actors = [ids[0], seller], parties = await Promise.all(actors.map(id => Database.prepareTradeParticipant(id)));
            return { token: `group-${++token}`, actorA: actors[0], actorB: actors[1], seqA: parties[0].sequence, seqB: parties[1].sequence,
                town: 'Giran', point: destination,
                lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === 1867).id,
                    selfId: 1867, count: amount, price: 100,
                    certificate: Intent.encode({ itemId: 1867, amount, price: 100, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 }) }],
                parties: parties.map(p => ({ ...p, route: p.meetingId
                    ? { fee: 0, scroll: false, method: `meeting:${p.meetingId}`, durationMs: 0 }
                    : { fee: 20, scroll: false, method: 'walk', durationMs: 100 } })) };
        };
        const accept = request => Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => true });
        const funds = async id => (await Database.fetchItems(id)).find(row => row.selfId === 57).amount;
        const first = await accept(await prepare()), a = first.meeting.id;
        const secondRequest = await prepare(ids[2]), second = await accept(secondRequest), b = second.meeting.id;
        assert.equal(second.meeting.routeReserveA, 0, 'shared actor reserves one trip');
        assert.equal(await funds(ids[0]), 119580, 'two independent purchases plus one trip');
        let own = await Database.prepareTradeParticipant(ids[0]);
        assert.equal(own.meetingId, a, 'earliest accepted commitment anchors the trip');
        assert.deepEqual(own.acceptedIncoming, { 1867: 4 }, 'all committed incoming counted once');
        assert.deepEqual(second.coldLifeRows[ids[0]].acceptedIncoming, { 1867: 4 });
        assert.equal((await accept(secondRequest)).meeting.id, b, 'replay reserves no second assets');
        const balance = await funds(ids[0]);
        await assert.rejects(accept(await prepare(ids[2], 2, { ...point, locX: point.locX + 1 })), /point_changed/);
        await assert.rejects(accept(await prepare(ids[2], 1000)), /stock_changed/);
        const forged = await prepare(ids[2]); forged.parties[0].route.method = 'walk';
        await assert.rejects(accept(forged), /route_changed/);
        assert.equal(await funds(ids[0]), balance, 'incompatible point, double stock and route forgery roll back');
        const delivered = await Database.arriveTradeMeeting(b);
        assert.equal(delivered.meeting.state, 'completed');
        assert.deepEqual(delivered.coldLifeRows[ids[0]].acceptedIncoming, { 1867: 4 }, 'pending physical delivery remains incoming until settled');
        assert.deepEqual(JSON.parse(delivered.coldLifeRows[ids[0]].statsJson).tradeMeeting, [a, 1]);
        for (const actor of [ids[0], ids[2]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(b, actor); }
        assert.deepEqual((await Database.prepareTradeParticipant(ids[0])).acceptedIncoming, { 1867: 2 });
        assert.equal((await Database.prepareTradeParticipant(ids[0])).meetingId, a, 'cleaning a later purchase preserves the earlier route');
        await Database.cancelTradeMeeting(a, 'fixture');
        for (const actor of [ids[0], ids[1]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(a, actor); }
        assert.equal((await Database.fetchTradeMeetingReceipt(secondRequest.token, ids[0])).meetingId, b, 'late old cleanup cannot overwrite newer receipt');
        assert.deepEqual((await Database.prepareTradeParticipant(ids[0])).acceptedIncoming, {});
        assert.equal(await funds(ids[0]), 119800, 'only the completed purchase costs money');
        // Cancel the anchor while a different seller remains: its paid goods
        // stay committed, and its route becomes the new anchor without a fare.
        const c = (await accept(await prepare())).meeting.id;
        const d = (await accept(await prepare(ids[2]))).meeting.id;
        const cancelled = await Database.cancelTradeMeeting(c, 'fixture');
        assert.deepEqual(JSON.parse(cancelled.coldLifeRows[ids[0]].statsJson).tradeMeeting, [d, 1]);
        assert.deepEqual(cancelled.coldLifeRows[ids[0]].acceptedIncoming, { 1867: 2 });
        assert.equal((await Database.fetchTradeMeeting(d)).routeReserveA, 0);
        for (const actor of [ids[0], ids[1]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(c, actor); }
        assert.equal((await Database.arriveTradeMeeting(d)).meeting.state, 'completed');
        for (const actor of [ids[0], ids[2]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(d, actor); }
        const source = (await Database.fetchItems(ids[1])).find(row => row.selfId === 1867);
        await Database.replaceBoardRecords(ids[1], 'sell_ad', [{ storeType: 1, title: 'Fixture sale', town: 'Giran', ...point,
            lines: [{ objectId: source.id, selfId: 1867, name: 'Animal Skin', count: 2, price: 100, stackable: true }] }], { expected: {} });
        const ad = (await Database.fetchAfkTradeShops(ids[1])).find(row => row.kind === 'sell_ad');
        const advertised = async () => {
            const request = await prepare(ids[1], 2);
            request.lines[0].adId = ad.id; request.lines[0].adRevision = ad.revision;
            return request;
        };
        const quoted = (await accept(await advertised())).meeting.id;
        await assert.rejects(accept(await advertised()), /quote_changed/, 'one advertisement cannot promise its remaining units twice');
        await Database.cancelTradeMeeting(quoted, 'fixture');
        for (const actor of [ids[0], ids[1]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(quoted, actor); }
        // A meeting that takes the whole advertised count closes the record
        // like every other fill: nothing stays on the board at count 0.
        const filled = (await accept(await advertised())).meeting.id;
        const sold = await Database.arriveTradeMeeting(filled);
        assert.equal(sold.meeting.state, 'completed');
        assert.equal((await Database.fetchAfkTradeShops(ids[1])).some(row => row.id === ad.id), false, 'a filled advertisement is closed');
        assert.deepEqual(sold.closed.map(row => [row.id, row.status, row.lines[0].count]), [[ad.id, 'filled', 0]], 'the closed record reaches board memory');
        for (const actor of [ids[0], ids[1]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(filled, actor); }
        const accepted = [];
        for (let i = 0; i < 8; i++) accepted.push((await accept(await prepare(ids[1], 1))).meeting.id);
        await assert.rejects(accept(await prepare(ids[1], 1)), /backpressure/);
        assert.equal((await Database.fetchTradeMeetingsForOwner(ids[0])).length, 8);
        assert.deepEqual((await Database.prepareTradeParticipant(ids[0])).acceptedIncoming, { 1867: 8 });
        const plans = await Database.execute(["EXPLAIN QUERY PLAN SELECT id FROM board_trade_meetings WHERE actorA=? AND state='accepted' ORDER BY id LIMIT 8", [ids[0]]]);
        assert(plans.some(row => row.detail.includes('board_trade_meetings_actor_a')), 'owner lookup uses the compound index');
        await Database.cancelTradeMeeting(accepted[0], 'fixture');
        await assert.rejects(accept(await prepare(ids[1], 1)), /backpressure/, 'terminal receipts still awaiting cleanup count toward retained owner bound');
        for (const meeting of accepted) {
            await Database.cancelTradeMeeting(meeting, 'fixture');
            for (const actor of [ids[0], ids[1]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(meeting, actor); }
        }
        assert.equal((await Database.prepareTradeParticipant(ids[0])).meetingId, null);
        await assert.rejects(accept(secondRequest), /participant_changed/);
        // Stock below the survival line is paid from the survival reserve
        // first: the accept checks the buyer worker's kit cost (E198).
        const wallet = await funds(ids[0]);
        await Database.execute(["UPDATE bot_life_state SET statsJson=json_set(statsJson,'$.money[2]',?) WHERE characterId=?", [wallet - 100, ids[0]]]);
        await assert.rejects(accept(await prepare()), /economy_funding_changed/, 'free cash above the reserve cannot pay 220');
        const kit = await prepare(); kit.parties[0].survivalCost = 200;
        const survival = (await accept(kit)).meeting.id;
        await Database.cancelTradeMeeting(survival, 'fixture');
        for (const actor of [ids[0], ids[1]]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(survival, actor); }
        // A world saved before that fix holds such records; they close once.
        const sellAd = async seller => {
            const stock = (await Database.fetchItems(seller)).find(row => row.selfId === 1867);
            await Database.replaceBoardRecords(seller, 'sell_ad', [{ storeType: 1, title: 'Fixture sale', town: 'Giran', ...point,
                lines: [{ objectId: stock.id, selfId: 1867, name: 'Animal Skin', count: 2, price: 100, stackable: true }] }], { expected: {} });
            return (await Database.fetchAfkTradeShops(seller)).find(row => row.kind === 'sell_ad');
        };
        const empty = await sellAd(ids[1]), kept = await sellAd(ids[2]);
        await Database.execute(['UPDATE afk_trade_lines SET count=0 WHERE shopId=?', [empty.id]]);
        await Database.execute(['DELETE FROM schema_migrations WHERE version=65']);
        await Database.close(); Database.init();
        assert.equal(await Database.fetchAfkTradeShop(empty.id), null, 'an old filled record is deleted');
        assert.equal((await Database.fetchAfkTradeShop(kept.id)).lines[0].count, 2, 'a record with stock stays');
        console.log('PASS native shared point: separate escrow/incoming, one trip, incompatible/duplicate rollback, independent completion/cancellation, anchor promotion, receipt order, bounded indexed group');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
