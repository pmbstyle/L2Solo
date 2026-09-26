const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Recovery = require('../src/GameServer/Bot/Population/PartyAssemblyRecovery');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const Requests = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Duty = require('../src/GameServer/Bot/Population/ClanPartyDuty');
const at = Date.now(), minute = 60000;
const spot = { id: '24_20:antharas_lair' };
const objective = { status: 'open', priority: 'required', objectiveKey: 'drop:test', spotId: spot.id, npcId: 621 };
const original = { partyId: 'scattered', leaderId: 1, memberIds: [1, 2], spotId: spot.id,
    status: 'active', startedAt: at - 10 * minute, stats: { objective,
        sessionReview: { nextAt: at + 20 * minute } } };
const members = [1, 2].map(id => ({ characterId: id, name: `Hunter${id}`, phase: 'cold', activity: 'grouped',
    level: 55, party: { partyId: original.partyId, leaderId: 1 }, spotId: spot.id,
    loc: { locX: id === 1 ? 145224 : 48000, locY: 120001, locZ: -4500 },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 }, timing: {}, inventory: {},
    stats: { classId: 1, role: 'dps', equipmentPlan: { status: 'active', strategy: 'direct_drop', requiresParty: true,
        target: { selfId: 91 }, next: { spotId: spot.id, npcId: 621 } } } }));
let party = original;
for (let tick = 0; tick <= 10; tick++) {
    const timestamp = at + tick * 30000;
    const result = Resolver.resolve({ party, members, spot, timestamp, rng: () => { throw Error('remote combat'); } });
    assert.strictEqual(result.debug.reason, 'party_assembling');
    assert(result.memberResults.every(entry => entry.result.materialize.exp === 0));
    party = { ...party, stats: { ...party.stats, ...result.partyPatch.stats } };
    assert.strictEqual(Lifecycle.sessionExpired(party, timestamp), tick === 10,
        'five observed minutes of failed assembly must trigger review before the normal session timer');
}
const timestamp = at + 5 * minute;
const restored = JSON.parse(JSON.stringify(party));
const review = Lifecycle.review(restored, members, timestamp);
assert.strictEqual(review.party.status, 'dissolved');
assert(review.decisions.every(d => d.reason === Recovery.REASON && d.leave));
assert(review.states.every(s => !s.party.partyId && s.activity === 'hunting'));
assert(review.states.every(s => s.timing.nextResolveAt === timestamp + 30000));
for (const state of review.states) {
    assert.deepStrictEqual(state.vitals, members[0].vitals);
    assert.deepStrictEqual(state.inventory, {});
    assert(Recovery.coolingDown(state, timestamp));
    assert.strictEqual(Requests.partyRequestForPlan(state, state.stats.equipmentPlan, timestamp).status, 'deferred');
    assert.strictEqual(Requests.partyObjectiveForState(state), null);
    for (const activity of ['traveling', 'shopping', 'resting', 'hunting']) {
        assert.strictEqual(Requests.partyRequestForPlan({ ...state, activity },
            { levelingRecovery: {} }, timestamp), state.stats.partyRequest,
        'travel and recovery replanning must preserve the cooldown');
    }
    assert.strictEqual(Duty.waiting({ ...state, stats: { ...state.stats,
        clanPartyObjective: { ...objective, clanGoalKey: 'clan-goal' } } }), false);
}
assert.deepStrictEqual(Composition.selectMembers(review.states, { timestamp, minSize: 2 }), []);
assert.deepStrictEqual(Composition.selectRecruits([members[0]], [review.states[1]], { timestamp }), []);
assert.strictEqual(Composition.selectMembers(review.states, { timestamp: timestamp + Recovery.RETRY_MS, minSize: 2 }).length, 2);
assert.strictEqual(Requests.partyRequestForPlan(review.states[0], members[0].stats.equipmentPlan,
    timestamp + Recovery.RETRY_MS).status, 'open');

const gathered = members.map(s => ({ ...s, loc: { ...members[0].loc } }));
const rescued = Lifecycle.review(restored, gathered, timestamp);
assert.strictEqual(rescued.leaving.size, 0, 'a successful gathering just before review must preserve the party');
assert.strictEqual(rescued.party.stats.assemblyWait, null);
const rested = { ...restored, stats: { ...restored.stats, restUntil: timestamp + minute } };
assert.strictEqual(Lifecycle.review(rested, members, timestamp).leaving.size, 0);
assert.strictEqual(Lifecycle.sessionExpired(rested, timestamp), false);
const staleRaidAssembly = {
    ...restored,
    stats: {
        ...restored.stats,
        objective: { ...objective, sourceKind: 'raid', raidBoss: true },
        raidPreparation: { status: 'ready' },
        raidEncounter: { status: 'active' }
    }
};
assert.strictEqual(Lifecycle.sessionExpired(staleRaidAssembly, timestamp), true,
    'an active raid snapshot must not keep an incomplete roster stuck after its assembly timeout');
const gatheredRaidWithoutTank = {
    ...staleRaidAssembly,
    partyId: 'raid-without-tank',
    memberIds: [1, 2, 3, 4, 5, 6, 7]
};
const gatheredRaidMembers = gatheredRaidWithoutTank.memberIds.map((id) => ({
    characterId: id,
    name: `RaidHunter${id}`,
    level: 55,
    phase: 'cold',
    activity: 'grouped',
    party: { partyId: gatheredRaidWithoutTank.partyId, leaderId: 1 },
    spotId: spot.id,
    loc: { ...members[0].loc },
    vitals: { ...members[0].vitals },
    inventory: {},
    stats: { role: id === 1 ? 'healer' : id === 2 ? 'buffer' : 'dps' }
}));
const invalidRaidReview = Lifecycle.review(gatheredRaidWithoutTank, gatheredRaidMembers, timestamp);
assert.strictEqual(invalidRaidReview.party.status, 'dissolved',
    'physical assembly must not rescue a raid roster that still lacks a required combat role');
assert([...invalidRaidReview.leaving.values()].every((reason) => reason === Recovery.REASON));
const away = { ...restored, stats: { ...restored.stats, travel: { arrivalAt: timestamp + minute } } };
assert.strictEqual(Lifecycle.review(away, members, timestamp).leaving.size, 0);
const afterDowntime = Recovery.record(party, timestamp + 24 * 60 * minute);
assert.strictEqual(afterDowntime.waitedMs, party.stats.assemblyWait.waitedMs, 'offline time must not count as failed assembly');
const duplicate = Recovery.record(party, timestamp);
assert.strictEqual(duplicate.waitedMs, party.stats.assemblyWait.waitedMs, 'replayed timestamp adds no wait');

// A real combat attempt clears old assembly evidence, including an unfinished fight.
const syntheticSpot = { id: 'assembled', name: 'test', avgLevel: 20, density: 3, npcSelfIds: [],
    mob: { hp: 1, damage: 1 }, rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
const fight = Resolver.resolve({ party: { ...party, spotId: syntheticSpot.id }, members, spot: syntheticSpot,
    timestamp, elapsedMs: 45000, rng: () => 0.5 });
assert.strictEqual(fight.partyPatch.stats.assemblyWait, null);
assert(fight.debug.wins > 0);
console.log('Party assembly timeout, live-time accounting, release, cooldown and recovery checks passed');
