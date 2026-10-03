const assert = require('assert');

require('../src/Global');

// K3 follow-up: a clan's equipment goal is fulfilled when its beneficiary
// wears the item. When the next review finds no member with an equipment need,
// it selected nothing and the fulfilled goal stood as executing for hours. The
// review now hands the goal back closed, so the clan shows no finished goal as
// work in progress and its key stops counting as active.
const DataCache = invoke('GameServer/DataCache');
const ClanEquipmentService = invoke('GameServer/Clan/ClanEquipmentService');

DataCache.init();

const previousGoal = {
    type: 'equipment', status: 'executing', goalKey: 'clan-equipment:1:2000249:890:4',
    target: { memberId: 2000249, itemId: 890, itemName: 'Ring of Devotion', slot: 4, grade: 'd', strategy: 'market' },
    plan: { kind: 'market', reasonCode: 'clan_equipment_market' }, assignedMemberIds: [2000249]
};
const clan = { id: 6000017, level: 0, members: [], state: { updatedAt: 1791031770796, productionGoal: previousGoal } };
const planning = (previousFulfilled) => ({ plans: new Map(), previousFulfilled, selection: null, spots: [] });

async function run() {
    const closed = await ClanEquipmentService.resolveClan(clan, previousGoal, { planning: planning(true) });
    assert.strictEqual(closed.reason, 'no_equipment_debt', 'fixture: nobody needs anything next');
    assert.strictEqual(closed.goal?.status, 'completed', 'a fulfilled goal is closed when the review selects none');
    assert.strictEqual(closed.goal.goalKey, previousGoal.goalKey, 'the same goal is closed');
    assert.strictEqual(closed.expectedUpdatedAt, clan.state.updatedAt, 'the store checks the clan state it read');

    const waiting = await ClanEquipmentService.resolveClan(clan, previousGoal, { planning: planning(false) });
    assert.strictEqual(waiting.goal, undefined, 'an unfulfilled goal stays as it is');

    const done = { ...previousGoal, status: 'completed' };
    const again = await ClanEquipmentService.resolveClan({ ...clan, state: { ...clan.state, productionGoal: done } }, done,
        { planning: planning(true) });
    assert.strictEqual(again.goal, undefined, 'a closed goal is not written again');
    console.log('Clan fulfilled goal closing checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
