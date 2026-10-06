'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require(path.join(gameRoot, 'src/Global'));

const directory = fs.mkdtempSync(path.join(gameRoot, 'tmp', 'pvp-membership-'));
const databasePaths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
options.default.Database.path = databasePaths.world;
options.default.Database.historyPath = databasePaths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Index = invoke('GameServer/Bot/AI/BotPvpIndex');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const previousUser = World.user, realNow = Date.now;
const failures = [], measurements = [];
let now = realNow(), serial = 9_850_000, acceptedState = null;

function reset() {
    World.user = { sessions: [], revision: 0 };
    Index.invalidate();
}

function model(id, name, properties = {}) {
    return new Actor({ id, name, username: name, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, hp: 100, maxHp: 100, mp: 100, maxMp: 100, ...properties });
}

function member({ id = ++serial, account = `bot_membership_${++serial}`, leader = null,
    partyId = null, online = true, hp = 100, register = true } = {}) {
    const session = { accountId: account, followPlayerSession: leader, partyCompanion: !!leader,
        coldLifeState: partyId === null ? null : { party: { partyId } },
        fetchAccountId() { return this.accountId; }, socket: { destroy() { session.destroyed = true; } },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = model(id, account, { hp });
    session.actor.session = session;
    if (register) World.insertUser(session);
    session.actor.setIsOnline(online);
    return session;
}

function refs(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: exact member count`);
    expected.forEach((session, i) => assert.equal(actual[i], session, `${label}: original session/order ${i}`));
}

function members(session, expected, label) { refs(Index.members(session), expected, label); }

function check(name, work) {
    try { work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}

function instrument(session) {
    const reads = { actor: 0, follow: 0, companion: 0, coldState: 0, id: 0, online: 0, point: 0 };
    for (const [key, counter] of [['actor', 'actor'], ['followPlayerSession', 'follow'],
        ['partyCompanion', 'companion'], ['coldLifeState', 'coldState']]) {
        let original = session[key];
        Object.defineProperty(session, key, { configurable: true,
            get() { reads[counter]++; return original; }, set(value) { original = value; } });
    }
    const actor = session.actor;
    for (const [key, counter] of [['fetchId', 'id'], ['fetchIsOnline', 'online'],
        ['fetchLocX', 'point'], ['fetchLocY', 'point'], ['fetchLocZ', 'point']]) {
        const original = actor[key];
        actor[key] = function (...args) { reads[counter]++; return original.apply(this, args); };
    }
    for (const key of Object.keys(reads)) reads[key] = 0;
    return reads;
}

function totals(rows) {
    return rows.reduce((sum, row) => Object.fromEntries(Object.keys(sum).map(key => [key, sum[key] + row[key]])),
        { actor: 0, follow: 0, companion: 0, coldState: 0, id: 0, online: 0, point: 0 });
}

try {
    assert.equal(Database.isReady(), false, 'no Database or World initializer is called');
    Date.now = () => now;
    console.log('SOURCE', JSON.stringify({ gameRoot, defaultConfig: process.env.L2NODE_CONFIG_FILE,
        sharedConfig: process.env.L2NODE_SHARED_CONFIG_FILE || null, legacyRefreshMs: Index.REFRESH_MS,
        worldPath: databasePaths.world, historyPath: databasePaths.history }));

    check('actual registered owner/companion seeds and World source order', () => {
        reset();
        const leader = member({ register: false });
        const second = member({ leader }), first = member({ leader });
        World.insertUser(leader);
        for (const session of [second, first, leader]) {
            const record = World.registeredActorById(session.actor.fetchId());
            assert.equal(record.session, session); assert.equal(record.actor, session.actor);
            assert.equal(Runtime.index.getSource(record.id, 'actor'), record);
        }
        members(leader, [leader, second, first], 'leader seed precedes its source-ordered bucket');
        members(first, [first, leader, second], 'companion seed and owner precede other members');
        const unregistered = member({ register: false });
        members(unregistered, [unregistered], 'queried original session keeps its seed fallback');
        assert.equal(World.registeredActorById(unregistered.actor.fetchId()), null);
    });

    check('autonomous keys, forming exclusion and late join preserve World order', () => {
        reset();
        const early = member(), owner = member({ partyId: 'membership_party' }), late = member({ partyId: 'membership_party' });
        const forming = member({ partyId: 'forming' }), outsider = member({ partyId: 'other_party' });
        members(owner, [owner, late], 'autonomous party'); members(forming, [forming], 'forming is excluded');
        members(outsider, [outsider], 'other party isolated');
        // Controlled original input plus the actual addressed World API.
        // Native producer coverage is the separate producer fixture.
        early.coldLifeState = { party: { partyId: 'membership_party' } };
        World.refreshPartyMemberships([early]);
        members(owner, [owner, early, late], 'late group join uses original World order');
        early.coldLifeState = { party: { partyId: 'other_party' } };
        World.refreshPartyMemberships([early]);
        members(owner, [owner, late], 'changed original state input removes old key');
        members(outsider, [outsider, early], 'changed state enters selected key');
        late.partyCompanion = true; late.followPlayerSession = outsider;
        World.refreshPartyMemberships([late]);
        members(owner, [owner], 'companion no longer shares autonomous key');
        members(late, [late, outsider], 'companion has exact new owner reference');
    });

    check('Index keeps raw facts and actual PvP caller applies alive/includeDead filters', () => {
        reset();
        const owner = member({ partyId: 'membership_alive' });
        const offline = member({ partyId: 'membership_alive', online: false });
        const dead = member({ partyId: 'membership_alive', hp: 0 });
        const malformed = member({ partyId: 'membership_alive' });
        malformed.actor.setLocXYZ({ locX: NaN, locY: 0, locZ: undefined });
        members(owner, [owner, offline, dead, malformed], 'no new Index online/dead/point filter');
        refs(Threats.members(owner), [owner, malformed], 'actual caller alive predicate');
        refs(Threats.members(owner, { includeDead: true }), [owner, offline, dead, malformed], 'actual includeDead');
        assert.equal(World.retireUserActor(malformed, malformed.actor), true);
        assert.equal(World.registeredActorById(malformed.actor.fetchId()).retired, true);
        members(owner, [owner, offline, dead, malformed], 'terminal current raw source remains a member');
        refs(Threats.members(owner), [owner, malformed], 'terminal spatial retirement adds no alive policy');
    });

    check('actual accepted same-id lifecycle state does not replace actor membership', () => {
        reset();
        const owner = member({ partyId: 'membership_dual' }), peer = member({ partyId: 'membership_dual' });
        const id = peer.actor.fetchId(), record = World.registeredActorById(id);
        acceptedState = Life.acceptLifecycleRow({ characterId: id, phase: 'hot', activity: 'resting', level: 1,
            hp: 12, maxHp: 100, mp: 31, maxMp: 100, locX: 18000, locY: 0, locZ: 0, updatedAt: now });
        assert.equal(Runtime.index.getSource(id, 'state').source, acceptedState);
        assert.equal(World.registeredActorById(id), record);
        members(owner, [owner, peer], 'original actor view survives actual state acceptance');
        assert.equal(Database.isReady(), false);
        Runtime.index.removeSource(id, 'state', acceptedState);
        acceptedState = null;
    });

    check('actual World replacement, late source cleanup, remove and reinsert', () => {
        reset();
        const owner = member({ partyId: 'membership_lifetime' }), peer = member({ partyId: 'membership_lifetime' });
        const id = owner.actor.fetchId(), oldActor = owner.actor, oldRecord = World.registeredActorById(id);
        assert.equal(World.retireUserActor(owner, oldActor), true);
        owner.actor = model(id, owner.accountId); owner.actor.session = owner;
        World.updateUserLocation(owner, owner.actor); owner.actor.setIsOnline(true);
        const replaced = World.registeredActorById(id);
        assert.notEqual(replaced.token, oldRecord.token); assert.equal(replaced.session, owner);
        assert.equal(replaced.order, oldRecord.order, 'same session keeps its original source order');
        oldActor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 }); oldActor.setIsOnline(true);
        assert.equal(World.retireUserActor(owner, oldActor), false);
        assert.equal(World.registeredActorById(id), replaced);
        members(peer, [peer, owner], 'late old actor cannot replace membership source');
        const newSession = member({ id, account: owner.accountId, partyId: 'membership_lifetime' });
        const current = World.registeredActorById(id);
        assert.equal(owner.destroyed, true); assert.equal(current.session, newSession);
        assert.notEqual(current.token, replaced.token);
        World.removeUser(owner);
        assert.equal(World.registeredActorById(id), current);
        members(peer, [peer, newSession], 'old session removal leaves current source');
        World.removeUser(newSession); members(peer, [peer], 'explicit current removal');
        newSession.actor.setIsOnline(true); assert.equal(World.registeredActorById(id), null);
        World.insertUser(newSession);
        members(newSession, [newSession, peer], 'reinsert seed and source order');
        assert(World.registeredActorById(id).order > current.order, 'remove then reinsert appends source order');
    });

    check('raw authority boundaries are recorded separately from stale-array parity', () => {
        reset();
        const old = member({ partyId: 'membership_boundary' }), peer = member({ partyId: 'membership_boundary' });
        const id = old.actor.fetchId(), oldRecord = World.registeredActorById(id);
        const replacement = member({ id, partyId: 'membership_boundary' });
        assert.equal(World.registeredActorById(id).session, replacement);
        assert.equal(oldRecord.retired, true);
        members(peer, [peer, replacement], 'displaced duplicate is retired by current raw authority');
        const previous = World.user;
        reset(); World.user = previous;
        assert.equal(World.registeredActorById(id), null, 'old array assignment alone cannot restore a canonical registration');
        members(peer, [peer], 'old array does not recreate native membership; original query seed remains');
        reset();
    });

    check('32 and 64 unrelated getters stay untouched by the addressed native query', () => {
        for (const count of [32, 64]) {
            reset();
            const unrelated = Array.from({ length: count }, () => member());
            const owner = member(), first = member({ leader: owner }), second = member({ leader: owner });
            members(owner, [owner, first, second], 'healthy group before instrumentation');
            for (const session of [owner, first, second]) assert.equal(World.registeredActorById(session.actor.fetchId()).session, session);
            const reads = unrelated.map(instrument);
            if (count === 32) Index.invalidate();
            else now += 1000; // Controlled elapsed time exceeds the actual existing 250 ms snapshot TTL.
            members(owner, [owner, first, second], 'measured addressed native query');
            const result = { unrelated: count, members: 3, trigger: count === 32 ? 'existing_invalidate' : 'elapsed_clock', reads: totals(reads) };
            measurements.push(result);
            console.log('ACTUAL MEMBERSHIP COST', JSON.stringify(result));
        }
        assert.deepEqual(measurements.map(value => value.reads), [
            { actor: 0, follow: 0, companion: 0, coldState: 0, id: 0, online: 0, point: 0 },
            { actor: 0, follow: 0, companion: 0, coldState: 0, id: 0, online: 0, point: 0 }
        ], 'membership query must not read unrelated original sessions when refreshing its selected group');
    });

    check('query-only enumeration trap after actual registration', () => {
        reset();
        const owner = member(), companion = member({ leader: owner });
        members(owner, [owner, companion], 'healthy original group before query trap');
        const sessions = World.user.sessions;
        World.user.sessions = new Proxy(sessions, { get(target, key) {
            if (key === Symbol.iterator || ['find', 'filter', 'map', 'forEach', 'some', 'values', 'entries', 'keys'].includes(key)
                || typeof key === 'string' && /^\d+$/.test(key)) throw Error('membership query enumerated World sessions');
            return Reflect.get(target, key);
        } });
        try { members(owner, [owner, companion], 'addressed membership must not enumerate World sessions'); }
        finally { World.user.sessions = sessions; }
    });

    check('native methods are required, selected key calls are exact and invalidate keeps live metadata', () => {
        reset();
        const owner = member({ partyId: 'membership_required' }), peer = member({ partyId: 'membership_required' });
        const originalKeys = World.pvpPartyMembershipKeys, originalMembers = World.pvpPartySessionsForKey;
        let keyCalls = 0, bucketCalls = 0;
        World.pvpPartyMembershipKeys = function (...args) { keyCalls++; return originalKeys.apply(this, args); };
        World.pvpPartySessionsForKey = function (...args) { bucketCalls++; return originalMembers.apply(this, args); };
        try {
            Index.invalidate();
            members(owner, [owner, peer], 'native invalidate does not destroy addressed metadata');
            assert.equal(keyCalls, 1); assert.equal(bucketCalls, 2, 'only own leader and autonomous key');
            const emptyKeys = { partyCompanion: true, followPlayerSession: null };
            World.pvpPartySessionsForKey = undefined;
            assert.throws(() => Index.members(emptyKeys), /invalid_party_membership_index/);
            World.pvpPartySessionsForKey = originalMembers;
            World.pvpPartyMembershipKeys = undefined;
            assert.throws(() => Index.members(owner), /invalid_party_membership_index/);
        } finally {
            World.pvpPartyMembershipKeys = originalKeys; World.pvpPartySessionsForKey = originalMembers;
        }
    });

    check('explicit injected legacy reader preserves seed policy and has no World load at import', () => {
        const source = fs.readFileSync(path.join(gameRoot, 'src/GameServer/Bot/AI/BotPvpIndex.js'), 'utf8');
        const leader = {}, queried = { actor: {}, partyCompanion: 1, followPlayerSession: leader },
            companion = { actor: {}, partyCompanion: true, followPlayerSession: queried };
        const legacyWorld = { user: { sessions: [queried, companion], revision: 1 } };
        let loads = 0;
        const module = { exports: {} };
        vm.runInNewContext(source, { module, exports: module.exports, Date, Map, Set,
            invoke(name) { assert.equal(name, 'GameServer/World/World'); loads++; return legacyWorld; } });
        assert.equal(loads, 0, 'no World/Runtime import while reader module loads');
        refs(module.exports.members(queried), [queried, leader, companion], 'truthy seed differs from strict ownership key');
        module.exports.invalidate();
        refs(module.exports.members(companion), [companion, queried], 'strict companion key and seed order');
    });

    if (failures.length) throw Error('membership contracts failed: ' + failures.join(', '));
} finally {
    const databaseReady = Database.isReady();
    const databaseFilesCreated = Object.values(databasePaths).filter(file => fs.existsSync(file)).length;
    if (acceptedState) Runtime.index.removeSource(acceptedState.characterId, 'state', acceptedState);
    World.user = previousUser; Index.invalidate(); Date.now = realNow;
    fs.rmSync(directory, { recursive: true, force: true });
    console.log('CLEANUP', JSON.stringify({ databaseReady, databaseFilesCreated,
        disposableRemoved: !fs.existsSync(directory), worldRestored: World.user === previousUser,
        clockRestored: Date.now === realNow, failures: failures.length }));
}
