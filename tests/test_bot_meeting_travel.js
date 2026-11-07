'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Travel = invoke('GameServer/Bot/AI/BotTownTravel');
const Routes = require('../src/GameServer/Bot/Travel/TravelRoutes');
const NativeTeleport = invoke('GameServer/Actor/Generics/TeleportTo');
const originalInvoke = global.invoke, originalBetween = Routes.between, originalTimeout = global.setTimeout;
let nativeMode = false;
let x = 0, paid = [], acknowledgements = [], teleports = [], moves = [], cancelled = [];
const actor = { fetchId: () => 1, isDead: () => false, fetchHp: () => 100,
    fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0,
    state: { fetchHits: () => false, fetchCasts: () => false },
    moveTo: movement => moves.push(movement) };
const session = { actor, tradeMeetingPresence: {} };
const meeting = { id: 1, state: 'accepted', locX: 2000, locY: 0, locZ: 0,
    routeA: JSON.stringify({ fee: 300, scroll: false }), routeReserveA: 300, nextLegA: 1, legA: null };
const database = { fetchTradeMeeting: async () => ({ ...meeting }), fetchItems: async () => [],
    payTradeMeetingLeg: async (_id, side, sequence, legId, fee, scroll) => {
        assert.equal(side, 0);
        if (meeting.legA) assert.deepEqual(JSON.parse(meeting.legA), { sequence, legId, fee, scroll });
        else { paid.push(fee); meeting.routeReserveA -= fee; meeting.legA = JSON.stringify({ sequence, legId, fee, scroll }); meeting.nextLegA++; }
        return {};
    }, acknowledgeTradeMeetingLeg: async (_id, side, sequence) => {
        assert.equal(side, 0); assert.equal(JSON.parse(meeting.legA).sequence, sequence);
        acknowledgements.push(sequence); meeting.legA = null;
    }, cancelTradeMeeting: async (id, reason) => { cancelled.push({ id, reason }); return {}; } };
global.invoke = name => {
    if (nativeMode && name === path.actor) return { updatePosition: (_session, _actor, point) => { x = point.locX; } };
    if (nativeMode && name === 'GameServer/Pets/PetTravel') return { begin: () => [], finish() {} };
    if (name === 'Database') return database;
    if (name === 'GameServer/Bot/Population/BotLifeState') return {};
    if (name === 'GameServer/AfkTrade/AfkTradeService') return { syncOnlineInventory: async () => {} };
    if (name === 'GameServer/World/World') return { notifyUserStateChanged() {}, npc: { spawns: [{
        fetchSelfId: () => 1, fetchLocX: () => x < 1000 ? 0 : 1400, fetchLocY: () => 0, fetchLocZ: () => 0 }] } };
    if (name === 'GameServer/Actor/Generics/TeleportTo') return (_session, _actor, point, options) => {
        teleports.push({ point, arrive: options.onArrival }); return true;
    };
    return originalInvoke(name);
};
Routes.between = position => ({ start: { locX: position.locX < 1000 ? 0 : 1400, locY: 0 }, route: {
    fee: position.locX >= 2000 ? 0 : position.locX < 1000 ? 300 : 200, steps: position.locX >= 2000 ? [] : [{
    npcId: 1, locX: position.locX < 1000 ? 1000 : 2000, locY: 0, locZ: 0,
    fee: position.locX < 1000 ? 100 : 200 }] } });
(async () => {
    try {
        await Travel.requestMeeting(session, actor, meeting, 0);
        assert.deepEqual(paid, [100], 'reserve is paid one performed hop at a time');
        assert.deepEqual(acknowledgements, [], 'departure is not physical arrival');
        await Travel.requestMeeting(session, actor, meeting, 0);
        assert.equal(teleports.length, 1, 'one active physical departure');
        x = 1000; await teleports[0].arrive();
        assert.deepEqual(acknowledgements, [1]);
        assert.deepEqual(paid, [100], 'walking to next gatekeeper pays no fare');
        assert.equal(moves.at(-1).to.locX, 1400);
        x = 1400; await Travel.requestMeeting(session, actor, meeting, 0);
        assert.deepEqual(paid, [100, 200]);
        // A restart loses the in-memory callback after the physical teleport.
        x = 2000; session.meetingTravel = undefined;
        await Travel.requestMeeting(session, actor, meeting, 0);
        assert.deepEqual(acknowledgements, [1, 2]);
        assert.deepEqual(paid, [100, 200], 'a delivered but unacknowledged hop never pays again');
        assert.equal(moves.at(-1).to.locX, 2000);
        meeting.routeA = JSON.stringify({ fee: 0, scroll: false, method: 'walk' });
        x = 0; session.meetingTravel = undefined;
        const departures = teleports.length;
        await Travel.requestMeeting(session, actor, meeting, 0);
        assert.equal(teleports.length, departures, 'explicitly agreed walking does not buy a teleport');
        assert.equal(moves.at(-1).to.locX, 2000);
        for (const method of ['soe_gatekeeper', 'meeting:99']) {
            meeting.routeA = JSON.stringify({ fee: 0, scroll: false, method });
            const walks = moves.length;
            await Travel.requestMeeting(session, actor, meeting, 0);
            assert.deepEqual(cancelled.at(-1), { id: 1, reason: 'route_unfunded' });
            assert.equal(moves.length, walks, 'an unfunded native/shared route never becomes a cross-town walk');
            assert.equal(teleports.length, departures);
        }
        nativeMode = true;
        const timers = [];
        global.setTimeout = callback => { timers.push(callback); return 0; };
        actor.clearDestId = () => {};
        actor.automation = { abortAll() {} };
        session.accountId = 'bot_meeting_test';
        session.dataSendToMeAndOthers = () => {};
        let completed = 0;
        const afterArrival = () => { assert.equal(x, 3000); assert.equal(session.pendingActorTeleport, undefined); completed++; };
        assert(NativeTeleport(session, actor, { locX: 3000, locY: 0, locZ: 0 }, { onArrival: afterArrival }));
        assert.equal(completed, 0);
        timers.shift()(); await Promise.resolve();
        assert.equal(completed, 1, 'native receipt delivery runs after physical position and teleport ownership clear');
        NativeTeleport(session, actor, { locX: 4000, locY: 0, locZ: 0 }, { onArrival: () => completed++ });
        actor.teleportSequence++;
        timers.shift()(); await Promise.resolve();
        assert.equal(completed, 1, 'superseded physical teleport acknowledges no arrival');
        console.log('Hot meeting route: native arrival acknowledgement, per-hop fare, gatekeeper walk and lost callback recovery passed');
    } finally { global.invoke = originalInvoke; Routes.between = originalBetween; global.setTimeout = originalTimeout; }
})().catch(error => { console.error(error); process.exitCode = 1; });
