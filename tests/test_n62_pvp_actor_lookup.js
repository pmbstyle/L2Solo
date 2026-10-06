'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Index = invoke('GameServer/Bot/AI/BotPvpIndex');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const previousUser = World.user;
const realNow = Date.now;
let now = realNow(), serial = 8_900_000;
const loc = { locX: 0, locY: 0, locZ: -3400 };

function register(properties = {}) {
    const id = properties.id ?? ++serial;
    const accountId = properties.accountId ?? `player_pvp_lookup_${id}`;
    const session = { accountId, fetchAccountId() { return this.accountId; } };
    session.actor = new Actor({ id, name: accountId, username: accountId, clanId: 0,
        isOnline: false, ...loc, ...properties });
    session.actor.session = session;
    World.insertUser(session);
    session.actor.setIsOnline(true);
    return session;
}

function instrument(session) {
    const reads = { actor: 0, coordinates: 0 };
    let actor = session.actor;
    Object.defineProperty(session, 'actor', { configurable: true,
        get() { reads.actor++; return actor; }, set(value) { actor = value; } });
    for (const key of ['fetchLocX', 'fetchLocY', 'fetchLocZ']) {
        const original = actor[key];
        actor[key] = function() { reads.coordinates++; return original.call(this); };
    }
    return reads;
}

function reset(reads) { for (const row of reads) row.actor = row.coordinates = 0; }
function totals(reads) {
    return reads.reduce((sum, row) => ({ actor: sum.actor + row.actor,
        coordinates: sum.coordinates + row.coordinates }), { actor: 0, coordinates: 0 });
}

try {
    assert.equal(invoke('Database').isReady(), false, 'fixture never opens a database or initializes World');
    Date.now = () => now;
    World.user = { sessions: [], revision: 0 };
    const target = register(), id = target.actor.fetchId();
    const originalActor = target.actor;
    assert.equal(Index.actor(String(id)), originalActor, 'numeric caller ids select the exact registered actor');
    assert.equal(Index.actor(id + 1000), null);
    assert.equal(Index.actor(NaN), null);
    target.actor.setIsOnline(false);
    assert.equal(Index.actor(id), originalActor, 'raw identity lookup also retains offline actors');
    target.actor.setIsOnline(true);
    World.retireUserActor(target, originalActor);
    assert.equal(World.registeredActorById(id).retired, true);
    assert.equal(Index.actor(id), originalActor, 'terminal spatial retirement does not change raw PvP identity');
    assert(!World.realPlayerSessionsNear(loc, 100).includes(target));
    World.insertUser(target);
    target.actor.setLocXYZ({ ...loc, locZ: NaN });
    assert.equal(Index.actor(id), originalActor, 'raw lookup has no new coordinate or floor eligibility filter');
    target.actor.setLocXYZ(loc);
    World.removeUser(target);
    assert.equal(Index.actor(id), null, 'explicit removal invalidates immediately');
    World.insertUser(target);
    const replacement = register({ id, accountId: target.accountId });
    assert.equal(Index.actor(id), replacement.actor, 'replacement is current without waiting for the old snapshot TTL');
    World.removeUser(target);
    World.retireUserActor(target, originalActor);
    originalActor.setLocXYZ({ ...loc, locX: 30_000 });
    originalActor.setIsOnline(true);
    assert.equal(Index.actor(id), replacement.actor, 'late old-source cleanup and setters cannot reclaim a replacement');
    replacement.actor.setId(id + 1);
    assert.equal(Index.actor(id), null, 'the selected current actor id is revalidated');
    replacement.actor.setId(id);
    World.updateUserLocation(replacement);
    assert.equal(Index.actor(id), replacement.actor);
    assert.equal(Threats.character({ fetchKind: () => 'Summon', fetchOwnerId: () => id }), replacement.actor,
        'the real summon-owner consumer resolves the registered owner');
    assert.equal(Threats.character({ fetchKind: () => 'Summon', fetchOwnerId: () => id + 1000 }), null);
    console.log('PASS native registered identity, offline/terminal, removal/replacement/late source and summon-owner controls');

    const companion = register();
    companion.partyCompanion = true; companion.followPlayerSession = replacement;
    const partyA = register(), partyB = register(), forming = register();
    partyA.coldLifeState = partyB.coldLifeState = { party: { partyId: 'pvp_lookup_party' } };
    forming.coldLifeState = { party: { partyId: 'forming' } };
    Index.invalidate();
    assert.deepEqual(Index.members(replacement), [replacement, companion]);
    assert.deepEqual(Index.members(companion), [companion, replacement]);
    assert.deepEqual(Index.members(partyA), [partyA, partyB]);
    assert.deepEqual(Index.members(forming), [forming]);
    companion.followPlayerSession = forming;
    now += Index.REFRESH_MS + 1;
    assert.deepEqual(Index.members(replacement), [replacement], 'existing party snapshot refresh still follows its TTL');
    assert.deepEqual(Index.members(forming), [forming, companion]);
    console.log('PASS unchanged follow-player/background/forming party membership and snapshot TTL');

    // Execute the exact helper under the existing cold-worker dependency
    // boundary. This proves lazy loading, not a native worker thread run.
    const workerSource = fs.readFileSync(require.resolve('../src/GameServer/Bot/Population/ColdSimulationWorker'), 'utf8');
    const forbidden = /^(Database|GameServer\/World(?:\/|$)|GameServer\/Bot\/BotManager|GameServer\/Network(?:\/|$)|Server$)/;
    assert(workerSource.includes(`const forbidden = ${forbidden};`));
    assert(!workerSource.includes("['GameServer/World/World',"), 'worker has no real-World mirror');
    const calls = [], moduleControl = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/GameServer/Bot/AI/BotPvpIndex'), 'utf8'), {
        module: moduleControl, invoke(name) {
            calls.push(name);
            if (forbidden.test(name)) throw new Error(`cold worker forbidden dependency: ${name}`);
            throw new Error(`unexpected actor lookup dependency: ${name}`);
        }
    });
    assert.deepEqual(calls, [], 'module load must not import or invoke World');
    assert.throws(() => moduleControl.exports.actor(id), /cold worker forbidden dependency: GameServer\/World\/World/);
    assert.deepEqual(calls, ['GameServer/World/World']);

    const unrelated = Array.from({ length: 64 }, (_, n) => instrument(register({ locX: 100_000 + n * 6000 })));
    for (const invalidate of [true, false]) {
        if (invalidate) Index.invalidate();
        else now += Index.REFRESH_MS + 1;
        reset(unrelated);
        assert.equal(Index.actor(id), replacement.actor);
        assert.deepEqual(totals(unrelated), { actor: 0, coordinates: 0 },
            'direct actor lookup must never refresh distant unrelated registered owners, including invalidation/TTL boundaries');
    }
    assert.equal(invoke('Database').isReady(), false);
    console.log('PASS indexed PvP actor lookup; zero unrelated-owner reads, lazy worker dependency and no database/server');
} finally {
    Date.now = realNow;
    World.user = previousUser;
    Index.invalidate();
}
