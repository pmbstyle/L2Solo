const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-slice3.sqlite');
const Database = invoke('Database');
const ClanEconomyService = invoke('GameServer/Clan/ClanEconomyService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_slice3', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_slice3', ?, ?, 0, 20, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_slice3', ?, 20, ?, 'hunting', 'cold', ?, ?, ?)`);
    const insertItem = seed.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
        VALUES (?, ?, ?, 0, 0, 0, ?)`);
    for (let index = 1; index <= 5; index += 1) {
        const id = 4300000 + index;
        const name = `SliceThree${index}`;
        const adena = index === 1 ? 0 : index === 4 ? 10000 : 4000000;
        const inventory = { '57': { selfId: 57, name: 'Adena', amount: adena } };
        insertCharacter.run(id, name, index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : 11);
        insertState.run(id, name, adena, JSON.stringify(inventory), JSON.stringify({
            generatedCold: true,
            generatedIndex: index,
            classId: index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : 11
        }), index);
        if (adena > 0) insertItem.run(57, 'Adena', adena, id);
        if (index === 2) insertItem.run(1864, 'Stem', 10, id);
        if (index === 3) insertItem.run(1864, 'Stem', 5, id);
        if (index === 4) insertItem.run(5339, 'Recipe: Sealed Majestic Leather Armor(100%)', 2, id);
    }
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();

    try {
        const created = await Database.createAutonomousClan({
            name: 'SliceThreeClan',
            leaderId: 4300001,
            memberIds: [4300001, 4300002, 4300003, 4300004, 4300005],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 0, goal: null }
        });
        assert.strictEqual(created.ok, true);

        const [simulation] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const state = JSON.parse(simulation.stateJson);
        state.level = 1;
        await Database.execute(['UPDATE clans SET level = 1 WHERE id = ?', [created.clanId]]);
        await Database.execute(['UPDATE clan_simulation_clans SET stateJson = ? WHERE clanId = ?', [JSON.stringify(state), created.clanId]]);

        const resolved = await ClanEconomyService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(resolved.levelUps, 1, 'level 1 must advance after a real treasury contribution');
        assert(resolved.contributions > 0, 'level 1 must apply real Adena contributions');

        const [clan] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [created.clanId]]);
        assert.strictEqual(Number(clan.level), 2);
        const [contributions] = await Database.execute(['SELECT COUNT(*) AS entries, SUM(amount) AS amount FROM clan_contributions WHERE clanId = ? AND targetLevel = 1', [created.clanId]]);
        assert.strictEqual(Number(contributions.amount), 2500000);

        const warehouse = await Database.fetchClanWarehouseItems(created.clanId);
        const adena = warehouse.find((item) => Number(item.selfId) === 57);
        const stems = warehouse.find((item) => Number(item.selfId) === 1864);
        const recipe = warehouse.find((item) => Number(item.selfId) === 5339);
        assert.strictEqual(Number(adena.amount), 2500000, 'level 1 Adena must live in the clan warehouse');
        assert.strictEqual(Number(stems.amount), 15, 'free material surplus must be deposited atomically');
        assert.strictEqual(Number(recipe.amount), 1, 'the clan warehouse keeps one recipe instance');

        const [leaderAdena] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 57', [4300001]]);
        assert.strictEqual(leaderAdena, undefined, 'level 1 treasury must not mint Adena in the leader inventory');
        const [remainingRecipe] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 5339', [4300004]]);
        assert.strictEqual(Number(remainingRecipe.amount), 1, 'duplicate recipe must remain under normal disposition policy');

        const [stateAfter] = await Database.execute(['SELECT statsJson, simulationRevision FROM bot_life_state WHERE characterId = ?', [4300002]]);
        const warehouseState = JSON.parse((await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]))[0].stateJson);
        assert(Number(warehouseState.warehouseRevision) > 0, 'warehouse revision must advance with each real transfer');
        assert(Number(stateAfter.simulationRevision) > 0, 'cold character revision must fence inventory mutation');

        const staleReserve = await Database.reserveClanWarehouseItem({
            clanId: created.clanId,
            selfId: 1864,
            amount: 5,
            goalKey: 'slice3-stale',
            expectedWarehouseRevision: 0
        });
        assert.strictEqual(staleReserve.ok, false);
        assert.strictEqual(staleReserve.code, 'ownership_conflict');

        const reserve = await Database.reserveClanWarehouseItem({
            clanId: created.clanId,
            selfId: 1864,
            amount: 5,
            goalKey: 'slice3-readiness',
            beneficiaryId: 4300002,
            expectedWarehouseRevision: Number(warehouseState.warehouseRevision)
        });
        assert.strictEqual(reserve.ok, true);
        const duplicateReserve = await Database.reserveClanWarehouseItem({
            clanId: created.clanId,
            selfId: 1864,
            amount: 5,
            goalKey: 'slice3-readiness'
        });
        assert.strictEqual(duplicateReserve.ok, false);
        assert.strictEqual(duplicateReserve.code, 'warehouse_reservation_exists');
        const released = await Database.releaseClanWarehouseReservation({
            clanId: created.clanId,
            selfId: 1864,
            goalKey: 'slice3-readiness',
            expectedWarehouseRevision: Number(reserve.warehouseRevision)
        });
        assert.strictEqual(released.ok, true);

        console.log('Clan simulation Slice 3 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
