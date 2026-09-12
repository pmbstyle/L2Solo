const assert = require('assert');
const { spawnSync } = require('child_process');
const Budget = require('../src/GameServer/Bot/Population/PvpEncounterBudget');
const start = 1800000000000;
const encounter = { startedAt: start, expiresAt: start + Budget.INITIAL_MS, actions: 40 };
const active = { ongoing: true, fighters: [{ attacks: 1 }] };
for (const combat of [
    { ongoing: true, fighters: [{ attacks: 0, heals: 1 }] },
    { ...active, ongoing: false, outcome: 'retreated' },
    { ...active, ongoing: false, outcome: 'killed' },
    { ...active, ongoing: false, outcome: 'disengaged' }
]) assert.strictEqual(Budget.extend(encounter, combat, start + 26000), encounter,
    'healing, idle time and completed fights do not renew an encounter');
assert.strictEqual(Budget.extend(encounter, active, encounter.expiresAt), encounter,
    'a delayed callback cannot resurrect an expired fight');
const exhausted = { ...encounter, actions: Budget.MAX_ACTIONS };
assert.strictEqual(Budget.extend(exhausted, active, start + 26000), exhausted,
    'extensions do not grant another action budget');
const result = spawnSync(process.execPath, [require.resolve('./test_pvp_encounter_handoff'), '--extension'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
