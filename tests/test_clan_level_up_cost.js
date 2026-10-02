const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// A bot clan's level-up spends its Adena like the player's level-up
// (NpcBypasses/Clan): level 1 from the leader's wallet, level 2 from the clan
// warehouse. A payment that is not there keeps the clan at its level.
const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-level-up-cost.sqlite');
const Database = invoke('Database');

function seedDatabase() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_levelcost', 'test-only');
    for (const [clanId, leaderId, level] of [[71, 4500001, 0], [72, 4500002, 1], [73, 4500003, 0], [74, 4500004, 0], [75, 4500005, 0]]) {
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
    const adena = seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (57, 'Adena', ?, 0, 0, 0, ?)`);
    adena.run(900000, 4500001);
    adena.run(100000, 4500003);
    adena.run(900000, 4500004);
    adena.run(900000, 4500005);
    // Leader 4500004 is in a party; leader 4500005's row is owned by the cold worker
    // with a virtual wallet of 1M.
    seed.prepare("UPDATE bot_life_state SET partyId = 'party-1' WHERE characterId = 4500004").run();
    seed.prepare(`UPDATE bot_life_state SET simulationOwner = 'cold_simulation_owner', adena = 1000000,
        inventorySummary = '{"57":{"selfId":57,"name":"Adena","amount":1000000}}' WHERE characterId = 4500005`).run();
    seed.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, enchant, reservedAmount)
        VALUES (72, 57, 'Adena', 'Other.Adena', 2600000, 0, 0)`).run();
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    const level = async (clanId) => Number((await Database.execute(['SELECT level FROM clans WHERE id = ?', [clanId]]))[0].level);
    const wallet = async (id) => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = 57', [id]]))[0].n);
    try {
        const first = await Database.advanceAutonomousClanLevel({ clanId: 71, fromLevel: 0, toLevel: 1, requiredAmount: 650000 });
        assert.strictEqual(first.ok, true, JSON.stringify(first));
        assert.strictEqual(await wallet(4500001), 250000, 'level 1 is paid from the leader wallet');
        const [snapshot] = await Database.execute(['SELECT adena, inventorySummary FROM bot_life_state WHERE characterId = ?', [4500001]]);
        assert.strictEqual(Number(snapshot.adena), 250000, 'the cold snapshot follows the paid wallet');
        assert.strictEqual(JSON.parse(snapshot.inventorySummary)['57'].amount, 250000);

        const second = await Database.advanceAutonomousClanLevel({ clanId: 72, fromLevel: 1, toLevel: 2, requiredAmount: 2500000 });
        assert.strictEqual(second.ok, true, JSON.stringify(second));
        const [left] = await Database.execute(['SELECT amount FROM clan_warehouse_items WHERE clanId = 72 AND selfId = 57']);
        assert.strictEqual(Number(left.amount), 100000, 'level 2 is paid from the clan warehouse');

        const short = await Database.advanceAutonomousClanLevel({ clanId: 73, fromLevel: 0, toLevel: 1, requiredAmount: 650000 });
        assert.strictEqual(short.ok, false);
        assert.strictEqual(short.code, 'leader_adena_not_ready');
        assert.strictEqual(await level(73), 0, 'an unpaid level-up rolls back');
        assert.strictEqual(await wallet(4500003), 100000);
        // A leader held by a party pays later; nothing changes now.
        const busy = await Database.advanceAutonomousClanLevel({ clanId: 74, fromLevel: 0, toLevel: 1, requiredAmount: 650000 });
        assert.strictEqual(busy.code, 'leader_busy');
        assert.strictEqual(await level(74), 0);

        // A worker-owned leader pays from its virtual wallet and its revision moves,
        // so an older worker proposal cannot write the old wallet back.
        const [before] = await Database.execute(['SELECT simulationRevision FROM bot_life_state WHERE characterId = 4500005']);
        const worker = await Database.advanceAutonomousClanLevel({ clanId: 75, fromLevel: 0, toLevel: 1, requiredAmount: 650000 });
        assert.strictEqual(worker.ok, true, JSON.stringify(worker));
        assert.strictEqual(Number(worker.leaderRow.adena), 350000, 'paid from the virtual wallet');
        assert.strictEqual(Number(worker.leaderRow.simulationRevision), Number(before.simulationRevision) + 1, 'the revision moves');
        console.log('Clan level-up cost checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
