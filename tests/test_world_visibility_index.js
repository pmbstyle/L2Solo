'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Model = invoke('GameServer/Model/Actor');
const Session = invoke('GameServer/Session');
const BotSession = invoke('GameServer/Bot/BotSession');
const Shared = invoke('GameServer/Network/Shared');
const Database = invoke('Database');
const Runtime = require('../src/GameServer/World/CharacterLocationRuntime');
const previousUser = World.user;
const origin = { locX: 0, locY: 0, locZ: -3400 };
let serial = 9700000;

function registered(loc = origin, { id = ++serial, account = `player_visibility_${id}`, online = true, extra = {} } = {}) {
    const session = { accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, ...extra };
    session.actor = new Model({ id, name: account, username: account, clanId: 0, isOnline: false, ...loc });
    session.actor.session = session;
    World.insertUser(session);
    session.actor.setIsOnline(online);
    return session;
}

function properties(session, loc = origin) {
    return { id: ++serial, name: 'VisibilitySelected', username: session.accountId, clanId: 0,
        isOnline: false, ...loc, items: [], paperdoll: utils.tupleAlloc(16, {}) };
}

function noSessionScan(work) {
    const sessions = World.user.sessions;
    World.user.sessions = new Proxy(sessions, { get(target, key) {
        if (['filter', 'find', 'map', 'forEach', 'values', Symbol.iterator].includes(key)
            || (typeof key === 'string' && /^\d+$/.test(key))) {
            throw new Error('visibility_session_scan');
        }
        return Reflect.get(target, key);
    } });
    try { return work(); } finally { World.user.sessions = sessions; }
}

function unrelatedCost(source, expected) {
    const counts = { actor: 0, online: 0, xy: 0, z: 0 };
    for (const size of [32, 64]) {
        for (let n = size === 32 ? 0 : 32; n < size; n++) {
            const far = registered({ ...origin, locX: 100000000 + n * 6000 }), actor = far.actor;
            Object.defineProperty(far, 'actor', { get() { counts.actor++; return actor; } });
            for (const [method, kind] of [['fetchIsOnline', 'online'], ['fetchLocX', 'xy'],
                ['fetchLocY', 'xy'], ['fetchLocZ', 'z']]) {
                const original = actor[method];
                actor[method] = function () { counts[kind]++; return original.call(this); };
            }
        }
        for (const name of ['fetchVisibleUsers', 'fetchVisibleRealPlayers']) {
            for (const key of Object.keys(counts)) counts[key] = 0;
            assert.deepEqual(World[name](source, source.actor), expected[name]);
            console.log(JSON.stringify({ query: name, unrelatedActors: size, getterReads: { ...counts } }));
            assert.deepEqual(counts, { actor: 0, online: 0, xy: 0, z: 0 },
                'registered unrelated actors must not be inspected by a local visibility query');
        }
        for (const key of Object.keys(counts)) counts[key] = 0;
        World.realPlayerSessionsNear(origin, 6000);
        assert.deepEqual(counts, { actor: 0, online: 0, xy: 0, z: 0 });
    }
}

try {
    assert.equal(Database.isReady(), false);
    World.user = { sessions: [], revision: 0 };
    const source = registered();
    const first = registered({ ...origin, locX: 100, locZ: 50000 });
    const bot = registered({ ...origin, locX: -100 }, { account: `bot_visibility_${++serial}` });
    const boundary = registered({ ...origin, locX: 6000 });
    const offline = registered({ ...origin, locX: 100 }, { online: false });
    const unknown = registered({ ...origin, locX: 100 });
    unknown.actor.setIsOnline(undefined);
    const badZ = registered({ ...origin, locX: 200, locZ: NaN });
    const nullXY = registered({ locX: undefined, locY: null, locZ: 0 });
    const flaggedBot = registered({ ...origin, locX: 300 }, { extra: { botSession: true } });
    const simulated = registered({ ...origin, locX: 350 }, { extra: { isSimPlayer: true } });
    const expected = { fetchVisibleUsers: [first, bot, badZ, nullXY, flaggedBot, simulated],
        fetchVisibleRealPlayers: [first, badZ, nullXY, simulated] };
    assert.deepEqual(World.fetchVisibleUsers(source, source.actor), expected.fetchVisibleUsers);
    assert.deepEqual(World.fetchVisibleRealPlayers(source, source.actor), expected.fetchVisibleRealPlayers);
    const firstReader = World.realPlayerSessionsNear(origin, 6000);
    assert(firstReader.includes(first));
    assert(firstReader.includes(boundary), 'first-reader inclusive boundary stays separate');
    assert(firstReader.includes(unknown), 'first classifier retains online!==false');
    assert(firstReader.includes(flaggedBot), 'first classifier and legacy bot flag remain distinct');
    for (const missing of [badZ, nullXY, offline, bot, simulated]) assert(!firstReader.includes(missing));
    console.log('PASS native registration/order/source/strict6000/noZ/nullishXY/online/bot and actual XYZ first-reader positives');

    if (process.argv.includes('--red-cost')) {
        unrelatedCost(source, expected);
    } else {
        const offlineId = offline.actor.fetchId();
        const offlineRecord = World.registeredActorById(offlineId);
        assert.equal(offlineRecord.actor, offline.actor);
        assert.equal(Runtime.index.getSource(offlineId, 'actor'), offlineRecord,
            'raw current registration must be the SAME original common actor-slot record, even before first online');
        assert.equal(Runtime.index.getSource(first.actor.fetchId(), 'actor'), World.registeredActorById(first.actor.fetchId()));
        assert.equal(offlineRecord.source, offline.actor);
        assert.equal(Runtime.index.records.get(offlineId).actor.indexed, false);
        const state = { id: offlineId, source: {}, phase: 'cold', loc: { ...origin, locX: 12000 }, spotId: 'visibility_cold' };
        Runtime.index.setSource(offlineId, 'state', state);
        offline.actor.setIsOnline(true);
        assert.equal(World.registeredActorById(offlineId), offlineRecord);
        assert.equal(Runtime.index.getSource(offlineId, 'actor'), offlineRecord);
        assert(World.fetchVisibleUsers(source, source.actor).includes(offline));
        offline.actor.setIsOnline(false);
        assert.equal(Runtime.index.getSource(offlineId, 'actor'), offlineRecord);
        assert.equal(Runtime.index.records.get(offlineId).actor.indexed, false);
        assert.equal(Runtime.index.getSource(offlineId, 'state'), state);

        const normalizedNull = registered({ locX: null, locY: null, locZ: null });
        assert(World.realPlayerSessionsNear(origin, 0).includes(normalizedNull), 'actual Number(null) XYZ stays finite zero');
        assert(World.fetchVisibleUsers(source, source.actor).includes(normalizedNull));
        World.removeUser(normalizedNull);
        badZ.actor.setLocXYZ({ ...origin, locX: 200, locZ: undefined });
        assert(World.fetchVisibleUsers(source, source.actor).includes(badZ));
        assert(!World.realPlayerSessionsNear(origin, 6000).includes(badZ), 'undefined actual Z stays invalid for first reader');

        const bad = registered({ ...origin, locX: NaN });
        const badRecord = World.registeredActorById(bad.actor.fetchId());
        assert.equal(Runtime.index.getSource(bad.actor.fetchId(), 'actor'), badRecord);
        assert.equal(Runtime.index.records.get(badRecord.id).actor.indexed, false);
        assert(!World.fetchVisibleUsers(source, source.actor).includes(bad));
        assert.doesNotThrow(() => bad.actor.setLocXYZ({ ...origin, locX: 'bad' }));
        bad.actor.setLocXYZ({ ...origin, locX: '400', locY: '0', locZ: '0' });
        assert.equal(World.registeredActorById(badRecord.id), badRecord);
        assert(World.fetchVisibleUsers(source, source.actor).includes(bad));
        assert(World.realPlayerSessionsNear(origin, 6000).includes(bad));
        World.removeUser(bad);

        const token = World.registeredActorById(first.actor.fetchId()).token;
        World.insertUser(first);
        assert.equal(World.registeredActorById(first.actor.fetchId()).token, token);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), expected.fetchVisibleUsers);
        first.actor.state.setDead(true);
        assert(World.fetchVisibleUsers(source, source.actor).includes(first), 'dead but online stays visible');
        first.actor.state.setDead(false);
        Shared.enterCharacterHall(first, []);
        const retired = World.registeredActorById(first.actor.fetchId());
        assert(retired.retired);
        assert.notEqual(retired.token, token);
        assert.equal(Runtime.index.getSource(retired.id, 'actor'), retired);
        assert.equal(Runtime.index.records.get(retired.id).actor.indexed, false);
        first.actor.setLocXYZ(origin); first.actor.setIsOnline(true);
        assert.equal(World.registeredActorById(retired.id), retired);
        assert(!World.fetchVisibleUsers(source, source.actor).includes(first));
        assert(!World.realPlayerSessionsNear(origin, 6000).includes(first));
        World.insertUser(first);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), expected.fetchVisibleUsers,
            'explicit same-session registration restores original relative arrival order');
        const previousActor = first.actor;
        Session.prototype.setActor.call(first, properties(first, { ...origin, locX: 400 }));
        first.actor.setIsOnline(true);
        previousActor.setLocXYZ(origin); previousActor.setIsOnline(true);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), expected.fetchVisibleUsers);
        assert.equal(World.retireUserActor(first, previousActor), false);
        assert.equal(World.registeredActorById(first.actor.fetchId()).actor, first.actor);
        const selectedId = first.actor.fetchId(), selectedActor = first.actor;
        const selectedToken = World.registeredActorById(selectedId).token;
        Session.prototype.setActor.call(first, { ...properties(first, origin), id: selectedId });
        first.actor.setIsOnline(true);
        assert.notEqual(World.registeredActorById(selectedId).token, selectedToken);
        selectedActor.setLocXYZ(origin); selectedActor.setIsOnline(true);
        assert.equal(World.retireUserActor(first, selectedActor), false);
        assert.equal(World.registeredActorById(selectedId).actor, first.actor);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), expected.fetchVisibleUsers,
            'same-character native actor replacement keeps order and rejects previous token/source');

        Shared.enterCharacterHall(offline, []);
        const offlineRetired = World.registeredActorById(offlineId);
        assert(offlineRetired.retired);
        assert.equal(Runtime.index.getSource(offlineId, 'actor'), offlineRetired);
        offline.actor.setIsOnline(true);
        assert(!World.fetchVisibleUsers(source, source.actor).includes(offline));
        assert.equal(Runtime.index.getSource(offlineId, 'state'), state);

        const actualBot = new BotSession(`bot_visibility_selection_${++serial}`);
        World.insertUser(actualBot);
        actualBot.setActor(properties(actualBot, { ...origin, locX: 500 }));
        assert.equal(Runtime.index.getSource(actualBot.actor.fetchId(), 'actor'), World.registeredActorById(actualBot.actor.fetchId()));
        actualBot.actor.setIsOnline(true);
        assert(World.fetchVisibleUsers(source, source.actor).includes(actualBot));
        assert(!World.fetchVisibleRealPlayers(source, source.actor).includes(actualBot));
        World.removeUser(actualBot);

        const oldSameActor = registered({ ...origin, locX: 550 });
        const commonActor = oldSameActor.actor, oldSameRecord = World.registeredActorById(commonActor.fetchId());
        const newSameActor = { accountId: `player_visibility_same_actor_${++serial}`, actor: commonActor,
            fetchAccountId() { return this.accountId; } };
        commonActor.session = newSameActor;
        World.insertUser(newSameActor);
        const sameRecord = World.registeredActorById(commonActor.fetchId());
        assert.notEqual(sameRecord, oldSameRecord);
        assert.notEqual(sameRecord.token, oldSameRecord.token);
        assert.equal(Runtime.index.getSource(commonActor.fetchId(), 'actor'), sameRecord);
        assert.equal(World.updateUserLocation(oldSameActor, commonActor), false);
        assert.equal(World.notifyUserStateChanged(oldSameActor, commonActor), false);
        assert.equal(World.retireUserActor(oldSameActor, commonActor), false);
        World.removeUser(oldSameActor);
        assert.equal(World.registeredActorById(commonActor.fetchId()), sameRecord,
            'late former session cannot delete a newer token even when the actor object is identical');
        assert(World.fetchVisibleUsers(source, source.actor).includes(newSameActor));
        World.removeUser(newSameActor);

        World.removeUser(bot);
        World.insertUser(bot);
        const reordered = [first, badZ, nullXY, flaggedBot, simulated, bot];
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), reordered, 'remove/reinsert is a new arrival');
        const replacement = registered({ ...origin, locX: -200 }, { account: bot.accountId });
        assert(bot.destroyed);
        bot.actor.setLocXYZ(origin); bot.actor.setIsOnline(true); World.removeUser(bot);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), [...reordered.slice(0, -1), replacement]);
        const duplicate = registered({ ...origin, locX: 600 });
        const displacedActor = duplicate.actor;
        const latest = registered({ ...origin, locX: 700 }, { id: displacedActor.fetchId() });
        displacedActor.setLocXYZ(origin); displacedActor.setIsOnline(true);
        assert(!World.fetchVisibleUsers(source, source.actor).includes(duplicate));
        assert(World.fetchVisibleUsers(source, source.actor).includes(latest));
        World.removeUser(duplicate);
        assert.equal(Runtime.index.getSource(latest.actor.fetchId(), 'actor'), World.registeredActorById(latest.actor.fetchId()));
        World.removeUser(latest); World.removeUser(replacement);
        World.insertUser(bot);
        expected.fetchVisibleUsers = [first, badZ, nullXY, flaggedBot, simulated, bot];
        expected.fetchVisibleRealPlayers = [first, badZ, nullXY, simulated];
        noSessionScan(() => {
            assert.deepEqual(World.fetchVisibleUsers(source, source.actor), expected.fetchVisibleUsers);
            assert.deepEqual(World.fetchVisibleRealPlayers(source, source.actor), expected.fetchVisibleRealPlayers);
            World.realPlayerSessionsNear(origin, 6000);
        });
        unrelatedCost(source, expected);
        for (const radius of [NaN, Infinity, -1]) assert.throws(() => World.realPlayerSessionsNear(origin, radius), RangeError);
        assert.throws(() => World.realPlayerSessionsNear({ ...origin, locZ: NaN }, 6000), RangeError);
        assert.deepEqual(World.fetchVisibleUsers(source, new Model({ ...origin, locX: NaN })), []);

        const oldUser = World.user;
        World.user = { sessions: [], revision: 0 };
        assert.equal(Runtime.index.getSource(offlineId, 'state'), state);
        assert.equal(Runtime.index.getSource(offlineId, 'actor'), null);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), []);
        World.user = oldUser;
        source.actor.setLocXYZ(origin); source.actor.setIsOnline(true);
        assert.equal(World.registeredActorById(source.actor.fetchId()), null);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), []);
        assert.deepEqual(World.fetchVisibleRealPlayers(source, source.actor), []);
        assert.throws(() => World.realPlayerSessionsNear(origin, 6000), /uninitialized/);
        World.insertUser(source); World.insertUser(first);
        assert.deepEqual(World.fetchVisibleUsers(source, source.actor), [first]);
        Runtime.index.removeSource(offlineId, 'state', state.source);
        assert.equal(Database.isReady(), false);
        console.log('PASS common raw identity/legacy geometry/first actualXYZ/order/token/terminal/replacement/reset/local access native contracts');
    }
} finally {
    World.user = previousUser;
}
