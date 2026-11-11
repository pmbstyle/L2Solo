'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const { createWorld, Database } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Actor/Actor');
const AI = invoke('GameServer/Bot/BotAI');
const Meetings = require('../src/GameServer/AfkTrade/TradeMeetingService');
const Intent = require('../src/GameServer/Bot/Economy/TradeIntent');
const ids = [730321, 730322], point = { locX: 15631, locY: 142885, locZ: -2704 };
const restores = [], sessions = [], moves = new Map(), shoppingTicks = [];
let arrivalChecks = 0;
function stub(object, key, value) {
    const previous = object[key]; object[key] = value;
    restores.push(() => { object[key] = previous; });
}
const flush = async () => { for (let n = 0; n < 30; n++) await new Promise(resolve => setImmediate(resolve)); };
async function eventually(check, message) {
    const deadline = Date.now() + 5000;
    do {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    assert.fail(message);
}
function isolateOrdinaryAI() {
    // Keep unrelated combat/social/economy work out of this arrival scenario;
    // the real dispatcher, meeting hold, movement publication and DB stay live.
    const noops = {
        'GameServer/Bot/AI/BotClanChat': ['flush'],
        'GameServer/Bot/Economy/BotTradeChat': ['flush'],
        'GameServer/Bot/AI/PendingSweep': ['prune'],
        'GameServer/Bot/Population/PopulationService': ['recordHotTick'],
        'GameServer/Bot/Population/BotGlobalChat': ['offerReply'],
        'GameServer/Bot/AI/HotBotPolicyOverlay': ['get'],
        'GameServer/Bot/AI/BotPvpDefense': ['tick'],
        'GameServer/Bot/AI/ClanAllianceSupportAI': ['tick'],
        'GameServer/Bot/BotTradeService': ['activeTradeSummary'],
        'GameServer/Bot/Economy/BuffServiceChat': ['onDuty'],
        'GameServer/Bot/AI/ChatArrivalState': ['tick'],
        'GameServer/Bot/Economy/BuffService': ['buyOnAnswer'],
        'GameServer/Bot/AI/BotEquipmentUpgrade': ['applyBestUpgrades'],
        'GameServer/ClanHall/BotVisit': ['tick'],
        'GameServer/Bot/AI/HotResourceCompetition': ['tick']
    };
    for (const [name, keys] of Object.entries(noops)) for (const key of keys) stub(invoke(name), key, () => undefined);
    const lod = invoke('GameServer/Bot/AI/HotActorLodPolicy');
    stub(lod, 'evaluate', () => ({ tier: 'full', playerVisible: false }));
    stub(lod, 'shouldRefreshStatus', () => false);
    stub(lod, 'budgetExceeded', () => false);
    stub(Math, 'random', () => 0.5);
    stub(invoke('GameServer/Bot/AI/States/ShoppingState'), 'tick', session => shoppingTicks.push(session.actor.fetchId()));
}
(async () => {
    const fixture = await createWorld(ids.map(id => ({ id, classId: 0, level: 30 })), 'hot-meeting-materialization');
    const previousUsers = World.user;
    World.user = { sessions: [], revision: 0 };
    try {
        const arrive = Database.arriveTradeMeeting;
        stub(Database, 'arriveTradeMeeting', (...args) => { arrivalChecks++; return arrive(...args); });
        await Life.init();
        for (const [side, id] of ids.entries()) {
            const account = `bot_materialization_${id}`;
            await Database.createAccount(account, 'test');
            await Database.execute(['UPDATE characters SET username=? WHERE id=?', [account, id]]);
            await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 120000, slot: 0 });
            await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
            await Life.upsertState({ characterId: id, accountName: account, name: `Arrival${id}`,
                phase: 'cold', activity: 'traveling', level: 30, adena: 120000,
                inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
                loc: { ...point, locX: point.locX + (side ? -1000 : 1000) }, currentRegion: 'Dion',
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
                stats: { travel: { to: point, arrivalActivity: 'shopping' }, money: [100, 0, 1000, 0] }, timing: {} }, 'fixture');
        }
        const parties = await Promise.all(ids.map(id => Database.prepareTradeParticipant(id)));
        const request = { token: 'cold-to-hot-arrival', actorA: ids[0], actorB: ids[1],
            seqA: parties[0].sequence, seqB: parties[1].sequence, town: 'Dion', point,
            lines: [{ payer: 0, itemId: parties[1].inventory.find(row => row.selfId === 1867).id,
                selfId: 1867, count: 6, price: 100,
                certificate: Intent.encode({ itemId: 1867, amount: 6, price: 100,
                    key: 'resale:1867', recipeId: 0, valueHours: 2, valueRate: 100 }) }],
            parties: parties.map(p => ({ ...p, route: { fee: 0, scroll: false, method: 'walk', durationMs: 1000 } })) };
        const accepted = await Database.acceptTradeMeeting(request, { freshPreparation: true, validatePreparation: () => true });
        Object.values(accepted.coldLifeRows).forEach(row => Life.acceptLifecycleRow(row));
        await Meetings.init(); await flush();
        const meetingId = accepted.meeting.id;
        assert.equal((await Database.fetchTradeMeeting(meetingId)).arrivalMask, 0);

        // Materialize the accepted cold participants as BotManager does:
        // preserve their snapshots, persist hot ownership, then register actors.
        for (const id of ids) {
            const cold = Life.cachedState(id);
            const [row] = await Database.execute(['SELECT * FROM characters WHERE id=?', [id]]);
            const session = { accountId: row.username, fetchAccountId() { return this.accountId; },
                aiActive: true, plan: 'shopping', coldLifeState: cold,
                dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
            const actor = session.actor = new Actor(session, { ...row, ...cold.loc,
                isOnline: true, items: await Database.fetchItems(id), paperdoll: utils.tupleAlloc(16, {}) });
            // Only the walking clock is controlled. Arrival uses the native
            // Actor setter, including its actual meeting-presence notification.
            actor.moveTo = move => moves.set(id, move.to);
            sessions.push(session);
            assert.equal((await Life.markHot(session, 'spawn')).phase, 'hot');
            assert.equal(session.tradeMeetingPresence, undefined, 'the cold session has no hot presence marker');
            World.insertUser(session);
        }
        await eventually(() => moves.size === ids.length, 'hot participants must resume their final walks');
        for (const session of sessions) {
            assert.equal(session.tradeMeetingPresence?.id, meetingId, 'materialization restores the accepted arrival marker');
            assert.equal(session.tradeMeetingPresence.actorId, session.actor.fetchId());
            assert.deepEqual(moves.get(session.actor.fetchId()), point);
        }
        isolateOrdinaryAI();
        for (const session of sessions) AI.tick(session);
        await flush();
        assert.deepEqual(shoppingTicks, [], 'ordinary shopping cannot steal an accepted meeting');
        const markers = sessions.map(session => session.tradeMeetingPresence);
        const waitingChecks = arrivalChecks;
        for (let n = 0; n < 5; n++) for (const session of sessions) AI.tick(session);
        await flush();
        sessions.forEach((session, side) => assert.equal(session.tradeMeetingPresence, markers[side], 'waiting preserves the current arrival/waypoint marker'));
        assert.equal(arrivalChecks, waitingChecks, 'held AI ticks do not poll native arrival transactions');

        sessions[0].actor.setLocXYZ(point);
        await eventually(async () => (await Database.fetchTradeMeeting(meetingId))?.arrivalMask === 1,
            'the native movement event must record the first arrival');
        assert.equal((await Database.fetchTradeMeeting(meetingId)).state, 'accepted', 'one participant cannot settle the deal');
        sessions[1].actor.setLocXYZ(point);
        await eventually(async () => (await Database.fetchTradeMeetingReceipt(request.token, ids[0]))?.outcome === 'completed'
            && Meetings.counters().participants === 0, 'both native arrivals must complete and release the meeting');
        assert.equal(await Database.fetchTradeMeeting(meetingId), undefined, 'both terminal receipts are acknowledged');
        for (const session of sessions) {
            const id = session.actor.fetchId();
            assert.equal(Life.cachedState(id).stats.tradeMeeting, undefined);
            assert.equal(session.coldLifeState.stats.tradeMeeting, undefined, 'the inherited snapshot cannot resurrect the hold');
            assert.equal(session.tradeMeetingPresence, undefined);
            AI.tick(session);
            assert.equal(session.meetingAiHold, undefined, 'the dispatcher releases its accepted-meeting hold');
        }
        assert.deepEqual(shoppingTicks, ids, 'both bots return to their ordinary AI state');
        assert.equal(await fixture.amount(ids[0], 1867), 26);
        assert.equal(await fixture.amount(ids[1], 1867), 14);
        assert.equal(await fixture.amount(ids[0], 57), 119400);
        assert.equal(await fixture.amount(ids[1], 57), 120600);
        sessions.forEach((session, side) => assert.equal(session.actor.backpack.fetchTotalAdena(), side ? 120600 : 119400,
            'terminal settlement also refreshes the live inventory'));
        console.log('PASS cold -> hot meeting: restored presence, native arrivals, single settlement and ordinary AI resumption');
    } finally {
        Meetings.reset();
        for (const restore of restores.reverse()) restore();
        for (const session of sessions) World.removeUser(session);
        World.user = previousUsers;
        await fixture.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
