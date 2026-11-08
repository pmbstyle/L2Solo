'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('clan-action-fairness');
require('../src/Global');
const Database = invoke('Database');
const TYPES = ['goal_plan', 'contribution', 'supplies', 'member_titles', 'party', 'warehouse', 'market', 'production'];
const PRIORITY = { goal_plan: 75, contribution: 75, supplies: 40, member_titles: 20, party: 50,
    warehouse: 50, market: 50, production: 40 };
let sequence = 0;
async function enqueue(type, at, priority = PRIORITY[type]) {
    return Database.enqueueClanAction({ clanId: 1, actionKey: `fairness:${++sequence}`, actionType: type,
        priority, availableAt: at });
}
async function reset() {
    await Database.execute(['DELETE FROM clan_actions', []]);
    await Database.execute(["DELETE FROM world_meta WHERE key = 'clanActionScheduler:v1'", []]);
}
async function finish(action) {
    await Database.resolveClanAction({ actionId: action.id, status: 'succeeded', result: { ok: true } });
}
async function release(action, availableAt, continuation = false, unstarted = false) {
    return Database.releaseClanAction({ actionId: action.id, availableAt, continuation, unstarted,
        expectedAttempt: action.attempt, expectedLeaseUntil: action.leaseUntil });
}

async function main() {
    fixture.assertConfigured(options.default);
    await Database.init();
    await Database.execute(["INSERT INTO clans(id,name,leaderId) VALUES(1,'FairQueue',1)", []]);
    await Database.execute([`INSERT INTO clan_simulation_clans(clanId,createdAt,updatedAt,stateJson)
        VALUES(1,1,1,'{}')`, []]);
    let at = Date.now();
    for (const type of TYPES) await enqueue(type, at);
    const turns = new Map(TYPES.map(type => [type, 0]));
    for (let index = 0; index < TYPES.length * 2; index++) {
        const { action } = await Database.claimClanAction({ at });
        assert(action);
        turns.set(action.actionType, turns.get(action.actionType) + 1);
        await finish(action);
        await enqueue(action.actionType, at);
        if (index === TYPES.length - 1) assert([...turns.values()].every(count => count === 1),
            'every ready type gets a turn before a continuously replenished plan gets its second');
    }
    assert([...turns.values()].every(count => count === 2), 'fairness spans successive one-action admissions');

    await reset();
    await enqueue('goal_plan', at);
    const budgetSupply = await enqueue('supplies', at);
    let budgetClaim = (await Database.claimClanAction({ at })).action;
    await finish(budgetClaim);
    await enqueue('goal_plan', at);
    budgetClaim = (await Database.claimClanAction({ at })).action;
    assert.equal(budgetClaim.id, budgetSupply.actionId);
    await Database.execute([`CREATE TEMP TRIGGER fail_clan_refund BEFORE INSERT ON world_meta
        WHEN NEW.key='clanActionScheduler:v1' BEGIN SELECT RAISE(ABORT,'refund_write_failed'); END`, []]);
    await assert.rejects(release(budgetClaim, at, false, true), /refund_write_failed/);
    const [heldBudgetClaim] = await Database.execute(['SELECT status,attempt,leaseUntil FROM clan_actions WHERE id=?', [budgetClaim.id]]);
    assert.equal(heldBudgetClaim.status, 'running', 'failed refund cannot partially release the lease');
    assert.equal(heldBudgetClaim.attempt, budgetClaim.attempt);
    assert.equal(heldBudgetClaim.leaseUntil, budgetClaim.leaseUntil);
    await Database.execute(['DROP TRIGGER fail_clan_refund', []]);
    await release(budgetClaim, at, false, true);
    budgetClaim = (await Database.claimClanAction({ at })).action;
    assert.equal(budgetClaim.id, budgetSupply.actionId,
        'a task claimed after the budget deadline retains the next service turn');
    await finish(budgetClaim);

    await reset();
    await enqueue('goal_plan', at);
    await enqueue('contribution', at);
    const laterSupply = await enqueue('supplies', at);
    const earlierClaim = (await Database.claimClanAction({ at })).action;
    const laterClaim = (await Database.claimClanAction({ at })).action;
    await release(earlierClaim, at, false, true);
    let nextClaim = (await Database.claimClanAction({ at })).action;
    assert.equal(nextClaim.id, laterSupply.actionId, 'an older lease cannot rewind a newer dispatch');
    await finish(nextClaim);
    await finish(laterClaim);

    await reset();
    const otherWork = await enqueue('supplies', at, 100);
    const otherClaim = (await Database.claimClanAction({ at })).action;
    await enqueue('goal_plan', at);
    const latestClaim = (await Database.claimClanAction({ at })).action;
    await release(otherClaim, at, true);
    await release(latestClaim, at, false, true);
    await enqueue('supplies', at, 1000);
    nextClaim = (await Database.claimClanAction({ at })).action;
    assert.equal(nextClaim.id, otherWork.actionId, 'refund preserves a continuation published after its receipt');
    await finish(nextClaim);
    nextClaim = (await Database.claimClanAction({ at })).action;
    assert.equal(nextClaim.id, latestClaim.id, 'the refunded task keeps its place after an earlier type becomes ready');
    await finish(nextClaim);

    await reset();
    const atomicPlan = await enqueue('goal_plan', at);
    const atomicSupply = await enqueue('supplies', at);
    await Database.execute([`CREATE TEMP TRIGGER fail_clan_schedule BEFORE INSERT ON world_meta
        WHEN NEW.key='clanActionScheduler:v1' BEGIN SELECT RAISE(ABORT,'scheduler_write_failed'); END`, []]);
    await assert.rejects(Database.claimClanAction({ at }), /scheduler_write_failed/);
    const unchanged = await Database.execute(['SELECT status,attempt FROM clan_actions ORDER BY id', []]);
    assert(unchanged.every(row => row.status === 'pending' && row.attempt === 0),
        'a scheduler write failure rolls back both the cursor and the lease');
    await Database.execute(['DROP TRIGGER fail_clan_schedule', []]);
    let claimed = await Database.claimClanAction({ at });
    assert.equal(claimed.action.id, atomicPlan.actionId);
    await finish(claimed.action);
    claimed = await Database.claimClanAction({ at });
    assert.equal(claimed.action.id, atomicSupply.actionId);
    await finish(claimed.action);

    await reset();
    const low = await enqueue('supplies', at, 10);
    const high = await enqueue('supplies', at, 40);
    let { action } = await Database.claimClanAction({ at });
    assert.equal(action.id, high.actionId, 'priority still orders ordinary work within a type');
    await finish(action);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, low.actionId);
    await finish(action);

    await reset();
    const pending = await enqueue('supplies', at);
    const normal = [];
    for (let index = 0; index < 4; index++) normal.push(await enqueue('supplies', at));
    await enqueue('goal_plan', at);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.actionType, 'goal_plan');
    await finish(action);
    await enqueue('goal_plan', at);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, pending.actionId);
    assert.equal((await release(action, at + 1000, true)).ok, true);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.actionType, 'goal_plan', 'the next type keeps its own service turn');
    await finish(action);
    await enqueue('goal_plan', at);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, normal[0].actionId, 'a continuation cannot bypass its retry time');
    await finish(action);
    at += 1000;
    // The queue order and continuation survive a real connection restart.
    await Database.close();
    await Database.init();
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.actionType, 'goal_plan', 'restart preserves the next type to be served');
    await finish(action);
    await enqueue('goal_plan', at);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, pending.actionId, 'ready continuation resumes before the remaining ordinary backlog');
    await release(action, at + 1000, true);
    at += 1000;
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.actionType, 'goal_plan');
    await finish(action);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, normal[1].actionId, 'a recurring continuation yields the next turn to ordinary work');
    await finish(action);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, pending.actionId, 'the continuation receives the following turn');
    await release(action, at, false, true);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, pending.actionId, 'a budget refund restores continuation/ordinary alternation too');
    await release(action, at);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, normal[2].actionId, 'a released unstarted continuation still yields ordinary work');
    await finish(action);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, pending.actionId, 'a budget release does not lose an existing continuation marker');
    await finish(action);

    await reset();
    const unstarted = await enqueue('supplies', at);
    action = (await Database.claimClanAction({ at })).action;
    const stale = await Database.releaseClanAction({ actionId: action.id, availableAt: at, continuation: true,
        expectedAttempt: action.attempt + 1, expectedLeaseUntil: action.leaseUntil });
    assert.equal(stale.code, 'ownership_conflict');
    await release(action, at);
    const urgent = await enqueue('supplies', at, 100);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, urgent.actionId, 'a rejected or unstarted release cannot acquire continuation priority');
    await finish(action);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, unstarted.actionId);
    const reclaimed = await Database.claimClanAction({ at: at + 120000 });
    assert.equal(reclaimed.recovered, 1);
    assert.equal(reclaimed.action.id, action.id, 'expired leases still recover the durable action');
    assert.equal((await release(action, at, true)).code, 'ownership_conflict', 'the former owner cannot mark a recovered lease');
    await finish(reclaimed.action);
    await reset();
    const future = await enqueue('member_titles', at + 1000);
    assert.equal((await Database.claimClanAction({ at })).action, null);
    action = (await Database.claimClanAction({ at: at + 1000 })).action;
    assert.equal(action.id, future.actionId, 'a future-only queue admits exactly at its ready time');
    await finish(action);
    assert.equal((await Database.claimClanAction({ at: at + 1000 })).action, null);

    // A player clan's legacy review storm must not starve another clan's
    // funded payment, even when every old action has a higher aged priority.
    await reset();
    for (const clanId of [2, 3]) {
        await Database.execute(['INSERT INTO clans(id,name,leaderId) VALUES(?,?,1)', [clanId, `Fair${clanId}`]]);
        await Database.execute([`INSERT INTO clan_simulation_clans(clanId,createdAt,updatedAt,stateJson)
            VALUES(?,1,1,'{}')`, [clanId]]);
    }
    const clanWork = (clanId, readyAt = at) => Database.enqueueClanAction({ clanId, actionType: 'contribution',
        actionKey: `clan-fairness:${++sequence}`, availableAt: readyAt, priority: clanId === 1 ? 1000 : 1 });
    for (let index = 0; index < 30; index++) await clanWork(1, at - 300 * 60000);
    await clanWork(2); await clanWork(3);
    const clans = [];
    for (let index = 0; index < 3; index++) {
        action = (await Database.claimClanAction({ at })).action;
        clans.push(action.clanId);
        await finish(action);
        await clanWork(action.clanId);
    }
    assert.deepEqual(clans, [1, 2, 3], 'each ready clan receives a turn inside a continuously busy type');
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.clanId, 1, 'the next clan round continues durably');
    await release(action, at, false, true);
    const refundedClan = (await Database.claimClanAction({ at })).action;
    assert.equal(refundedClan.clanId, action.clanId, 'an unused budget turn restores the clan cursor too');
    await finish(refundedClan);

    await reset();
    const continuationWork = await clanWork(1);
    const ordinaryWork = await clanWork(1);
    await clanWork(2);
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, continuationWork.actionId);
    await release(action, at, true);
    for (let turn = 0; turn < 3; turn++) {
        action = (await Database.claimClanAction({ at })).action;
        if (action.clanId === 2) { await finish(action); await clanWork(2); }
        else { assert.equal(action.id, continuationWork.actionId); await release(action, at, true); }
    }
    action = (await Database.claimClanAction({ at })).action;
    assert.equal(action.id, ordinaryWork.actionId,
        'another clan ordinary turn cannot reset this clan continuation/ordinary alternation');
    await finish(action);
    console.log('Clan actions: fair types, native priorities, durable bounded continuations, retry times and lease fencing passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await Database.close(); require('node:fs').rmSync(fixture.directory, { recursive: true, force: true }); });
