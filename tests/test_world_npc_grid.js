const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');

const originalNpc = World.npc;
try {
    let locX = 100;
    let locY = 100;
    const npc = {
        fetchLocX: () => locX,
        fetchLocY: () => locY
    };

    World.npc = {
        spawns: [npc],
        grid: {},
        gridKeys: new WeakMap()
    };
    World.indexSpawnsInGrid();
    assert.deepStrictEqual(World.npc.grid['0_0'], [npc], 'the startup rebuild must index the NPC once');

    locX = 6500;
    locY = 100;
    assert.strictEqual(World.removeNpcFromGrid(npc), true,
        'removal must use the recorded insertion sector after the NPC has moved');
    assert.strictEqual(World.npc.grid['0_0'], undefined, 'the original sector must not retain a stale NPC');

    assert.strictEqual(World.addNpcToGrid(npc), true, 'incremental insertion must accept the moved NPC');
    assert.deepStrictEqual(World.npc.grid['1_0'], [npc], 'incremental insertion must use the current sector');
    World.addNpcToGrid(npc);
    assert.strictEqual(World.npc.grid['1_0'].length, 1, 'incremental insertion must not duplicate an NPC');

    locX = 12500;
    World.addNpcToGrid(npc);
    assert.strictEqual(World.npc.grid['1_0'], undefined, 'reindexing a moved NPC must clear its previous sector');
    assert.deepStrictEqual(World.npc.grid['2_0'], [npc], 'reindexing must place the NPC in its new sector');
} finally {
    World.npc = originalNpc;
}

console.log('World NPC grid checks passed');
