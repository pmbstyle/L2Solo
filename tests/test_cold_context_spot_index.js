const assert = require('assert');
require('../src/Global');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

const spot = (id) => ({ id, name: id, minLevel: 10, maxLevel: 12, avgLevel: 11, density: 6,
    center: { locX: 0, locY: 0, locZ: 0 }, npcEntries: [] });
const original = SpotProfiles.cache;
try {
    const coordinator = new ColdSimulationCoordinator();
    SpotProfiles.cache = [spot('1_1'), spot('1_2')];
    const first = coordinator.contextIndex();
    const second = coordinator.contextIndex({ compactPartyMembers: true });
    assert.strictEqual(second.spots, first.spots, 'one spot catalog builds its id index once');
    assert.deepStrictEqual([...first.spots.keys()], ['1_1', '1_2']);
    assert.strictEqual(first.spots.get('1_2'), SpotProfiles.cache[1]);
    assert.strictEqual(second.compactPartyMembers, true, 'per-call options still apply');
    assert.notStrictEqual(second, first, 'every call still returns its own index object');

    SpotProfiles.cache = [spot('2_1')];
    const rebuilt = coordinator.contextIndex();
    assert.notStrictEqual(rebuilt.spots, first.spots, 'a rebuilt catalog gets a new id index');
    assert.deepStrictEqual([...rebuilt.spots.keys()], ['2_1']);
    assert.deepStrictEqual([...first.spots.keys()], ['1_1', '1_2'], 'an earlier index is not changed');
} finally { SpotProfiles.cache = original; }

console.log('cold context spot index tests passed');
