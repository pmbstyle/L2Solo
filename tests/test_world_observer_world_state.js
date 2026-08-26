const assert = require('assert');

const WorldState = require('../src/WorldObserver/public/worldState');

const decoded = WorldState.decodeBootstrap({
    actorFormat: 'row-v1',
    actorFields: ['id', 'name', 'online'],
    bots: [[1, 'Row bot', null]],
    players: [[2, 'Row player', true]]
});
assert.deepStrictEqual(decoded.bots, [{ id: 1, name: 'Row bot' }]);
assert.deepStrictEqual(decoded.players, [{ id: 2, name: 'Row player', online: true }]);

const snapshot = {
    generatedAt: 100,
    bots: [{ id: 1, name: 'Old bot' }],
    players: [{ id: 2, name: 'Player' }]
};
const applied = WorldState.applyChanges(snapshot, {
    revision: 8,
    upserts: [
        { id: 1, kind: 'bot', name: 'Moved bot' },
        { id: 3, kind: 'player', name: 'New player' }
    ],
    removals: [{ id: 2, kind: 'player' }]
}, 200);

assert.strictEqual(applied.revision, 8);
assert.deepStrictEqual(applied.snapshot.bots, [{ id: 1, name: 'Moved bot' }]);
assert.deepStrictEqual(applied.snapshot.players, [{ id: 3, name: 'New player' }]);
assert.deepStrictEqual([...applied.changedKeys].sort(), ['bot:1', 'player:2', 'player:3']);
assert.deepStrictEqual(snapshot.players, [{ id: 2, name: 'Player' }], 'the reducer must not mutate the previous snapshot');

const reset = WorldState.applyChanges(applied.snapshot, {
    revision: 12,
    reset: true,
    actors: [{ id: 4, kind: 'bot', name: 'Only actor' }]
}, 300);
assert.deepStrictEqual(reset.snapshot.bots, [{ id: 4, name: 'Only actor' }]);
assert.deepStrictEqual(reset.snapshot.players, []);

console.log('World observer state reducer checks passed');
