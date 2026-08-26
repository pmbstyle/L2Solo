const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-player-managed-clan.sqlite');
const Database = invoke('Database');
const GoalService = invoke('GameServer/Clan/ClanGoalService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
        .forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.exec('ALTER TABLE clan_simulation_clans DROP COLUMN mode');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('managed_player', 'test-only');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_managed', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ, clanId, clanPrivileges
    ) VALUES (?, ?, ?, ?, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400, 6200001, ?)`);
    insertCharacter.run(5200001, 'managed_player', 'ManagedLeader', 4, 55, 2047);
    insertCharacter.run(5200002, 'bot_pop_managed', 'ManagedTank', 4, 52, 0);
    seed.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (6200001, ?, 3, 5200001)').run('ManagedClan');
    seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (5200002, 'bot_pop_managed', 'ManagedTank', 52, 'hunting', 'cold', '{}', ?, 1000)`).run(JSON.stringify({
        generatedCold: true,
        classId: 4,
        role: 'tank'
    }));
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();

    try {
        const columns = await Database.execute(['PRAGMA table_info(clan_simulation_clans)', []]);
        assert(columns.some((column) => column.name === 'mode'), 'migration 26 must add the clan automation mode');

        const enabled = await Database.syncPlayerManagedClan(6200001);
        assert.strictEqual(enabled.ok, true);
        assert.strictEqual(enabled.created, true);
        assert.strictEqual(enabled.mode, 'player_managed');
        assert.deepStrictEqual(enabled.memberIds, [5200002], 'only generated bot members belong to the automation roster');

        const [simulation] = await Database.execute([
            'SELECT mode, stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [6200001]
        ]);
        assert.strictEqual(simulation.mode, 'player_managed');
        const state = JSON.parse(simulation.stateJson);
        assert.strictEqual(state.mode, 'player_managed');
        assert.strictEqual(state.leaderId, 5200001);
        assert.strictEqual(state.level, 3);
        assert.deepStrictEqual(state.memberIds, [5200002]);

        const [action] = await Database.execute([
            `SELECT actionType, status, reasonCode FROM clan_actions
             WHERE clanId = ? ORDER BY id DESC LIMIT 1`,
            [6200001]
        ]);
        assert.deepStrictEqual(action, { actionType: 'goal_plan', status: 'pending', reasonCode: 'player_managed_sync' });
        assert.strictEqual(await Database.isAutonomousClan(6200001), false,
            'player-managed clans must not consume autonomous founder capacity');
        assert.strictEqual(await Database.isAutonomousBotMember(5200002, 6200001), false,
            'the player must retain the right to remove a managed bot member');

        const projection = await GoalService.clanProjectionById(6200001);
        assert(projection, 'the clan goal runtime must project player-managed clans');
        assert.strictEqual(projection.leaderId, 5200001);
        assert(projection.members.some((member) => member.characterId === 5200002 && member.phase === 'cold'));

        await Database.removeCharacterFromClan(5200002);
        const disabled = await Database.syncPlayerManagedClan(6200001);
        assert.strictEqual(disabled.disabled, true);
        const remaining = await Database.execute([
            'SELECT clanId FROM clan_simulation_clans WHERE clanId = ?',
            [6200001]
        ]);
        assert.strictEqual(remaining.length, 0, 'automation should switch off after the last bot leaves');
        const [cancelled] = await Database.execute([
            'SELECT status, reasonCode FROM clan_actions WHERE clanId = ? ORDER BY id DESC LIMIT 1',
            [6200001]
        ]);
        assert.deepStrictEqual(cancelled, { status: 'cancelled', reasonCode: 'player_managed_disabled' });

        console.log('Player-managed clan checks passed');
    } finally {
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
