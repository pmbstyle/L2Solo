'use strict';
// Task 4 B5 (N4): an accepted meeting fills the card's purchase (the old card
// buys nothing); when that meeting ends without delivery (expired) its incoming clears, the
// same card's amount reopens once and the next plan buys exactly that amount;
// a second plan while the new meeting is accepted buys nothing more.
const assert = require('node:assert/strict');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const [buyer, seller] = [730241, 730242], SKIN = 1867, restore = [];
const point = { locX: 83396, locY: 147904, locZ: -3400 };
function stub(object, key, value) { const prior = object[key]; restore.push(() => object[key] = prior); object[key] = value; }
(async () => {
    const world = await createWorld([buyer, seller].map(id => ({ id, classId: 0, level: 30 })), 'task4-b5-expiry');
    try {
        await Database.createAccount('bot_b5_expiry_fixture', 'test');
        await Database.execute(["UPDATE characters SET username='bot_b5_expiry_fixture' WHERE id IN (?,?)", [buyer, seller]]);
        await Life.init();
        for (const id of [buyer, seller]) {
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: SKIN, name: 'Animal Skin', amount: 100, slot: 0 });
            await Life.upsertState({ characterId: id, phase: 'cold', activity: 'shopping', level: 30,
                adena: 120000, inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), loc: point,
                currentRegion: 'Giran', vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        let token = 0;
        const prepare = async () => {
            const parties = await Promise.all([buyer, seller].map(id => Database.prepareTradeParticipant(id)));
            return { token: `b5-expiry-${++token}`, actorA: buyer, actorB: seller, seqA: parties[0].sequence, seqB: parties[1].sequence,
                town: 'Giran', point, lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === SKIN).id,
                    selfId: SKIN, count: 2, price: 100,
                    certificate: Intent.encode({ itemId: SKIN, amount: 2, price: 100, key: `resale:${SKIN}`, recipeId: 0, valueHours: 2, valueRate: 100 }) }],
                parties: parties.map(p => ({ ...p, route: p.meetingId
                    ? { fee: 0, scroll: false, method: `meeting:${p.meetingId}`, durationMs: 0 }
                    : { fee: 20, scroll: false, method: 'walk', durationMs: 100 } })) };
        };
        const accept = async () => {
            const result = await Database.acceptTradeMeeting(await prepare(), { freshPreparation: true, validatePreparation: () => true });
            assert(Life.acceptLifecycleRow(result.coldLifeRows[buyer]));
            return result.meeting.id;
        };
        // The worker's card: buy 2 skins, decided on a bag of 100 and no incoming.
        const prepared = Life.cachedState(buyer);
        const leaf = { itemId: SKIN, amount: 2, heldAtDecision: Decision.heldFor(prepared, SKIN) };
        assert.equal(leaf.heldAtDecision, 100);
        const remaining = () => Decision.remainingToOrder(leaf, Life.cachedState(buyer), prepared);
        const board = new BoardIndex();
        board.put({ id: 77, ownerId: 99, kind: 'sell_ad', custodyPolicy: 1, revision: 4, storeType: Afk.SELL ?? 1,
            town: 'Giran', lines: [{ lineId: 78, selfId: SKIN, count: 2, price: 100 }] });
        stub(Afk, 'boardIndex', () => board);
        stub(Afk, 'offerOf', line => ({ store: { afkTrade: true, conditional: true, storeType: line.storeType,
            shopId: line.recordId, items: [{ selfId: SKIN, count: 2, price: 100, afkTradeLineId: 78 }] } }));
        const bought = [];
        // The executor accepts a real meeting, as the native trade does.
        stub(Afk, 'buyFromShop', async (actor, store, itemId, count) => { bought.push(count); return { pending: true, meetingId: await accept() }; });
        const take = { take: [Afk.SELL ?? 1, SKIN, 2, 77, 78, 4, 100] };

        // 1. A meeting for the same 2 skins was accepted since the card. The
        //    accept moves the simulation revision, so the old card is stale
        //    (tradeDeferred) before the incoming check: it buys nothing.
        const first = await accept();
        assert.deepEqual(Life.cachedState(buyer).acceptedIncoming, { [SKIN]: 2 });
        assert(Life.cachedState(buyer).simulation.revision > prepared.simulation.revision, 'a meeting accept moves the revision');
        assert.equal(remaining(), 0);
        assert.equal((await Market.executePlan(prepared, take)).tradeDeferred, true);
        assert.deepEqual(bought, [], 'accepted incoming fills the card: no second order');

        // 2. The meeting expires undelivered: incoming clears, the money returns, the amount reopens once.
        const expired = await Database.cancelTradeMeeting(first, 'expired');
        assert.equal(expired.meeting.state, 'cancelled');
        assert(Life.acceptLifecycleRow(expired.coldLifeRows[buyer]));
        for (const actor of [buyer, seller]) { await Database.settleBoardOwner(actor); await Database.acknowledgeTradeMeeting(first, actor); }
        Life.acceptLifecycleRow(await Database.fetchTradeMeetingOwnerState(buyer));
        assert.deepEqual((await Database.prepareTradeParticipant(buyer)).acceptedIncoming, {});
        assert.deepEqual(Life.cachedState(buyer).acceptedIncoming, {}, 'an expired meeting leaves no incoming');
        assert.equal(Life.cachedState(buyer).stats.tradeMeeting, undefined, 'no meeting is held after the expiry');
        assert.equal((await Database.fetchItems(buyer)).find(row => row.selfId === 57).amount, 120000, 'an expired meeting costs nothing');
        assert.equal(remaining(), 2, 'the card amount reopens');

        // 3. The worker's next card (made on the state after the expiry) buys exactly the reopened amount, once.
        const fresh = Life.cachedState(buyer);
        assert.equal(Decision.remainingToOrder(leaf, fresh, prepared), 2);
        assert.equal((await Market.executePlan(fresh, take)).pending, true);
        assert.deepEqual(bought, [2], 'one order of the reopened 2');
        assert.deepEqual(Life.cachedState(buyer).acceptedIncoming, { [SKIN]: 2 });
        assert.equal(remaining(), 0);
        // 4. Replaying that card, or a plan on the state with the new meeting, orders nothing more.
        assert.equal((await Market.executePlan(fresh, take)).tradeDeferred, true);
        assert.equal((await Market.executePlan(Life.cachedState(buyer), take)).pending, true);
        assert.deepEqual(bought, [2], 'no second order after the reopened one');
        console.log('PASS Task 4 B5 expiry: incoming waits, expiry reopens the amount once, one reorder, no second');
    } finally { for (const fn of restore.reverse()) fn(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
