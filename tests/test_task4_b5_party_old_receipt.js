'use strict';
// Task 4 B5 N13 (E169 old accepted receipt): a trade meeting accepted before the
// buyer joins a party still completes. Goods arrive, the receipt is readable,
// custody is conserved, and the party bot accepts no new trade afterwards.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [730281, 730282], point = { locX: 83396, locY: 147904, locZ: -3400 };
(async () => {
    const world = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'b5-party-old-receipt');
    try {
        await Database.createAccount('bot_b5_old_receipt', 'test');
        await Database.execute(["UPDATE characters SET username='bot_b5_old_receipt' WHERE id IN (?,?)", ids]);
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
        const prepare = async (amount = 2) => {
            const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
            return { token: `old-receipt-${++token}`, actorA: ids[0], actorB: ids[1], seqA: parties[0].sequence, seqB: parties[1].sequence,
                town: 'Giran', point,
                lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === 1867).id, selfId: 1867, count: amount, price: 100,
                    certificate: Intent.encode({ itemId: 1867, amount, price: 100, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 }) }],
                parties: parties.map(p => ({ ...p, route: { fee: 20, scroll: false, method: 'walk', durationMs: 100 } })) };
        };
        const accept = request => Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => true });
        const held = async () => {
            const rows = await Database.execute([`SELECT selfId,SUM(amount) amount FROM (
                SELECT selfId,amount FROM items UNION ALL SELECT selfId,amount FROM board_settlements
                UNION ALL SELECT selfId,heldCount amount FROM board_trade_meeting_lines
                UNION ALL SELECT 57 selfId,escrowA+escrowB+routeReserveA+routeReserveB amount FROM board_trade_meetings
                UNION ALL SELECT 57 selfId,escrowAdena amount FROM afk_trade_shops) GROUP BY selfId`]);
            return Object.fromEntries(rows.map(row => [row.selfId, Number(row.amount)]));
        };
        const bag = async id => Object.fromEntries((await Database.fetchItems(id)).map(row => [row.selfId, row.amount]));
        const before = await held();
        const request = await prepare();
        const accepted = await accept(request), meetingId = accepted.meeting.id;
        assert(accepted.pending, 'meeting accepted before the party join');
        // The buyer joins a party after acceptance (the native row only; no admission check runs here).
        await Database.execute(['UPDATE bot_life_state SET partyId=? WHERE characterId=?', ['b5-joined-party', ids[0]]]);
        assert.equal((await Database.prepareTradeParticipant(ids[0])).partyId, 'b5-joined-party');
        const arrived = await Database.arriveTradeMeeting(meetingId);
        assert.equal(arrived.meeting.state, 'completed', 'an old accepted meeting completes for a party bot');
        for (const actor of ids) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(meetingId, actor); }
        assert.equal((await bag(ids[0]))[1867], 102, 'goods delivered to the party buyer');
        assert.equal((await bag(ids[1]))[1867], 98, 'goods left the seller');
        for (const actor of ids) {
            const receipt = await Database.fetchTradeMeetingReceipt(request.token, actor);
            assert.equal(receipt?.meetingId, meetingId, `receipt fetched for ${actor}`);
            assert.equal(receipt.outcome, 'completed');
        }
        assert.deepEqual((await Database.prepareTradeParticipant(ids[0])).acceptedIncoming, {}, 'no incoming left after receipt');
        assert.deepEqual(await held(), before, 'custody conserved: goods and Adena (walk legs unpaid here)');
        assert.equal((await bag(ids[0]))[57], 119800, 'buyer paid once');
        assert.equal((await bag(ids[1]))[57], 120200, 'seller paid once');
        const fresh = await prepare(1);
        await assert.rejects(accept(fresh), /party_busy/, 'a party bot accepts no new trade after its old receipt');
        assert.equal((await bag(ids[0]))[1867], 102, 'refused trade moves nothing');
        console.log('PASS task4 b5 N13: old accepted meeting completes for a party bot, receipt read, custody conserved, no new trade');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
