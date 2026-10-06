const assert = require('assert');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const cache = new Cache();
const states = Array.from({ length: 2500 }, (_, characterId) => ({
    characterId, updatedAt: characterId, phase: characterId % 5 ? 'cold' : 'hot',
    activity: characterId % 7 ? 'hunting' : 'pk_hunting',
    loc: { locX: (characterId * 1337) % 150000 - 75000, locY: (characterId * 451) % 150000 - 75000 }
}));
states.forEach(state => cache.set(state.characterId, state));
for (const loc of [{ locX: 0, locY: 0 }, { locX: -6000, locY: 6000 }, { locX: 14900, locY: 18000 }]) {
    for (const radius of [1, 6000, 9000, 30000]) {
        const distance = state => (state.loc.locX - loc.locX) ** 2 + (state.loc.locY - loc.locY) ** 2;
        const expected = states.filter(state => state.phase === 'cold' && state.activity !== 'pk_hunting' && distance(state) <= radius ** 2)
            .sort((a, b) => distance(a) - distance(b) || a.characterId - b.characterId).slice(0, 100);
        assert.deepStrictEqual(cache.near(loc, radius, 100), expected, 'spatial lookup matches exhaustive search');
    }
}
cache.set(1, { ...states[1], loc: { locX: 0, locY: 0 } });
assert.strictEqual(cache.near({ locX: 0, locY: 0 }, 1, 100)[0].characterId, 1);
cache.set(1, { ...cache.get(1), phase: 'hot' });
assert(!cache.near({ locX: 0, locY: 0 }, 1, 100).some(state => state.characterId === 1));
assert.strictEqual(cache.recent(1)[0].characterId, 2499);
cache.set(2, { ...states[2], updatedAt: 9999 });
assert.strictEqual(cache.recent(1)[0].characterId, 2);
cache.delete(2); assert(!cache.recent(2500).some(state => state.characterId === 2));
cache.clear();
assert.deepStrictEqual(cache.locationIndex.nearSources({ locX: 0, locY: 0, locZ: 0 }, Number.MAX_VALUE,
    { view: 'state', kind: 'cold', allowUnsafeCellBounds: true }), []);
assert.strictEqual(cache.size, 0);
assert.deepStrictEqual(cache.recent(10), []);

// The order kept on every write equals a stable sort of the Map values:
// newest updatedAt first, equal times in Map (first insertion) order.
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const reference = new Map();
const sorted = () => [...reference.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
for (let step = 0; step < 20000; step++) {
    const id = Math.floor(random() * 300);
    const roll = random();
    if (roll < 0.1) {
        cache.delete(id); reference.delete(id);
    } else {
        // Few distinct times: many ties, also missing and zero updatedAt.
        const updatedAt = roll < 0.15 ? undefined : Math.floor(random() * 40);
        const state = { characterId: id, updatedAt, phase: 'cold', activity: 'hunting', loc: { locX: id, locY: 0 } };
        cache.set(id, state); reference.set(id, state);
    }
    if (step % 97 === 0) assert.deepStrictEqual(cache.recent(2000), sorted(), `order after step ${step}`);
}
assert.deepStrictEqual(cache.recent(2000), sorted(), 'final order');
assert.deepStrictEqual(cache.recent(5), sorted().slice(0, 5), 'limit');
console.log('Life state spatial parity, movement, phase and ordered cache checks passed');
