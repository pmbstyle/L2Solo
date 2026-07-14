const assert = require('assert');

require('../src/Global');

const TownGuard = invoke('GameServer/Npc/TownGuard');

function actor({ name = 'Guard', karma = 0, x = 0, y = 0, z = 0, dead = false } = {}) {
    return {
        fetchName: () => name,
        fetchKarma: () => karma,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => z,
        state: { fetchDead: () => dead }
    };
}

assert.strictEqual(TownGuard.isTownGuard(actor({ name: 'Giran Bow Guard E' })), true, 'city guard variants must be classified as guards');
assert.strictEqual(TownGuard.isTownGuard(actor({ name: 'Ant Guard' })), false, 'monster guards must not police PKs');
assert.strictEqual(TownGuard.isTownGuard(actor({ name: 'Guard' })), true, 'generic town guards must police PKs');

const guard = actor({ name: 'Giran Court Guard', x: 0, y: 0 });
assert.strictEqual(TownGuard.canEngage(guard, actor({ karma: 720, x: 500, y: 0 })), true, 'a guard should engage a visible red name in guard range');
assert.strictEqual(TownGuard.canEngage(guard, actor({ karma: 0, x: 500, y: 0 })), false, 'a guard must not engage a white player');
assert.strictEqual(TownGuard.canEngage(guard, actor({ karma: 720, x: 1500, y: 0 })), false, 'a guard must not chase a PK outside its aggro range');

console.log('Town guard PK regression checks passed');
