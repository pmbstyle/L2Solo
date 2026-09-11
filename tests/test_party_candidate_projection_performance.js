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
    const warmup = await LifeState.coldPartyCandidateProjections();
    assert.strictEqual(warmup.length, 1776, 'warmup query must cover the complete eligible pool');
    assert.strictEqual(new Set(warmup.map((state) => state.spotId)).size, 24, 'projection must not starve smaller spots');

    const durations = [];
    for (let run = 0; run < 7; run += 1) {
        const startedAt = performance.now();
        const rows = await LifeState.coldPartyCandidateProjections();
        durations.push(performance.now() - startedAt);
        assert.strictEqual(rows.length, 1776);
    }

    const sorted = [...durations].sort((left, right) => left - right);
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
    assert(
        p95Ms < 150,
        `complete party candidate projection p95 ${p95Ms.toFixed(1)}ms exceeded the 150ms CI ceiling`
    );

    const hydrated = await LifeState.statesByIds(warmup.slice(0, 15).map((state) => state.characterId), {
        ownerId: 'legacy_main',
        unassigned: true
    });
    assert.strictEqual(hydrated.length, 15, 'only the selected shortlist should require full state hydration');

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
    const scalarFields = `characterId, characterName, level, activity, spotId,
        activityStartedAt, updatedAt, simulationOwner, simulationRevision,
        phase, partyId, partyObjectiveSpot, partyRequestStatus, partyRequestPriority`;
    const projectedFields = ['role', 'generatedIndex', 'partyRequestJson',
        'clanPartyObjectiveJson', 'equipmentPlanJson', 'partyHistoryJson']
        .map((name, index) => `json_extract(payloadJson, '$[${index}]') ${name}`).join(', ');
    const legacyFields = `json_extract(statsJson, '$.role') role,
        json_extract(statsJson, '$.generatedIndex') generatedIndex,
        json_extract(statsJson, '$.partyRequest') partyRequestJson,
        json_extract(statsJson, '$.clanPartyObjective') clanPartyObjectiveJson,
        json_extract(statsJson, '$.equipmentPlan') equipmentPlanJson,
        json_extract(statsJson, '$.partyHistory') partyHistoryJson`;
    const verifyProjection = async () => {
        const expected = await Database.execute([`SELECT ${scalarFields}, ${legacyFields}
            FROM bot_life_state ORDER BY characterId`, []]);
        const actual = await Database.execute([`SELECT ${scalarFields}, ${projectedFields}
            FROM bot_life_state INNER JOIN bot_party_candidate_projection USING (characterId) ORDER BY characterId`, []]);
        assert.deepStrictEqual(actual, expected, 'projection must exactly match authoritative fields');
    };
    await verifyProjection(); // Includes migration backfill of pre-existing states.
    const changedStats = {
        role: 'buffer', generatedIndex: 17,
        partyRequest: { status: 'open', priority: 'required', spotId: 'new-spot', requestedAt: 123 },
        clanPartyObjective: { target: { itemId: 57 } },
        equipmentPlan: { next: { spotId: 'fallback-spot' } },
        partyHistory: { friends: [3100001, 3100002], nested: { keep: true } }
    };
    await Database.execute(['UPDATE bot_life_state SET statsJson = ?, level = ?, spotId = ? WHERE characterId = ?',
        [JSON.stringify(changedStats), 44, 'new-spot', 3100000]]);
    await verifyProjection();
    const changed = (await LifeState.coldPartyCandidateProjections()).find(row => row.characterId === 3100000);
    assert.strictEqual(changed.party.role, 'buffer');
    assert.deepStrictEqual(changed.stats.partyHistory, changedStats.partyHistory);
    await Database.execute(['CREATE TABLE projection_writes(n INTEGER)', []]);
    await Database.execute([`CREATE TRIGGER observe_projection_write AFTER UPDATE ON bot_party_candidate_projection
        BEGIN INSERT INTO projection_writes VALUES(1); END`, []]);
    await Database.execute(['UPDATE bot_life_state SET statsJson = ? WHERE characterId = ?',
        [JSON.stringify({ ...changedStats, coldCombat: { hp: 10, effects: [] } }), 3100000]]);
    assert.strictEqual((await Database.execute(['SELECT count(*) n FROM projection_writes', []]))[0].n, 0,
        'unrelated combat updates must not rewrite the party payload');
    await Database.execute([`UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner',
        simulationRevision = simulationRevision + 1 WHERE characterId = ?`, [3100000]]);
    assert(!(await LifeState.coldPartyCandidateProjections()).some(row => row.characterId === 3100000),
        'a claimed bot must disappear immediately, without waiting for cache expiry');
    await verifyProjection();
    await Database.execute(['BEGIN IMMEDIATE', []]);
    await Database.execute([`UPDATE bot_life_state SET simulationOwner = 'legacy_main', statsJson = '{}' WHERE characterId = ?`, [3100000]]);
    await verifyProjection();
    await Database.execute(['ROLLBACK', []]);
    await verifyProjection();
    assert(!(await LifeState.coldPartyCandidateProjections()).some(row => row.characterId === 3100000));
    await Database.execute([`UPDATE bot_life_state SET simulationOwner = 'legacy_main', statsJson = '{}' WHERE characterId = ?`, [3100000]]);
    await verifyProjection(); // Removed JSON keys must not survive in the projection.
    await Database.execute(["INSERT INTO clans(id, name, leaderId) VALUES(900, 'ProjectionClan', 3100000)", []]);
    await Database.execute([`INSERT INTO clan_operations(id, clanId, operationKey, operationType, leaderId)
        VALUES(901, 900, 'projection-reservation', 'raid', 3100000)`, []]);
    await Database.execute([`INSERT INTO clan_operation_members(operationId, clanId, characterId)
        VALUES(901, 900, 3100000)`, []]);
    assert(!(await LifeState.coldPartyCandidateProjections()).some(row => row.characterId === 3100000),
        'an active operation reservation must still exclude its member');
    await Database.execute(["UPDATE clan_operation_members SET status = 'released' WHERE characterId = ?", [3100000]]);
    assert((await LifeState.coldPartyCandidateProjections()).some(row => row.characterId === 3100000),
        'released reservations must become eligible immediately');
    await Database.execute(['DELETE FROM bot_life_state WHERE characterId = ?', [3100000]]);
    await verifyProjection();
    await Database.execute([`INSERT INTO bot_life_state(characterId, accountName, characterName, level,
        spotId, activity, phase, statsJson, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [3100000, 'party_projection_probe', 'Reinserted', 44, 'new-spot', 'hunting', 'cold', JSON.stringify(changedStats), 123]]);
    await verifyProjection();
    assert.strictEqual((await Database.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
    assert.deepStrictEqual(await Database.execute(['PRAGMA foreign_key_check', []]), []);
    await Database.close();
    Database.init();
    await verifyProjection();
    assert.strictEqual((await Database.execute(['SELECT count(*) n FROM schema_migrations WHERE version = 39', []]))[0].n, 1);
    assert((await LifeState.coldPartyCandidateProjections()).some(row => row.characterId === 3100000),
        'the projection must survive close/reopen');
    await Database.close();
    console.log(`party candidate projection performance checks passed p95=${p95Ms.toFixed(1)}ms`);
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) {}
    process.exitCode = 1;
});
