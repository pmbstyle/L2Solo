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
cache.clear(); assert.strictEqual(cache.cells.size, 0); assert.strictEqual(cache.size, 0);
console.log('Life state spatial parity, movement, phase and ordered cache checks passed');
