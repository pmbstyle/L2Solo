const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-party-takeover-'));
options.default.Database.path = path.join(tempDir, 'test.sqlite');

async function run() {
    Database.init();
    const timestamp = Date.now();
    const partyId = 'takeover-commit-test';
    for (const id of [101, 102]) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_takeover_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_takeover_${id}`, `Takeover${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(
            characterId,accountName,characterName,phase,activity,partyId,hp,maxHp,mp,maxMp,level,
            nextResolveAt,lastResolvedAt,updatedAt,statsJson,simulationOwner,simulationRevision
        ) VALUES (?,?,?,'hot','grouped',?,100,100,100,100,20,NULL,?,?,?,'legacy_main',3)`, [
            id,
            `bot_takeover_${id}`,
            `Takeover${id}`,
            partyId,
            timestamp - 1000,
            timestamp,
            JSON.stringify({ role: id === 101 ? 'tank' : 'healer', leaderId: 101 })
        ]]);
    }
    await Database.execute([`INSERT INTO bot_background_parties(
        partyId,leaderId,memberIdsJson,spotId,startedAt,nextResolveAt,cohesion,risk,status,roleCoverageJson,statsJson,updatedAt
    ) VALUES (?,?,?,?,?,NULL,0.8,0.2,'hot','{}','{}',?)`, [
        partyId, 101, JSON.stringify([101, 102]), 'test', timestamp - 60000, timestamp
    ]]);

    const request = {
        partyId,
        expectedUpdatedAt: timestamp,
        playerId: 9001,
        source: 'test',
        members: [101, 102].map((characterId) => ({
            characterId,
            expectedRevision: 3,
            expectedUpdatedAt: timestamp
        }))
    };
    const stale = await Database.takeOverBackgroundParty({
        ...request,
        members: request.members.map((member, index) => ({
            ...member,
            expectedRevision: member.expectedRevision + Number(index === 1)
        }))
    });
    assert.strictEqual(stale.ok, false, 'one stale member must abort the whole takeover');
    assert.strictEqual((await Database.execute(['SELECT status FROM bot_background_parties WHERE partyId=?', [partyId]]))[0].status, 'hot');
    assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM bot_life_state WHERE partyId=?', [partyId]]))[0].n, 2);

    const committed = await Database.takeOverBackgroundParty(request);
    assert(committed.ok, JSON.stringify(committed));
    assert.strictEqual(committed.party.status, 'player_taken_over');
    assert.strictEqual(committed.rows.length, 2);
    committed.rows.forEach((row) => {
        assert.strictEqual(row.partyId, null);
        assert.strictEqual(row.phase, 'hot');
        assert.strictEqual(row.activity, 'hunting');
        assert.strictEqual(row.simulationRevision, 4);
        const stats = JSON.parse(row.statsJson);
        assert.strictEqual(stats.leaderId, 9001);
        assert.strictEqual(stats.playerPartyTakeover.partyId, partyId);
    });
    assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM bot_life_state WHERE partyId=?', [partyId]]))[0].n, 0);

    const restored = await Database.restoreTakenOverBackgroundParty({
        partyId,
        playerId: 9001,
        source: 'test_player_left'
    });
    assert(restored.ok, JSON.stringify(restored));
    assert.strictEqual(restored.party.status, 'hot');
    assert.strictEqual(restored.rows.length, 2);
    restored.rows.forEach((row) => {
        assert.strictEqual(row.partyId, partyId);
        assert.strictEqual(row.phase, 'hot');
        assert.strictEqual(row.activity, 'grouped');
        assert.strictEqual(row.simulationRevision, 5);
        const stats = JSON.parse(row.statsJson);
        assert.strictEqual(stats.leaderId, 101);
        assert.strictEqual(stats.backgroundPartyId, partyId);
        assert.strictEqual(stats.playerPartyTakeover, undefined);
    });
    assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM bot_life_state WHERE partyId=?', [partyId]]))[0].n, 2);

    const retaken = await Database.takeOverBackgroundParty({
        partyId,
        expectedUpdatedAt: restored.party.updatedAt,
        playerId: 9001,
        source: 'test_again',
        members: restored.rows.map((row) => ({
            characterId: row.characterId,
            expectedRevision: row.simulationRevision,
            expectedUpdatedAt: row.updatedAt
        }))
    });
    assert(retaken.ok, JSON.stringify(retaken));
    await Database.execute(["UPDATE bot_life_state SET phase='cold' WHERE characterId IN (101,102)", []]);
    const restoredCold = await Database.restoreTakenOverBackgroundParty({ partyId, playerId: 9001 });
    assert(restoredCold.ok, JSON.stringify(restoredCold));
    assert.strictEqual(restoredCold.party.status, 'active');
    assert(Number(restoredCold.party.nextResolveAt) > 0);
    assert(Number(JSON.parse(restoredCold.party.statsJson).formedAt) >= timestamp,
        'restoration must start a fresh autonomous party-session window');
    assert.strictEqual(JSON.parse(restoredCold.party.statsJson).sessionReview, null);
    assert(restoredCold.rows.every((row) => row.phase === 'cold' && row.partyId === partyId));
    await Database.close();
}

run().then(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('player party takeover commit tests passed');
}).catch(async (error) => {
    try { await Database.close(); } catch (_) {}
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
