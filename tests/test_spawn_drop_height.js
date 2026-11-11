const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const geodataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-drop-height-'));
const previousGeodataDir = process.env.L2NODE_GEODATA_DIR;
process.env.L2NODE_GEODATA_DIR = geodataDir;
const { useRate } = require('./helpers/progressionRate');
require('../src/Global');

const Data = invoke('GameServer/DataCache');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');
const Rewards = invoke('GameServer/World/Generics/NpcRewards');
const SpawnItem = invoke('GameServer/World/Generics/SpawnItem');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Etiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');

Data.init();
const restores = [];
const created = [];
function replace(object, key, value) {
    const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value;
}
function coords(object) {
    return { locX: object.fetchLocX(), locY: object.fetchLocY(), locZ: object.fetchLocZ() };
}

// Use the real geodata height decoder over a small synthetic complex block.
// Every block shares it; the terrain slopes across both cell axes. No local
// geodata files are needed, and wrong spawn/drop Z is visible in wire packets.
const regionKey = Geo.getRegionKey(59814, 25253);
const block = Buffer.alloc(129);
block[0] = 1;
for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) {
    block.writeInt16LE(((-4480 + x * 16 + y * 8) * 2) | 15, 1 + (x * 8 + y) * 2);
}

try {
    replace(Geo, 'regions', { [regionKey]: block });
    replace(Geo, `index_${regionKey}`, new Uint32Array(65536));
    const packets = [];
    const session = { accountId: 'player_height_test', actor: {
        fetchId: () => 990001, fetchLevel: () => 45, fetchIsOnline: () => true,
        fetchLocX: () => 59814, fetchLocY: () => 25253
    }, dataSendToMe: packet => packets.push(packet), dataSendToMeAndOthers: packet => packets.push(packet) };
    const world = { npc: { spawns: [], nextId: 1000000, periodMode: 'day' },
        user: { sessions: [session] }, items: { spawns: [], nextId: 5000000 },
        addNpcToGrid() {}, spawnItem: SpawnItem };
    const template = Data.npcs.find(npc => npc.selfId === 558);
    assert(template, 'the incident fixture uses the real Rotting Tree template');
    const definition = { npc: template, bounds: [
        { locX: 59760, locY: 25200, minZ: -4800, maxZ: -3818 },
        { locX: 59856, locY: 25200, minZ: -4800, maxZ: -3818 },
        { locX: 59856, locY: 25296, minZ: -4800, maxZ: -3818 },
        { locX: 59760, locY: 25296, minZ: -4800, maxZ: -3818 }
    ], spawn: { selfId: 558, coords: [], total: 1, respawn: 60, bias: 0 } };
    replace(Data, 'npcSpawns', [{ bounds: definition.bounds, spawns: [definition.spawn] }]);
    SpawnNpcs.call(world);
    const initial = world.npc.spawns[0]; created.push(initial);
    assert.strictEqual(initial.fetchLocZ(), Geo.getHeight(initial.fetchLocX(), initial.fetchLocY(), -3818),
        'initial polygon spawns must stand on terrain instead of the territory ceiling');
    assert.notStrictEqual(initial.fetchLocZ(), -3818);

    packets.length = 0;
    const respawn = SpawnNpcs.spawnNpc(world, definition); created.push(respawn);
    assert.strictEqual(respawn.fetchLocZ(), Geo.getHeight(respawn.fetchLocX(), respawn.fetchLocY(), -3818),
        'the respawn path must also resolve the selected XY to terrain');
    assert(packets.some(packet => packet[0] === 0x16), 'grounded respawns are announced through NpcInfo');

    const fixed = { locX: 59814, locY: 25253, locZ: -3901, head: 123 };
    const explicit = SpawnNpcs.spawnNpc(world, { ...definition, spawn: { ...definition.spawn, coords: [fixed] } });
    created.push(explicit);
    assert.deepStrictEqual(coords(explicit), { locX: fixed.locX, locY: fixed.locY, locZ: fixed.locZ },
        'explicit datapack heights must survive terrain correction unchanged');

    replace(Party, 'groundLootLeader', value => value);
    replace(Party, 'queueRandomGroundPickup', () => false);
    replace(Etiquette, 'observeDrop', () => {});
    replace(Data, 'fetchNpcRewardsFromSelfId', (_id, callback) => callback({ rewards: [
        { overall: 100, items: [{ selfId: 57, min: 15000, max: 15000, chance: 100 }] }
    ] }));
    const originalPreset = process.env.L2NODE_PROGRESSION_RATE;
    restores.push(() => {
        useRate(originalPreset);
    });
    useRate('x1');
    const npc = { fetchSelfId: () => 558, fetchLevel: () => 43,
        fetchLocX: () => 59814, fetchLocY: () => 25253, fetchLocZ: () => -3818 };
    for (let index = 0; index < 10; index++) Rewards.call(world, session, npc);
    assert.strictEqual(world.items.spawns.length, 10, 'all guaranteed drops reach the physical world');
    world.items.spawns.forEach(item => {
        const ground = Geo.getHeight(item.fetchLocX(), item.fetchLocY(), npc.fetchLocZ());
        assert.strictEqual(item.fetchLocZ(), ground, 'each scattered drop rests on the terrain at its own XY');
        assert.strictEqual(item.fetchAmount(), 15000, 'grounding preserves the rolled stack');
        assert.strictEqual(item.model.partyLootLeaderId, 990001, 'grounding preserves loot provenance');
        const packet = packets.find(packet => packet[0] === 0x0b && packet.readInt32LE(1) === item.fetchId());
        assert(packet, 'a grounded drop is sent to the player');
        assert.strictEqual(packet.readInt32LE(17), ground, 'C4 SpawnItem transmits the grounded Z');
    });

    // Two floors at the same XY: the corpse is on the lower one. The player
    // on the upper floor must not pull its loot through the ceiling.
    const layered = Buffer.alloc(1 + 64 * 5); layered[0] = 2;
    for (let cell = 0; cell < 64; cell++) {
        const offset = 1 + cell * 5; layered[offset] = 2;
        layered.writeInt16LE((-4400 * 2) | 15, offset + 1);
        layered.writeInt16LE((-3800 * 2) | 15, offset + 3);
    }
    Geo.regions[regionKey] = layered;
    const upperFloor = SpawnNpcs.spawnNpc(world, definition); created.push(upperFloor);
    assert.strictEqual(upperFloor.fetchLocZ(), -3800,
        'a territory height hint selects its own layer instead of the lowest floor');
    Rewards.call(world, session, { ...npc, fetchLocZ: () => -4394 });
    assert.strictEqual(world.items.spawns.at(-1).fetchLocZ(), -4400,
        'loot resolves the corpse floor, including the six-unit actor offset');

    // Remove the synthetic data; the empty directory has no fallback region file.
    replace(Geo, 'regions', {});
    replace(Geo, `index_${regionKey}`, undefined);
    const fallback = SpawnNpcs.spawnNpc(world, definition); created.push(fallback);
    assert.strictEqual(fallback.fetchLocZ(), -3818, 'missing geodata retains the authored territory height');
    Rewards.call(world, session, { ...npc, fetchLocZ: () => -4394 });
    assert.strictEqual(world.items.spawns.at(-1).fetchLocZ(), -4394,
        'missing geodata retains the corpse height without burying the item');
    console.log('Spawn/drop heights: initial spawn, respawn, fixed coordinates, slopes, C4 packets, layers and fallback passed');
} finally {
    created.forEach(npc => npc?.destructor?.({ dataSendToMe() {}, dataSendToMeAndOthers() {} }));
    restores.reverse().forEach(restore => restore());
    if (previousGeodataDir === undefined) delete process.env.L2NODE_GEODATA_DIR;
    else process.env.L2NODE_GEODATA_DIR = previousGeodataDir;
    fs.rmSync(geodataDir, { recursive: true, force: true });
}
