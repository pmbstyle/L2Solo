const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-atomic-party-membership.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ColdSimulationOwner = invoke('GameServer/Bot/Population/ColdSimulationOwner');

fs.rmSync(databasePath, { force: true });

const seed = new DatabaseSync(databasePath);
seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('party_atomic_probe', 'test-only');
const insertCharacter = seed.prepare(`INSERT INTO characters(
    id, username, name, classId, race, level, maxHp, maxMp,
    sex, face, hair, hairColor, locX, locY, locZ
) VALUES (?, 'party_atomic_probe', ?, 0, 0, 20, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
const insertState = seed.prepare(`INSERT INTO bot_life_state(
    characterId, accountName, characterName, level, spotId, activity, phase,
    nextResolveAt, hp, maxHp, mp, maxMp, inventorySummary, statsJson, updatedAt
) VALUES (?, 'party_atomic_probe', ?, 20, 'cruma', 'party_wait', 'cold',
    1000, 500, 500, 250, 250, '{}', ?, ?)`);

for (let index = 1; index <= 4; index += 1) {
    const characterId = 3200000 + index;
    const name = `AtomicParty${index}`;
    insertCharacter.run(characterId, name);
    insertState.run(characterId, name, JSON.stringify({
        role: index === 1 || index === 3 ? 'tank' : 'healer',
        partyRequest: {
            status: 'open',
            priority: 'required',
            requestedAt: 100,
            objectiveKey: 'direct_drop:cruma:701',
            spotId: 'cruma'
        }
    }), 100 + index);
}
seed.close();

options.default.Database.path = path.relative(rootDir, databasePath);
ColdSimulationOwner.recoverStartupLeases = () => Promise.resolve({ affectedRows: 0 });
DataCache.init();
Database.init();

(async () => {
    const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
    const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual(await PartyState.init(), true);

    const firstMembers = await LifeState.statesByIds([3200001, 3200002], {
        ownerId: 'legacy_main',
        unassigned: true
    });
    const firstPartyDue = Date.now() + 45000;
    const preparedParty = PartyState.prepareCommit({
        partyId: 'bgp_atomic_success',
        leaderId: 3200001,
        memberIds: [3200001, 3200002],
        spotId: 'cruma',
        nextResolveAt: firstPartyDue,
        status: 'active',
        roleCoverage: { tank: 1, healer: 1 },
        stats: { objective: { objectiveKey: 'direct_drop:cruma:701', spotId: 'cruma' } }
    });
    const preparedMembers = firstMembers.map((member) => LifeState.preparePartyAssignment(
        member,
        preparedParty.snapshot.partyId,
        member.stats.role,
        preparedParty.snapshot.leaderId,
        preparedParty.snapshot.nextResolveAt
    ));
    assert(preparedMembers.every((entry) => Number(entry.snapshot.timing.nextResolveAt) === firstPartyDue),
        'atomic party assignment must align member scheduling with the durable party row');

    const committed = await Database.commitBackgroundPartyMembership({
        party: preparedParty.row,
        members: preparedMembers,
        event: {
            characterId: 3200001,
            eventType: 'party',
            summary: 'AtomicParty1 formed a party near cruma',
            weight: 2,
            createdAt: 500,
            meta: { partyId: 'bgp_atomic_success', memberIds: [3200001, 3200002] }
        }
    });
    assert.strictEqual(committed.ok, true, 'valid party membership must commit atomically');
    const savedParty = (await Database.execute([
        'SELECT partyId, leaderId, memberIdsJson FROM bot_background_parties WHERE partyId = ?',
        ['bgp_atomic_success']
    ]))[0];
    assert.deepStrictEqual(savedParty, {
        partyId: 'bgp_atomic_success',
        leaderId: 3200001,
        memberIdsJson: '[3200001,3200002]'
    });
    const savedMembers = await Database.execute([
        'SELECT characterId, partyId, activity, statsJson FROM bot_life_state WHERE characterId IN (?, ?) ORDER BY characterId',
        [3200001, 3200002]
    ]);
    assert(savedMembers.every((row) => row.partyId === 'bgp_atomic_success' && row.activity === 'grouped'));
    assert(savedMembers.every((row) => !JSON.parse(row.statsJson).partyRequest));
    assert.deepStrictEqual((await Database.execute([
        'SELECT characterId, eventType, summary, weight, createdAt, metaJson FROM bot_life_events WHERE characterId = ?',
        [3200001]
    ]))[0], {
        characterId: 3200001,
        eventType: 'party',
        summary: 'AtomicParty1 formed a party near cruma',
        weight: 2,
        createdAt: 500,
        metaJson: '{"partyId":"bgp_atomic_success","memberIds":[3200001,3200002]}'
    });

    const conflictMembers = await LifeState.statesByIds([3200003, 3200004], {
        ownerId: 'legacy_main',
        unassigned: true
    });
    const conflictParty = PartyState.prepareCommit({
        partyId: 'bgp_atomic_conflict',
        leaderId: 3200003,
        memberIds: [3200003, 3200004],
        spotId: 'cruma',
        status: 'active'
    });
    const conflictAssignments = conflictMembers.map((member) => LifeState.preparePartyAssignment(
        member,
        conflictParty.snapshot.partyId,
        member.stats.role,
        conflictParty.snapshot.leaderId
    ));
    conflictAssignments[1].expectedUpdatedAt -= 1;
    const rejected = await Database.commitBackgroundPartyMembership({
        party: conflictParty.row,
        members: conflictAssignments
    });
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'membership_conflict');
    assert.strictEqual((await Database.execute([
        'SELECT COUNT(*) AS n FROM bot_background_parties WHERE partyId = ?',
        ['bgp_atomic_conflict']
    ]))[0].n, 0, 'conflicted transaction must not leave a party row');
    assert.strictEqual((await Database.execute([
        'SELECT COUNT(*) AS n FROM bot_life_state WHERE characterId IN (?, ?) AND partyId IS NOT NULL',
        [3200003, 3200004]
    ]))[0].n, 0, 'conflicted transaction must not assign any member');

    assert.strictEqual((await Database.execute(['PRAGMA integrity_check', []]))[0].integrity_check, 'ok');
    await Database.close();
    console.log('Atomic background party membership checks passed');
})().catch(async (error) => {
    console.error(error);
    try { await Database.close(); } catch (_) {}
    process.exitCode = 1;
});
