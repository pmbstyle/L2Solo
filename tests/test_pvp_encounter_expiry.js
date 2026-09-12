const { spawnSync } = require('child_process');
const result = spawnSync(process.execPath, [require.resolve('./test_pvp_encounter_handoff'), '--expire-cooldown'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
