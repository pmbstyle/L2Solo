'use strict';
const assert = require('node:assert/strict');

require('../src/Global');

// K40: when a clan moves its equipment goal to a new beneficiary, the old
// beneficiary's party and clan marks are released. That release ran before
// the new beneficiary was assigned; when the assignment failed (here: the
// warehouse could not hand over the materials) the goal was not saved, so
// the clan kept the old goal with its party gone and nobody working on the
// new one. The release now follows a successful assignment; parties whose
// members the new roster needs are still reformed first.
invoke('GameServer/DataCache').init();
const Equipment = invoke('GameServer/Clan/ClanEquipmentService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Database = invoke('Database');

const restore = [];
function replace(object, key, value) {
    const original = object[key];
    restore.push(() => { object[key] = original; });
    object[key] = value;
}

const oldGoal = { goalKey: 'old', type: 'equipment', target: { memberId: 1, itemId: 80 }, status: 'executing', assignedMemberIds: [1] };

async function rotate({ handoffOk, oldPartyMembers }) {
    const states = new Map([
        [1, { characterId: 1, simulationRevision: 1, stats: { clanId: 7,
            equipmentPlan: { status: 'active', target: { selfId: 80 }, clanGoal: { goalKey: 'old', clanId: 7 } },
            partyRequest: { clanGoalKey: 'old' }, clanPartyObjective: { clanGoalKey: 'old', clanId: 7 } } }],
        [2, { characterId: 2, simulationRevision: 1, stats: { clanId: 7 }, inventory: {} }]
    ]);
    const party = { partyId: 'farm', status: 'active', memberIds: oldPartyMembers,
        stats: { objective: { sourceKind: 'drop', clanGoalKey: 'old', clanId: 7 } } };
    const events = [];
    replace(Parties, 'active', () => party.status === 'dissolved' ? [] : [party]);
    // The service reads the active-party indexes; here they filter the stubbed active().
    replace(Parties, 'activeByGoalKey', key => Parties.active()
        .filter(row => String(row.stats?.objective?.clanGoalKey || '') === String(key || '')));
    replace(Parties, 'activeByObjectiveClan', clanId => Parties.active()
        .filter(row => Number(row.stats?.objective?.clanId) === Number(clanId)));
    replace(Parties, 'activeByIds', ids => Parties.active().filter(row => ids.includes(row.partyId)));
    replace(Parties, 'setStatus', async (_, status) => { party.status = status; events.push('dissolve'); return true; });
    replace(LifeState, 'init', async () => {});
    replace(LifeState, 'findByCharacterId', async id => states.get(id));
    replace(LifeState, 'releaseDissolvedPartyMembers', async () => 0);
    replace(LifeState, 'upsertState', async (state, reason) => { states.set(state.characterId, state); events.push(reason); return state; });
    replace(LifeState, 'applyClanMaterialTransfer', async () => ({ ok: false, code: 'warehouse_short' }));
    const plan = { strategy: 'craft', status: 'ready_to_craft', target: { selfId: 81, slot: 128 }, craftProviders: {},
        materials: [{ selfId: 1865, amount: 1 }],
        warehouseMaterials: handoffOk ? [] : [{ selfId: 1865, amount: 1 }] };
    const member = { characterId: 2, name: 'Next', level: 40, phase: 'cold' };
    const clan = { id: 7, level: 3, members: [member], state: { updatedAt: 1, goal: oldGoal } };
    replace(Database, 'execute', async () => [{ stateJson: JSON.stringify(clan.state) }]);
    try {
        const result = await Equipment.resolveClan(clan, oldGoal, {
            planning: { selection: { member, plan }, previousFulfilled: false, plans: new Map(), spots: [] } });
        return { result, party, states, events, clan };
    } finally { while (restore.length) restore.pop()(); }
}

async function run() {
    const failed = await rotate({ handoffOk: false, oldPartyMembers: [1, 3] });
    assert.equal(failed.result.ok, false);
    assert.equal(failed.result.code, 'warehouse_handoff_deferred');
    assert.equal(failed.clan.state.goal, oldGoal, 'fixture: the old goal stays the clan goal');
    assert.equal(failed.party.status, 'active', 'the old goal keeps its party while it stays the clan goal');
    assert.equal(failed.states.get(1).stats.equipmentPlan.clanGoal?.goalKey, 'old', 'the old beneficiary keeps its clan mark');
    assert.equal(failed.states.get(1).stats.partyRequest?.clanGoalKey, 'old');
    assert.equal(failed.states.get(2).stats.equipmentPlan, undefined, 'the new beneficiary was not assigned');

    // A party whose members the new roster needs is reformed before the
    // assignment, as before, whether or not the assignment succeeds.
    const overlap = await rotate({ handoffOk: false, oldPartyMembers: [1, 2] });
    assert.equal(overlap.party.status, 'dissolved', 'the roster conflict release still runs first');
    assert.equal(overlap.states.get(1).stats.equipmentPlan.clanGoal?.goalKey, 'old');

    const moved = await rotate({ handoffOk: true, oldPartyMembers: [1, 3] });
    assert.equal(moved.result.ok, true, JSON.stringify(moved.result.code));
    assert.equal(moved.states.get(2).stats.equipmentPlan?.clanGoal?.goalKey, moved.result.goal.goalKey, 'the new beneficiary is assigned');
    assert.equal(moved.party.status, 'dissolved', 'the old party is released once the new goal is assigned');
    assert.equal(moved.states.get(1).stats.equipmentPlan.clanGoal, undefined, 'the old clan mark is released');
    assert.equal(moved.states.get(1).stats.partyRequest, undefined);
    assert.ok(moved.states.get(1).stats.equipmentPlan, 'the old beneficiary keeps its personal plan');
    assert.deepEqual(moved.events.slice(0, 2), ['clan_equipment_goal', 'dissolve'], 'assignment first, rotation after');
    assert.equal(moved.result.rotation?.changed, true);
    console.log('Clan beneficiary rotation order checks passed');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
