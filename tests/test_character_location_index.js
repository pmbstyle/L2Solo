'use strict';

const assert = require('assert');
const CharacterLocationIndex = require('../src/GameServer/World/CharacterLocationIndex');
const { SPOT_CELL_SIZE } = require('../src/GameServer/World/WorldConstants');

function location(locX, locY = 0, locZ = 0) {
    return { locX, locY, locZ };
}

function character(id, loc, extra = {}) {
    return { id, source: {}, phase: 'hot', realPlayer: false, loc, spotId: null, ...extra };
}

function ids(records) {
    return records.map((record) => record.id).sort((a, b) => a - b);
}

const index = new CharacterLocationIndex();
assert.strictEqual(index.cellSize, SPOT_CELL_SIZE, 'reuse the authored spot cells without changing radius');
const player = character(1, location(-1, -1, 25), { realPlayer: true, spotId: '-1_-1' });
const hot = character(2, location(1), { spotId: '0_0' });
const cold = character(3, location(2), { phase: 'cold', spotId: '0_0' });
index.put(player);
index.put(hot);
index.put(cold);
assert.deepStrictEqual(ids(index.near(location(0), 10)), [1, 2, 3]);
assert.deepStrictEqual(index.near(location(0), 10, { kind: 'player' }), [player]);
assert.deepStrictEqual(ids(index.near(location(0), 10, { kind: 'hot' })), [1, 2]);
assert.deepStrictEqual(index.near(location(0), 10, { kind: 'cold' }), [cold]);
assert.deepStrictEqual(ids(index.inSpot('0_0')), [2, 3], 'spot membership uses the same character records');
assert.strictEqual(index.get(1), player, 'keep the original runtime record/source identity');

player.loc.locX = -8;
player.loc.locZ = 500;
assert.deepStrictEqual(index.near(location(-8, -1, -500), 0, { kind: 'player' }), [player],
    'same-cell position is live and XY lookup leaves floor policy to its caller');
assert.deepStrictEqual(index.near(location(-1, -1), 0, { kind: 'player' }), [],
    'same-cell movement must not return an old copied point');
player.loc.locX = -6001;
player.spotId = '-2_-1';
assert.strictEqual(index.update(player.id, player.source), true);
assert.strictEqual(index.get(player.id), player, 'movement refresh retains the runtime record and live location reference');
assert.deepStrictEqual(index.near(location(-6001, -1), 0), [player], 'negative cell boundary refresh');
assert.deepStrictEqual(index.inSpot('-1_-1'), [], 'old spot membership is removed');
assert.deepStrictEqual(index.inSpot('-2_-1'), [player]);
player.loc = location(24001, 24001, 50);
player.spotId = '4_4';
index.update(player.id, player.source);
assert.deepStrictEqual(index.near(location(-6001, -1), 0), [], 'teleport removes the old cell');
assert.deepStrictEqual(index.near(location(24001, 24001), 0), [player]);

const boundary = character(4, location(15000, 3000, 100), { realPlayer: true });
index.put(boundary);
assert.deepStrictEqual(index.near(location(6000, 3000), 9000, { kind: 'player' }), [boundary],
    '9000 radius must reach cells beyond the legacy nine-bucket shape and include exact boundary');
boundary.loc.locX += 1;
assert.deepStrictEqual(index.near(location(6000, 3000), 9000, { kind: 'player' }), [],
    'live exact distance excludes a point just outside the requested radius');
assert.deepStrictEqual(index.near(location(0), 0), [], 'zero radius is a valid exact-point query');
const diagonal = character(5, location(3000, 4000), { realPlayer: true });
index.put(diagonal);
assert.deepStrictEqual(index.near(location(0), 5000, { kind: 'player' }), [diagonal],
    'diagonal exact distance retains the native squared-distance boundary');
assert.deepStrictEqual(index.near(location(0), 4999, { kind: 'player' }), []);
index.remove(diagonal.id, diagonal.source);

const replacement = character(1, location(10), { realPlayer: true });
index.put(replacement);
assert.strictEqual(index.remove(player.id, player.source), false, 'late old source removal cannot evict replacement');
assert.strictEqual(index.update(player.id, player.source), false, 'late old source refresh cannot move replacement');
assert.strictEqual(index.get(1), replacement);
const refreshed = { ...replacement, loc: location(15), spotId: 'new_spot' };
index.put(refreshed);
assert.strictEqual(index.get(1), refreshed, 'same-source refresh keeps the latest live record reference');
assert.deepStrictEqual(index.near(location(15), 0), [refreshed], 'same-cell refresh creates no duplicate character');
assert.deepStrictEqual(index.inSpot('new_spot'), [refreshed]);
assert.deepStrictEqual(index.inSpot('4_4'), [], 'replacement retires the old spot membership');
refreshed.realPlayer = false;
refreshed.phase = 'cold';
index.update(refreshed.id, refreshed.source);
assert.deepStrictEqual(index.near(location(15), 0, { kind: 'player' }), [], 'eligibility is refreshed immediately');
assert.deepStrictEqual(index.near(location(15), 0, { kind: 'cold' }), [refreshed]);
assert.strictEqual(index.remove(1, replacement.source), true);
assert.strictEqual(index.remove(1, replacement.source), false);
assert.strictEqual(index.get(1), null);
assert.deepStrictEqual(index.near(location(15), 0), [], 'removed source cannot remain in an empty bucket');
assert.deepStrictEqual(index.inSpot('new_spot'), [], 'remove retires the refreshed spot membership');

let unrelatedReads = 0;
for (let id = 100; id < 200; id += 1) {
    index.put(character(id, () => { unrelatedReads += 1; return location(0); }));
    index.put(character(id + 1000, () => { unrelatedReads += 1; return location(100000, 100000); }, { realPlayer: true }));
}
const local = character(500, location(10, 10, 2), { realPlayer: true });
index.put(local);
unrelatedReads = 0;
assert.deepStrictEqual(index.near(location(0), 100, { kind: 'player' }), [local]);
assert.strictEqual(unrelatedReads, 0, 'do not read local bots or distant players on a nearby player query');

for (const radius of [-1, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.throws(() => index.near(location(0), radius), RangeError, 'invalid/overflowing radius rejects explicitly');
}
for (const loc of [null, location(NaN), location(0, Infinity), location(0, 0, NaN)]) {
    assert.throws(() => index.near(loc, 1), RangeError, 'malformed query cannot silently look empty');
}
assert.throws(() => index.near(location(0), 1, { kind: 'unknown' }), RangeError);
assert.throws(() => index.put(character(0, location(0))), RangeError);
assert.throws(() => index.put(character(600, location(Infinity))), RangeError);
assert.throws(() => new CharacterLocationIndex({ cellSize: 0 }), RangeError);
index.clear();
assert.strictEqual(index.get(500), null);
assert.deepStrictEqual(index.near(location(0), 100000, { kind: 'player' }), []);
assert.deepStrictEqual(index.inSpot('0_0'), []);
assert.strictEqual(index.update(local.id, local.source), false, 'reset drops old memberships');

// Exercise only the actual World's runtime adapter, without Global, listeners,
// databases or World.init. Native Model/Coordinator integration has its own fixture.
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const worldFile = require.resolve('../src/GameServer/World/World');
const isolatedModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(worldFile, 'utf8'), {
    module: isolatedModule,
    require: createRequire(worldFile),
    path: { world: 'GameServer/World/' },
    invoke(name) {
        if (name === 'GameServer/World/WorldConstants') return require('../src/GameServer/World/WorldConstants');
        return { invalidate() {}, broadcastMemberPresence() {} };
    }
}, { filename: worldFile });
const World = isolatedModule.exports;
World.user = { sessions: [], revision: 0 };
const model = { id: 700, ...location(10, 20, 30), isOnline: true };
const actor = {
    fetchId: () => model.id,
    fetchLocX: () => model.locX,
    fetchLocY: () => model.locY,
    fetchLocZ: () => model.locZ,
    fetchIsOnline: () => model.isOnline
};
const session = { actor, accountId: 'player_location_fixture', fetchAccountId() { return this.accountId; } };
World.insertUser(session);
assert.strictEqual(World.realPlayerSessionsNear(location(10, 20), 0)[0], session);
for (const key of ['locX', 'locY', 'locZ']) {
    const old = model[key];
    model[key] = NaN;
    assert.doesNotThrow(() => World.updateUserLocation(session, actor), 'malformed live actor is skipped without failing its setter');
    assert.strictEqual(World.realPlayerSessionsNear(location(10, 20), 100).length, 0);
    assert.strictEqual(model.isOnline, true, 'invalid location does not change online status');
    model[key] = old;
    assert.strictEqual(World.updateUserLocation(session, actor), true, 'valid native update recovers the same source without re-registration');
    assert.strictEqual(World.realPlayerSessionsNear(location(10, 20), 0)[0], session);
}
Object.assign(model, { locX: '10', locY: '20', locZ: '30' });
assert.doesNotThrow(() => World.updateUserLocation(session, actor), 'native actor coordinates retain the original Number normalization');
assert.strictEqual(World.realPlayerSessionsNear(location(10, 20), 0)[0], session);
World.removeUser(session);
const partialActor = { fetchId: () => 701, fetchIsOnline: () => true };
const partialSession = { actor: partialActor, accountId: 'player_without_coordinates', fetchAccountId() { return this.accountId; } };
assert.doesNotThrow(() => World.insertUser(partialSession), 'existing non-location World consumers may register partial native actors');
assert.strictEqual(World.realPlayerSessionsNear(location(0), 100).length, 0, 'missing getters skip rather than inventing a location');
Object.assign(partialActor, { fetchLocX: () => 1, fetchLocY: () => 2, fetchLocZ: () => 3 });
assert.strictEqual(World.updateUserLocation(partialSession), true, 'a partial source can recover when real coordinates become available');
assert.strictEqual(World.realPlayerSessionsNear(location(1, 2), 0)[0], partialSession);
World.removeUser(partialSession);
console.log('character_location_index: PASS');
