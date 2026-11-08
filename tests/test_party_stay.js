const assert = require('assert');

require('../src/Global');

const Situations = require('../src/GameServer/Bot/Situations');
const Stay = require('../src/GameServer/Bot/Population/PartyStay');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');

// party_stay: a party member leaves when it must (C4: dead members are carried,
// karma washes alone, a bought bridge, a party it no longer earns XP in, a full bag,
// a better solo hunt), decided only on its own situations, never on a session clock.
const at = 1800000000000;
const member = (id, extra = {}) => ({ characterId: id, name: `Member${id}`, level: 40, phase: 'cold', activity: 'grouped',
    party: { partyId: 'stay', leaderId: 1, role: 'dps' }, loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 }, timing: { lastResolvedAt: at - 45000, nextResolveAt: at },
    inventory: {}, simulation: { revision: 1 }, ...extra,
    stats: { classId: 0, role: 'dps', backgroundPartyId: 'stay', woken: 0, waiting: 0, ...extra.stats } });
const cleanupNeed = Disposition.inventoryCleanupNeed;
Disposition.inventoryCleanupNeed = () => null;
try {
    // The decision reads the member's facts now.
    assert.deepStrictEqual(Stay.decide(member(1)), { answer: 'stay', reason: 'stay' });
    assert.strictEqual(Stay.decide(member(1, { vitals: { hp: 0 }, stats: { karma: 10 } })).answer, 'stay', 'a dead member is carried');
    assert.deepStrictEqual(Stay.decide(member(1, { stats: { karma: 10 } })), { answer: 'leave', reason: 'karma' });
    assert.strictEqual(Stay.decide(member(1), { bridgeReason: () => 'weapon_bridge' }).reason, 'weapon_bridge');
    assert.strictEqual(Stay.decide(member(1), { outleveled: true }).reason, 'party_outleveled');
    assert.strictEqual(Stay.decide(member(1), { soloBeatsShare: () => true }).reason, 'solo_income');
    Disposition.inventoryCleanupNeed = () => ({ reason: 'npc_only_inventory', slots: 10, limit: 80 });
    assert.deepStrictEqual(Stay.decide(member(1)), { answer: 'trip', reason: 'bag_full' }, 'a bag to sell goes to town');
    assert.strictEqual(Stay.decide(member(1), { clanDuty: true }).answer, 'stay', 'clan duty unloads only a bag at its floor');
    Disposition.inventoryCleanupNeed = () => null;
    // Shots under their line take no trip of their own (a solo bot hunts on without them
    // until its visit): a member out of shots stays, a candidate out of shots joins.
    const dry = member(1, { spotId: 'stay-spot', party: { partyId: null }, inventory: {}, stats: {
        kitRates: [1835, 0.005, 2, 1061, 0, 0, 0.08, 0.5, 13.2], earning: { spotId: 'stay-spot', shotsPerHour: 100, potionsPerHour: 0 } } });
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    assert.strictEqual(Sections.lineAt(Sections.linesOf(Sections.supplyOf(dry)), 'shots'), Sections.LINE_OUT, 'the fixture holds no shots');
    assert.deepStrictEqual(Stay.decide(dry), { answer: 'stay', reason: 'stay' });
    assert(Stay.joins(dry), 'forming takes a candidate out of shots');

    // A member's own situations wake its stay only while it is in a party.
    assert(!Situations.woken({}, 'party_stay') && Situations.woken({}, 'gear_plan'),
        'a row with no bits yet holds every decision woken once, but no stay (no solo step decides it)');
    const solo = Situations.raise({ woken: 0, waiting: 0 }, 'bag_full');
    assert(!Situations.woken(solo, 'party_stay'), 'a solo bot holds no stay');
    const grouped = Situations.raise({ woken: 0, waiting: 0, backgroundPartyId: member(1).stats.backgroundPartyId }, 'bag_full');
    assert(Situations.woken(grouped, 'party_stay'), 'bag_full wakes a member\'s stay');
    const low = Situations.raise({ woken: 0, waiting: 0, backgroundPartyId: member(1).stats.backgroundPartyId }, 'stock_low:shots');
    assert(!Situations.woken(low, 'party_stay'), 'shots under their line wake no stay');
    // Its leave answers the stay: a solo bot carries no stay bit to a stop.
    const left = Lifecycle.releaseMember(member(2, { stats: { woken: Situations.BITS.party_stay,
        waiting: Situations.BITS.party_stay << 8 } }), at, 'party_min_size');
    assert(!Situations.woken(left.stats, 'party_stay') && !(left.stats.waiting & Situations.planes(Situations.BITS.party_stay)));
    assert(Situations.woken(left.stats, 'earning_spot'), 'party_left wakes its earning spot');
    const outleveled = Lifecycle.releaseMember(member(2, { stats: { partyOutleveled: 1 } }), at, 'party_outleveled');
    assert(!outleveled.stats.partyOutleveled, 'a solo bot holds no XP share exclusion: its next party raises its own flip');
    // A row that kept the bit past a leave by another path (a player's takeover) is solo: no stay.
    assert(!Situations.woken({ woken: Situations.BITS.party_stay, waiting: 0, backgroundPartyId: null }, 'party_stay')
        && !Situations.anyWoken({ woken: Situations.BITS.party_stay, waiting: 0, earning: {}, wishSections: {} }),
    'a stay bit on a solo row wakes nothing');
} finally { Disposition.inventoryCleanupNeed = cleanupNeed; }

// One party step: { leader's party row, member states, batch }.
async function step(members, extra = {}) {
    const messages = [], party = { partyId: 'stay', leaderId: 1, memberIds: members.map(m => m.characterId), status: 'active',
        spotId: 'stay-spot', revision: 1, nextResolveAt: at, stats: {}, ...extra };
    const kernel = new ColdSimulationKernel({ now: () => at, partyMinSize: 2,
        resolveSolo: () => { throw Error('no solo round'); },
        resolveParty: ({ members: roster }) => ({ memberResults: roster.map(state => ({ state, result: {} })), events: [],
            nextResolveAt: at + 45000, partyPatch: {} }),
        projectResolve: state => ({ state }),
        emit: (type, payload) => messages.push({ type, payload }) });
    for (const state of members) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: at, partyId: party.partyId });
    }
    kernel.partyRuns.set(party.partyId, { party, members, spot: { id: 'stay-spot' }, startedAt: at });
    await kernel.resolvePartyStep(party.partyId);
    const proposals = messages.find(m => m.type === 'proposal_batch').payload.proposals;
    const resolution = proposals.find(p => p.partyResolution).partyResolution;
    return { party: resolution.party, stayTrips: resolution.stayTrips, states: proposals.map(p => p.nextState) };
}

(async () => {
    const karma = { karma: 10 };
    // Karma with no situation heard: no clock decides it.
    const quiet = await step([member(1), member(2), member(3, { stats: karma })]);
    assert.deepStrictEqual(quiet.party.memberIds, [1, 2, 3], 'a stay not woken is held');
    // karma_changed heard: the member leaves, the party goes on.
    const woken = Situations.raise({ ...member(3).stats, ...karma }, 'karma_changed');
    const leave = await step([member(1), member(2), member(3, { stats: woken })]);
    assert.deepStrictEqual(leave.party.memberIds, [1, 2]);
    const leaver = leave.states.find(state => state.characterId === 3);
    assert.strictEqual(leaver.party.partyId, null);
    assert.strictEqual(leaver.stats.partyBreakReason, 'karma');
    assert(!Situations.woken(leaver.stats, 'party_stay'), 'the decision is taken');
    // Under the minimum the party ends.
    const last = await step([member(1), member(3, { stats: woken })]);
    assert.strictEqual(last.party.status, 'dissolved');
    assert(last.states.every(state => !state.party.partyId));
    // The party's XP share comes to exclude a member far below it: party_outleveled, it leaves.
    const low = await step([member(1, { level: 60 }), member(2, { level: 60 }), member(3, { level: 20 })]);
    assert.deepStrictEqual(low.party.memberIds, [1, 2]);
    assert.strictEqual(low.states.find(state => state.characterId === 3).stats.partyBreakReason, 'party_outleveled');
    // A member that stays keeps its decision taken and its flag.
    const stays = await step([member(1), member(2, { stats: Situations.raise({ ...member(2).stats }, 'grade_changed', null, Situations.OPEN) })]);
    assert.deepStrictEqual(stays.party.memberIds, [1, 2]);
    assert(!Situations.woken(stays.states.find(state => state.characterId === 2).stats, 'party_stay'));
    // A clan duty member's bag trip rides the leader's commit whichever exit the step
    // takes, here a party still on its road: main starts it (stayTrips).
    Disposition.inventoryCleanupNeed = state => state.characterId === 2 ? { reason: 'inventory_capacity', slots: 81, limit: 80 } : null;
    try {
        const duty = { objective: { priority: 'required', clanGoalKey: 'clan:1' },
            travel: { reason: 'party_spot_replan', spotId: 'stay-spot', startedAt: at - 1000, arrivalAt: at + 60000 } };
        const full = Situations.raise({ ...member(2).stats }, 'bag_full', null, Situations.OPEN);
        const road = await step([member(1), member(2, { stats: full })], { stats: duty });
        assert.deepStrictEqual(road.stayTrips, [{ characterId: 2, reason: 'bag_full' }], 'the duty trip rides the travel wait');
        assert.deepStrictEqual(road.party.memberIds, [1, 2]);
    } finally { Disposition.inventoryCleanupNeed = () => null; }
    console.log('party stay: ok');
})().catch((err) => { console.error(err); process.exit(1); });
