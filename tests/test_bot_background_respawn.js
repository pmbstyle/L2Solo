const assert = require('assert');

require('../src/Global');

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');

const state = {
    characterId: 71,
    name: 'FallenHunter',
    level: 20,
    levelBand: '18-22',
    activity: 'dead',
    currentRegion: 'Execution Ground',
    spotId: 'execution_ground',
    vitals: { hp: 0, maxHp: 800, mp: 0, maxMp: 420 },
    stats: { deaths: 3 },
    party: { role: 'dps' }
};

const result = BackgroundResolver.resolveSolo({ state, spot: null, elapsedMs: 60000 });

assert.strictEqual(result.patch.activity, 'resting', 'a dead cold bot must recover before returning to the hunt');
assert.strictEqual(result.patch.vitals.hp, result.patch.vitals.maxHp, 'background respawn restores HP');
assert.strictEqual(result.patch.vitals.mp, result.patch.vitals.maxMp, 'background respawn restores MP');
assert(result.nextResolveAt >= Date.now() + 85000, 'background respawn includes a recovery delay');
assert.strictEqual(result.events[0].type, 'respawn');
assert.strictEqual(result.materialize.exp, 0, 'recovery must not award combat XP');

console.log('Bot background respawn checks passed');
