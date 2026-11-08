'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('delete-character-meetings');
require('../src/Global');
fixture.assertConfigured(options.default);
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));
const Database = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const DecisionTrace = require('../src/GameServer/Bot/DecisionTrace');
const Config = require('../src/GameServer/Bot/Population/PopulationConfig');
const Native = require('./helpers/nativeMarketFixture');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [9411, 9412, 9413, 9414, 9415], deleted = ids[2];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
invoke('GameServer/DataCache').init();

(async () => {
    await Database.init();
    try {
        await Life.init();
        for (const id of ids) {
            await Native.character(Database, id, `DeleteMeet${id}`, `bot_delete_meet_${id}`, point);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 100 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: point, currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        let token = 0;
        const accept = async (buyer, seller) => {
            const actors = [buyer, seller], parties = await Promise.all(actors.map(id => Database.prepareTradeParticipant(id)));
            return Database.acceptTradeMeeting({ token: `delete-meet-${++token}`, actorA: buyer, actorB: seller,
                seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Giran', point,
                lines: [{ payer: 0, itemId: parties[1].inventory.find(item => item.selfId === 1867).id,
                    selfId: 1867, count: 2, price: 100,
                    certificate: Intent.encode({ itemId: 1867, amount: 2, price: 100, key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 }) }],
                parties: parties.map(p => ({ ...p, route: p.meetingId
                    ? { fee: 0, scroll: false, method: `meeting:${p.meetingId}`, durationMs: 0 }
                    : { fee: 20, scroll: false, method: 'walk', durationMs: 100 } }))
            }, { freshPreparation: true, validatePreparation: () => true });
        };
        const refundBuyer = (await accept(ids[0], deleted)).meeting;
        const refundSeller = (await accept(deleted, ids[3])).meeting;
        const completed = (await accept(ids[1], deleted)).meeting;
        const cancelled = (await accept(deleted, ids[4])).meeting;
        const unrelated = (await accept(ids[0], ids[3])).meeting;
        assert.equal((await Database.arriveTradeMeeting(completed.id)).meeting.state, 'completed');
        await Database.cancelTradeMeeting(cancelled.id, 'fixture');
        // Leave both terminal deliveries unacknowledged, including a partial ack.
        await Database.acknowledgeTradeMeeting(completed.id, ids[1]);
        assert.equal((await Database.execute(['SELECT COUNT(*) n FROM board_trade_meetings WHERE actorA=? OR actorB=?', [deleted, deleted]]))[0].n, 4);
        const deletion = await Database.deleteCharacter(`BOT_DELETE_MEET_${deleted}`, `DELETEMEET${deleted}`);
        assert.equal(deletion.affectedRows, 1);
        // The meetings it closed reach main as every meeting end does (CharDelete hands them on): the survivors' rows,
        // never the deleted character's, and one traced end each with its reason.
        assert.deepEqual(deletion.meetings.filter(reply => Array.isArray(reply.closed)).map(reply => [reply.meeting.id, reply.meeting.reason])
            .sort((a, b) => a[0] - b[0]), [[refundBuyer.id, 'character_deleted'], [refundSeller.id, 'character_deleted']]);
        assert(deletion.meetings.every(reply => !reply.coldLifeRows[deleted]), 'the deleted character\'s row is not handed on');
        const traced = [], before = Number(Life.cachedState(ids[0]).simulation?.revision || 0);
        Config.decisionTrace = true;
        DecisionTrace.connect(batch => { traced.push(...batch.records.map(row => JSON.parse(row))); DecisionTrace.ack(batch.id, batch.records.length); });
        try { for (const reply of deletion.meetings) Meetings.acceptRows(reply); } finally { Config.decisionTrace = false; DecisionTrace.stop(); }
        assert.deepEqual(traced.filter(row => row.kind === 'meeting').map(row => [row.recordId, row.phase, row.reason]).sort((a, b) => a[0] - b[0]),
            [[refundBuyer.id, 'cancelled', 'character_deleted'], [refundSeller.id, 'cancelled', 'character_deleted']]);
        assert(Number(Life.cachedState(ids[0]).simulation?.revision || 0) > before, 'the survivor\'s refunded row reaches main');
        assert.equal((await Database.deleteCharacter(`bot_delete_meet_${deleted}`, `DeleteMeet${deleted}`)).affectedRows, 0);
        assert.equal((await Database.execute(['SELECT COUNT(*) n FROM board_trade_meetings WHERE actorA=? OR actorB=?', [deleted, deleted]]))[0].n, 0);
        assert.equal((await Database.fetchTradeMeeting(unrelated.id)).state, 'accepted', 'other commitments remain accepted');
        for (const id of ids.filter(id => id !== deleted)) await Database.settleBoardOwner(id);
        const amount = async (id, selfId) => Native.amount(await Database.fetchItems(id), selfId);
        assert.equal(await amount(ids[0], 57), 119800, 'cancelled buyer gets escrow and route back; unrelated escrow stays held');
        assert.equal(await amount(ids[3], 57), 120000, 'cancelled seller gets route back');
        assert.equal(await amount(ids[3], 1867), 98, 'seller stock is returned once; unrelated stock stays held');
        assert.equal(await amount(ids[1], 57), 119800, 'completed buyer still pays the completed price');
        assert.equal(await amount(ids[1], 1867), 102, 'completed goods remain deliverable after seller deletion');
        assert.equal(await amount(ids[4], 57), 120000);
        assert.equal(await amount(ids[4], 1867), 100, 'already cancelled goods are not returned twice');
        for (const [meeting, survivor, done] of [[refundBuyer, ids[0], false], [refundSeller, ids[3], false],
            [completed, ids[1], true], [cancelled, ids[4], false]]) {
            const receipt = await Database.fetchTradeMeetingReceipt(meeting.token, survivor);
            assert.equal(receipt.meetingId, meeting.id);
            assert.equal(receipt.outcome, done ? 'completed' : 'cancelled');
        }
        for (const id of [ids[0], ids[3]]) assert.equal((await Database.prepareTradeParticipant(id)).meetingId, unrelated.id);
        for (const id of [ids[1], ids[4]]) assert.equal((await Database.prepareTradeParticipant(id)).meetingId, null);
        await Database.close(); Database.init();
        assert.equal((await Database.fetchTradeMeeting(unrelated.id)).state, 'accepted');
        assert.equal((await Database.arriveTradeMeeting(unrelated.id)).meeting.state, 'completed');
        for (const id of [ids[0], ids[3]]) {
            await Database.settleBoardOwner(id);
            await Database.acknowledgeTradeMeeting(unrelated.id, id);
        }
        assert.equal(await amount(ids[0], 57), 119800);
        assert.equal(await amount(ids[3], 57), 120200);
        assert.equal(await amount(ids[0], 1867), 102);
        assert.equal(await amount(ids[3], 1867), 98);
        assert.deepEqual(await Database.execute(['PRAGMA foreign_key_check']), []);
        console.log('PASS delete character: all buyer/seller commitments, pending terminal deliveries, survivor refunds/receipts and unrelated meetings');
    } finally { await Database.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
