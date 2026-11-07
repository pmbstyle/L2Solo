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

// A red name standing still never reaches the movement gate: the one-second tick engages it.
const NpcAggro = invoke('GameServer/Npc/NpcAggro');
const engaged = [];
const standingGuard = Object.assign(actor({ name: 'Giran Court Guard' }), { fetchHostile: () => false, enterCombatState: (_, target) => engaged.push(target) });
const busyGuard = Object.assign(actor({ name: 'Giran Court Guard' }), { fetchHostile: () => false, enterCombatState: () => assert.fail('a guard in a fight keeps it') });
busyGuard.state.fetchCombats = () => true;
const red = Object.assign(actor({ karma: 240, x: 500 }), { fetchIsOnline: () => true });
const clean = Object.assign(actor({ karma: 0, x: 500 }), { fetchIsOnline: () => true });
NpcAggro.tickLiveActors({ user: { sessions: [{ actor: clean }, { actor: red }] }, fetchNpcsInRadius: () => [standingGuard, busyGuard] }, 1000);
assert.deepStrictEqual(engaged, [red], 'a guard engages the red name only, and only one not already fighting');

console.log('Town guard PK regression checks passed');
