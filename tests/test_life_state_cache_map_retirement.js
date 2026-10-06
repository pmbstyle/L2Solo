'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const cacheFile = require.resolve('../src/GameServer/Bot/Population/LifeStateCache');
const observed = [], independent = [];
require.cache[cacheFile].exports = class ObservedCache extends Cache {
    constructor(...args) { super(...args); observed.push(this); }
};
const World = invoke('GameServer/World/World'), Model = invoke('GameServer/Model/Actor');
const Life = invoke('GameServer/Bot/Population/BotLifeState'), Database = invoke('Database');
const Runtime = require('../src/GameServer/World/CharacterLocationRuntime');
const originalUser = World.user, originalExecute = Database.execute;
let sqlCalls = 0;
Database.execute = function (...args) { sqlCalls++; return originalExecute.apply(this, args); };
const id = 9910001, point = { locX: 0, locY: 0, locZ: -3400 };
const row = extra => ({ characterId: id, phase: 'cold', activity: 'hunting', updatedAt: 1,
    inventorySummary: JSON.stringify({ 57: { amount: 12, selfId: 57 } }), statsJson: '{}', ...point, ...extra });
const nativeSize = cache => Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(cache);

try {
    assert.equal(Database.isReady(), false);
    World.user = { sessions: [], revision: 0 };
    const session = { accountId: 'player_cache_retirement', fetchAccountId() { return this.accountId; } };
    session.actor = new Model({ id, name: 'CacheRetirementActor', username: session.accountId, clanId: 0, isOnline: false, ...point });
    session.actor.session = session;
    World.insertUser(session); session.actor.setIsOnline(true);
    const actorRecord = Runtime.index.getSource(id, 'actor');
    const first = Life.acceptLifecycleRow(row());
    const cache = observed.find(candidate => candidate.get(id) === first);
    assert(cache);
    assert.equal(Life.cachedState(id), first);
    assert.equal(Runtime.index.getSource(id, 'state').source, first);
    assert.deepEqual(cache.near(point, 1, 10), [first]);
    const hot = Life.acceptLifecycleRow(row({ phase: 'hot', inventorySummary: JSON.stringify({ 57: { amount: 31, selfId: 57 } }) }));
    assert.equal(cache.get(id), hot);
    assert.equal(Life.hotRow(id), hot);
    assert.equal(Runtime.index.getSource(id, 'state').source, hot);
    assert.notEqual(first.inventory, hot.inventory);
    assert.equal(first.inventory['57'].amount, 12); assert.equal(hot.inventory['57'].amount, 31);
    assert.equal(Runtime.index.getSource(id, 'actor'), actorRecord);
    assert.deepEqual(cache.near(point, 1, 10), []);
    assert.equal(sqlCalls, 0); assert.equal(Database.isReady(), false);
    if (nativeSize(cache)) assert.equal(Map.prototype.get.call(cache, id), hot,
        'before-code comparator: the actual native backing duplicates the already-positive original common source');
    console.log(JSON.stringify({ nativeAcceptance: true, rawCurrent: true, inventory: [12, 31], sqlCalls,
        nativeBackingSize: nativeSize(cache), publicSize: cache.size }));
    assert.equal(nativeSize(cache), 0, 'actual current lifecycle source must have ONE raw canonical backing');
    assert.equal(Map.prototype.get.call(cache, id), undefined);
    assert.deepEqual([...cache], [[id, hot]]);
    assert.deepEqual([...cache.keys()], [id]); assert.deepEqual([...cache.values()], [hot]);
    assert.equal(cache.size, Runtime.index.sourceSize('state'));
    const revision = cache.revision, stateRecord = Runtime.index.getSource(id, 'state');
    assert.throws(() => new Cache({ locationIndex: cache.locationIndex }), TypeError,
        'one injected owner is an explicit compatibility contract, not two private maps with contradictory sources');
    assert.equal(cache.revision, revision); assert.equal(cache.get(id), hot);
    assert.equal(Runtime.index.getSource(id, 'state'), stateRecord);
    assert.equal(Runtime.index.getSource(id, 'actor'), actorRecord);

    const plain = new Cache(); independent.push(plain);
    const values = [0, -0, NaN, Infinity, -Infinity, 42, 0n, 17n, '', 'state', false, true, Symbol('state')];
    assert.equal(plain.get('missing'), undefined); assert.equal(plain.has('missing'), false);
    assert.equal(plain.size, 0); assert.throws(() => plain.forEach(null), TypeError);
    for (const [key, value] of values.entries()) {
        assert.equal(plain.set(key, value), plain);
        assert.equal(plain.has(key), true); assert(Object.is(plain.get(key), value));
        assert(Object.is(plain.locationIndex.getSource(key, 'state').source, value));
    }
    assert.equal(plain.size, values.length); assert.equal(nativeSize(plain), 0);
    assert.deepEqual(plain.near(point, 1, 99), [], 'every primitive remains outside the spatial state view');
    assert.equal(plain.locationIndex.cells.size, 0); assert.equal(plain.locationIndex.spots.size, 0);
    assert.deepEqual([...plain.values()], values);
    assert.deepEqual([...plain.entries()].map(([key, value]) => [key, Object.is(value, values[key])]), values.map((_, key) => [key, true]));
    const receiver = {}, calls = [];
    plain.forEach(function (value, key, owner) { assert.equal(this, receiver); assert.equal(owner, plain); calls.push(key);
        assert(Object.is(value, values[key])); }, receiver);
    assert.deepEqual(calls, [...plain.keys()]);
    let directCalls = 0;
    const callable = function () { directCalls++; };
    callable.call = () => { throw Error('callback own call must be ignored'); };
    plain.forEach(callable);
    assert.equal(directCalls, values.length);
    assert.throws(() => new Cache({ locationIndex: plain.locationIndex }), TypeError);
    const oldRevision = plain.revision;
    assert.equal(plain.delete(2), true); assert.equal(plain.revision, oldRevision + 1);
    assert.equal(plain.delete(2), false); assert.equal(plain.revision, oldRevision + 1);
    assert.equal(plain.has(2), false); assert.equal(plain.locationIndex.getSource(2, 'state'), null);
    plain.set(2, NaN); assert.equal([...plain.keys()].at(-1), 2);
    for (const key of [0, 1, 8, 10]) {
        const beforeDelete = plain.revision;
        assert.equal(plain.has(key), true);
        assert.equal(plain.delete(key), true, 'present falsy source must not masquerade as a missing key');
        assert.equal(plain.revision, beforeDelete + 1);
        assert.equal(plain.has(key), false); assert.equal(plain.locationIndex.getSource(key, 'state'), null);
        assert.equal(plain.delete(key), false); assert.equal(plain.revision, beforeDelete + 1);
        plain.set(key, values[key]); assert(Object.is(plain.get(key), values[key]));
    }
    const beforeClear = plain.revision;
    plain.clear(); assert.equal(plain.size, 0); assert.equal(plain.revision, beforeClear + 1);
    assert.throws(() => new Cache({ locationIndex: plain.locationIndex }), TypeError, 'clear retains the owner binding');
    assert.throws(() => plain.forEach(undefined), TypeError);
    plain.clear(); assert.equal(plain.revision, beforeClear + 2, 'empty clear still changes revision');

    const opaque = {}, sameNaNKey = { phase: 'hot' };
    plain.set(opaque, false); plain.set(NaN, sameNaNKey); plain.set('future', 'old');
    assert.equal(plain.get(NaN), sameNaNKey); assert.equal(plain.get(opaque), false);
    const iterator = plain.values(); assert.equal(iterator.next().value, false);
    plain.set(NaN, 'new'); plain.delete('future'); plain.set('tail', -0);
    const rest = [...iterator]; assert.equal(rest[0], 'new'); assert(Object.is(rest[1], -0));
    assert.deepEqual([...plain.keys()], [opaque, NaN, 'tail']);
    const duringClear = plain.entries(); duringClear.next(); plain.clear(); plain.set('appended', 0n);
    assert.deepEqual([...duringClear], [['appended', 0n]]);
    plain.set('late', true); assert.equal(duringClear.next().done, true, 'finished native-style iterator never revives');
    plain.clear(); plain.set('first', false); plain.set('second', 0n); plain.set('third', values.at(-1));
    const visited = [];
    plain.forEach(function (value, key, owner) {
        assert.equal(this, receiver); assert.equal(owner, plain); visited.push(key);
        if (key === 'first') { plain.delete('second'); plain.set('fourth', -0); plain.set('first', true); }
        if (key === 'fourth') assert(Object.is(value, -0));
    }, receiver);
    assert.deepEqual(visited, ['first', 'third', 'fourth']);
    assert.equal(plain.get('first'), true);

    const active = { characterId: 2, phase: 'cold', activity: 'hunting', updatedAt: 4, loc: point };
    plain.clear(); plain.set(2, active);
    assert.deepEqual(plain.near(point, 1, 10), [active]);
    assert.equal(plain.recent(1)[0], active);
    plain.set(2, false);
    assert.equal(plain.locationIndex.removeSource(2, 'state', active), false);
    assert.deepEqual(plain.near(point, 1, 10), []); assert.equal(plain.get(2), false);
    plain.set(2, active); assert.deepEqual(plain.near(point, 1, 10), [active]);
    let rawLocReads = 0;
    const raw = { phase: 'hot', get loc() { rawLocReads++; throw Error('raw location'); } };
    plain.set('raw', raw); plain.set('raw', raw); assert.equal(plain.get('raw'), raw);
    plain.set('raw', 0); assert.equal(rawLocReads, 0);

    for (let otherId = 100; otherId < 164; otherId++) plain.locationIndex.put({ id: otherId, source: {}, phase: 'hot', loc: { locX: 60000, locY: 0, locZ: 0 } });
    const rawRows = plain.locationIndex.records.values.bind(plain.locationIndex.records);
    let unrelatedRows = 0;
    plain.locationIndex.records.values = function* () { for (const value of rawRows()) { unrelatedRows++; yield value; } };
    assert.equal(plain.get(2), active); assert.equal(plain.has('raw'), true);
    assert.equal(plain.size, 2); assert.deepEqual([...plain.keys()], [2, 'raw']);
    assert.deepEqual([...plain.values()], [active, 0]);
    assert.deepEqual([...plain.entries()], [[2, active], ['raw', 0]]);
    plain.forEach(() => {}); plain.clear();
    assert.equal(unrelatedRows, 0, 'Cache selected-view APIs and reset do not enumerate unrelated actor rows');
    assert.equal(plain.locationIndex.sourceSize('actor'), 64); assert.equal(nativeSize(plain), 0);
    console.log(JSON.stringify({ unrelatedActors: 64, unrelatedRows }));

    World.user = { sessions: [], revision: 0 };
    assert.equal(cache.get(id), hot); assert.equal(Life.cachedState(id), hot);
    assert.equal(Runtime.index.getSource(id, 'state').source, hot);
    assert.equal(Runtime.index.getSource(id, 'actor'), null);
    World.insertUser(session);
    cache.clear();
    assert.equal(cache.size, 0); assert.equal(nativeSize(cache), 0); assert.equal(Life.cachedState(id), null);
    assert.equal(Runtime.index.getSource(id, 'state'), null);
    assert.equal(Runtime.index.getSource(id, 'actor').source, session.actor);
    assert.throws(() => new Cache({ locationIndex: cache.locationIndex }), TypeError);
    const fresh = Life.acceptLifecycleRow(row());
    assert.equal(cache.get(id), fresh); assert.equal(Runtime.index.getSource(id, 'state').source, fresh);
    assert.deepEqual(cache.near(point, 1, 10), [fresh]); assert.equal(nativeSize(cache), 0);
    assert.equal(sqlCalls, 0); assert.equal(Database.isReady(), false);
    console.log('PASS actual native original references/empty native backing/owner before writes/primitives/live API/reset/cost; zero SQL/init');
} finally {
    for (const cache of [...observed, ...independent]) cache.clear();
    World.user = originalUser; Database.execute = originalExecute;
    require.cache[cacheFile].exports = Cache;
}
