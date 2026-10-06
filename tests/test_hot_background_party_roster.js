'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/Global');

const directory = fs.mkdtempSync(path.resolve(__dirname, '../tmp/hot-party-roster-'));
const databasePaths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
options.default.Database.path = databasePaths.world;
options.default.Database.historyPath = databasePaths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Hot = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Runtime = require('../src/GameServer/World/CharacterLocationRuntime');
const previousUser = World.user;
let serial = 9600000, partySerial = 0;

function reset() { World.user = { sessions: [], revision: 0 }; }
function member(id = ++serial, { account = `bot_roster_${++serial}`, partyId = null, online = true, hp = 100 } = {}) {
    const session = { accountId: account, hotBackgroundPartyId: partyId,
        fetchAccountId() { return this.accountId; }, socket: { destroy() { session.destroyed = true; } },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Actor({ id, name: account, username: account, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, hp, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor.session = session;
    World.insertUser(session);
    session.actor.setIsOnline(online);
    return session;
}
function party(ids, leaderId = ids[0]) {
    const partyId = `roster_native_${++partySerial}`;
    const current = Parties.acceptRow({ partyId, leaderId, memberIdsJson: JSON.stringify(ids),
        status: 'hot', startedAt: 1, updatedAt: 1, statsJson: '{}', roleCoverageJson: '{}' });
    assert.equal(Parties.find(partyId), current, 'actual accepted party cache returns its original current object');
    return current;
}
function attach(session, current) { session.hotBackgroundPartyId = current.partyId; return session; }
function refs(owner, expected) {
    const actual = Hot.roster(owner);
    assert.equal(actual.length, expected.length);
    expected.forEach((session, i) => assert.equal(actual[i], session, 'roster yields original sessions in authored order'));
    return actual;
}
function instrument(session) {
    const counts = { actor: 0, id: 0, online: 0, point: 0 };
    const actor = session.actor, originalId = actor.fetchId, originalOnline = actor.fetchIsOnline;
    Object.defineProperty(session, 'actor', { configurable: true, get() { counts.actor++; return actor; } });
    actor.fetchId = function () { counts.id++; return originalId.call(this); };
    actor.fetchIsOnline = function () { counts.online++; return originalOnline.call(this); };
    for (const field of ['fetchLocX', 'fetchLocY', 'fetchLocZ']) {
        const read = actor[field];
        actor[field] = function () { counts.point++; return read.call(this); };
    }
    return counts;
}

try {
    assert.equal(Database.isReady(), false);
    reset();
    const second = member(), third = member(undefined, { hp: 0 }), first = member(undefined, { online: false });
    const current = party([first.actor.fetchId(), second.actor.fetchId(), third.actor.fetchId()], first.actor.fetchId());
    [first, second, third].forEach(session => attach(session, current));
    refs(first, [first, second, third]);
    assert.equal(Hot.leader(second), first);
    assert.equal(first.actor.fetchIsOnline(), false);
    assert.equal(third.actor.isDead(), true);
    assert.equal(World.registeredActorById(first.actor.fetchId()).actor, first.actor, 'offline actor remains a raw source');
    first.actor.setLocXYZ({ locX: NaN, locY: 0, locZ: undefined });
    refs(first, [first, second, third]);
    const wrong = attach(member(), { partyId: 'wrong-party' }), companion = attach(member(), current);
    companion.partyCompanion = true;
    current.memberIds.push(wrong.actor.fetchId(), companion.actor.fetchId(), ++serial);
    refs(first, [first, second, third]);
    assert.deepEqual(Hot.roster(companion), []);
    const status = current.status;
    current.status = 'active'; assert.deepEqual(Hot.roster(first), []); current.status = status;
    assert.deepEqual(Hot.roster({}), []);
    current.memberIds = [third.actor.fetchId(), second.actor.fetchId(), first.actor.fetchId(), second.actor.fetchId()];
    refs(first, [third, second, first, second]);
    current.leaderId = ++serial; assert.equal(Hot.leader(second), second, 'missing leader keeps the caller fallback');
    console.log('PASS real World/Actor + accepted party: original order/duplicates/leader fallback/dead/offline/badXYZ/wrong party/companion');

    const actorRecord = World.registeredActorById(second.actor.fetchId());
    const cold = Life.acceptLifecycleRow({ characterId: second.actor.fetchId(), phase: 'cold', activity: 'hunting',
        level: 1, hp: 12, maxHp: 100, mp: 31, maxMp: 100, locX: 12000, locY: 0, locZ: 0, updatedAt: 1 });
    assert.equal(Runtime.index.getSource(second.actor.fetchId(), 'state').source, cold);
    assert.equal(World.registeredActorById(second.actor.fetchId()), actorRecord);
    refs(first, [third, second, first, second]);
    const hot = Life.acceptLifecycleRow({ characterId: second.actor.fetchId(), phase: 'hot', activity: 'resting',
        level: 1, hp: 3, maxHp: 100, mp: 7, maxMp: 100, locX: 24000, locY: 0, locZ: 0, updatedAt: 2 });
    assert.equal(Runtime.index.getSource(second.actor.fetchId(), 'state').source, hot);
    assert.notEqual(hot, cold);
    assert.equal(World.registeredActorById(second.actor.fetchId()).actor, second.actor);
    refs(first, [third, second, first, second]);
    console.log('PASS actual same-id cold/hot lifecycle source remains independent from current raw actor roster');

    // Raw terminal lifetime is different from spatial visibility lifetime.
    const beforeTerminal = World.registeredActorById(first.actor.fetchId());
    assert.equal(World.retireUserActor(first, first.actor), true);
    const terminal = World.registeredActorById(first.actor.fetchId());
    assert.notEqual(terminal, beforeTerminal); assert.notEqual(terminal.token, beforeTerminal.token);
    assert.equal(terminal.actor, first.actor); assert.equal(terminal.retired, true);
    refs(first, [third, second, first, second]);
    first.actor.setLocXYZ({ locX: 20000, locY: 0, locZ: 0 }); first.actor.setIsOnline(true);
    assert.equal(World.registeredActorById(first.actor.fetchId()), terminal);
    refs(first, [third, second, first, second]);
    World.insertUser(first);
    assert.equal(World.registeredActorById(first.actor.fetchId()).retired, false);
    console.log('PASS terminal current raw remains in roster; late setters keep token, explicit insertion restores');

    // Same-account replacement/remove is authoritative and keeps original refs.
    reset();
    const old = member(), peer = member();
    const replacementParty = party([old.actor.fetchId(), peer.actor.fetchId()]);
    attach(old, replacementParty); attach(peer, replacementParty);
    const oldRecord = World.registeredActorById(old.actor.fetchId());
    const replacement = member(old.actor.fetchId(), { account: old.accountId, partyId: replacementParty.partyId });
    assert.equal(old.destroyed, true);
    const replacementRecord = World.registeredActorById(old.actor.fetchId());
    assert.notEqual(replacementRecord.token, oldRecord.token);
    refs(peer, [replacement, peer]);
    old.actor.setLocXYZ({ locX: 12, locY: 0, locZ: 0 }); old.actor.setIsOnline(true);
    World.removeUser(old);
    assert.equal(World.registeredActorById(replacement.actor.fetchId()), replacementRecord);
    refs(peer, [replacement, peer]);
    World.removeUser(replacement); refs(peer, [peer]);
    assert.equal(World.registeredActorById(replacement.actor.fetchId()), null);
    replacement.actor.setIsOnline(true); assert.equal(World.registeredActorById(replacement.actor.fetchId()), null);
    World.insertUser(replacement); refs(peer, [replacement, peer]);
    console.log('PASS registered replacement/exact late source/removal/reinsert');

    // Current registration owns the source, independently of stale arrays.
    const duplicate = member(replacement.actor.fetchId(), { partyId: replacementParty.partyId });
    const selectedDuplicate = Hot.roster(peer)[0];
    assert.equal(World.registeredActorById(duplicate.actor.fetchId()).session, duplicate);
    assert.equal(selectedDuplicate, duplicate);
    refs(peer, [duplicate, peer]);
    console.log('SOURCE BOUNDARY duplicate', JSON.stringify({ oldArraySelected: selectedDuplicate === replacement,
        currentSelected: selectedDuplicate === duplicate, oldRetired: replacementRecord.retired,
        currentTokenIsNew: World.registeredActorById(duplicate.actor.fetchId()).token !== replacementRecord.token }));
    const oldUser = World.user;
    reset(); assert.deepEqual(Hot.roster(peer), []);
    duplicate.actor.setLocXYZ({ locX: 42, locY: 0, locZ: 0 }); duplicate.actor.setIsOnline(true);
    assert.equal(World.registeredActorById(duplicate.actor.fetchId()), null);
    World.user = oldUser;
    assert.equal(World.registeredActorById(duplicate.actor.fetchId()), null, 'old array assignment alone has no current registration');
    assert.deepEqual(Hot.roster(peer), [], 'reused old array cannot restore stale actor sources');
    console.log('SOURCE BOUNDARY reused old array', JSON.stringify({ oldRosterSize: Hot.roster(peer).length,
        currentRegistered: false }));
    World.insertUser(duplicate); assert.equal(World.registeredActorById(duplicate.actor.fetchId()).session, duplicate);
    refs(duplicate, [duplicate]);
    console.log('PASS duplicate/reset current-token authority; explicit insertion restores only that source');

    reset();
    const numeric = member(), textId = String(++serial), text = member(textId);
    const rawParty = party([numeric.actor.fetchId(), Number(textId)]);
    attach(numeric, rawParty); attach(text, rawParty);
    rawParty.memberIds = [String(numeric.actor.fetchId()), textId];
    refs(numeric, [text]);
    rawParty.memberIds = [numeric.actor.fetchId(), Number(textId)];
    refs(numeric, [numeric]);
    const malformed = [0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(id => attach(member(id), rawParty));
    rawParty.memberIds = malformed.map(session => session.actor.fetchId());
    const malformedRows = malformed.map(session => ({ id: String(session.actor.fetchId()),
        rawRegistered: World.registeredActorById(session.actor.fetchId()) !== null,
        rosterSelected: Hot.roster(numeric).includes(session) }));
    assert(malformedRows.every(value => value.rawRegistered === false));
    assert(malformedRows.every(value => value.rosterSelected === false));
    const missingId = ++serial;
    rawParty.memberIds = [undefined, null, missingId, NaN, numeric.actor.fetchId()];
    for (const id of rawParty.memberIds.slice(0, 4)) assert.equal(World.registeredActorById(id), null);
    refs(numeric, [numeric]);
    console.log('PASS absent undefined/null/missing/NaN raw IDs safely omitted beside a registered positive');
    console.log('RAW ID BOUNDARY', JSON.stringify(malformedRows));
    const long = Array.from({ length: 11 }, () => attach(member(), rawParty));
    rawParty.memberIds = long.map(session => session.actor.fetchId());
    refs(long[0], long);
    console.log('PASS strict final raw numeric/string ID comparison; no new roster cap; malformed raw source boundary recorded');

    const measurements = [];
    for (const count of [32, 64]) {
        reset();
        const unrelated = Array.from({ length: count }, () => member());
        const group = [member(), member(), member()];
        const localParty = party(group.map(session => session.actor.fetchId()));
        group.forEach(session => attach(session, localParty));
        group.forEach(session => assert.equal(World.registeredActorById(session.actor.fetchId()).actor, session.actor));
        const reads = unrelated.map(instrument);
        const lookup = World.registeredActorById, ids = localParty.memberIds.slice(), rawCalls = [];
        World.registeredActorById = function (id) { rawCalls.push(id); return lookup.call(this, id); };
        const sessions = World.user.sessions;
        World.user.sessions = new Proxy(sessions, { get(target, key) {
            if (key === Symbol.iterator || ['find', 'filter', 'map', 'forEach', 'some', 'values', 'entries', 'keys'].includes(key)
                || typeof key === 'string' && /^\d+$/.test(key)) throw Error('known-ID roster must not enumerate World sessions');
            return Reflect.get(target, key);
        } });
        try { refs(group[0], group); }
        finally { World.user.sessions = sessions; World.registeredActorById = lookup; }
        assert.equal(rawCalls.length, 3, 'one actual registered reader call per original raw member ID');
        assert.deepEqual(rawCalls, ids);
        const total = reads.reduce((sum, value) => Object.fromEntries(Object.keys(sum).map(key => [key, sum[key] + value[key]])),
            { actor: 0, id: 0, online: 0, point: 0 });
        measurements.push({ unrelated: count, members: group.length, rawCalls: rawCalls.length, reads: total });
        console.log('ACTUAL ROSTER COST', JSON.stringify(measurements.at(-1)));
    }
    assert.equal(Database.isReady(), false);
    assert.deepEqual(measurements.map(value => value.reads), [
        { actor: 0, id: 0, online: 0, point: 0 }, { actor: 0, id: 0, online: 0, point: 0 }
    ], 'known member IDs must not read unrelated World session/actor facts');
    console.log('PASS 32/64 unrelated registered actors untouched by known-ID roster');
} finally {
    const ready = Database.isReady();
    const opened = Object.values(databasePaths).filter(file => fs.existsSync(file)).length;
    World.user = previousUser;
    fs.rmSync(directory, { recursive: true, force: true });
    console.log('CLEANUP', JSON.stringify({ databaseReady: ready, databaseFilesCreated: opened,
        disposableRemoved: !fs.existsSync(directory), actorViewRestored: World.user === previousUser }));
}
