const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-warehouse-contribution-wallet.sqlite');
const Database = invoke('Database');
const ids = [4300001, 4300002, 4300003, 4300004, 4300005];

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_wallet', 'test-only');
    for (const id of ids) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp,
            sex, face, hair, hairColor, locX, locY, locZ)
            VALUES (?, 'bot_pop_wallet', ?, 4, 0, 40, 1000, 1000, 0, 0, 0, 0, 83400, 148600, -3400)`).run(id, `Wallet${id}`);
        seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
            inventorySummary, statsJson, updatedAt)
            VALUES (?, 'bot_pop_wallet', ?, 40, 1000000, 'hunting', 'cold', ?, ?, 1)`).run(id, `Wallet${id}`,
            JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 1000000 } }),
            JSON.stringify({ generatedCold: true, classId: 4 }));
        seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
            VALUES (57, 'Adena', 1000000, 0, 0, 0, ?)`).run(id);
    }
    seed.close();
}

async function wallet(id) {
    const [state] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [id]]);
    const [items] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM items WHERE characterId = ? AND selfId = 57', [id]]);
    return {
        column: Number(state.adena),
        summary: Number(JSON.parse(state.inventorySummary)['57'].amount),
        items: Number(items.amount)
    };
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await Database.initClanHalls(); // creates the dues cursor table, as the server start does
    try {
        const created = await Database.createAutonomousClan({
            name: 'WalletClan', leaderId: ids[0], memberIds: ids, founderQuorum: 5,
            maxBotClans: 40, maxBotMemberShare: 1, stateJson: { level: 0 }
        });
        assert.strictEqual(created.ok, true);
        await Database.execute(['UPDATE clans SET level = 1 WHERE id = ?', [created.clanId]]);
        // The hourly dues of a level-one clan: a one-off investment from the
        // member's savings into the clan warehouse.
        const result = await Database.settleClanDues({ clanId: created.clanId, characterId: ids[1], rate: 0.2, investFraction: 0.5 });
        assert.strictEqual(result.ok, true, result.code);
        assert(result.amount > 0, 'the member pays into the level fund');
        const [warehouse] = await Database.execute(['SELECT amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = 57', [created.clanId]]);
        assert.strictEqual(Number(warehouse.amount), result.amount);
        const left = 1000000 - result.amount;
        assert.deepStrictEqual(await wallet(ids[1]), { column: left, summary: left, items: left },
            'a level-one contribution must leave the payer\'s wallet column, summary and items equal');
        assert.deepStrictEqual(await wallet(ids[2]), { column: 1000000, summary: 1000000, items: 1000000 },
            'other members are untouched');
        console.log('Clan warehouse contribution wallet checks passed');
    } finally {
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
