const assert = require('assert');

require('../src/Global');

const Situations = require('../src/GameServer/Bot/Situations');
const Stay = require('../src/GameServer/Bot/Population/PartyStay');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');

// party_stay: a party member leaves when it must (C4: dead members are carried, a
// bought bridge, a party it no longer earns XP in, a full bag, a better solo hunt),
// decided only on its own situations, never on a session clock. Karma is no leave:
// C4 washes it by any EXP gained, a party share included (L2J Lisvus L2PcInstance.addExpAndSp).
const at = 1800000000000;
const member = (id, extra = {}) => ({ characterId: id, name: `Member${id}`, level: 40, phase: 'cold', activity: 'grouped',
    party: { partyId: 'stay', leaderId: 1, role: 'dps' }, loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: { hp: 500, maxHp: 500, mp: 200, maxMp: 200 }, timing: { lastResolvedAt: at - 45000, nextResolveAt: at },
    inventory: {}, simulation: { revision: 1 }, ...extra,
    stats: { classId: 0, role: 'dps', backgroundPartyId: 'stay', woken: 0, waiting: 0, ...extra.stats } });
const cleanupNeed = Disposition.inventoryCleanupNeed, cleanupCounted = Disposition.cleanupCounted;
Disposition.inventoryCleanupNeed = () => null;
// The bag fact at a cleanup count wherever the fixture's count names a need.
Disposition.cleanupCounted = state => !!Disposition.inventoryCleanupNeed(state);
try {
    // The decision reads the member's facts now.
    assert.deepStrictEqual(Stay.decide(member(1)), { answer: 'stay', reason: 'stay' });
    assert.strictEqual(Stay.decide(member(1, { vitals: { hp: 0 }, stats: { karma: 10 } })).answer, 'stay', 'a dead member is carried');
    assert.deepStrictEqual(Stay.decide(member(1, { stats: { karma: 10 } })), { answer: 'stay', reason: 'stay' }, 'karma is no leave');
    assert(Stay.joins(member(1, { party: { partyId: null }, stats: { karma: 10 } }), { now: at }), 'forming takes a candidate with karma');
    assert.strictEqual(Stay.decide(member(1), { bridgeReason: () => 'weapon_bridge' }).reason, 'weapon_bridge');
    assert(!Stay.joins(member(1, { party: { partyId: null } }), { now: at, bridgeReason: () => 'weapon_bridge' }),
        'forming takes no candidate that would leave at its first stay to buy its funded bridge');
    assert.strictEqual(Stay.decide(member(1), { outleveled: true }).reason, 'party_outleveled');
    assert.strictEqual(Stay.decide(member(1), { soloSooner: () => true }).reason, 'solo_sooner');
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
    assert(Stay.joins(dry, { now: at }), 'forming takes a candidate out of shots');

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
} finally { Disposition.inventoryCleanupNeed = cleanupNeed; Disposition.cleanupCounted = cleanupCounted; }

// One party step: { leader's party row, member states, batch }. round: each member's
// round result (none: an empty one); project: the step's projection (none: as resolved).
// options: the kernel's own (a re-plan's planner), run: the run's (a re-plan due);
// kernel: an earlier step's (its records kept), else a new one.
async function step(members, extra = {}, { round = () => ({}), project = state => ({ state }), options = {}, run = {}, kernel: given = null } = {}) {
    const messages = given?.messages || [], party = { partyId: 'stay', leaderId: 1, memberIds: members.map(m => m.characterId), status: 'active',
        spotId: 'stay-spot', revision: 1, nextResolveAt: at, stats: {}, ...extra };
    messages.length = 0;
    const kernel = given || new ColdSimulationKernel({ now: () => at, partyMinSize: 2, ...options,
        resolveSolo: () => { throw Error('no solo round'); },
        resolveParty: ({ members: roster }) => ({ memberResults: roster.map(state => ({ state, result: round(state) })), events: [],
            nextResolveAt: at + 45000, partyPatch: {} }),
        projectResolve: project,
        emit: (type, payload) => messages.push({ type, payload }) });
    kernel.messages = messages;
    for (const state of members) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: at, partyId: party.partyId });
    }
    kernel.partyRuns.set(party.partyId, { party, members, spot: { id: 'stay-spot' }, startedAt: at, ...run });
    await kernel.resolvePartyStep(party.partyId);
    const proposals = messages.find(m => m.type === 'proposal_batch').payload.proposals;
    const resolution = proposals.find(p => p.partyResolution).partyResolution;
    return { party: resolution.party, stayTrips: resolution.stayTrips, resolution, proposals, states: proposals.map(p => p.nextState), kernel };
}

(async () => {
    // A member with karma stays in its party, its stay woken or not, and its share of
    // the party's EXP washes its karma (the projection every member step takes).
    invoke('GameServer/DataCache').init();
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const exp = Number(invoke('GameServer/DataCache').experience[39]);
    const red = { exp, sp: 0, adena: 0, stats: { classProgressionLevel: 40, classProgressionClassId: 0, karma: 20 } };
    const share = state => ({ patch: {}, events: [], materialize: { exp: state.characterId === 3 ? 2600 : 0, sp: 0, adena: 0, items: [] },
        nextResolveAt: at + 45000, debug: { fights: 1, wins: 1 } });
    const project = (state, result, timestamp) => Life.prepareResolve(state, result,
        { timestamp, persist: false, projectClassProgression: true });
    const heard = Situations.raise(Situations.raise({ ...member(3).stats, ...red.stats }, 'karma_changed'),
        'grade_changed', null, Situations.OPEN);
    const washing = await step([member(1), member(2), member(3, { ...red, stats: heard })], {}, { round: share, project });
    assert.deepStrictEqual(washing.party.memberIds, [1, 2, 3], 'a member with karma stays');
    const washed = washing.states.find(state => state.characterId === 3);
    assert.strictEqual(washed.party.partyId, 'stay');
    assert.strictEqual(washed.stats.karma, 20 - Math.floor(2600 / invoke('GameServer/Karma').XP_DIVIDER),
        'its party EXP share washes its karma');
    assert(!Situations.woken(washed.stats, 'party_stay'), 'the decision is taken');
    // The party's XP share comes to exclude a member far below it: party_outleveled, it leaves.
    const low = await step([member(1, { level: 60 }), member(2, { level: 60 }), member(3, { level: 20 })]);
    assert.deepStrictEqual(low.party.memberIds, [1, 2]);
    assert.strictEqual(low.states.find(state => state.characterId === 3).stats.partyBreakReason, 'party_outleveled');
    // A leave under the minimum ends the party.
    const last = await step([member(1, { level: 60 }), member(3, { level: 20 })]);
    assert.strictEqual(last.party.status, 'dissolved');
    assert(last.states.every(state => !state.party.partyId));
    // A member that stays keeps its decision taken and its flag.
    const stays = await step([member(1), member(2, { stats: Situations.raise({ ...member(2).stats }, 'grade_changed', null, Situations.OPEN) })]);
    assert.deepStrictEqual(stays.party.memberIds, [1, 2]);
    assert(!Situations.woken(stays.states.find(state => state.characterId === 2).stats, 'party_stay'));
    // A clan duty member's bag trip rides the leader's commit whichever exit the step
    // takes, here a party still on its road: main starts it (stayTrips).
    Disposition.inventoryCleanupNeed = state => state.characterId === 2 ? { reason: 'inventory_capacity', slots: 81, limit: 80 } : null;
    Disposition.cleanupCounted = state => state.characterId === 2;
    try {
        const duty = { objective: { priority: 'required', clanGoalKey: 'clan:1' },
            travel: { reason: 'party_spot_replan', spotId: 'stay-spot', startedAt: at - 1000, arrivalAt: at + 60000 } };
        const full = Situations.raise({ ...member(2).stats }, 'bag_full', null, Situations.OPEN);
        const road = await step([member(1), member(2, { stats: full })], { stats: duty });
        assert.deepStrictEqual(road.stayTrips, [{ characterId: 2, reason: 'bag_full' }], 'the duty trip rides the travel wait');
        assert.deepStrictEqual(road.party.memberIds, [1, 2]);
        // A clan duty lets one member go at a time: behind another member's absence the
        // trip is not taken and its stay stays woken; the absence over, the next step sends it.
        // The held trip is one hold: the steps behind the same absence count it once.
        const away = { ...duty, marketAbsences: { 9: { characterId: 9, until: at + 60000 } } };
        const held = () => Situations.counts().raised['party:stay_trip:held'] || 0, before = held();
        const behind = await step([member(1), member(2, { stats: full })], { stats: away });
        assert.deepStrictEqual(behind.stayTrips || [], [], 'no trip while another member is away');
        assert(Situations.woken(behind.states.find(state => state.characterId === 2).stats, 'party_stay'), 'its stay waits woken');
        const still = await step([member(1), member(2, { stats: full })], { stats: away }, { kernel: behind.kernel });
        assert.deepStrictEqual(still.stayTrips || [], []);
        assert.strictEqual(held() - before, 1, 'two steps behind one absence: one held trip');
        const over = await step([member(1), member(2, { stats: full })], { stats: { ...away, marketAbsences: { 9: { until: at - 1 } } } },
            { kernel: behind.kernel });
        assert.deepStrictEqual(over.stayTrips, [{ characterId: 2, reason: 'bag_full' }], 'the absence over, the trip goes');
        // A step where its stay is not woken ends the hold: a trip held behind an absence after
        // it is a new held trip.
        const holds = held(), first = await step([member(1), member(2, { stats: full })], { stats: away });
        await step([member(1), member(2)], { stats: away }, { kernel: first.kernel });
        const again = await step([member(1), member(2, { stats: full })], { stats: away }, { kernel: first.kernel });
        assert.deepStrictEqual(again.stayTrips || [], []);
        assert.strictEqual(held() - holds, 2, 'two holds, each counted');
        Disposition.inventoryCleanupNeed = state => state.characterId >= 2 ? { reason: 'inventory_capacity', slots: 81, limit: 80 } : null;
        Disposition.cleanupCounted = state => state.characterId >= 2;
        const both = await step([member(1), member(2, { stats: full }), member(3, { stats: Situations.raise({ ...member(3).stats }, 'bag_full', null, Situations.OPEN) })],
            { stats: duty });
        assert.deepStrictEqual(both.stayTrips, [{ characterId: 2, reason: 'bag_full' }], 'two full bags: one trip');
        assert(Situations.woken(both.states.find(state => state.characterId === 3).stats, 'party_stay'), 'the other waits woken');
    } finally { Disposition.inventoryCleanupNeed = () => null; Disposition.cleanupCounted = cleanupCounted; }
    // A required party's re-plan (the worker's, at its step): each changed plan rides its
    // member's own commit, the member whose need ended holds that fact and its stay woken
    // there; the party's objective follows the plans of the members who still need it,
    // carried on the leader's row, and its spot answer, taken for the old objective, holds
    // none: the next step decides its spot.
    const drop = (target, spotId) => ({ status: 'active', strategy: 'direct_drop', partyNeed: 'required', requiresParty: true,
        target: { selfId: target }, next: { spotId, npcId: 20100 + target, itemId: target } });
    const solo = { status: 'active', strategy: 'market', partyNeed: 'solo_ok', target: { selfId: 9399 }, next: {} };
    const objective = { status: 'open', priority: 'required', objectiveKey: 'old', spotId: 'stay-spot' };
    const heldFor = { partyId: 'stay', memberIds: [1, 2, 3], spotId: 'stay-spot', stats: { objective } };
    const required = { objective, partySpot: Situations.partySpotAnswer(heldFor, { spotId: 'stay-spot' }, at) };
    assert(!Situations.partyWoken({ ...heldFor, stats: required }), 'fixture: the spot answer holds for the old objective');
    const needing = [member(1, { stats: { equipmentPlan: drop(9301, 'stay-spot') } }), member(2, { stats: { equipmentPlan: drop(9302, 'drop-spot') } }),
        member(3, { stats: { equipmentPlan: drop(9303, 'stay-spot') } })];
    const replans = { 1: drop(9301, 'drop-spot'), 2: drop(9302, 'drop-spot'), 3: solo };
    const replanned = await step(needing, { stats: required }, { run: { requirementRefresh: true },
        options: { planPartyRequirement: ({ state }) => ({ acquisitionPlan: replans[state.characterId] }) } });
    const committed = id => replanned.states.find(state => state.characterId === id).stats;
    assert.deepStrictEqual([1, 2, 3].map(id => committed(id).equipmentPlan), [replans[1], needing[1].stats.equipmentPlan, solo],
        'each member\'s commit carries its plan');
    assert.strictEqual(committed(3).partyNeedEnded, 'stay', 'the member whose need ended holds the fact with its plan');
    assert(Situations.woken(committed(3), 'party_stay'), 'party_need_ended wakes its stay on that commit');
    assert(committed(1).partyNeedEnded == null && !Situations.woken(committed(1), 'party_stay'), 'a member still needing it hears nothing');
    assert.strictEqual(replanned.resolution.requirementRefreshedAt, at, 'the re-plan is complete');
    assert.strictEqual(replanned.party.stats.objective?.spotId, 'drop-spot', 'the objective follows the members still needing it');
    assert.strictEqual(replanned.party.stats.acquisitionGoal?.target?.selfId, 9301);
    assert(Situations.partyWoken(replanned.party), 'a new objective is a new question for the party\'s spot: its next step decides');
    // Its next step: the member whose need ended (as its commit left it) leaves, the party goes on.
    const needEnded = committed(3);
    const done = await step([member(1, { stats: { equipmentPlan: replans[1] } }), member(2, { stats: { equipmentPlan: replans[2] } }),
        member(3, { stats: needEnded })], { stats: replanned.party.stats });
    assert.deepStrictEqual(done.party.memberIds, [1, 2]);
    assert.strictEqual(done.states.find(state => state.characterId === 3).stats.partyBreakReason, 'party_objective_complete');
    // A member whose plan never needed the party (a recruited healer), its stay woken by its
    // own new grade: what it came for is to help, it stays; at a full bag it goes to unload.
    const healer = { equipmentPlan: solo, woken: Situations.BITS.party_stay };
    const helped = await step([member(1, { stats: { equipmentPlan: replans[1] } }), member(2, { stats: { equipmentPlan: replans[2] } }),
        member(3, { stats: healer })], { stats: replanned.party.stats });
    assert.deepStrictEqual(helped.party.memberIds, [1, 2, 3], 'a helper whose need never was stays');
    // A need ended in an earlier party is not this party's.
    const earlier = await step([member(1, { stats: { equipmentPlan: replans[1] } }), member(2, { stats: { equipmentPlan: replans[2] } }),
        member(3, { stats: { ...needEnded, partyNeedEnded: 'older' } })], { stats: replanned.party.stats });
    assert.deepStrictEqual(earlier.party.memberIds, [1, 2, 3]);
    // Too few left needing it to go on: the member stays and helps (the party is not built to dissolve).
    const pair = await step([member(1, { stats: { equipmentPlan: replans[1] } }), member(3, { stats: needEnded })],
        { stats: replanned.party.stats });
    assert.deepStrictEqual(pair.party.memberIds, [1, 3], 'one member still needing it keeps its helper');
    // A member at weight penalty 1 whose last sale visit tried every kind it carries (the
    // sale retry holds): the bag fact at its floor woke the stay, and the stay reads that
    // fact, as a solo bot's build does: it goes to unload, never hunts on as its load grows.
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile'), Floor = invoke('GameServer/Bot/Population/SurvivalFloor');
    const maxLoad = Profile.profileFor(member(4), 0).maxLoad;
    const loaded = member(4, { inventory: { 999001: { selfId: 999001, amount: 1, stackable: true, mass: Math.ceil(maxLoad * 0.55) } },
        stats: { marketSellSeen: { items: [999001], buyers: null } } });
    assert.strictEqual(Floor.bagFloor(loaded)?.weightPenalty, 1, 'the fixture is at weight penalty 1');
    const holds = Disposition.saleRetryHolds;
    Disposition.saleRetryHolds = () => true;
    try {
        assert.strictEqual(Floor.bagFor(loaded), null, 'the fixture\'s sale retry holds');
        assert.deepStrictEqual(Stay.decide(loaded, { now: at }), { answer: 'trip', reason: 'bag_full' },
            'a member at its weight floor goes to unload whatever the sale retry says');
    } finally { Disposition.saleRetryHolds = holds; }
    console.log('party stay: ok');
})().catch((err) => { console.error(err); process.exit(1); });
