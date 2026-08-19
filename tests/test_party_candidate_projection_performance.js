const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-party-candidate-projection-performance.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');

fs.rmSync(databasePath, { force: true });

const seed = new DatabaseSync(databasePath);
seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('party_projection_probe', 'test-only');

const insertCharacter = seed.prepare(`INSERT INTO characters(
    id, username, name, classId, race, level, maxHp, maxMp,
    sex, face, hair, hairColor, locX, locY, locZ
) VALUES (?, 'party_projection_probe', ?, 0, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
const insertState = seed.prepare(`INSERT INTO bot_life_state(
    characterId, accountName, characterName, level, spotId, activity, phase,
    nextResolveAt, hp, maxHp, mp, maxMp, inventorySummary, statsJson, updatedAt
) VALUES (?, 'party_projection_probe', ?, ?, ?, ?, 'cold', ?, 500, 500, 250, 250, '{}', ?, ?)`);
const padding = 'x'.repeat(12000);

seed.exec('BEGIN IMMEDIATE');
try {
    for (let index = 0; index < 1776; index += 1) {
        const characterId = 3100000 + index;
        const name = `PartyProjection${index}`;
        const level = 10 + (index % 55);
        const spotId = `spot-${index % 24}`;
        const required = index % 4 === 0;
        const preferred = !required && index % 4 === 1;
        const stats = {
            role: index % 6 === 0 ? 'healer' : 'dps',
            padding,
            ...(required || preferred ? {
                partyRequest: {
                    status: 'open',
                    priority: required ? 'required' : 'preferred',
                    requestedAt: 1800000000000 + index,
                    spotId
                }
            } : {})
        };
        insertCharacter.run(characterId, name, level);
        insertState.run(
            characterId,
            name,
            level,
            spotId,
            index % 5 === 0 ? 'resting' : 'hunting',
            1800000000000 + index,
            JSON.stringify(stats),
            1800000000000 + index
        );
    }
    seed.exec('COMMIT');
} catch (error) {
    seed.exec('ROLLBACK');
    throw error;
} finally {
    seed.close();
}

options.default.Database.path = path.relative(rootDir, databasePath);
ColdSimulationOwner.recoverStartupLeases = () => Promise.resolve({ affectedRows: 0 });
DataCache.init();
Database.init();

(async () => {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual((await LifeState.coldPartyCandidates(250)).length, 250, 'warmup query must return the requested sample');

    const durations = [];
    for (let run = 0; run < 7; run += 1) {
        const startedAt = performance.now();
        const rows = await LifeState.coldPartyCandidates(250);
        durations.push(performance.now() - startedAt);
        assert.strictEqual(rows.length, 250);
    }

    const sorted = [...durations].sort((left, right) => left - right);
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
    assert(
        p95Ms < 200,
        `party candidate projection p95 ${p95Ms.toFixed(1)}ms exceeded the 200ms CI ceiling`
    );

    const projection = await Database.execute([
        `SELECT partyRequestStatus, partyRequestPriority, partyRequestedAt, partyObjectiveSpot
         FROM bot_life_state WHERE characterId = ?`,
        [3100000]
    ]);
    assert.deepStrictEqual(
        projection[0],
        {
            partyRequestStatus: 'open',
            partyRequestPriority: 'required',
            partyRequestedAt: 1800000000000,
            partyObjectiveSpot: 'spot-0'
        }
    );
    assert.strictEqual((await Database.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
    await Database.close();
    console.log(`party candidate projection performance checks passed p95=${p95Ms.toFixed(1)}ms`);
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) {}
    process.exitCode = 1;
});
