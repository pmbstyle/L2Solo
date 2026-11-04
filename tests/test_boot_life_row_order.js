'use strict';
// R16: the boot passes that write bot life rows (the board migrations, the
// meeting marker rewrite and the meeting recovery in AfkTrade.init) run after
// the life cache's init, in the order NodeL2 startServer runs them. A bot left
// hot by a restart, with a meeting marker and a load repair due (a henna its
// row does not know), boots cleanly: the init rebuilds it cold and saves the
// repair, the marker pass then rewrites the cold row. Run before the init, the
// marker pass put the stale hot copy into the cache, the repair's save refused
// a cold row over it and the whole life state failed ("state table
// unavailable"), so no population started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('boot-life-row-order');
require('../src/Global');
fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const World = invoke('GameServer/World/World');
const Native = require('./helpers/nativeMarketFixture');
process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const id = 9600511, loc = { locX: 83396, locY: 147904, locZ: -3400 };
// The steps in the order NodeL2 startServer runs them.
function bootSteps() {
    const startup = fs.readFileSync(require.resolve('../src/NodeL2'), 'utf8');
    const steps = [
        [startup.indexOf("invoke('GameServer/Bot/Population/BotLifeState').init()"), 'life', async () => {
            assert.equal(await Life.init(), true, 'the life state is ready');
        }],
        [startup.indexOf('await AfkTrade.init()'), 'board', () => AfkTrade.init()]
    ];
    for (const [at, name] of steps) assert(at >= 0, `NodeL2 startServer runs the ${name} step`);
    return steps.sort((a, b) => a[0] - b[0]);
}

async function run() {
    await Database.init();
    Data.init();
    World.user = { sessions: [], revision: 0 };
    const account = 'bot_boot_order';
    await Native.character(Database, id, 'BootOrder', account, loc);
    // Hot at shutdown, still naming a meeting with the old two-field marker
    // (that meeting is gone); its row lists no henna, the record has one.
    const stats = { classId: 0, role: 'dps', canonicalAreaId: 'giran', hennas: [null, null, null],
        coldCombat: { skillSource: 'hot', skills: [] }, tradeMeeting: [424242, 1] };
    await Database.execute([`INSERT INTO bot_life_state (characterId,accountName,characterName,level,
        phase,activity,currentRegion,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,
        activityStartedAt,nextResolveAt,lastResolvedAt,updatedAt,simulationRevision)
        VALUES (?,?,?,20,'hot','hunting','Giran',?,?,?,100,100,100,100,'{}',?,?,?,?,?,3)`,
        [id, account, 'BootOrder', loc.locX, loc.locY, loc.locZ, JSON.stringify(stats),
            Date.now() - 60000, Date.now() + 30000, Date.now() - 60000, Date.now() - 30000]]);
    await Database.setCharacterHenna(id, 1, 1);

    for (const [, , step] of bootSteps()) await step();

    const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
    const saved = JSON.parse(row.statsJson), cached = Life.cachedState(id);
    assert.equal(row.phase, 'cold', 'the stale hot row is rebuilt cold');
    assert.deepEqual(saved.hennas, [1, null, null], 'the henna repair is saved');
    assert.equal(saved.tradeMeeting ?? null, null, 'the marker of a gone meeting is cleared in the row');
    assert.equal(cached?.phase, 'cold', 'the cache the worker starts from holds the cold row');
    assert.deepEqual(cached.stats.hennas, [1, null, null], 'the cache has the repaired hennas');
    assert.equal(cached.stats.tradeMeeting ?? null, null, 'the cache has the rewritten marker');
    assert.equal(cached.simulation.revision, Number(row.simulationRevision), 'the cache matches the row');
    console.log('boot life row order PASS: stale hot row with a meeting marker and a henna repair boots cold, repaired and remarked');
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });
