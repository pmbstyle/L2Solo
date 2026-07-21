const assert = require('assert');

require('../src/Global');

const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
invoke('GameServer/DataCache').init();

const now = 1_750_000_000_000;
const state = {
    characterId: 72,
    name: 'RecoveringHunter',
    level: 40,
    levelBand: '38-42',
    activity: 'resting',
    spotId: 'execution_ground',
    vitals: { hp: 200, maxHp: 1200, mp: 50, maxMp: 650 },
    stats: { classId: 1, role: 'dps', restUntil: now + 600000 },
    party: { role: 'dps' }
};

const recovering = BackgroundResolver.resolveSolo({
    state,
    spot: { id: 'execution_ground' },
    elapsedMs: 30000,
    timestamp: now + 30000
});

assert.strictEqual(recovering.patch.activity, 'resting', 'a cold bot must not fight before it has recovered');
assert(recovering.patch.vitals.hp > state.vitals.hp, 'cold resting must restore HP with C4 ticks');
assert(recovering.patch.vitals.mp > state.vitals.mp, 'cold resting must restore MP with C4 ticks');
assert.strictEqual(recovering.materialize.exp, 0, 'cold resting must not award combat XP');
assert(recovering.patch.stats.restUntil > now + 30000, 'cold recovery deadline must remain persisted in stats');

const ready = BackgroundResolver.resolveSolo({
    state: {
        ...state,
        vitals: { hp: 1200, maxHp: 1200, mp: 650, maxMp: 650 },
        stats: { ...state.stats, restUntil: now - 1 }
    },
    spot: { id: 'execution_ground' },
    elapsedMs: 3000,
    timestamp: now
});
assert.strictEqual(ready.patch.activity, 'hunting', 'a recovered cold bot should return to hunting after its recovery delay');
assert.strictEqual(ready.patch.stats.restUntil, null, 'completed recovery must clear its persisted deadline');

console.log('Bot background rest checks passed');
