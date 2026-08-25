const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const databasePath = path.join(rootDir, 'tmp', 'test-clan-simulation-slice5.sqlite');
const Database = invoke('Database');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const ClanPartyService = invoke('GameServer/Clan/ClanPartyService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BackgroundPartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');

function removeDatabaseFiles() {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
}

function seedDatabase() {
    removeDatabaseFiles();
    const seed = new DatabaseSync(databasePath);
    seed.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    seed.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_slice5', 'test-only');
    const insertCharacter = seed.prepare(`INSERT INTO characters(
        id, username, name, classId, race, level, maxHp, maxMp,
        sex, face, hair, hairColor, locX, locY, locZ
    ) VALUES (?, 'bot_pop_slice5', ?, ?, 0, 60, 500, 250, 0, 0, 0, 0, 83400, 148600, -3400)`);
    const insertState = seed.prepare(`INSERT INTO bot_life_state(
        characterId, accountName, characterName, level, adena, activity, phase,
        inventorySummary, statsJson, updatedAt
    ) VALUES (?, 'bot_pop_slice5', ?, 60, 100000, 'hunting', 'cold', ?, ?, ?)`);
    for (let index = 1; index <= 5; index += 1) {
        const id = 4500000 + index;
        const classId = index === 1 ? 4 : index === 2 ? 15 : index === 3 ? 21 : index === 4 ? 43 : 11;
        insertCharacter.run(id, `SliceFive${index}`, classId);
        insertState.run(id, `SliceFive${index}`, JSON.stringify({ '57': { selfId: 57, name: 'Adena', amount: 100000 } }), JSON.stringify({
            generatedCold: true,
            classId,
            partyHistory: { cruma: { runs: 3 } }
        }), index);
    }
    seed.close();
}

async function main() {
    seedDatabase();
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await LifeState.init();
    await BackgroundPartyState.init();

    try {
        const created = await Database.createAutonomousClan({
            name: 'SliceFiveClan',
            leaderId: 4500001,
            memberIds: [4500001, 4500002, 4500003, 4500004, 4500005],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 2, goal: null }
        });
        assert.strictEqual(created.ok, true);
        await Database.execute(['UPDATE clans SET level = 2 WHERE id = ?', [created.clanId]]);

        const firstGoal = await ClanGoalService.resolveBatch(4, { budgetMs: 1000 });
        assert.strictEqual(firstGoal.attempted, 1);
        const [beforeSetup] = await Database.execute(['SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?', [created.clanId]]);
        const setupState = JSON.parse(beforeSetup.stateJson);
        const farmGoal = {
            ...setupState.goal,
            plan: {
                ...setupState.goal.plan,
                kind: 'farm',
                sourceId: Config.bloodMarkSourceNpcId,
                reasonCode: 'party_ready'
            },
            assignedMemberIds: [4500001, 4500002, 4500003, 4500004, 4500005],
            status: 'executing'
        };
        const goalSetup = await Database.updateAutonomousClanGoal({
            clanId: created.clanId,
            goal: farmGoal,
            expectedUpdatedAt: setupState.updatedAt,
            eventType: 'test_farm_setup',
            reasonCode: 'party_ready'
        });
        assert.strictEqual(goalSetup.ok, true);

        await Database.execute(['UPDATE bot_life_state SET partyId = ? WHERE characterId = ?', ['busy-party', 4500002]]);
        const originalFetchActiveOperation = Database.fetchActiveAutonomousClanOperation;
        let activeOperationLookups = 0;
        let notReady;
        try {
            Database.fetchActiveAutonomousClanOperation = (...args) => {
                activeOperationLookups += 1;
                return originalFetchActiveOperation.apply(Database, args);
            };
            notReady = await ClanPartyService.resolveBatch(4, { budgetMs: 1000, rng: () => 0 });
        } finally {
            Database.fetchActiveAutonomousClanOperation = originalFetchActiveOperation;
        }
        assert.strictEqual(notReady.started, 0, 'an unavailable required role must keep the clan party pending');
        assert.strictEqual(activeOperationLookups, 0, 'a not-ready roster without goal.partyId must not query for an impossible active operation');
        const [beforeRefreshStart] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [created.clanId]
        ]);
        const staleRosterState = JSON.parse(beforeRefreshStart.stateJson);
        const staleRosterGoal = {
            ...staleRosterState.goal,
            assignedMemberIds: [4500001, 4500003, 4500004, 4500005]
        };
        const staleRosterUpdate = await Database.updateAutonomousClanGoal({
            clanId: created.clanId,
            goal: staleRosterGoal,
            expectedUpdatedAt: staleRosterState.updatedAt,
            eventType: 'test_stale_roster_setup',
            reasonCode: 'party_not_ready'
        });
        assert.strictEqual(staleRosterUpdate.ok, true);

        const busyParty = await BackgroundPartyState.createOrUpdate({
            partyId: 'busy-party',
            leaderId: 4500001,
            memberIds: [4500001, 4500002, 4500003, 4500004, 4500005],
            spotId: 'test-spot',
            startedAt: Date.now(),
            nextResolveAt: Date.now() + 30000,
            status: 'active',
            stats: { objective: { clanId: null } }
        });
        assert(busyParty);
        await Database.execute([
            'UPDATE bot_life_state SET partyId = ? WHERE characterId BETWEEN ? AND ?',
            ['busy-party', 4500001, 4500005]
        ]);

        const started = await ClanPartyService.resolveBatch(4, { budgetMs: 1000, rng: () => 0 });
        assert.strictEqual(started.started, 1,
            'a required support must be reclaimed and a refreshed roster started in the same pass');
        assert.strictEqual(BackgroundPartyState.find('busy-party').status, 'dissolved');
        const lingeringBusyMembers = await Database.execute([
            'SELECT characterId FROM bot_life_state WHERE partyId = ?',
            ['busy-party']
        ]);
        assert.deepStrictEqual(lingeringBusyMembers, [], 'reclaimed party members must be durably detached');
        const [activeOperation] = await Database.execute([
            "SELECT * FROM clan_operations WHERE clanId = ? AND status = 'active'",
            [created.clanId]
        ]);
        assert(activeOperation, 'operation must survive between resolver passes');
        const activeMembers = await Database.execute([
            "SELECT characterId FROM clan_operation_members WHERE operationId = ? AND status = 'active'",
            [activeOperation.id]
        ]);
        assert.strictEqual(activeMembers.length, 5);
        const activeMemberIds = activeMembers.map((member) => Number(member.characterId));
        const activeStates = await LifeState.statesByIds(activeMemberIds, { ownerId: 'legacy_main' });
        const competingParty = BackgroundPartyState.prepareCommit({
            partyId: 'competing-party',
            leaderId: activeMemberIds[0],
            memberIds: activeMemberIds,
            spotId: 'test-spot',
            startedAt: Date.now(),
            nextResolveAt: Date.now() + 30000,
            status: 'active'
        });
        const competingMembers = activeStates.map((member) => LifeState.preparePartyAssignment(
            member,
            competingParty.snapshot.partyId,
            member.stats?.role || 'dps',
            competingParty.snapshot.leaderId,
            competingParty.snapshot.nextResolveAt
        ));
        const competingCommit = await Database.commitBackgroundPartyMembership({
            party: competingParty.row,
            members: competingMembers
        });
        assert.strictEqual(competingCommit.ok, false);
        assert.strictEqual(competingCommit.reason, 'clan_operation_reserved',
            'atomic ordinary-party commit must respect the clan operation reservation');
        const reservedCandidates = await LifeState.statesByIds(
            activeMemberIds,
            { ownerId: 'legacy_main', unassigned: true }
        );
        assert.deepStrictEqual(reservedCandidates, [], 'active clan operation members must be excluded from ordinary party hydration');

        const resolved = await ClanPartyService.resolveBatch(4, { budgetMs: 1000, rng: () => 0 });
        assert.strictEqual(resolved.succeeded, 1, 'second pass must resolve the persistent operation');
        const [clan] = await Database.execute(['SELECT level FROM clans WHERE id = ?', [created.clanId]]);
        assert.strictEqual(Number(clan.level), 3, 'Blood Mark reward must advance the autonomous clan');

        const [operation] = await Database.execute(['SELECT status, wins, deaths FROM clan_operations WHERE id = ?', [activeOperation.id]]);
        assert.strictEqual(operation.status, 'succeeded');
        assert.strictEqual(Number(operation.wins), 1);
        assert.strictEqual(Number(operation.deaths), 0);
        const [warehouse] = await Database.execute([
            'SELECT amount FROM clan_warehouse_items WHERE clanId = ? AND selfId = ?',
            [created.clanId, Config.bloodMarkItemId]
        ]);
        assert.strictEqual(Number(warehouse?.amount || 0), 0, 'level-up must consume the required Blood Mark');
        const rewardLedger = await Database.execute([
            "SELECT * FROM clan_warehouse_ledger WHERE clanId = ? AND operation = 'party_reward'",
            [created.clanId]
        ]);
        assert.strictEqual(rewardLedger.length, 1);
        const releasedMembers = await Database.execute([
            "SELECT COUNT(*) AS count FROM clan_operation_members WHERE operationId = ? AND status = 'active'",
            [activeOperation.id]
        ]);
        assert.strictEqual(Number(releasedMembers[0].count), 0);

        const replay = await Database.completeAutonomousClanOperation({
            operationId: activeOperation.id,
            success: true,
            drops: [{ selfId: Config.bloodMarkItemId, amount: 1, name: 'Blood Mark' }]
        });
        assert.strictEqual(replay.ok, true);
        assert.strictEqual(replay.idempotent, true);
        const rewardLedgerAfterReplay = await Database.execute([
            "SELECT * FROM clan_warehouse_ledger WHERE clanId = ? AND operation = 'party_reward'",
            [created.clanId]
        ]);
        assert.strictEqual(rewardLedgerAfterReplay.length, 1, 'replayed completion must not duplicate rewards');

        const terminal = await ClanPartyService.resolveBatch(4, { budgetMs: 1000, rng: () => 0 });
        assert.strictEqual(terminal.started, 0);
        assert.strictEqual(terminal.resolved, 0);

        const timestamp = Date.now();
        await Database.execute([`INSERT INTO clan_warehouse_items
            (clanId, selfId, name, amount, createdAt, updatedAt)
            VALUES (?, ?, 'Blood Mark', 1, ?, ?)`, [created.clanId, Config.bloodMarkItemId, timestamp, timestamp]]);
        const currentProjection = await ClanGoalService.clanProjectionById(created.clanId);
        const staleProjection = {
            ...currentProjection,
            level: 2,
            state: { ...currentProjection.state, level: 2, goal: null }
        };
        const goalEventsBefore = await Database.fetchClanGoalEvents(created.clanId, 200);
        const staleResolve = await ClanGoalService.resolveClan(staleProjection);
        assert.strictEqual(staleResolve.ok, true);
        assert.strictEqual(staleResolve.skipped, true,
            'an already-advanced clan must skip planning from its stale level-2 projection');
        assert.strictEqual(staleResolve.reason, 'level_already_advanced');
        assert.strictEqual(Number(staleResolve.level), 3);
        const [stateAfterStaleResolve] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [created.clanId]
        ]);
        assert.strictEqual(JSON.parse(stateAfterStaleResolve.stateJson).goal, null,
            'a stale level-2 projection must not persist a Blood Mark goal onto a level-3 clan');
        const goalEventsAfter = await Database.fetchClanGoalEvents(created.clanId, 200);
        assert.strictEqual(goalEventsAfter.length, goalEventsBefore.length,
            'skipping an already-advanced clan must not emit a misleading goal event');

        console.log('Clan simulation Slice 5 checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
