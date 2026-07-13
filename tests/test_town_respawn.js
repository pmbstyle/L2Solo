const assert = require('assert');

require('../src/Global');

const TownRespawn = invoke('GameServer/World/TownRespawn');
const BotAI = invoke('GameServer/Bot/BotAI');

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(76000, 144000),
    { locX: 83446, locY: 147904, locZ: -3400 },
    'a player who dies near Giran should respawn beside the Giran gatekeeper'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(-82000, 151000),
    { locX: -80702, locY: 149776, locZ: -3040 },
    'a player who dies near Gludin should respawn beside the Gludin gatekeeper'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(166612, 20436),
    { locX: 146787, locY: 25807, locZ: -2008 },
    'Cemetery belongs to the Aden restart region, not Oren'
);

assert.deepStrictEqual(
    TownRespawn.getRespawnCoords(146828, -12859),
    { locX: 146787, locY: 25807, locZ: -2008 },
    'Blazing Swamp belongs to the Aden restart region, not Oren'
);

assert.strictEqual(
    BotAI.getClosestTown(76000, 144000).name,
    'Giran',
    'bots should use the same nearest-town source as player respawns'
);

console.log('Town respawn regression checks passed');
