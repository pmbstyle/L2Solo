const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-equipment-warehouse.sqlite');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_clan_warehouse', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_clan_warehouse', ?, ?, 0, 40, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_clan_warehouse', ?, 40, 100000, 'hunting', 'cold', ?, ?, ?)`);
    [4, 15].forEach((classId, index) => {
        const id = 4800001 + index;
        const name = `ClanCrafter${index + 1}`;
        insertCharacter.run(id, name, classId);
        insertState.run(
            id,
            name,
            JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 100000 } }),
            JSON.stringify({ generatedCold: true, classId }),
            index + 1
        );
    });
    seed.close();
}

async function main() {
    DataCache.init();
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await LifeState.init();

    const originalPlanFor = GearAcquisitionPlanner.planFor;
    const originalSpotEnsure = SpotProfiles.ensure;
    GearAcquisitionPlanner.planFor = (state) => {
        const targetId = 9910000 + Number(state.characterId || 0);
        const owned = Number(state.inventory?.['1864']?.amount || 0);
        return {
            status: owned >= 5 ? 'ready_to_craft' : 'active',
            grade: 'c',
            strategy: 'craft',
            partyNeed: 'solo_ok',
            partyNeedReason: 'solo_ready',
            requiresParty: false,
            target: { selfId: targetId, name: `Clan Crafted Item ${state.characterId}`, slot: 7 },
            recipeId: 77001,
            materials: [{ selfId: 1864, amount: 5, owned, missing: Math.max(0, 5 - owned) }],
            next: owned >= 5 ? null : { spotId: 'clan-warehouse-test-spot', npcId: 7001, itemId: 1864 }
        };
    };
    SpotProfiles.ensure = () => [];

    try {
        const created = await Database.createAutonomousClan({
            name: 'Clan Warehouse Test',
            leaderId: 4800001,
            memberIds: [4800001, 4800002],
            founderQuorum: 2,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 3, goal: null }
        });
        assert.strictEqual(created.ok, true);
        await Database.execute(['UPDATE clans SET level = 3 WHERE id = ?', [created.clanId]]);
        await Database.execute([`INSERT INTO clan_warehouse_items(
            clanId, selfId, name, kind, amount, enchant, createdAt, updatedAt
        ) VALUES (?, 1864, 'Stem', 'Other.Material', 5, 0, 1, 1)`, [created.clanId]]);

        const first = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(first.attempted, 1);
        const [simulation] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const goal = JSON.parse(simulation.stateJson).goal;
        assert.strictEqual(goal.type, 'equipment');
        assert.strictEqual(goal.plan.kind, 'craft');
        assert.strictEqual(Number(goal.target.memberId), 4800001);

        const [beneficiaryItem] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = 1864', [goal.target.memberId]]);
        assert.strictEqual(Number(beneficiaryItem.amount), 5, 'warehouse materials must be handed to the selected beneficiary');
        const [warehouseItem] = await Database.execute(['SELECT amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = 1864', [created.clanId]]);
        assert.strictEqual(warehouseItem, undefined, 'consumed warehouse stock must not remain available');
        const [beneficiaryState] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = ?', [goal.target.memberId]]);
        const stats = JSON.parse(beneficiaryState.statsJson);
        assert.strictEqual(stats.equipmentPlan.status, 'ready_to_craft');
        assert.deepStrictEqual(stats.equipmentPlan.warehouseMaterials, [{ selfId: 1864, amount: 5 }]);

        const second = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(second.changed, 0, 'the warehouse handoff must not churn the durable clan goal');
        const [ledger] = await Database.execute(["SELECT COUNT(*) AS count FROM clan_warehouse_ledger WHERE clanId = ? AND operation = 'withdraw'", [created.clanId]]);
        assert.strictEqual(Number(ledger.count), 1);
        console.log('Clan equipment warehouse checks passed');
    } finally {
        GearAcquisitionPlanner.planFor = originalPlanFor;
        SpotProfiles.ensure = originalSpotEnsure;
        await Database.close();
        removeDatabaseFiles();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
