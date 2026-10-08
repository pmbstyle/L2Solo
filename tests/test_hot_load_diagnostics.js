const assert = require('node:assert/strict');
require('../src/Global');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Load = invoke('GameServer/Bot/LoadTest/HotBotLoadTest');
const interval = global.setInterval;
Config.developerDiagnostics = false;
Config.debug = true;
global.setInterval = () => { throw Error('load test timer constructed off'); };
try {
    Load.start();
    assert.equal(Load.started, false);
} finally { global.setInterval = interval; }
console.log('Hot load harness requires developer diagnostics before starting work');
