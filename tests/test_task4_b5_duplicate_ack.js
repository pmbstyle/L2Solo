'use strict';
// Task 4 B5 (N6): a completed meeting replayed (arrive twice, a late cancel,
// settle and ack twice per actor) records one market trade for its event key,
// keeps each actor's last receipt, and moves the goods once: the buyer's card
// sees the 2 skins once (nothing left to order, not a negative or double count).
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const [buyer, seller] = [730251, 730252], SKIN = 1867;
const point = { locX: 83396, locY: 147904, locZ: -3400 };
(async () => {
    const world = await createWorld([buyer, seller].map(id => ({ id, classId: 0, level: 30 })), 'task4-b5-duplicate-ack');
    try {
        await Database.createAccount('bot_b5_ack_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_b5_ack_fixture' WHERE id IN (?,?)", [buyer, seller]]);
        await Life.init();
        for (const id of [buyer, seller]) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: SKIN, name: 'Animal Skin', amount: 100, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: point,
                currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const parties = await Promise.all([buyer, seller].map(id => Database.prepareTradeParticipant(id)));
        const request = { token: 'b5-ack-1', actorA: buyer, actorB: seller, seqA: parties[0].sequence, seqB: parties[1].sequence,
            town: 'Giran', point, lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === SKIN).id,
                selfId: SKIN, count: 2, price: 100,
                certificate: Intent.encode({ itemId: SKIN, amount: 2, price: 100, key: `resale:${SKIN}`, recipeId: 0, valueHours: 2, valueRate: 100 }) }],
            parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 100 } })) };
        const prepared = Life.cachedState(buyer);
        const leaf = { itemId: SKIN, amount: 2, heldAtDecision: Decision.heldFor(prepared, SKIN) };
        const bag = async id => Object.fromEntries((await Database.fetchItems(id)).map(row => [row.selfId, row.amount]));
        // Rows move from the world outbox to the history file; count once both settled.
        const trades = async id => {
            const key = `meeting:${id}:*`;
            for (let tries = 0; tries < 100; tries++) {
                const outbox = (await Database.execute([`SELECT COUNT(*) AS n FROM history_outbox
                    WHERE kind = 'market_trade' AND json_extract(payload, '$.eventKey') GLOB ?`, [key]]))[0].n;
                if (!Number(outbox)) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            return Number((await Database.readHistory(['SELECT COUNT(*) AS n FROM market_trades WHERE eventKey GLOB ?', [key]]))[0].n);
        };
        const receipts = async () => (await Database.execute(['SELECT characterId, lastReceipt FROM board_trade_participants WHERE characterId IN (?,?) ORDER BY characterId', [buyer, seller]]));

        const accepted = await Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => true });
        const id = accepted.meeting.id;
        Life.acceptLifecycleRow(accepted.coldLifeRows[buyer]);
        assert.equal(Decision.remainingToOrder(leaf, Life.cachedState(buyer), prepared), 0, 'accepted incoming fills the card');

        // Terminal twice: arrive, arrive again, then a late cancel of the completed meeting.
        const completed = await Database.arriveTradeMeeting(id);
        assert.equal(completed.meeting.state, 'completed');
        await Database.arriveTradeMeeting(id);
        await Database.cancelTradeMeeting(id, 'late-cancel');
        assert.equal((await Database.fetchTradeMeeting(id)).state, 'completed', 'a late cancel cannot undo a completed meeting');
        assert.equal(await trades(id), 1, 'one market trade row per meeting line after a repeated terminal');

        // Settle and ack twice per actor; the buyer's second ack comes before the seller's first.
        for (const actor of [buyer, buyer]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(id, actor); }
        assert.equal((await Database.fetchTradeMeeting(id)).deliveryMask, 1, 'a repeated ack keeps one side acknowledged');
        await Database.settleBoardOwner(seller); await Database.acknowledgeTradeMeeting(id, seller);
        const receipt = await receipts();
        assert(receipt.every(row => row.lastReceipt && JSON.parse(row.lastReceipt)[1] === id), 'both actors hold the receipt');
        for (const actor of [seller, buyer]) {
            await Database.settleBoardOwner(actor);
            assert.equal(await Database.acknowledgeTradeMeeting(id, actor), null, 'an ack after cleanup is a no-op');
        }
        assert.deepEqual(await receipts(), receipt, 'lastReceipt unchanged by repeated acks');
        assert.equal(await trades(id), 1, 'still one market trade row after repeated acks');

        // The goods moved once and the buyer's card counts them once.
        const after = await bag(buyer);
        assert.equal(after[SKIN], 102); assert.equal(after[57], 119800);
        assert.equal((await bag(seller))[SKIN], 98); assert.equal((await bag(seller))[57], 120200);
        Life.acceptLifecycleRow(await Database.fetchTradeMeetingOwnerState(buyer));
        const current = Life.cachedState(buyer);
        assert.deepEqual(current.acceptedIncoming, {}, 'delivered goods are not also incoming');
        assert.equal(Decision.heldFor(current, SKIN), 102, 'the card sees +2 once');
        assert.equal(Decision.remainingToOrder(leaf, current, prepared), 0);
        console.log('PASS Task 4 B5 duplicate ack: one trade row per event key, receipt kept, goods and card progress once');
    } finally { await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
