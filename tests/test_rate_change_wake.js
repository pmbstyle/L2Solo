'use strict';
// The progression rate is part of every spot's hour. A world saved at one rate and booted at another
// wakes every bot's earning answer and its build (rate_changed), so both are taken again at the rate the
// world runs at now, and the world records that rate; a boot at the recorded rate wakes nothing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
require('./helpers/databaseIsolation');
const secondBoot = process.env.RATE_WAKE_SECOND_BOOT_INI;
const fixture = secondBoot ? null : require('./helpers/isolatedSocialDatabase')('rate-change-wake');
if (secondBoot) process.env.L2NODE_CONFIG_FILE = secondBoot;
process.env.L2NODE_PROGRESSION_RATE = 'x1';
require('../src/Global');
if (fixture) fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Situations = invoke('GameServer/Bot/Situations');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
if (fixture) process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const ID = 9600511, loc = { locX: 45596, locY: 247589, locZ: -6518 };
const stats = JSON.stringify({ classId: 0, role: 'dps', canonicalAreaId: 'elven_ruins',
    hennas: [null, null, null], coldCombat: { skillSource: 'hot', skills: [] } });
// Its earning answer and build held, nothing woken: the answer priced at the rate it was saved at.
const mind = JSON.stringify({ woken: 0, earning: { spotId: 'elven_ruins', earning: 3522108, at: 1 }, wishSections: { at: 1 } });
const wakes = Situations.BITS.earning_spot | Situations.BITS.build;
const x1 = JSON.stringify(invoke('GameServer/ProgressionRates').profile());

async function run() {
    await Database.init();
    if (secondBoot) { assert.equal(await Life.init(), true); return; }
    const account = 'bot_rate_wake';
    await Native.character(Database, ID, 'RateWake', account, loc);
    const now = Date.now();
    await Database.execute([`INSERT INTO bot_life_state (characterId,accountName,characterName,level,
        phase,activity,currentRegion,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,mindJson,
        activityStartedAt,nextResolveAt,lastResolvedAt,updatedAt,simulationRevision)
        VALUES (?,?,?,21,'cold','hunting','Elven Ruins',?,?,?,100,100,100,100,'{}',?,?,?,?,?,?,3)`,
        [ID, account, 'RateWake', loc.locX, loc.locY, loc.locZ, stats, mind, now - 1000, now + 60000, now - 1000, now - 500]]);
    // Saved at x50.
    await Database.execute([`INSERT INTO world_meta (key, value) VALUES ('progressionRate', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ preset: 'x50', multiplier: 50 })]]);
    assert.equal(await Life.init(), true);
    const [row] = await Database.execute(['SELECT mindJson FROM bot_life_state WHERE characterId = ?', [ID]]);
    assert.equal(JSON.parse(row.mindJson).woken & wakes, wakes, 'booted at x1: the row holds its earning spot and build woken');
    const state = Life.cachedState(ID);
    assert.equal(Situations.woken(state.stats, 'earning_spot'), true, 'the earning answer is taken again at the new rate');
    assert.equal(Situations.woken(state.stats, 'build'), true, 'and the build that prices in its hour');
    assert.equal(state.stats.earning.earning, 3522108, 'fixture: the old answer is still held until its decision runs');
    const [meta] = await Database.execute(["SELECT value FROM world_meta WHERE key = 'progressionRate'", []]);
    assert.equal(meta.value, x1, 'the world records the rate it runs at');
    await Database.execute([`UPDATE bot_life_state SET mindJson = json_set(mindJson, '$.woken', 0) WHERE characterId = ?`, [ID]]);
    await Database.close();

    // Booted again at the recorded rate: nothing is woken.
    const child = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, RATE_WAKE_SECOND_BOOT_INI: fixture.ini }, encoding: 'utf8' });
    assert.equal(child.status, 0, `second boot failed: ${child.stdout}\n${child.stderr}`);
    const db = new DatabaseSync(fixture.world, { readOnly: true });
    const after = db.prepare('SELECT mindJson FROM bot_life_state WHERE characterId = ?').get(ID);
    db.close();
    assert.equal(JSON.parse(after.mindJson).woken & wakes, 0, 'the same rate wakes nothing');
    console.log('rate change wake PASS: x50 save booted at x1 wakes earning spot and build, recorded; same rate wakes nothing');
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });
