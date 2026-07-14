const assert = require('assert');

require('../src/Global');

const SpawnNpcs = invoke('GameServer/World/Generics/SpawnNpcs');

assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 0 }, () => 0.5), 60000, 'fixed NPC respawn should use its datapack seconds');
assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 10 }, () => 0), 50000, 'respawn bias should permit the sourced early bound');
assert.strictEqual(SpawnNpcs.respawnDelayMs({ respawn: 60, bias: 10 }, () => 1), 70000, 'respawn bias should permit the sourced late bound');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: -1 }), false, 'datapack sentinel -1 must not schedule an NPC respawn');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: 0 }), false, 'zero respawn must not schedule an NPC respawn');
assert.strictEqual(SpawnNpcs.shouldRespawn({ respawn: 60 }), true, 'positive respawn must schedule an NPC respawn');

console.log('NPC respawn regression checks passed');
