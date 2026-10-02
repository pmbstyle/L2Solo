const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// A bot clan's level-up spends its Adena like the player's level-up
// (NpcBypasses/Clan), from the clan warehouse where the dues went. A payment
// that is not there keeps the clan at its level.
const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-level-up-cost.sqlite');
const Database = invoke('Database');

function seedDatabase() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_levelcost', 'test-only');
    for (const [clanId, leaderId, level] of [[71, 4500001, 0], [72, 4500002, 1], [73, 4500003, 0]]) {
        seed.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
            locX, locY, locZ, clanId) VALUES (?, 'bot_pop_levelcost', ?, 0, 0, 30, 500, 250, 0, 0, 0, 0, 0, 0, 0, ?)`).run(leaderId, `Lead${leaderId}`, clanId);
        seed.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
            inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_levelcost', ?, 30, 0, 'hunting', 'cold', '{}', '{}', 1)`).run(leaderId, `Lead${leaderId}`);
        seed.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (?, ?, ?, ?)').run(clanId, `Cost${clanId}`, level, leaderId);
        seed.prepare(`INSERT INTO clan_simulation_clans(clanId, mode, stateJson, createdAt, updatedAt)
            VALUES (?, 'autonomous', '{"mode":"autonomous","warehouseRevision":0}', 0, 0)`).run(clanId);
        seed.prepare(`INSERT INTO clan_contributions(clanId, characterId, targetLevel, amount, source, resolveKey, createdAt)
            VALUES (?, ?, ?, ?, 'adena', ?, 0)`).run(clanId, leaderId, level, level === 0 ? 650000 : 2500000, `seed:${clanId}`);
    }
    const fund = seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, enchant, reservedAmount)
        VALUES (?, 57, 'Adena', 'Other.Adena', ?, 0, 0)`);
    fund.run(71, 700000);
    fund.run(72, 2600000);
    fund.run(73, 100000);
    seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (57, 'Adena', 900000, 0, 0, 0, 4500001)`).run();
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    const level = async (clanId) => Number((await Database.execute(['SELECT level FROM clans WHERE id = ?', [clanId]]))[0].level);
    const wallet = async (id) => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = 57', [id]]))[0].n);
    try {
        const warehouse = async (clanId) => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_warehouse_items WHERE clanId = ? AND selfId = 57', [clanId]]))[0].n);
        const first = await Database.advanceAutonomousClanLevel({ clanId: 71, fromLevel: 0, toLevel: 1, requiredAmount: 650000 });
        assert.strictEqual(first.ok, true, JSON.stringify(first));
        assert.strictEqual(await warehouse(71), 50000, 'level 1 is paid from the clan warehouse');
        assert.strictEqual(await wallet(4500001), 900000, 'the leader\'s wallet is not touched');

        const second = await Database.advanceAutonomousClanLevel({ clanId: 72, fromLevel: 1, toLevel: 2, requiredAmount: 2500000 });
        assert.strictEqual(second.ok, true, JSON.stringify(second));
        assert.strictEqual(await warehouse(72), 100000, 'level 2 is paid from the clan warehouse');

        const short = await Database.advanceAutonomousClanLevel({ clanId: 73, fromLevel: 0, toLevel: 1, requiredAmount: 650000 });
        assert.strictEqual(short.ok, false);
        assert.strictEqual(short.code, 'warehouse_item_not_ready');
        assert.strictEqual(await level(73), 0, 'an unpaid level-up keeps the level');
        assert.strictEqual(await warehouse(73), 100000);
        console.log('Clan level-up cost checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
