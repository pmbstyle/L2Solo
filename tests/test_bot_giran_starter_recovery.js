const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const BotManager = invoke('GameServer/Bot/BotManager');

DataCache.init();

const starter = {
    username: 'bot_ti_01',
    name: 'Aldren',
    homeRegion: 'Talking Island',
    spawnClassId: 0,
    classId: 0
};
const stacked = { locX: 83180, locY: 147780, locZ: -3466 };
const recovered = BotManager.recoverStarterSpawn(starter, stacked);

assert.notStrictEqual(recovered.locX, stacked.locX, 'a starter retained at the old Giran stack must receive a home spawn');
assert.notStrictEqual(recovered.locY, stacked.locY, 'a starter retained at the old Giran stack must receive a home spawn');
assert.deepStrictEqual(
    BotManager.recoverStarterSpawn(starter, stacked),
    recovered,
    'starter recovery must be stable across restarts rather than reshuffling the town on every boot'
);
assert.strictEqual(
    BotManager.recoverStarterSpawn({ ...starter, merchantConfigName: 'GiranWeapons', locX: 70000, locY: 50000, locZ: -1500 }, stacked).locX,
    70000,
    'configured merchant locations must never be moved by the starter recovery'
);
assert.strictEqual(
    BotManager.recoverStarterSpawn({ ...starter, merchantConfigName: 'GiranWeapons', locX: 70000, locY: 50000, locZ: -1500 }, stacked).locY,
    50000,
    'configured merchant locations must never be moved by the starter recovery'
);

console.log('Bot Giran starter recovery checks passed');
