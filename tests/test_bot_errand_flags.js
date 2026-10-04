const assert = require('assert');

require('../src/Global');

invoke('GameServer/DataCache').init();

const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const ColdVisit = invoke('GameServer/ClanHall/ColdVisit');
const Mammon = invoke('GameServer/Bot/AI/BotMammonUnseal');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ClanPartyRescue = invoke('GameServer/Bot/Population/ClanPartyRescue');
const CompetitionValidation = invoke('GameServer/Bot/Population/ColdCompetitionValidation');

// Which "busy" flag stops which decision today. One row per stats flag, one
// column per copy that reads such a list. Each cell is true when that flag
// alone blocks the decision for an otherwise free cold solo hunter.
const now = 1_000_000_000;
const objective = { status: 'open', priority: 'required', clanGoalKey: 'equipment:11', clanId: 11 };
const flags = {
    warehouseWorkflow: { step: 1 },
    warehouseErrand: { step: 1 },
    marketStore: { items: [] },
    marketReturn: { spotId: 'home' },
    partyMarketReturn: { partyId: 'p1', until: now + 60000 },
    craftShop: { stationId: 1 },
    craftStationId: 1,
    craftReturn: { spotId: 'home' },
    supplyErrand: { itemId: 57 },
    mammonReturn: { spotId: 'home' },
    clanPartyObjective: objective,
    clanGoal: { clanId: 11, goalKey: 'equipment:11' },
    clanAllianceQuest: { clanId: 11 },
    pvpEncounter: { key: 'e1', sequence: 1 }
};

function hunter(flag) {
    const stats = flag === 'clanGoal'
        ? { equipmentPlan: { clanGoal: flags.clanGoal } }
        : flag ? { [flag]: flags[flag] } : {};
    return {
        characterId: 7001, name: 'Probe', accountName: 'bot_probe', phase: 'cold', activity: 'hunting',
        level: 40, spotId: 'home', currentRegion: 'Gludio', loc: { locX: 1000, locY: 2000, locZ: -3000 },
        vitals: { hp: 500, maxHp: 500, mp: 100, maxMp: 100 }, inventory: {}, stats
    };
}

const sellGoal = {
    type: 'sell_inventory',
    target: { cleanupReason: 'inventory_capacity', itemCount: 81 },
    plan: { kind: 'market_sell', expectedBenefit: 'market_sale_inventory', cleanupReason: 'inventory_capacity' }
};
const competition = (retreat) => (state) => CompetitionValidation.member(state, state.characterId,
    { id: state.characterId, partyId: null }, { spotId: 'home', npcId: 1 }, {
        party: true, retreat, at: now, memory: { snapshot: () => ({ revision: 1 }) },
        participantAllowed: () => true, contestContextAllowed: () => true
    }) !== null;

// Copies that read a busy list. Database.coldSimulationPartition (the SQL
// claim) is pinned by test_cold_claim_flags.js, the hot clan hall duty, the
// competition monitor and the activation filter are inline and not reached
// from here.
const copies = {
    ownerEligibility: (state) => !Owner.eligibility(state).ok,
    kernelLifecycle: (state) => lifecycleKind(state) === 'command',
    coldClanHallVisit: (state) => !ColdVisit.eligible(state),
    mammonTrip: (state) => Mammon.beginTravel({
        ...state, inventory: { 6674: { selfId: 6674, amount: 1 } }
    }, now) === null,
    marketTrip: (state) => GoalExecutor.beginMarketTravel(state, sellGoal, now) === null,
    clanPartyRescue: (state) => !ClanPartyRescue.eligible(state, objective),
    competitionMember: competition(false),
    competitionRetreat: competition(true)
};

const T = true;
const F = false;
const columns = Object.keys(copies);
//                    owner kernel visit mammon market rescue compet retreat
const expected = {
    warehouseWorkflow: [T, T, T, F, F, T, T, T],
    warehouseErrand: [T, T, F, F, F, T, F, F],
    marketStore: [T, T, F, T, F, T, F, F],
    marketReturn: [T, T, T, T, F, F, T, T],
    partyMarketReturn: [F, T, T, T, T, T, F, F],
    craftShop: [T, T, F, F, F, T, F, F],
    craftStationId: [T, T, F, T, F, T, F, F],
    craftReturn: [F, F, T, T, F, F, F, F],
    supplyErrand: [T, T, T, T, F, T, T, T],
    mammonReturn: [T, T, T, F, F, F, F, F],
    clanPartyObjective: [F, F, T, F, F, F, F, F],
    clanGoal: [F, F, T, F, F, F, F, F],
    clanAllianceQuest: [F, F, T, F, F, F, F, F],
    pvpEncounter: [F, F, T, T, F, T, F, T]
};

for (const [name, copy] of Object.entries(copies)) {
    assert.strictEqual(copy(hunter(null)), false, `${name}: a free hunter is not busy`);
}
const actual = Object.fromEntries(Object.keys(flags).map((flag) => [
    flag, columns.map((column) => copies[column](hunter(flag)))
]));
for (const flag of Object.keys(flags)) {
    assert.deepStrictEqual(actual[flag], expected[flag],
        `${flag}: busy per copy ${columns.join(',')}`);
}

console.log('Bot errand flag matrix checks passed');
