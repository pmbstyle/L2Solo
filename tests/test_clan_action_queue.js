const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-action-queue.sqlite');
const Database = invoke('Database');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_action_queue', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_action_queue', ?, ?, 0, 20, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_action_queue', ?, 20, 4000000, 'hunting', 'cold', ?, ?, ?)`);
    const insertAdena = seed.prepare(`INSERT INTO items(selfId, name, amount, equipped, slot, characterId)
        VALUES (57, 'Adena', 4000000, 0, 0, ?)`);
    for (let index = 1; index <= 5; index += 1) {
        const id = 4700000 + index;
        const classId = index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : 11;
        const name = `ActionQueue${index}`;
        insertCharacter.run(id, name, classId);
        insertState.run(id, name, JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 4000000 } }), JSON.stringify({
            generatedCold: true,
            generatedIndex: index,
            classId,
            partyHistory: { cruma: { runs: 3 } }
        }), index);
        insertAdena.run(id);
    }
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    try {
        const created = await Database.createAutonomousClan({
            name: 'ActionQueueClan',
            leaderId: 4700001,
            memberIds: [4700001, 4700002, 4700003, 4700004, 4700005],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 0, goal: null }
        });
        assert.strictEqual(created.ok, true);

        const initialActions = await Database.fetchClanActions({ clanId: created.clanId, limit: 10 });
        assert.strictEqual(initialActions.length, 1);
        assert.strictEqual(initialActions[0].actionType, 'goal_plan');
        assert.strictEqual(initialActions[0].status, 'pending');

        const first = await ClanActionService.resolveBatch({ limit: 2, budgetMs: 2000 });
        assert.strictEqual(first.claimed >= 2, true, 'planner and first executable action must be claimed');
        assert.strictEqual(first.succeeded >= 2, true, 'claimed actions must resolve');

        const [ledger] = await Database.execute([
            'SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS amount FROM clan_contributions WHERE clanId = ?',
            [created.clanId]
        ]);
        assert(Number(ledger.entries) > 0, 'contribution action must produce a real ledger entry');
        assert(Number(ledger.amount) > 0);

        const actionsAfterFirst = await Database.fetchClanActions({ clanId: created.clanId, limit: 20 });
        assert(actionsAfterFirst.some((action) => action.actionType === 'contribution' && action.status === 'succeeded'));
        assert(actionsAfterFirst.some((action) => action.status === 'pending' || action.status === 'running'));

        await Database.close();
        Database.init();
        ClanActionService.resetMetrics();
        const recovered = await ClanActionService.resolveBatch({ limit: 2, budgetMs: 2000 });
        assert(recovered.attempted > 0, 'the durable action queue must continue after a restart');

        const actionRows = await Database.fetchClanActions({ clanId: created.clanId, limit: 20 });
        console.log(JSON.stringify({
            first,
            recovered,
            actionStatuses: actionRows.map((action) => `${action.actionType}:${action.status}`),
            contributionEntries: Number(ledger.entries)
        }));
        console.log('Clan action queue checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
