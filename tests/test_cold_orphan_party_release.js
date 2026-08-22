const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-orphan-party-release.sqlite');
fs.rmSync(databasePath, { force: true });
fs.rmSync(`${databasePath}-wal`, { force: true });
fs.rmSync(`${databasePath}-shm`, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();
Database.init();

const originalCachedState = LifeState.cachedState;

(async () => {
    const partyId = 'orphan-release-party';
    const staleAt = Date.now() - (8 * 60 * 60 * 1000);
    const characters = [];

    for (let index = 1; index <= 3; index += 1) {
        const accountName = `orphan_release_${index}`;
        await Database.createAccount(accountName, 'secret');
        await Database.createCharacter(accountName, {
            name: `OrphanRelease${index}`,
            race: 0,
            classId: 0,
            maxHp: 300,
            maxMp: 120,
            sex: 0,
            face: 0,
            hair: 0,
            hairColor: 0,
            locX: -84191,
            locY: 244577,
            locZ: -3729
        });
        const [character] = await Database.fetchCharacters(accountName);
        characters.push({ ...character, accountName });
    }

    assert.strictEqual(await LifeState.init(), true);
    assert.strictEqual(await PartyState.init(), true);

    const memberIds = characters.map((character) => Number(character.id));
    for (const [index, character] of characters.entries()) {
        const saved = await LifeState.upsertState({
            characterId: Number(character.id),
            accountName: character.accountName,
            name: character.name,
            level: 20,
            phase: 'cold',
            activity: 'grouped',
            timing: {
                activityStartedAt: staleAt,
                nextResolveAt: staleAt,
                lastResolvedAt: staleAt
            },
            party: {
                partyId,
                role: index === 0 ? 'leader' : 'dps',
                leaderId: memberIds[0]
            },
            stats: {
                classId: 0,
                role: index === 0 ? 'leader' : 'dps',
                leaderId: memberIds[0],
                backgroundPartyId: partyId
            },
            loc: { locX: -84191, locY: 244577, locZ: -3729 },
            vitals: { hp: 300, maxHp: 300, mp: 120, maxMp: 120 },
            inventory: {}
        }, 'orphan_release_fixture');
        assert(saved, `fixture member ${character.name} must persist`);
    }

    const party = await PartyState.createOrUpdate({
        partyId,
        leaderId: memberIds[0],
        memberIds,
        spotId: 'orphan-release-spot',
        startedAt: staleAt,
        nextResolveAt: staleAt,
        status: 'active'
    });
    assert(party, 'active orphan fixture party must persist');

    const claim = await Owner.claim(LifeState.cachedState(memberIds[0]), {
        allowParty: true,
        allowLifecycle: true,
        timestamp: Date.now()
    });
    assert.strictEqual(claim.ok, true, `fixture must include a cold-owned member: ${JSON.stringify(claim)}`);

    // Simulate the coordinator's actual orphan detector: the party is active,
    // but none of its declared members are present in the worker snapshot.
    LifeState.cachedState = () => null;
    const orphaned = await Coordinator.reconcileOrphanedBackgroundParties();
    assert.deepStrictEqual(orphaned.map((entry) => entry.partyId), [partyId]);

    const persistedParty = await Database.execute([
        'SELECT status FROM bot_background_parties WHERE partyId = ?',
        [partyId]
    ]);
    assert.strictEqual(persistedParty[0].status, 'dissolved');

    const persistedMembers = await Database.execute([
        `SELECT partyId, activity, nextResolveAt, statsJson, simulationOwner, simulationRevision
         FROM bot_life_state WHERE characterId IN (?, ?, ?) ORDER BY characterId`,
        memberIds
    ]);
    assert.strictEqual(persistedMembers.length, memberIds.length);
    persistedMembers.forEach((member) => {
        const stats = JSON.parse(member.statsJson || '{}');
        assert.strictEqual(member.partyId, null, 'runtime dissolve must clear durable partyId');
        assert.strictEqual(member.activity, 'hunting', 'grouped member must resume solo lifecycle');
        assert(Number(member.nextResolveAt) > Date.now(), 'released member must receive a bounded solo due time');
        assert.strictEqual(stats.backgroundPartyId, null, 'runtime dissolve must clear backgroundPartyId');
        assert.strictEqual(stats.partyBreakReason, 'orphaned_dissolved_party');
        assert.strictEqual(member.simulationOwner, 'legacy_main', 'cold-owned member must hand off before release');
    });
    assert(Number(persistedMembers[0].simulationRevision) > 0, 'cold-owned member handoff must advance revision');

    console.log('Cold orphan party durable member release checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    LifeState.cachedState = originalCachedState;
    await Database.close().catch(() => null);
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
});
