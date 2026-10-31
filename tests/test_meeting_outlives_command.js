'use strict';
// A cold bot's economy command opens a trade meeting and ends; both workers
// answer later. The accept then writes under the deal's own checks, not under
// the ended command's guard (live: 47% of the failed meetings on 11-01).
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Meetings = invoke('GameServer/AfkTrade/TradeMeetingService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Town = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const TradeIntent = invoke('GameServer/Bot/Economy/TradeIntent');
const sellerId = 730331, buyerId = 730332, SHOT = 1835;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

(async () => {
    const world = await createWorld([{ id: sellerId, classId: 0, level: 20 }, { id: buyerId, classId: 0, level: 20 }], 'meeting-outlives-command');
    const { requestMeetingPreparation: prepare, meetingPreparationCurrent: current } = Coordinator;
    const nativeAccept = Database.acceptTradeMeeting;
    try {
        await Database.createAccount('bot_outlives', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id IN (?,?)', ['bot_outlives', sellerId, buyerId]]);
        await Life.init();
        const place = Town.marketTown('Giran').center;
        await Database.setItem(sellerId, { selfId: 57, amount: 1000, slot: 0 });
        await Database.setItem(sellerId, { selfId: SHOT, amount: 3000, slot: 0 });
        await Database.setItem(buyerId, { selfId: 57, amount: 1000000, slot: 0 });
        for (const [id, name, adena] of [[sellerId, 'OutlivesSeller', 1000], [buyerId, 'OutlivesBuyer', 1000000]]) {
            await Life.upsertState({ characterId: id, accountName: 'bot_outlives', name, level: 20, phase: 'cold',
                activity: 'shopping', currentRegion: 'Giran', adena, loc: place,
                vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                stats: { classId: 0, generatedCold: true, money: [100, 0, 1000, 0] },
                timing: { activityStartedAt: Date.now() - 60000, lastResolvedAt: Date.now() - 1000, nextResolveAt: Date.now() + 60000 }
            }, 'outlives_fixture');
        }
        const stack = (await Database.prepareTradeParticipant(sellerId)).inventory.find(row => row.selfId === SHOT);
        await Database.createAfkTradeShop(sellerId, { kind: 'sell_ad', storeType: 1, town: 'Giran', ...place,
            lines: [{ objectId: stack.id, selfId: SHOT, count: 3000, price: 1 }] });
        await Afk.init();
        const record = Afk.ownerRecords(sellerId).find(row => row.kind === 'sell_ad');

        // The two workers answer by hand, after the command ended.
        const answers = [];
        Coordinator.requestMeetingPreparation = (id, request) => new Promise(resolve => answers.push(() => resolve({
            approved: true, characterId: id, token: request.token, route: { fee: 0, scroll: false, method: 'walk', durationMs: 0 },
            sequence: request.parties[[request.actorA, request.actorB].indexOf(id)].sequence, certificates: request.lines.map(line => TradeIntent.encode({ itemId: line.selfId, amount: line.count, price: line.price,
                key: `resale:${line.selfId}`, valueHours: 1, valueRate: 1 })) })));
        Coordinator.meetingPreparationCurrent = () => true;
        let wrote = false;
        Database.acceptTradeMeeting = async (request) => {
            await Database.execute(['UPDATE bot_life_state SET updatedAt=updatedAt WHERE characterId=?', [buyerId]]);
            wrote = true;
            return { pending: false, meeting: { id: 1, token: request.token, actorA: request.actorA, actorB: request.actorB, state: 'cancelled', revision: 1 } };
        };

        let commandRuns = true;
        const opened = await Database.withMutationAdmission(() => {
            if (!commandRuns) throw Error('cold_postcommit_source_retired');
        }, () => Meetings.trade(buyerId, { shopId: record.id }, SHOT, 100));
        assert.equal(opened.pending, true, 'the command leaves the deal preparing');
        commandRuns = false;
        for (let wait = 0; wait < 40 && answers.length < 2; wait++) await settle();
        assert.equal(answers.length, 2, 'both bots are asked');
        answers.forEach(answer => answer());
        for (let wait = 0; wait < 40 && !wrote; wait++) await settle();
        assert.equal(wrote, true, 'the accept writes after its command ended');
        // A timer the scope armed (the meeting queue's drain, the hot AI's) as well.
        let live = true, timed = null;
        await Database.withMutationAdmission(() => { if (!live) throw Error('cold_postcommit_source_retired'); }, () => {
            timed = new Promise(resolve => setImmediate(resolve)).then(() => Database.execute(
                ['UPDATE bot_life_state SET updatedAt=updatedAt WHERE characterId=?', [buyerId]]));
        });
        live = false;
        await timed;
        console.log('A meeting outlives its command: passed');
    } finally {
        Coordinator.requestMeetingPreparation = prepare;
        Coordinator.meetingPreparationCurrent = current;
        Database.acceptTradeMeeting = nativeAccept;
        await world.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
