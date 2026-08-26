const assert = require('assert');

require('../src/Global');

const Projection = invoke('WorldObserver/WorldObserverProjection');

Projection.clear();
const initial = Projection.reset([
    { id: 1, kind: 'bot', name: 'One', loc: { locX: 10, locY: 20 } },
    { id: 2, kind: 'player', name: 'Two', loc: { locX: 30, locY: 40 } }
]);
assert.strictEqual(initial.revision, 1);
assert.strictEqual(initial.actors.length, 2);

const unchanged = Projection.apply({ upserts: [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 10, locY: 20 } }] });
assert.strictEqual(unchanged.revision, 1, 'identical actors must not advance the world revision');
assert.deepStrictEqual(Projection.changesSince(1), { revision: 1, reset: false, upserts: [], removals: [] });

const changed = Projection.apply({
    upserts: [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 11, locY: 20 } }],
    removals: [{ id: 2, kind: 'player' }]
});
assert.strictEqual(changed.revision, 2);
assert.deepStrictEqual(Projection.changesSince(1), {
    revision: 2,
    reset: false,
    upserts: [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 11, locY: 20 } }],
    removals: [{ id: 2, kind: 'player' }]
});

const reset = Projection.changesSince(0);
assert.strictEqual(reset.reset, true);
assert.deepStrictEqual(reset.actors, [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 11, locY: 20 } }]);

Projection.clear();
console.log('World observer projection checks passed');
