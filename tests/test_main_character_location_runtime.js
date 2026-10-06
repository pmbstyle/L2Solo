'use strict';

const assert = require('node:assert/strict');
require('../src/Global');
const indexFile = require.resolve('../src/GameServer/World/CharacterLocationIndex');
const cacheFile = require.resolve('../src/GameServer/Bot/Population/LifeStateCache');
const Index = require(indexFile), Cache = require(cacheFile);
const indexes = [], caches = [];
// Observe native construction without replacing validation, location lookup or
// lifecycle writers. The actual production cache is used for its clear boundary.
require.cache[indexFile].exports = class ObservedIndex extends Index {
    constructor(...args) { super(...args); indexes.push(this); }
};
require.cache[cacheFile].exports = class ObservedCache extends Cache {
    constructor(...args) { super(...args); caches.push(this); }
};
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const previousUser = World.user;
const origin = { locX: 0, locY: 0, locZ: -3400 };
let serial = 9200000;
const registered = (x, id = ++serial) => {
    const session = { accountId: `player_main_map_${id}`, fetchAccountId() { return this.accountId; } };
    session.actor = new Actor({ id, name: session.accountId, username: session.accountId,
        clanId: 0, isOnline: false, ...origin, locX: x });
    session.actor.session = session;
    World.insertUser(session);
    session.actor.setIsOnline(true);
    return session;
};
const row = (id, extra = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting',
    updatedAt: 1, locX: 12000, locY: 0, locZ: 0, level: 10, ...extra });
const state = (id, x = 0, extra = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting',
    updatedAt: 1, loc: { locX: x, locY: 0, locZ: NaN }, stats: {}, ...extra });

async function main() {
    assert.equal(Database.isReady(), false);
    World.user = { sessions: [], revision: 0 };
    const firstUser = World.user;
    const target = registered(0), id = target.actor.fetchId();
    const shared = indexes.find(index => index.get(id)?.source === target.actor);
    assert(shared, 'observe native actor registration');
    const accepted = Life.acceptLifecycleRow(row(id));
    assert.equal(await Life.findByCharacterId(id), accepted, 'actual lifecycle acceptance stores the current original state');
    assert(World.realPlayerSessionsNear(origin, 1).includes(target), 'actor positive remains visible at its own location');
    const cache = caches.find(candidate => candidate.get(id) === accepted);
    assert(cache, 'observe the actual production LifeState cache');
    assert.equal(cache.near(accepted.loc, 1, 10)[0], accepted, 'old cold lookup positive at its independent location');
    console.log('PASS native actor/current lifecycle/cold-near positives before shared-source contract');
    assert.equal(shared.getSource(id, 'state')?.source, accepted,
        'actual lifecycle cache must publish the original state into the same native World index');

    const Runtime = require('../src/GameServer/World/CharacterLocationRuntime');
    assert.equal(Runtime.index, shared);
    assert.equal(cache.locationIndex, shared);
    assert.equal(cache.cells, undefined);
    assert.equal(cache.cellById, undefined, 'retire the second spatial grid');
    assert.equal(shared.getSource(id, 'actor').source, target.actor);
    assert.equal(shared.nearSources({ ...accepted.loc, locZ: 0 }, 1, { view: 'state', kind: 'cold' })[0].source, accepted);

    const hot = Life.acceptLifecycleRow(row(id, { phase: 'hot' }));
    assert.equal(cache.get(id), hot);
    assert.equal(shared.getSource(id, 'state').source, hot, 'hot state retains the original raw source');
    assert.deepEqual(shared.nearSources({ ...hot.loc, locZ: 0 }, 1, { view: 'state', kind: 'cold' }), [],
        'hot state leaves prior cold spatial membership');
    assert.equal(shared.get(id).source, target.actor);
    const pk = Life.acceptLifecycleRow(row(id, { activity: 'pk_hunting' }));
    assert.equal(cache.get(id), pk);
    assert.equal(shared.getSource(id, 'state').source, pk);
    assert.deepEqual(shared.nearSources({ ...pk.loc, locZ: 0 }, 1, { view: 'state', kind: 'cold' }), []);
    let fresh = Life.acceptLifecycleRow(row(id, { updatedAt: 2 }));
    assert.equal(shared.getSource(id, 'state').source, fresh);
    assert.equal(shared.removeSource(id, 'state', accepted), false, 'late old state cannot delete its replacement');
    const currentRecord = shared.getSource(id, 'state');
    const currentCell = shared.cells.get(shared.records.get(id).state.key).state.cold;
    cache.set(id, fresh);
    assert.equal(shared.getSource(id, 'state'), currentRecord, 'same source write retains the live projected record');
    assert.equal(shared.cells.get(shared.records.get(id).state.key).state.cold, currentCell,
        'same-cell source write retains its membership Set');
    assert.equal(cache.delete(id), true);
    assert.equal(shared.getSource(id, 'state'), null);
    assert.equal(shared.get(id).source, target.actor, 'state delete preserves the independent native actor');
    fresh = Life.acceptLifecycleRow(row(id, { updatedAt: 3 }));

    const oldToken = World.registeredActorById(id);
    const firstBinding = Runtime.bindWorld(firstUser);
    World.user = firstUser;
    assert.equal(Runtime.bindWorld(firstUser), firstBinding, 'same active World assignment is idempotent');
    assert.equal(World.registeredActorById(id), oldToken);
    assert.equal(shared.get(id).source, target.actor);
    assert.throws(() => { World.user = 42; }, TypeError);
    assert.equal(World.user, firstUser, 'invalid binding cannot evict the previous runtime');
    assert.equal(World.registeredActorById(id), oldToken);
    World.user = { sessions: [], revision: 0 };
    assert.equal(Runtime.index, shared, 'actual assignment keeps the one holder index');
    assert.equal(shared.get(id), null, 'actor membership resets immediately at assignment');
    assert.equal(shared.getSource(id, 'state').source, fresh, 'World reset keeps current cold source');
    assert.equal(World.registeredActorById(id), null);
    assert.throws(() => World.realPlayerSessionsNear(origin, 1), /uninitialized/);
    target.actor.setLocXYZ({ ...origin, locX: 2 });
    target.actor.setIsOnline(true);
    assert.equal(shared.get(id), null, 'late old source cannot republish into a new World');
    World.user = firstUser;
    assert.equal(World.registeredActorById(id), null, 'reused user object cannot revive its stale registration token');
    assert.throws(() => World.realPlayerSessionsNear(origin, 1), /uninitialized/);
    World.insertUser(target);
    assert.notEqual(World.registeredActorById(id).token, oldToken.token);
    assert.equal(shared.get(id).source, target.actor);
    assert(World.realPlayerSessionsNear({ ...origin, locX: 2 }, 1).includes(target));

    const replacement = registered(3, id);
    assert.equal(World.registeredActorById(id).actor, replacement.actor);
    target.actor.setLocXYZ({ ...origin, locX: 4 });
    assert.equal(World.retireUserActor(target, target.actor), false);
    World.removeUser(target);
    assert.equal(shared.get(id).source, replacement.actor, 'late old session cleanup preserves new actor');
    assert.equal(shared.getSource(id, 'state').source, fresh);

    let actorReads = 0, coldReads = 0;
    for (let n = 0; n < 32; n++) {
        const far = registered(100000000 + n * 6000), actor = far.actor;
        Object.defineProperty(far, 'actor', { get() { actorReads++; return actor; } });
        cache.set(actor.fetchId(), state(actor.fetchId(), 0, {
            loc: { get locX() { coldReads++; return 100000000 + n * 6000; }, locY: 0 }
        }));
    }
    actorReads = coldReads = 0;
    assert.equal(cache.near(fresh.loc, 1, 10)[0], fresh);
    assert(World.realPlayerSessionsNear({ ...origin, locX: 3 }, 9000).includes(replacement));
    assert.deepEqual({ actorReads, coldReads }, { actorReads: 0, coldReads: 0 });
    assert.equal(cache.near(origin, 1000000, 100)[0], fresh);
    assert.equal(coldReads, 0, 'safe wide metadata filters outside-range sources before location reads');
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(shared.getSource(id, 'state'), null);
    assert.equal(shared.get(id).source, replacement.actor, 'production Cache clear preserves native actor view');

    const standalone = new Cache(), other = new Cache();
    assert.notEqual(standalone.locationIndex, shared);
    assert.notEqual(standalone.locationIndex, other.locationIndex);
    const injectedIndex = new Index({ legacyStateCache: true });
    assert.equal(new Cache({ locationIndex: injectedIndex }).locationIndex, injectedIndex);
    assert.throws(() => new Cache({ locationIndex: new Index() }), TypeError,
        'reject incompatible injected index before any Cache write/query');
    const zero = state(0, 0, { loc: { locX: '0', locY: '', locZ: NaN } });
    standalone.set(0, zero);
    assert.equal(standalone.near(origin, 1, 10)[0], zero);
    assert.equal(standalone.locationIndex.getSource(0, 'state').source, zero);
    zero.loc.locX = 'bad';
    assert.deepEqual(standalone.near(origin, 1, 10), [], 'accept malformed live source before strict point access');
    zero.loc.locX = NaN;
    assert.equal(standalone.near(origin, 1, 10)[0], zero, 'source NaN truthiness normalization stays zero');
    assert.deepEqual(standalone.near({ locX: NaN, locY: 0 }, 1, 10), []);
    assert.deepEqual(standalone.near(origin, 0, 10), []);
    zero.phase = 'hot';
    assert.deepEqual(standalone.near(origin, 1, 10), [], 'current live phase exclusion');
    zero.phase = 'cold'; zero.activity = 'pk_hunting';
    assert.deepEqual(standalone.near(origin, 1, 10), []);
    zero.activity = 'hunting';
    const finiteFar = state(4, 0, { loc: { locX: 1e100, locY: -1e100 } });
    standalone.set(4, finiteFar);
    assert.equal(standalone.locationIndex.getSource(4, 'state').source, finiteFar);
    assert.deepEqual(standalone.near(origin, Number.MAX_VALUE, 10), [zero, finiteFar]);
    assert.deepEqual(standalone.near({ locX: 1e100, locY: 0 }, 1e100, 10), [zero, finiteFar]);
    // Do not call the old Cache implementation for this nonadvancing-loop case.
    assert.deepEqual(standalone.near({ locX: 1e100, locY: 0 }, 1, 10), []);

    const strict = new Index(), legacy = new Index({ legacyStateCache: true });
    const record = { id: 5, source: finiteFar, phase: 'cold', loc: { ...finiteFar.loc, locZ: 0 } };
    assert.throws(() => strict.setSource(5, 'state', record), RangeError);
    assert.throws(() => legacy.put(record), RangeError, 'legacy mode never broadens actor source geometry');
    assert.throws(() => legacy.put({ ...record, id: 0, loc: origin }), RangeError);
    assert.throws(() => strict.setSource(0, 'state', { ...record, id: 0, loc: origin }), RangeError);
    assert.throws(() => legacy.near(origin, Number.MAX_VALUE), RangeError);
    assert.throws(() => legacy.nearSources(origin, Number.MAX_VALUE, { view: 'state', kind: 'cold' }), RangeError);
    assert.throws(() => legacy.nearSources(origin, 1, { accept: 42 }), TypeError);
    assert.throws(() => legacy.nearSources(origin, 1, { allowUnsafeCellBounds: true }), RangeError);
    assert.throws(() => new Index({ legacyStateCache: 'yes' }), TypeError);
    const right = { id: 6, source: {}, phase: 'hot', loc: { ...origin, locX: 20 } };
    const left = { id: 7, source: {}, phase: 'hot', loc: { ...origin, locX: -20 } };
    strict.put(right); strict.put(left);
    assert.deepEqual(strict.near(origin, 1000000), [left, right], 'wide generic lookup retains cell-coordinate traversal order');
    strict.setSource(6, 'state', { id: 6, source: {}, phase: 'cold', loc: origin, spotId: 'cold_spot' });
    strict.clearSourceView('actor');
    assert.equal(strict.get(6), null);
    assert.equal(strict.inSpotSources('cold_spot', { view: 'state' }).length, 1);
    strict.clearSourceView('state');
    assert.equal(strict.records.size, 0);
    assert.equal(strict.cells.size, 0);
    assert.equal(strict.spots.size, 0);
    assert.throws(() => strict.clearSourceView('invalid'), RangeError);
    assert.equal(Database.isReady(), false, 'native proof never initialized a database');
    console.log('PASS main shared sources/reset/ID0/legacy geometry/strict actor/wide cost/native lifecycle controls');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const cache of caches) cache.clear();
    World.user = previousUser;
    require.cache[indexFile].exports = Index;
    require.cache[cacheFile].exports = Cache;
});
