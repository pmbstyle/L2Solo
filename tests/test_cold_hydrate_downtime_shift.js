'use strict';
// L136: a restart shifts every persisted due time by the downtime (the world
// was paused), bots and active parties, in the row and the cache alike, so the
// worker's first command checkpoint and the party commit fence still match
// the row. updatedAt moves too, so a second boot with no write in between
// shifts only its own gap, not the first downtime again. lastResolvedAt moves
// with them: the first step's length (now - lastResolvedAt) must not hold the
// downtime, or the bot is credited hunting time it never lived. The pause ends
// when the shift runs, before the boot repairs: the boot time is not lived
// time either, and a row a repair rewrites (a stale hot row) still moves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
require('./helpers/databaseIsolation');
const secondBoot = process.env.DOWNTIME_SHIFT_SECOND_BOOT_INI;
const fixture = secondBoot ? null : require('./helpers/isolatedSocialDatabase')('cold-hydrate-downtime');
if (secondBoot) process.env.L2NODE_CONFIG_FILE = secondBoot;
require('../src/Global');
if (fixture) fixture.assertConfigured(options.default);
const Database = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { SERVER_STARTED_AT } = require('../src/GameServer/Bot/Population/Uptime');
const Native = require('./helpers/nativeMarketFixture');
Data.init();
if (fixture) process.on('exit', () => fs.rmSync(fixture.directory, { recursive: true, force: true }));

const loc = { locX: 45596, locY: 247589, locZ: -6518 };
// No startup repair touches these rows (canonical area, hennas, hot skills),
// so the cache can only carry the shift if the boot itself applied it.
const stats = JSON.stringify({ classId: 0, role: 'dps', canonicalAreaId: 'elven_ruins',
    hennas: [null, null, null], coldCombat: { skillSource: 'hot', skills: [] } });
const PARTY = 'downtime-party';

async function bot(id, name, nextResolveAt, updatedAt, phase = 'cold') {
    const account = `bot_downtime_${id}`;
    await Native.character(Database, id, name, account, loc);
    await Database.execute([`INSERT INTO bot_life_state (characterId,accountName,characterName,level,
        phase,activity,currentRegion,locX,locY,locZ,hp,maxHp,mp,maxMp,inventorySummary,statsJson,
        activityStartedAt,nextResolveAt,lastResolvedAt,updatedAt,simulationRevision)
        VALUES (?,?,?,18,?,'hunting','Elven Ruins',?,?,?,100,100,100,100,'{}',?,?,?,?,?,3)`,
        [id, account, name, phase, loc.locX, loc.locY, loc.locZ, stats,
            updatedAt - 1000, nextResolveAt, updatedAt - 1000, updatedAt]]);
}

function checkpointRow(row) {
    return { ...row, lastHotAt: row.lastHotAt || 0, nextResolveAt: row.nextResolveAt || 0 };
}

async function boot() {
    assert.equal(await Life.init(), true);
    assert.equal(await Party.init(), true);
}

async function run() {
    if (secondBoot) {
        await Database.init();
        await boot();
        return;
    }
    await Database.init();
    const startedAt = Math.floor(SERVER_STARTED_AT), downtime = 6 * 3600000, lastWrite = startedAt - downtime;
    const rows = {
        overdue: [9600411, 'DowntimeOverdue', lastWrite - 120000, lastWrite],
        later: [9600412, 'DowntimeLater', lastWrite + 300000, lastWrite - 30000],
        unset: [9600413, 'DowntimeUnset', null, lastWrite - 10000],
        // A write stamped after this process started (clock moved back):
        // neither the downtime source nor shifted.
        future: [9600414, 'DowntimeFuture', startedAt + 7200000, startedAt + 3600000]
    };
    for (const [id, name, next, updated] of Object.values(rows)) await bot(id, name, next, updated);
    // Left hot by a crash: the boot recovery rewrites it (cold, updatedAt = now)
    // but keeps its old due time, which must still move by the downtime.
    const staleHot = [9600417, 'DowntimeStaleHot', lastWrite - 120000, lastWrite];
    await bot(...staleHot, 'hot');
    // Its hot session (activated following the player) gained a level and
    // EXP, was placed near the player, drank 7 potions and paid 600 Adena: all
    // of it went to the record only. The row still holds the activation-time copy.
    const hotRecord = { level: 19, exp: 123456, sp: 789, loc: { ...loc, locX: loc.locX + 300 }, potions: 3, adena: 400 };
    await Database.execute([`UPDATE characters SET level = ?, exp = ?, sp = ?, locX = ?, hp = 60, mp = 40 WHERE id = ?`,
        [hotRecord.level, hotRecord.exp, hotRecord.sp, hotRecord.loc.locX, staleHot[0]]]);
    await Database.setItem(staleHot[0], { selfId: 1060, name: 'Lesser Healing Potion', amount: hotRecord.potions });
    await Database.setItem(staleHot[0], { selfId: 57, name: 'Adena', amount: hotRecord.adena });
    await Database.execute([`UPDATE bot_life_state SET activity = 'following', adena = 1000, inventorySummary = ? WHERE characterId = ?`,
        [JSON.stringify({ 57: { selfId: 57, name: 'Adena', amount: 1000, stackable: true },
            1060: { selfId: 1060, name: 'Lesser Healing Potion', amount: 10, stackable: true } }), staleHot[0]]]);
    // A configured static merchant stays hot (BotManager spawns it after
    // boot); a dynamic market store has no startup owner and cools.
    const staticMerchant = [9600421, Object.keys(invoke('GameServer/Bot/MerchantStoreConfigs'))[0], lastWrite + 300000, lastWrite];
    const marketStore = [9600422, 'DowntimeMarketStore', lastWrite + 300000, lastWrite];
    for (const merchant of [staticMerchant, marketStore]) await bot(...merchant, 'hot');
    await Database.execute([`UPDATE bot_life_state SET activity = 'merchant',
        statsJson = CASE WHEN characterId = ? THEN json_set(statsJson, '$.marketStore', json('{"storeType":1}')) ELSE statsJson END
        WHERE characterId IN (?, ?)`, [marketStore[0], staticMerchant[0], marketStore[0]]]);
    // A hot row whose character is gone (an old world saved without foreign
    // keys): it cools as it is and does not fail every other bot's recovery.
    const orphan = 9600430;
    const raw = new DatabaseSync(fixture.world);
    raw.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
    raw.prepare(`INSERT INTO bot_life_state (characterId,accountName,characterName,level,phase,activity,locX,locY,locZ,
        inventorySummary,statsJson,nextResolveAt,updatedAt) VALUES (?,?,?,18,'hot','hunting',?,?,?,'{}',?,?,?)`)
        .run(orphan, 'bot_downtime_orphan', 'DowntimeOrphan', loc.locX, loc.locY, loc.locZ, stats, lastWrite, lastWrite);
    raw.close();
    // A row saved with fractional clocks: a command checkpoint refuses it, so the bot would take no command.
    const fractional = [9600418, 'DowntimeFraction', lastWrite + 0.5, lastWrite];
    await bot(...fractional);
    await Database.execute([`UPDATE bot_life_state SET activityStartedAt = activityStartedAt + 0.7, lastResolvedAt = lastResolvedAt + 0.7,
        updatedAt = updatedAt + 0.5, statsJson = json_set(statsJson, '$.restUntil', ?) WHERE characterId = ?`, [lastWrite + 0.5, fractional[0]]]);
    const party = { nextResolveAt: lastWrite - 5000, updatedAt: lastWrite - 20000 };
    await Database.execute([`INSERT INTO bot_background_parties (partyId,leaderId,memberIdsJson,spotId,startedAt,
        nextResolveAt,cohesion,risk,status,roleCoverageJson,statsJson,updatedAt)
        VALUES (?,?,?,NULL,?,?,0.65,0.25,'active','{}','{}',?)`,
        [PARTY, 9600415, JSON.stringify([9600415, 9600416]), lastWrite - 600000, party.nextResolveAt, party.updatedAt]]);
    await Database.execute([`INSERT INTO bot_background_parties (partyId,leaderId,memberIdsJson,spotId,startedAt,
        nextResolveAt,cohesion,risk,status,roleCoverageJson,statsJson,updatedAt)
        VALUES ('fractional-party',9600419,?,NULL,?,?,0.65,0.25,'active','{}',?,?)`,
        [JSON.stringify([9600419, 9600420]), lastWrite - 600000.5, lastWrite + 0.5, JSON.stringify({ restUntil: lastWrite + 0.5 }), lastWrite - 20000.5]]);
    const beforeBoot = Date.now();
    await boot();
    // The pause the boot applied: from the last write to the shift, so it holds
    // the boot time before the shift too (this process started before beforeBoot).
    // The fractional row's updatedAt (lastWrite + 0.5) is the last write, whole up to 1 ms.
    const { downtimeMs: pause } = await Life.bootPause();
    const lastWritten = Math.ceil(lastWrite + 0.5);
    assert(pause >= beforeBoot - lastWritten, `the pause lasts until the shift (${pause} ms < ${beforeBoot - lastWritten} ms)`);

    const shifted = (value, moved) => moved ? value + pause : value;
    const expected = {
        overdue: [shifted(rows.overdue[2], true), shifted(rows.overdue[3], true)],
        later: [shifted(rows.later[2], true), shifted(rows.later[3], true)],
        // No due time, but a last step: the step length still excludes the downtime.
        unset: [null, shifted(rows.unset[3], true)],
        future: [rows.future[2], rows.future[3]]
    };
    for (const [key, [id]] of Object.entries(rows)) {
        const state = Life.cachedState(id);
        const [row] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]);
        assert.equal(state.timing.nextResolveAt, expected[key][0], `${key}: cached due time`);
        assert.equal(row.nextResolveAt === null ? null : Number(row.nextResolveAt), expected[key][0], `${key}: row due time`);
        assert.equal(Number(row.updatedAt), expected[key][1], `${key}: updatedAt moves with the due time`);
        assert.equal(state.updatedAt, Number(row.updatedAt), `${key}: cached updatedAt matches the row`);
        const lastResolvedAt = key === 'future' ? rows.future[3] - 1000 : expected[key][1] - 1000;
        assert.equal(Number(row.lastResolvedAt), lastResolvedAt, `${key}: lastResolvedAt moves with the due time`);
        assert.equal(state.timing.lastResolvedAt, lastResolvedAt, `${key}: cached lastResolvedAt matches the row`);
        assert(Protocol.sameCommandCheckpoint(state, checkpointRow(row)),
            `${key}: the worker's first command checkpoint matches the row`);
    }
    const [hotRow] = await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [staleHot[0]]]);
    const hotState = Life.cachedState(staleHot[0]);
    const wholeState = Life.cachedState(fractional[0]);
    assert(Protocol.commandCheckpoint(wholeState), 'whole clocks: a row saved with fractions takes commands again');
    assert(Number.isSafeInteger(wholeState.stats.restUntil), 'whole clocks: the rest deadline in the stats too');
    assert.equal(hotRow.phase, 'cold', 'stale hot: recovered as cold');
    assert.equal(Number(hotRow.nextResolveAt), staleHot[2] + pause, 'stale hot: row due time moves by the downtime');
    assert.equal(hotState.timing.nextResolveAt, staleHot[2] + pause, 'stale hot: cached due time moves by the downtime');
    assert.equal(Number(hotRow.lastResolvedAt), staleHot[3] - 1000 + pause, 'stale hot: lastResolvedAt moves by the downtime');
    // PER-7: the record wins. The row and the cache the worker starts from
    // keep the hot session's gain and spending, so its first commit cannot
    // write the activation-time EXP, potions or Adena back.
    assert.equal(Number(hotRow.level), hotRecord.level, 'stale hot: the row keeps the level gained hot');
    assert.equal(Number(hotRow.exp), hotRecord.exp, 'stale hot: the row keeps the EXP gained hot');
    assert.equal(Number(hotRow.sp), hotRecord.sp, 'stale hot: the row keeps the SP gained hot');
    assert.equal(Number(hotRow.adena), hotRecord.adena, 'stale hot: the Adena paid hot is not refunded');
    assert.equal(JSON.parse(hotRow.inventorySummary)[1060].amount, hotRecord.potions, 'stale hot: the potions drunk hot do not come back');
    assert.deepEqual([Number(hotRow.hp), Number(hotRow.mp)], [60, 40], 'stale hot: the vitals from the record');
    // The activation placement is temporary: back at its background place, in both copies.
    assert.equal(Number(hotRow.locX), loc.locX, 'stale hot: the row keeps its background position');
    assert.equal(hotRow.activity, 'hunting', 'stale hot: a following bot resumes hunting');
    assert.equal(hotState.exp, hotRecord.exp, 'stale hot: the cache the worker reads has the record EXP');
    assert.equal(hotState.adena, hotRecord.adena, 'stale hot: the cache has the record Adena');
    assert.equal(hotState.inventory[1060].amount, hotRecord.potions, 'stale hot: the cache has the record potions');
    assert.equal(hotState.stats.canonicalAreaId, 'elven_ruins', 'stale hot: the plan fields stay');
    const [orphanRow] = await Database.execute(['SELECT phase FROM bot_life_state WHERE characterId=?', [orphan]]);
    assert.equal(orphanRow.phase, 'cold', 'a stale hot row with no character record still cools');
    const [staticRow] = await Database.execute(['SELECT phase FROM bot_life_state WHERE characterId=?', [staticMerchant[0]]]);
    const [storeRow] = await Database.execute(['SELECT phase FROM bot_life_state WHERE characterId=?', [marketStore[0]]]);
    assert.equal(staticRow.phase, 'hot', 'a configured static merchant stays hot for its startup spawn');
    assert.equal(storeRow.phase, 'cold', 'a dynamic market store cools: nothing spawns it on startup');
    const [character] = await Database.execute(['SELECT level, exp, locX FROM characters WHERE id = ?', [staleHot[0]]]);
    assert.equal(Number(character.locX), loc.locX, 'stale hot: the record takes the background position, as markCold writes it');
    const items = await Database.fetchItems(staleHot[0]);
    assert.deepEqual([Number(character.level), Number(character.exp)], [hotRecord.level, hotRecord.exp], 'stale hot: the record is not rolled back');
    assert.deepEqual([Native.amount(items, 1060), Native.amount(items, 57)], [hotRecord.potions, hotRecord.adena],
        'stale hot: the item rows are not rolled back');
    const [wholeParty] = await Database.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', ['fractional-party']]);
    assert(['startedAt', 'nextResolveAt', 'updatedAt'].every((key) => Number.isSafeInteger(Number(wholeParty[key]))),
        'whole clocks: the party fence reads whole milliseconds');
    assert(Number.isSafeInteger(JSON.parse(wholeParty.statsJson).restUntil), 'whole clocks: the party rest deadline too');
    const cachedParty = Party.find(PARTY);
    const [partyRow] = await Database.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', [PARTY]]);
    assert.equal(cachedParty.nextResolveAt, party.nextResolveAt + pause, 'party: cached due time');
    assert.equal(Number(partyRow.nextResolveAt), party.nextResolveAt + pause, 'party: row due time');
    assert.equal(Number(partyRow.updatedAt), party.updatedAt + pause, 'party: updatedAt moves with the due time');
    assert.equal(cachedParty.updatedAt, Number(partyRow.updatedAt), 'party: the commit fence (updatedAt) matches the row');
    await Database.close();

    // Second boot on the same DB, no write in between: only its own gap.
    const child = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, DOWNTIME_SHIFT_SECOND_BOOT_INI: fixture.ini }, encoding: 'utf8' });
    assert.equal(child.status, 0, `second boot failed: ${child.stdout}\n${child.stderr}`);
    const line = /cold hydrate: shifted (\d+) due times by (\d+) ms/.exec(child.stdout);
    assert(line, `second boot shifts and logs: ${child.stdout}`);
    // The gap is this process's start to the child's start, minutes at most on
    // a loaded machine; the six-hour fixture downtime counted again would
    // exceed half of it by hours.
    const gap = Number(line[2]);
    assert(gap > 0 && gap < downtime / 2, `second boot shifts only its gap, not the downtime again (got ${gap} ms)`);
    const db = new DatabaseSync(fixture.world, { readOnly: true });
    const overdue = db.prepare('SELECT nextResolveAt FROM bot_life_state WHERE characterId=?').get(rows.overdue[0]);
    const partyAfter = db.prepare('SELECT nextResolveAt FROM bot_background_parties WHERE partyId=?').get(PARTY);
    db.close();
    assert.equal(Number(overdue.nextResolveAt), expected.overdue[0] + gap, 'second boot: bot moved by the gap only');
    assert.equal(Number(partyAfter.nextResolveAt), party.nextResolveAt + pause + gap, 'second boot: party moved by the gap only');
    console.log('cold hydrate downtime shift PASS: bots and party +%d ms in row and cache, future write ignored, second boot +%d ms only',
        pause, gap);
}
run().then(() => Database.close()).catch(async error => { console.error(error); process.exitCode = 1; await Database.close(); });
