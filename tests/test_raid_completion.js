const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const Raid = require('../src/GameServer/Bot/Population/ColdRaidEncounter');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
Data.init();
const at = Date.now();
const objective = { sourceKind: 'raid', raidBossTemplateId: 10484, npcId: 10484 };
const spot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById('raid:10484');
const state = { characterId: 1, name: 'Completion', phase: 'cold', activity: 'grouped', level: 50,
    spotId: spot.id, loc: { ...spot.center }, exp: 10000, sp: 10, adena: 100,
    inventory: {}, party: { partyId: 'raid-test', leaderId: 1 },
    vitals: { hp: 5000, maxHp: 5000, mp: 1000, maxMp: 1000 },
    timing: { nextResolveAt: at }, stats: { classId: 0, clanPartyObjective: objective,
        equipmentPlan: { status: 'active', next: { ...objective, spotId: spot.id } },
        pveEncounter: { mob: { selfId: 10484 }, hp: 1 }, clanGoalKey: 'keep-clan-goal' } };
const zero = result => assert.deepEqual(result.materialize, { exp: 0, sp: 0, adena: 0, items: [] });
const original = structuredClone(state);
for (const reason of ['raid_defeated', 'raid_unavailable', 'raid_failed', 'party_session_rotation', 'party_break']) {
    const released = Lifecycle.releaseMember(state, at, reason, objective);
    assert.equal(released.party.partyId, null);
    assert.equal(released.spotId, null);
    assert.equal(released.activity, 'hunting');
    assert.equal(released.stats.clanPartyObjective, null);
    assert.equal(released.stats.equipmentPlan, null);
    assert.equal(released.stats.pveEncounter, null);
    assert.equal(released.stats.clanGoalKey, 'keep-clan-goal');
    assert.equal(released.exp, state.exp);
    assert.deepEqual(released.inventory, state.inventory);
    assert.deepEqual(released.loc, state.loc, 'release must not teleport the bot');
    assert(released.timing.nextResolveAt > at);
}
assert.deepEqual(state, original, 'release must not mutate the leased base snapshot');
for (const activity of ['dead', 'resting', 'shopping', 'crafting']) {
    assert.equal(Lifecycle.releaseMember({ ...state, activity }, at, 'raid_defeated', objective).activity, activity);
}
const normal = { ...state, spotId: 'field', stats: { equipmentPlan: { next: { sourceKind: 'drop' } },
    clanPartyObjective: { sourceKind: 'drop' } } };
assert.deepEqual(Lifecycle.releaseMember(normal, at, 'party_break').stats.equipmentPlan, normal.stats.equipmentPlan);

const originalNpc = Combat.npcForSpot;
Combat.npcForSpot = () => { throw Error('solo raid must not even select a monster or reach fallback combat'); };
try {
    const solo = { ...state, party: { partyId: null } };
    for (const input of [
        { state: solo, spot, targetNpcId: 671 }, // observed ordinary goal target + stale raid spot
        { state: { ...solo, spotId: null, stats: {} }, spot: { ...spot, raidBoss: false } },
        { state: { ...solo, spotId: 'field', stats: {} }, spot: { id: 'field' }, targetNpcId: 10484 },
        { state: { ...solo, spotId: 'field', stats: { pveEncounter: state.stats.pveEncounter } }, spot: { id: 'field' } },
        { state: solo, spot: { id: 'field' } },
        { state: solo, spot: null }
    ]) {
        const result = Solo.resolveSolo({ ...input, timestamp: at });
        zero(result);
        assert.equal(result.debug.reason, 'solo_raid_forbidden');
        assert.equal(result.debug.fights, 0);
        assert.equal(result.debug.wins, 0);
        assert.equal(result.patch.stats.pveEncounter, null);
    }
    const waiting = Solo.resolveSolo({ state: { ...solo, stats: { clanPartyObjective: {
        ...objective, status: 'open', priority: 'required', clanGoalKey: 'new-raid' } } }, spot, timestamp: at });
    zero(waiting);
    assert.equal(waiting.patch.activity, 'party_wait', 'a fresh clan assignment still assembles normally');
} finally { Combat.npcForSpot = originalNpc; }

async function run() {
    const victory = { version: 1, key: spot.id, bossTemplateId: 10484, raidInstanceId: 'old-spawn',
        status: 'defeated', hp: 0, maxHp: 500000, updatedAt: at, defeatedAt: at, winnerPartyId: 'raid-test' };
    const party = { partyId: 'raid-test', memberIds: [1], stats: { objective, raidEncounter: victory } };
    // No corpse, incomplete roster, dead member, stale cold authority: terminal
    // completion must precede all those recovery/preparation checks.
    const unavailable = { ...spot, raidWorldAvailable: false, raidInstanceId: null,
        raidAuthority: { ...victory, status: 'active', hp: null, updatedAt: at - 1000 } };
    Raid.resetForTests();
    const staged = await Raid.stage({ key: spot.id, id: 'completion', memberIds: [1] }, () => Party.resolve({
        party, members: [{ ...state, activity: 'dead', vitals: { ...state.vitals, hp: 0 } }],
        spot: unavailable, targetNpcId: 10484, timestamp: at + 1 }));
    assert.equal(staged.result.partyPatch.status, 'dissolved');
    assert.equal(staged.result.partyPatch.stats.partyBreakReason, 'raid_defeated');
    assert.equal(staged.snapshot.status, 'defeated');
    assert.equal(staged.snapshot.raidInstanceId, 'old-spawn');
    assert.equal(staged.snapshot.maxHp, 500000);
    staged.result.memberResults.forEach(({ result }) => zero(result));
    Raid.acknowledge('completion', 1, true);
    assert.equal(Raid.begin(party, unavailable, 10484, at + 2).status, 'defeated');
    const replay = Party.resolve({ party, members: [state], spot: unavailable, timestamp: at + 3 });
    replay.memberResults.forEach(({ result }) => zero(result));
    assert.equal(replay.debug.fights, 0);

    const respawned = { ...spot, raidWorldAvailable: true, raidInstanceId: 'new-spawn', raidAuthority: victory };
    const next = await Raid.stage({ key: spot.id, id: 'respawn', memberIds: [1] }, () => Party.resolve({
        party, members: [state], spot: respawned, timestamp: at + 4 }));
    assert.equal(next.result.partyPatch.status, 'dissolved', 'old winning party must not reopen');
    assert.equal(next.snapshot.raidInstanceId, 'new-spawn');
    assert.equal(next.snapshot.status, 'active', 'old victory must not kill the next spawn');
    Raid.abort('respawn');
    const Index = invoke('GameServer/World/RaidEntityIndex');
    const originalBoss = Index.bossByTemplateId;
    try {
        Index.bossByTemplateId = () => ({ raidInstanceId: 'new-spawn',
            setHp() { throw Error('old victory must not damage a respawn'); } });
        for (const raidInstanceId of ['old-spawn', null]) {
            const settled = await require('../src/GameServer/Bot/Population/ColdRaidWorldBridge').settle({
                ...party, stats: { ...party.stats, raidEncounter: { ...victory, raidInstanceId } } });
            assert.equal(settled.ok, false);
            assert.equal(settled.reason, 'raid_instance_changed');
        }
    } finally { Index.bossByTemplateId = originalBoss; }
    Raid.resetForTests();
    const unknown = Raid.begin({ stats: {} }, { ...spot, raidWorldAvailable: false }, 10484, at);
    assert.equal(unknown.status, 'unavailable', 'missing boss alone is not an active encounter or a victory');
    console.log('Raid completion: no solo rewards, clean detachment, terminal hot victory and respawn isolation passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => Raid.resetForTests());
