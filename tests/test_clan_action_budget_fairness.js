'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('clan-action-budget-fairness');
require('../src/Global');
invoke('GameServer/DataCache').init({ validate: false });
const Database = invoke('Database');
const Actions = invoke('GameServer/Clan/ClanActionService');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const Warehouse = invoke('GameServer/Clan/ClanWarehouseService');
const Equipment = invoke('GameServer/Clan/ClanWarehouseEquipmentService');
const Events = require('../src/GameServer/Clan/ClanReviewEvents');

async function main() {
    await Database.init();
    await Database.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES(1,'BudgetFair',1,3)", []]);
    await Database.execute([`INSERT INTO clan_simulation_clans(clanId,createdAt,updatedAt,stateJson)
        VALUES(1,1,1,'{}')`, []]);
    const original = { now: Date.now, claim: Database.claimClanAction,
        ensure: Database.ensurePlayerManagedClans, clans: Database.fetchAutonomousClans,
        projection: Goals.clanProjectionById, goal: Goals.resolveClan,
        warehouse: Warehouse.resolveClan, equipment: Equipment.resolveClan };
    let clock = Date.now(), plans = 0, supplies = 0, sequence = 0;
    const enqueuePlan = () => Database.enqueueClanAction({ clanId: 1, actionType: 'goal_plan',
        priority: 75, actionKey: `budget:plan:${++sequence}`, availableAt: clock });
    try {
        Date.now = () => clock;
        Database.ensurePlayerManagedClans = async () => ({});
        Database.fetchAutonomousClans = async () => [];
        Goals.clanProjectionById = async () => ({ id: 1, level: 3, members: [],
            state: { mode: 'autonomous', goal: { status: 'completed' } } });
        Goals.resolveClan = async () => {
            plans++;
            clock += 45;
            await enqueuePlan();
            return { ok: true, changed: false };
        };
        Warehouse.resolveClan = async () => { supplies++; return { ok: true }; };
        Equipment.resolveClan = async () => ({ exchanged: 0, pending: false });
        Database.claimClanAction = async options => {
            const claim = await original.claim.call(Database, options);
            if (claim.action?.actionType === 'supplies') clock += 50;
            return claim;
        };
        await Events.drain(null, 1000);
        await enqueuePlan();
        await Database.enqueueClanAction({ clanId: 1, actionType: 'supplies', priority: 40,
            actionKey: 'budget:supplies', availableAt: clock });
        const batches = [];
        for (let index = 0; index < 4; index++) batches.push(await Actions.resolveBatch({ limit: 8, budgetMs: 80 }));
        assert.equal(batches[0].attempted, 1);
        assert.equal(batches[0].released, 1, 'a 50ms claim after a 45ms plan exceeds the 80ms budget');
        assert.equal(supplies, 1, 'the unused supply turn executes in the following batch despite fresh plans');
        assert(plans > 0, 'planning also continues to make progress');
        assert.equal((await Database.fetchClanActionQueueStats()).running, 0, 'no unstarted lease remains stranded');
        console.log('Clan action budget fairness passed: slow claims return their unused service turn');
    } finally {
        Date.now = original.now;
        Database.claimClanAction = original.claim;
        Database.ensurePlayerManagedClans = original.ensure;
        Database.fetchAutonomousClans = original.clans;
        Goals.clanProjectionById = original.projection;
        Goals.resolveClan = original.goal;
        Warehouse.resolveClan = original.warehouse;
        Equipment.resolveClan = original.equipment;
        Actions.stopEvents();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await Database.close(); require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }); });
