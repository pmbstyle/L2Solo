'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

// E270 / E256: a meeting result read from the DB for one character is not
// shown to, or marked on, the character selected next on the same connection.
const presented = { notify: [], result: [] };
for (const [file, exports] of [
    ['PlayerMeetingNotifications', { notify: (session, row) => presented.notify.push(row.id) }],
    ['PlayerBoardWindow', { meetingResult: (session, row) => presented.result.push(row.id) }]
]) {
    const filename = path.join(__dirname, '../src/GameServer/AfkTrade', `${file}.js`);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const Service = require('../src/GameServer/AfkTrade/TradeMeetingService');

function actor(id) {
    return { fetchId: () => id, isDead: () => false, fetchHp: () => 100,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
}
const session = { actor: actor(5) };
const inventory = [];
let releaseAnchor, anchorAsked = false;
let botState = null;
const cancelled = { id: 9, actorA: 5, actorB: 6, state: 'cancelled', locX: 0, locY: 0, locZ: 0 };
let resultMeeting = cancelled;
const native = {
    recoverTradeMeetings: async () => [],
    fetchTradeMeetingByToken: async token => token === 'switch' ? resultMeeting : null,
    fetchTradeMeetingForOwner: id => id === 5
        ? new Promise(resolve => { anchorAsked = true; releaseAnchor = resolve; }) : Promise.resolve(null),
    fetchItems: async () => []
};
global.utils = { infoWarn() {} };
global.invoke = name => ({
    Database: native,
    'GameServer/Bot/Economy/MeetingPriceRefusals': { clear() {} },
    'GameServer/Bot/Population/BotLifeState': { cachedState: id => id === 5 ? botState : null,
        subscribeChanges: () => () => {}, subscribeMarketReviewChanges: () => () => {} },
    'GameServer/AfkTrade/AfkTradeService': { subscribeBoardChanges: () => () => {},
        syncOnlineInventory: async id => { inventory.push(id); } },
    'GameServer/World/World': { registeredActorById: id => id === 5 ? { session } : null,
        subscribeUserChanges: () => () => {} }
})[name];

(async () => {
    try {
        await Service.init();
        const pending = Service.accept('switch');
        for (let i = 0; i < 50 && !anchorAsked; i++) await new Promise(resolve => setImmediate(resolve));
        assert(anchorAsked, 'the result waits on the meeting anchor read');
        session.actor = actor(7);
        releaseAnchor({ id: 11, actorA: 5, actorB: 8, state: 'accepted', locX: 10, locY: 20, locZ: 0 });
        await pending;
        assert.equal(session.tradeMeetingPresence, undefined, 'no marker of character 5 is set on the new character');
        assert.deepEqual(presented, { notify: [], result: [] }, 'no meeting result of character 5 reaches the new character');
        assert.deepEqual(inventory, [5], 'the inventory sync stays bound to the meeting character');
        // A marker for the same character retains the other participant's route
        // for the native countdown, whichever side the player occupies.
        session.actor = actor(5);
        for (const playerIsA of [true, false]) {
            anchorAsked = false;
            const syncing = Service.accept('switch');
            for (let i = 0; i < 50 && !anchorAsked; i++) await new Promise(resolve => setImmediate(resolve));
            assert(anchorAsked);
            releaseAnchor({ id: 11, actorA: playerIsA ? 5 : 8, actorB: playerIsA ? 8 : 5,
                state: 'accepted', locX: 10, locY: 20, locZ: 0, town: 'Giran',
                routeA: JSON.stringify({ durationMs: playerIsA ? 1000 : 45000 }),
                routeB: JSON.stringify({ durationMs: playerIsA ? 45000 : 1000 }) });
            await syncing;
            assert.deepEqual(session.tradeMeetingPresence, { id: 11, actorId: 5, otherId: 8,
                locX: 10, locY: 20, locZ: 0, present: null, town: 'Giran', route: { durationMs: 45000 } });
        }
        // A meeting can start cold, then finish after its shopper materializes.
        // No sellAndRestock continuation owns that inherited session snapshot.
        for (const outcome of ['completed', 'cancelled']) for (const nextMeeting of [null, [11, 2]]) {
            resultMeeting = { ...cancelled, state: outcome };
            session.coldLifeState = { characterId: 5, stats: { tradeMeeting: [9, 1], wishFocus: 'retained' } };
            botState = { characterId: 5, phase: 'hot', stats: nextMeeting ? { tradeMeeting: nextMeeting } : {} };
            anchorAsked = false;
            const syncing = Service.accept('switch');
            for (let i = 0; i < 50 && !anchorAsked; i++) await new Promise(resolve => setImmediate(resolve));
            assert(anchorAsked);
            releaseAnchor(null);
            await syncing;
            assert.deepEqual(session.coldLifeState.stats.tradeMeeting || null, nextMeeting,
                'a terminal native meeting retires the inherited hot shopping blocker and preserves any next commitment');
            assert.equal(session.coldLifeState.stats.wishFocus, 'retained', 'unrelated hot session state is preserved');
        }
        console.log('Meeting result after character switch passed');
    } finally { Service.reset(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
