const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-blood-mark-support.sqlite');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GoalService = invoke('GameServer/Clan/ClanGoalService');
const PartyService = invoke('GameServer/Clan/ClanPartyService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_blood_support', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_blood_support', ?, ?, 0, 60, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase, spotId,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_blood_support', ?, 60, 100000, 'hunting', 'cold', 'blood-mark-ready', ?, ?, ?)`);
    const addBot = (id, classId, name, updatedAt = id) => {
        insertCharacter.run(id, name, classId);
        insertState.run(id, name,
            JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 100000 } }),
            JSON.stringify({ generatedCold: true, classId, partyHistory: { raid: { runs: 3 } } }),
            updatedAt);
    };

    [4, 21, 11, 7, 44].forEach((classId, index) => addBot(4600001 + index, classId, `RecruitClan${index + 1}`, index + 1));
    addBot(4600101, 15, 'RecruitableHealer', 10);
    for (let index = 0; index < 20; index += 1) {
        const classId = index === 0 ? 4 : index === 1 ? 21 : 11;
        addBot(4601001 + index, classId, `FullClan${index + 1}`, 100 + index);
    }
    addBot(4601101, 15, 'GuestHealer', 200);
    seed.close();
}

async function createLevelTwoClan(name, memberIds) {
    const created = await Database.createAutonomousClan({
        name,
        leaderId: memberIds[0],
        memberIds,
        founderQuorum: 5,
        maxBotClans: 40,
        maxBotMemberShare: 1,
        stateJson: { level: 2, goal: null }
    });
    assert.strictEqual(created.ok, true);
    await Database.execute(['UPDATE clans SET level = 2 WHERE id = ?', [created.clanId]]);
    return created.clanId;
}

async function planAndStart(clanId) {
    let projection = await GoalService.clanProjectionById(clanId);
    const planned = await GoalService.resolveClan(projection);
    assert.strictEqual(planned.ok, true);
    projection = await GoalService.clanProjectionById(clanId);
    assert.strictEqual(projection.state.goal.plan.kind, 'farm');
    const started = await PartyService.resolveClan(projection, { rng: () => 0 });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.code, 'party_operation_started');
    return started;
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    DataCache.init();
    await LifeState.init();

    try {
        const recruitClanId = await createLevelTwoClan(
            'RecruitSupport',
            [4600001, 4600002, 4600003, 4600004, 4600005]
        );
        const recruited = await planAndStart(recruitClanId);
        assert.deepStrictEqual(recruited.joinedMemberIds, [4600101],
            'a missing healer must first join the autonomous clan when membership permits');
        const [joinedHealer] = await Database.execute(['SELECT clanId FROM characters WHERE id = 4600101']);
        assert.strictEqual(Number(joinedHealer.clanId), recruitClanId);
        assert(recruited.memberIds.includes(4600101), 'the recruited healer must enter the Blood Mark operation');
        assert.deepStrictEqual(recruited.guestMemberIds, []);

        const fullMemberIds = Array.from({ length: 20 }, (_, index) => 4601001 + index);
        const fullClanId = await createLevelTwoClan('GuestSupport', fullMemberIds);
        const guest = await planAndStart(fullClanId);
        assert(guest.guestMemberIds.includes(4601101),
            'a full clan must borrow a free suitable healer instead of blocking its Blood Mark operation');
        assert(guest.memberIds.includes(4601101));
        const [guestHealer] = await Database.execute(['SELECT clanId FROM characters WHERE id = 4601101']);
        assert.strictEqual(Number(guestHealer.clanId), 0, 'a guest operation must not rewrite clan membership');
        const [reservation] = await Database.execute([`
            SELECT members.status, operations.clanId
            FROM clan_operation_members members
            JOIN clan_operations operations ON operations.id = members.operationId
            WHERE members.characterId = 4601101 AND members.status = 'active'
        `]);
        assert(reservation, 'the guest must be atomically reserved for the clan operation');
        assert.strictEqual(Number(reservation.clanId), fullClanId);

        const activeProjection = await GoalService.clanProjectionById(fullClanId);
        const resolved = await PartyService.resolveClan(activeProjection, { rng: () => 0 });
        assert.strictEqual(resolved.ok, true);
        assert.strictEqual(resolved.code, 'party_operation_succeeded');
        const [advancedClan] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [fullClanId]]);
        assert.strictEqual(Number(advancedClan.level), 3,
            'the guest-supported operation must execute and deliver Blood Mark progression');
        const [releasedGuest] = await Database.execute([`
            SELECT status FROM clan_operation_members
            WHERE characterId = 4601101 ORDER BY id DESC LIMIT 1
        `]);
        assert.strictEqual(releasedGuest.status, 'released', 'the guest reservation must be released after execution');

        console.log('Clan Blood Mark support recruitment checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
