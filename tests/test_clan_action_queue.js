const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-action-queue.sqlite');
const Database = invoke('Database');
const ClanActionService = invoke('GameServer/Clan/ClanActionService');
const ClanGoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanPartyService = invoke('GameServer/Clan/ClanPartyService');

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
    for (let index = 1; index <= 10; index += 1) {
        const id = 4700000 + index;
        const rosterSlot = (index - 1) % 5;
        const classId = rosterSlot === 0 ? 4
            : rosterSlot === 1 ? 15
                : rosterSlot === 2 ? 21
                    : rosterSlot === 3 ? 11 : 56;
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

        const compatibilityClaims = await Database.claimClanActions({ limit: 8 });
        assert.strictEqual(compatibilityClaims.length, 1, 'the legacy batch API must not pre-claim unadmitted work');
        const compatibilityClaim = compatibilityClaims[0];
        const staleRelease = await Database.releaseClanAction({
            actionId: compatibilityClaim.id,
            expectedAttempt: Number(compatibilityClaim.attempt) + 1,
            expectedLeaseUntil: compatibilityClaim.leaseUntil
        });
        assert.strictEqual(staleRelease.code, 'ownership_conflict', 'release must be fenced by the exact claim attempt');
        const compatibilityRelease = await Database.releaseClanAction({
            actionId: compatibilityClaim.id,
            expectedAttempt: compatibilityClaim.attempt,
            expectedLeaseUntil: compatibilityClaim.leaseUntil
        });
        assert.strictEqual(compatibilityRelease.ok, true);

        await ClanActionService.bootstrap();
        const originalClaimClanAction = Database.claimClanAction;
        Database.claimClanAction = async (options) => {
            const claim = await originalClaimClanAction.call(Database, options);
            await new Promise((resolve) => setTimeout(resolve, 250));
            return claim;
        };
        let budgetStopped;
        try {
            budgetStopped = await ClanActionService.resolveBatch({ limit: 8, budgetMs: 200 });
        } finally {
            Database.claimClanAction = originalClaimClanAction;
        }
        assert.strictEqual(budgetStopped.claimed, 1, 'the scheduler may acquire only the action currently being admitted');
        assert.strictEqual(budgetStopped.attempted, 0, 'an action claimed after the deadline must not start');
        assert.strictEqual(budgetStopped.released, 1, 'an unstarted action must return to pending immediately');
        assert.strictEqual(budgetStopped.leftRunning, 0, 'budget exhaustion must not leak a running action');
        assert.strictEqual(budgetStopped.budgetStopped, true);
        const queueAfterBudgetStop = await Database.fetchClanActionQueueStats();
        assert.strictEqual(queueAfterBudgetStop.running, 0);
        assert(queueAfterBudgetStop.pending >= 1);
        assert.strictEqual(ClanActionService.metrics().releasedUnstarted, 1);

        let claimCalls = 0;
        let maxRunning = 0;
        Database.claimClanAction = async (options) => {
            const before = await Database.fetchClanActionQueueStats();
            assert.strictEqual(before.running, 0, 'the previous action must settle before another claim');
            const claim = await originalClaimClanAction.call(Database, options);
            const after = await Database.fetchClanActionQueueStats();
            maxRunning = Math.max(maxRunning, after.running);
            claimCalls += claim.action ? 1 : 0;
            return claim;
        };
        let first;
        try {
            first = await ClanActionService.resolveBatch({ limit: 2, budgetMs: 2000 });
        } finally {
            Database.claimClanAction = originalClaimClanAction;
        }
        assert.strictEqual(first.claimed >= 2, true, 'planner and first executable action must be claimed');
        assert.strictEqual(first.succeeded >= 2, true, 'claimed actions must resolve');
        assert.strictEqual(first.resolved, 2, 'each admitted claim must reach a terminal state');
        assert.strictEqual(first.leftRunning, 0);
        assert.strictEqual(claimCalls, 2);
        assert.strictEqual(maxRunning, 1, 'durable action concurrency must remain one');

        const [ledger] = await Database.execute([
            'SELECT COUNT(*) AS entries, COALESCE(SUM(amount), 0) AS amount FROM clan_contributions WHERE clanId = ?',
            [created.clanId]
        ]);
        assert(Number(ledger.entries) > 0, 'contribution action must produce a real ledger entry');
        assert(Number(ledger.amount) > 0);

        const actionsAfterFirst = await Database.fetchClanActions({ clanId: created.clanId, limit: 20 });
        assert(actionsAfterFirst.some((action) => action.actionType === 'contribution' && action.status === 'succeeded'));
        assert(actionsAfterFirst.some((action) => action.status === 'pending' || action.status === 'running'));
        const pendingForRecovery = actionsAfterFirst.find((action) => action.status === 'pending');
        assert(pendingForRecovery, 'the action chain must leave a pending recovery fixture');
        const expiredAt = Date.now() - 1000;
        await Database.execute([
            `UPDATE clan_actions SET status = 'running', leaseUntil = ?, updatedAt = ?
                WHERE id = ? AND status = 'pending'`,
            [expiredAt, expiredAt, pendingForRecovery.id]
        ]);

        await Database.close();
        Database.init();
        ClanActionService.resetMetrics();
        const recovered = await ClanActionService.resolveBatch({ limit: 2, budgetMs: 2000 });
        assert(recovered.attempted > 0, 'the durable action queue must continue after a restart');
        const recoveredMetrics = ClanActionService.metrics();
        assert(recoveredMetrics.leaseRecoveries >= 1, 'expired running actions must be visible as lease recoveries');
        assert(recoveredMetrics.stages.claim.count > 0, 'claim latency must be observable');
        assert(recoveredMetrics.stages.projection.count > 0, 'projection latency must be observable');
        assert(recoveredMetrics.stages.execute.count > 0, 'execution latency must be observable');
        assert(recoveredMetrics.stages.settle.count > 0, 'settlement latency must be observable');
        assert(recoveredMetrics.stages.total.p95Ms >= 0, 'action p95 must be exposed');
        assert.strictEqual((await Database.fetchClanActionQueueStats()).running, 0, 'recovery must not leave another claimed batch behind');

        const actionRows = await Database.fetchClanActions({ clanId: created.clanId, limit: 20 });
        console.log(JSON.stringify({
            first,
            recovered,
            actionStatuses: actionRows.map((action) => `${action.actionType}:${action.status}`),
            contributionEntries: Number(ledger.entries)
        }));

        const replanCreated = await Database.createAutonomousClan({
            name: 'MarketReplanClan',
            leaderId: 4700006,
            memberIds: [4700006, 4700007, 4700008, 4700009, 4700010],
            founderQuorum: 5,
            maxBotClans: 40,
            maxBotMemberShare: 1,
            stateJson: { level: 2, goal: null }
        });
        assert.strictEqual(replanCreated.ok, true);
        await Database.execute(['UPDATE clans SET level = 2 WHERE id = ?', [replanCreated.clanId]]);

        const [simulation] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [replanCreated.clanId]
        ]);
        const staleAt = Date.now() - 10 * 60 * 1000;
        const marketGoal = {
            type: 'item',
            target: { itemId: 1419, itemName: 'Blood Mark' },
            required: 1,
            progress: 0,
            plan: { kind: 'market', sourceId: null, beneficiaryId: null, selectedAt: staleAt, reasonCode: 'market_demand_open' },
            assignedMemberIds: [4700006, 4700007, 4700008, 4700009, 4700010],
            partyId: null,
            catastrophicFailures: 0,
            status: 'executing',
            reasonCodes: ['market_demand_open'],
            createdAt: staleAt,
            updatedAt: staleAt
        };
        const goalSetup = await Database.updateAutonomousClanGoal({
            clanId: replanCreated.clanId,
            goal: marketGoal,
            expectedUpdatedAt: Number(JSON.parse(simulation.stateJson).updatedAt),
            eventType: 'test_market_replan_setup',
            reasonCode: 'market_demand_open'
        });
        assert.strictEqual(goalSetup.ok, true);
        const demand = await Database.upsertClanMarketDemand({
            clanId: replanCreated.clanId,
            itemId: 1419,
            amount: 1,
            maxPrice: 2500000,
            goalKey: `${replanCreated.clanId}:level-2:1419`,
            status: 'open'
        });
        await Database.execute([
            'UPDATE clan_market_demands SET updatedAt = ? WHERE id = ?',
            [staleAt, demand.demandId]
        ]);
        const bootstrapAction = (await Database.fetchClanActions({ clanId: replanCreated.clanId, limit: 4 }))[0];
        await Database.resolveClanAction({
            actionId: bootstrapAction.id,
            status: 'cancelled',
            result: { reason: 'test_setup' },
            reasonCode: 'test_setup'
        });
        const marketAction = await Database.enqueueClanAction({
            clanId: replanCreated.clanId,
            actionKey: `test:${replanCreated.clanId}:market-no-offer`,
            actionType: 'market',
            priority: 200,
            payload: { reason: 'test_market_replan' }
        });
        const [claimedMarket] = await Database.claimClanActions({ limit: 1 });
        assert.strictEqual(claimedMarket.id, marketAction.actionId);
        const marketMiss = await ClanActionService.resolveAction(claimedMarket);
        assert.strictEqual(marketMiss.result.reason, 'market_no_offer');
        const afterMiss = await Database.fetchClanActions({ clanId: replanCreated.clanId, limit: 8 });
        const pendingPlan = afterMiss.find((action) => action.actionType === 'goal_plan' && action.status === 'pending');
        assert(pendingPlan, 'market miss must enqueue a fresh goal planner action');
        assert.strictEqual(Number(pendingPlan.priority), 100);

        const [claimedPlan] = await Database.claimClanActions({ limit: 1 });
        assert.strictEqual(claimedPlan.id, pendingPlan.id);
        await ClanActionService.resolveAction(claimedPlan);
        const [replannedState] = await Database.execute([
            'SELECT stateJson FROM clan_simulation_clans WHERE clanId = ?',
            [replanCreated.clanId]
        ]);
        const replannedGoal = JSON.parse(replannedState.stateJson).goal;
        assert.strictEqual(replannedGoal.plan.kind, 'farm', 'a stale market demand must fall back to farm');
        const replannedActions = await Database.fetchClanActions({ clanId: replanCreated.clanId, limit: 8 });
        assert(replannedActions.some((action) => action.actionType === 'party' && action.status === 'pending'));

        const transientPartyAction = await Database.enqueueClanAction({
            clanId: replanCreated.clanId,
            actionKey: `test:${replanCreated.clanId}:party-not-ready`,
            actionType: 'party',
            priority: 1000,
            payload: { reason: 'test_party_not_ready' }
        });
        const [claimedParty] = await Database.claimClanActions({ limit: 1 });
        assert.strictEqual(claimedParty.id, transientPartyAction.actionId);
        const actionCountBeforeDeferral = (await Database.fetchClanActions({ clanId: replanCreated.clanId, limit: 20 })).length;
        const deferStartedAt = Date.now();
        const originalResolveClanParty = ClanPartyService.resolveClan;
        let deferredParty;
        try {
            ClanPartyService.resolveClan = async () => ({
                ok: false,
                skipped: true,
                code: 'party_not_ready'
            });
            deferredParty = await ClanActionService.resolveAction(claimedParty);
        } finally {
            ClanPartyService.resolveClan = originalResolveClanParty;
        }
        assert.strictEqual(deferredParty.deferred, true, 'party readiness must defer the durable action instead of failing it');
        assert.strictEqual(deferredParty.status, 'pending');
        const actionsAfterDeferral = await Database.fetchClanActions({ clanId: replanCreated.clanId, limit: 20 });
        assert.strictEqual(actionsAfterDeferral.length, actionCountBeforeDeferral, 'transient readiness must not append another action row');
        const samePartyAction = actionsAfterDeferral.find((action) => Number(action.id) === Number(claimedParty.id));
        assert.strictEqual(samePartyAction.status, 'pending');
        assert(Number(samePartyAction.availableAt) >= deferStartedAt + ClanActionService.config.actionRetryMs,
            'the same party action must retain the configured retry delay');
        assert.strictEqual(
            actionsAfterDeferral.some((action) => action.actionType === 'party' && action.status === 'failed'),
            false,
            'party_not_ready is a transient state, not a terminal failure'
        );
        assert(ClanActionService.metrics().deferred >= 1, 'transient action deferrals must be observable');
        assert(ClanActionService.metrics().stages.defer.count >= 1, 'defer settlement latency must be observable');
        assert(ClanActionService.metrics().stages['execute:party'].count >= 1,
            'party execution latency must remain separately observable');

        const readyRoster = [4, 15, 21, 11, 56].map((classId) => ({ classId, phase: 'cold' }));
        assert.strictEqual(ClanGoalPolicy.hasReadyRoles(readyRoster), true);
        assert.strictEqual(ClanGoalPolicy.hasReadyRoles(readyRoster.map((member) => (
            member.classId === 21 ? { ...member, partyId: 'background-party' } : member
        ))), false, 'a background-party member must not count as an available role');
        const expandedRoster = [4, 4, 4, 4, 15, 21, 11].map((classId, index) => ({
            characterId: 8000 + index,
            classId,
            level: 60 - index,
            phase: 'cold'
        }));
        const expandedIds = ClanGoalPolicy.operationMembers(expandedRoster, 9);
        assert.strictEqual(expandedIds.length, 7, 'a clan operation may use more than five available members');
        const cappedIds = ClanGoalPolicy.operationMembers(expandedRoster, 3).sort((a, b) => a - b);
        assert.deepStrictEqual(cappedIds, [8000, 8004, 8005],
            'role-first selection must retain one tank, healer, and buffer when the roster is capped');
        assert.strictEqual(ClanGoalPolicy.hasReadyRoles(expandedRoster), true,
            'a larger role-balanced clan roster must be ready');
        assert.strictEqual(ClanGoalPolicy.hasReadyRoles(expandedRoster.map((member) => (
            member.characterId === 8005 ? { ...member, simulationOwner: 'cold_simulation_owner' } : member
        ))), false, 'a worker-owned support must not be reserved by the main-owned clan operation');
        console.log('Clan action queue checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
