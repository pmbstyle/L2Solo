const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-slice6.sqlite');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const ContributionPolicy = invoke('GameServer/Clan/ClanContributionPolicy');
const ClanSimulationService = invoke('GameServer/Clan/ClanSimulationService');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanMarketService = invoke('GameServer/Clan/ClanMarketService');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_slice6', 'test-only');
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_market_slice6', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, ?, ?, ?, 0, ?, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase, currentRegion,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, 'cold', ?, ?, ?, ?)`);
    const insertAdena = seed.prepare(`INSERT INTO items(selfId, name, amount, equipped, slot, characterId)
        VALUES (57, 'Adena', 20000000, 0, 0, ?)`);
    const insertPersona = seed.prepare(`INSERT INTO bot_personas(
        characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt
    ) VALUES (?, 1, ?, 'progression', 'steady_achiever', ?, 'slice6 validation persona', 0, 0)`);
    const traits = {
        ambition: 0.95,
        assertiveness: 0.90,
        resilience: 0.90,
        sociability: 0.90,
        commitment: 0.90
    };
    for (let index = 1; index <= 60; index += 1) {
        const id = 4600000 + index;
        const classId = index % 5 === 1 ? 4 : index % 5 === 2 ? 15 : index % 5 === 3 ? 21 : index % 5 === 4 ? 43 : 11;
        const name = `SliceSix${index}`;
        insertCharacter.run(id, 'bot_pop_slice6', name, classId, 60);
        insertState.run(id, 'bot_pop_slice6', name, 60, 20000000, 'hunting', 'Giran', JSON.stringify({
            '57': { selfId: 57, name: 'Adena', amount: 20000000 }
        }), JSON.stringify({ generatedCold: true, classId, traits, partyHistory: { cruma: { runs: 3 } } }), index);
        insertPersona.run(id, String(id), JSON.stringify({ ...traits, caution: 0.50, empathy: 0.80 }));
        insertAdena.run(id);
    }

    const sellerId = 4600061;
    insertCharacter.run(sellerId, 'bot_market_slice6', 'MarketSellerSix', 11, 60);
    insertState.run(sellerId, 'bot_market_slice6', 'MarketSellerSix', 60, 2000000, 'merchant', 'Giran', JSON.stringify({
        '57': { selfId: 57, name: 'Adena', amount: 2000000 },
        '1419': { selfId: 1419, name: 'Blood Mark', amount: 1, kind: 'Other.None' }
    }), JSON.stringify({
        marketStore: {
            storeType: 1,
            sellerCharacterId: sellerId,
            sellerName: 'MarketSellerSix',
            town: 'Giran',
            items: [{ selfId: 1419, name: 'Blood Mark', count: 1, price: 500000 }],
            expiresAt: Date.now() + 300000
        }
    }), 1000);
    insertAdena.run(sellerId);
    seed.prepare(`INSERT INTO items(selfId, name, amount, equipped, slot, characterId)
        VALUES (1419, 'Blood Mark', 1, 0, 0, ?)`).run(sellerId);
    seed.close();
}

async function main() {
    DataCache.init();
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await LifeState.init();

    const previousRate = process.env.L2NODE_PROGRESSION_RATE;
    try {
        const requirements = {};
        for (const rate of ['x1', 'x10', 'x50']) {
            process.env.L2NODE_PROGRESSION_RATE = rate;
            requirements[rate] = ContributionPolicy.scaledAdenaRequirement(0);
        }
        assert(requirements.x1 < requirements.x10 && requirements.x10 < requirements.x50);
        assert(requirements.x50 < requirements.x1 * 50, 'Adena scaling must remain sublinear');

        process.env.L2NODE_PROGRESSION_RATE = 'x1';
        ClanSimulationService.resetMetrics();
        const firstHours = await ClanSimulationService.resolveBatch(64, { budgetMs: 5000 });
        assert(firstHours.created > 0, 'eligible first-hours population must create autonomous clans');
        const [population] = await Database.execute([`SELECT
            COUNT(*) AS total,
            COUNT(CASE WHEN clanId != 0 THEN 1 END) AS clanMembers
            FROM characters WHERE username = 'bot_pop_slice6'`, []]);
        const [autonomous] = await Database.execute(['SELECT COUNT(*) AS count FROM clan_simulation_clans', []]);
        assert(Number(autonomous.count) > 0 && Number(autonomous.count) <= Config.maxBotClans);
        assert(Number(population.clanMembers) <= Math.floor(Number(population.total) * Config.maxBotMemberShare));
        assert(Number(population.total) - Number(population.clanMembers) >= 10, 'a material solo population must remain');

        const [clanRow] = await Database.execute(['SELECT clanId, stateJson FROM clan_simulation_clans ORDER BY clanId LIMIT 1', []]);
        assert(clanRow, 'the validation population must contain a persistent clan');
        const clanId = Number(clanRow.clanId);
        const state = JSON.parse(clanRow.stateJson);
        state.level = 2;
        state.goal = null;
        await Database.execute(['UPDATE clans SET level = 2 WHERE id = ?', [clanId]]);
        await Database.execute(['UPDATE clan_simulation_clans SET stateJson = ? WHERE clanId = ?', [JSON.stringify(state), clanId]]);

        const goalPass = await ClanGoalService.resolveBatch(16, { budgetMs: 1000 });
        assert.strictEqual(goalPass.attempted > 0, true);
        const [goalRow] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]]);
        const goal = JSON.parse(goalRow.stateJson).goal;
        assert(goal && goal.type === 'item');
        assert.strictEqual(goal.plan.kind, 'market', 'a real Blood Mark offer must be preferred by the goal planner');
        const [signalState] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = (SELECT leaderId FROM clans WHERE id = ?)', [clanId]]);
        assert.strictEqual(Number(JSON.parse(signalState.statsJson).marketWanted.itemId), Config.bloodMarkItemId);

        const market = await ClanMarketService.resolveBatch(16, { budgetMs: 3000 });
        assert.strictEqual(market.purchases, 1, 'clan market resolver must use the normal cold purchase path');
        const [advanced] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [clanId]]);
        assert.strictEqual(Number(advanced.level), 3);
        const [seller] = await Database.execute(['SELECT amount FROM items WHERE characterId = ? AND selfId = ?', [4600061, Config.bloodMarkItemId]]);
        assert.strictEqual(Number(seller?.amount || 0), 0, 'market settlement must remove the seller item exactly once');
        const [marketLedger] = await Database.execute(["SELECT COUNT(*) AS count FROM clan_warehouse_ledger WHERE clanId = ? AND operation = 'deposit'", [clanId]]);
        assert.strictEqual(Number(marketLedger.count), 1);
        const [fulfilledDemand] = await Database.execute(['SELECT status FROM clan_market_demands WHERE clanId = ?', [clanId]]);
        assert.strictEqual(fulfilledDemand.status, 'fulfilled');
        const [clearedSignal] = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId = (SELECT leaderId FROM clans WHERE id = ?)', [clanId]]);
        assert.notStrictEqual(Number(JSON.parse(clearedSignal.statsJson).marketWanted?.itemId || 0), Config.bloodMarkItemId);

        const memberRows = await Database.execute(['SELECT id FROM characters WHERE clanId = ? ORDER BY id LIMIT 1', [clanId]]);
        const fencedMember = Number(memberRows[0].id);
        const [fencedState] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [clanId]]);
        const fencedRevision = Number(JSON.parse(fencedState.stateJson).warehouseRevision || 0);
        const insertedMaterial = await Database.execute([`INSERT INTO items(selfId, name, amount, equipped, slot, characterId)
            VALUES (1864, 'Varnish', 1, 0, 0, ?)`, [fencedMember]]);
        await Database.execute(["UPDATE bot_life_state SET phase = 'hot' WHERE characterId = ?", [fencedMember]]);
        const stale = await Database.transferInventoryToClanWarehouse({
            clanId,
            characterId: fencedMember,
            item: { id: insertedMaterial.insertId, selfId: 1864, name: 'Varnish', kind: 'Other.Material' },
            amount: 1,
            expectedWarehouseRevision: fencedRevision,
            resolveKey: 'slice6:hot-cold-fence'
        });
        assert.strictEqual(stale.code, 'stale_snapshot');
        await Database.execute(["UPDATE bot_life_state SET phase = 'cold' WHERE characterId = ?", [fencedMember]]);

        await Database.close();
        Database.init();
        const persistedClans = await Database.fetchClanSimulationClans();
        const persistedEvents = await Database.fetchClanGoalEvents(clanId, 50);
        const persistedLedger = await Database.execute(['SELECT COUNT(*) AS count FROM clan_warehouse_ledger WHERE clanId = ?', [clanId]]);
        assert(persistedClans.some((clan) => Number(clan.clanId) === clanId));
        assert(persistedEvents.some((event) => event.eventType === 'market_purchase'));
        assert(Number(persistedLedger[0].count) >= 1);

        const originalProfile = PopulationService.playerActivityProfile;
        PopulationService.playerActivityProfile = () => ({ protected: true, realPlayers: 1 });
        const deferred = await PopulationService.resolveClanSimulation();
        PopulationService.playerActivityProfile = originalProfile;
        assert.strictEqual(deferred.playerProtected, true, 'clan simulation must preserve player activity context');
        assert(deferred.actions && deferred.actions.attempted >= 0, 'clan actions must remain schedulable with a real player online');

        const metrics = {
            founder: ClanSimulationService.metrics(),
            market: ClanMarketService.metrics()
        };
        assert(metrics.founder.founderCreated > 0);
        assert(metrics.market.purchases > 0);
        console.log(JSON.stringify({
            rates: requirements,
            firstHours,
            population: { total: Number(population.total), clanMembers: Number(population.clanMembers) },
            autonomousClans: Number(autonomous.count),
            market,
            metrics
        }));
        console.log('Clan simulation Slice 6 checks passed');
    } finally {
        if (previousRate === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = previousRate;
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
