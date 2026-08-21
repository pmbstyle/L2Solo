const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-slice2.sqlite');
const Database = invoke('Database');
const Policy = invoke('GameServer/Clan/ClanContributionPolicy');
const ClanEconomyService = invoke('GameServer/Clan/ClanEconomyService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_slice2', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_slice2', ?, ?, 0, 20, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_slice2', ?, 20, ?, 'hunting', 'cold', ?, ?, ?)`);
    const insertAdena = seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (57, 'Adena', ?, 0, 0, 0, ?)`);
    for (let index = 1; index <= 10; index += 1) {
        const id = 4200000 + index;
        const name = `SliceTwo${index}`;
        const adena = index <= 5 ? 1000000 : 10000;
        insertCharacter.run(id, name, index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : 11);
        insertState.run(id, name, adena, JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: adena } }), JSON.stringify({
            generatedCold: true,
            generatedIndex: index,
            classId: index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : 11
        }), index);
        if (index <= 5) insertAdena.run(adena, id);
    }
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();

    try {
        const x1 = Policy.scaledAdenaRequirement(0);
        const previousRate = process.env.L2NODE_PROGRESSION_RATE;
        process.env.L2NODE_PROGRESSION_RATE = 'x10';
        const x10 = Policy.scaledAdenaRequirement(0);
        if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = previousRate;
        assert.strictEqual(x1, 650000);
        assert(x10 > x1, 'level-one clan Adena requirement must scale with progression rate');

        const wallet = Policy.disposableAdena({ level: 20, adena: 10000 });
        assert.strictEqual(wallet.reserve, 5000);
        assert.strictEqual(wallet.disposable, 5000);
        assert.strictEqual(Policy.contributionCap({ level: 20, adena: 10000 }).maxContribution, 1750);

        const created = await Database.createAutonomousClan({
            name: 'SliceTwoClan',
            leaderId: 4200001,
            memberIds: [4200001, 4200002, 4200003, 4200004, 4200005],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 0.70,
            stateJson: { level: 0, goal: null }
        });
        assert.strictEqual(created.ok, true);

        const manual = await Database.transferClanAdena({
            clanId: created.clanId,
            characterId: 4200002,
            leaderId: 4200001,
            targetLevel: 0,
            amount: 10000,
            reserve: 5000,
            maxContributionFraction: 0.35,
            resolveKey: 'slice2-idempotency'
        });
        assert.strictEqual(manual.ok, true);
        const duplicate = await Database.transferClanAdena({
            clanId: created.clanId,
            characterId: 4200002,
            leaderId: 4200001,
            targetLevel: 0,
            amount: 10000,
            reserve: 5000,
            maxContributionFraction: 0.35,
            resolveKey: 'slice2-idempotency'
        });
        assert.strictEqual(duplicate.ok, false);
        assert.strictEqual(duplicate.code, 'contribution_already_applied');

        const resolved = await ClanEconomyService.resolveBatch(8, { budgetMs: 1000 });
        assert.strictEqual(resolved.levelUps, 1, 'level 0 should advance after the real contribution ledger reaches 650k');
        assert.strictEqual(resolved.contributions > 0, true);

        const [clan] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [created.clanId]]);
        assert.strictEqual(Number(clan.level), 1);
        const [ledger] = await Database.execute(['SELECT COUNT(*) AS entries, SUM(amount) AS amount FROM clan_contributions WHERE clanId = ?', [created.clanId]]);
        assert.strictEqual(Number(ledger.amount), 650000);
        assert(Number(ledger.entries) >= 2);

        const [source] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 57', [4200002]]);
        const [leader] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 57', [4200001]]);
        assert(Number(source.amount) >= 5000, 'the contributor must retain the configured personal reserve');
        assert.strictEqual(Number(leader.amount), 1650000, 'the leader must receive real Adena in inventory');

        const [sourceState] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [4200002]]);
        const [leaderState] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [4200001]]);
        assert(Number(sourceState.adena) >= 5000);
        assert.strictEqual(Number(leaderState.adena), 1650000);
        assert.strictEqual(JSON.parse(leaderState.inventorySummary)['57'].amount, 1650000);

        console.log('Clan simulation Slice 2 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
