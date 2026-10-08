const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');
invoke('GameServer/DataCache').init();

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
    // Existing successful-upgrade fixture must fund the leader's player-rule SP cost.
    const levelSp = invoke('GameServer/Clan/ClanRules').LEVEL_REQUIREMENTS[0].sp;
    seed.prepare('UPDATE characters SET sp = ?').run(levelSp);
    seed.prepare('UPDATE bot_life_state SET sp = ?').run(levelSp);
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await Database.initClanHalls(); // creates the dues cursor table, as the server start does

    try {
        const x1 = Policy.scaledAdenaRequirement(0);
        const previousRate = process.env.L2NODE_PROGRESSION_RATE;
        process.env.L2NODE_PROGRESSION_RATE = 'x10';
        const x10 = Policy.scaledAdenaRequirement(0);
        if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = previousRate;
        assert.strictEqual(x1, 650000);
        assert(x10 > x1, 'level-one clan Adena requirement must scale with progression rate');

        assert.strictEqual(Policy.personalReserve({ level: 20, adena: 10000,
            stats: { money: [77000, 2e-5, 1500, 0] } }), 1500);

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

        // Level 0 dues: a share of new earnings, paid into the clan warehouse.
        const settle = (characterId, rate, timestamp) => Database.settleClanDues({ clanId: created.clanId, characterId, rate, timestamp });
        assert.strictEqual((await settle(4200002, 0.35, 1)).amount, 0, 'the first settlement only marks the wallet');
        await Database.execute(['UPDATE items SET amount = amount + 2000000 WHERE characterId = ? AND selfId = 57', [4200002]]);
        const paid = await settle(4200002, 0.35, 2);
        assert.strictEqual(paid.amount, 700000, '35% of the 2M earned');
        assert.strictEqual((await settle(4200002, 0.35, 3)).amount, 0, 'the same earnings cannot be collected twice');

        const resolved = await ClanEconomyService.resolveBatch(8, { budgetMs: 1000 });
        assert.strictEqual(resolved.levelUps, 1, 'level 0 should advance after the real contribution ledger reaches 650k');

        const [clan] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [created.clanId]]);
        assert.strictEqual(Number(clan.level), 1);
        const [ledger] = await Database.execute(['SELECT COUNT(*) AS entries, SUM(amount) AS amount FROM clan_contributions WHERE clanId = ?', [created.clanId]]);
        assert.strictEqual(Number(ledger.amount), 700000);
        assert.strictEqual(Number(ledger.entries), 1);

        const [source] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 57', [4200002]]);
        const [leader] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 57', [4200001]]);
        assert.strictEqual(Number(source.amount), 2300000);
        assert.strictEqual(Number(leader.amount), 1000000, 'the leader\'s own wallet is not the clan fund');
        // The level-up spent 650k of the 700k in the warehouse, like the player's level-up.
        const [fund] = await Database.execute(['SELECT amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = 57', [created.clanId]]);
        assert.strictEqual(Number(fund.amount), 50000);

        const [sourceState] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [4200002]]);
        assert.strictEqual(Number(sourceState.adena), 2300000);
        assert.strictEqual(JSON.parse(sourceState.inventorySummary)['57'].amount, 2300000);

        console.log('Clan simulation Slice 2 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
