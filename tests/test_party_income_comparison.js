'use strict';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Income = invoke('GameServer/Bot/Population/PartyIncomeComparison');
const Goals = invoke('GameServer/Bot/Population/PartyGoalPolicy');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const at = 1791648945955;
const base = { cash: 5000, spendable: 0, solo: { income: 1000 }, party: { income: 200 } };
assert.equal(Income.evaluate(base).accept, false, 'fast group XP cannot compensate for a lower personal margin');
assert.equal(Income.evaluate({ ...base, party: { income: 3000 }, fee: 100, spendable: 100, assemblyHours: .1 }).accept, true);
assert.equal(Income.evaluate({ ...base, solo: null }).reason, 'goal_requires_party');
assert.equal(Income.evaluate({ ...base, party: { income: 0 }, partyItemHours: .1 }).accept, false);
assert.equal(Income.evaluate({ ...base, party: null }).reason, 'income_unknown');
assert.equal(Income.evaluate({ ...base, spendable: 5000,
    solo: { income: 1000, travelHours: .1 } }).accept, false,
    'already funded gear does not require a trip to the alternative earning camp');
assert.equal(Income.evaluate({ ...base, spendable: 5000, solo: null }).accept, false,
    'already funded gear can be bought without an earning hunt');
assert.equal(Income.evaluate({ ...base, fee: 100, party: { income: 3000 } }).reason, 'help_fee_unfunded');
assert.equal(Income.evaluate({ ...base, partyItemHours: .1 }).reason, 'equipment_sooner',
    'receiving the actual gear sooner can beat saving cash despite a smaller cash margin');
assert.equal(Income.evaluate({ ...base, party: { income: 1000 }, rewardFee: 4000, deliveryHours: 2 }).partyHours, 2,
    'a helper payment becomes purchase cash after delivery, never at invitation time');
for (const multiplier of [1, 10, 50]) assert.equal(Income.evaluate({ ...base,
    solo: { income: 1000 * multiplier }, party: { income: 200 * multiplier } }).accept, false);

const original = { value: Table.value, ranked: Table.rankedIncome, hunt: Hunt.huntIncome,
    samples: Hunt.sampledRows, costs: Hunt.consumablePrices, ensure: Profiles.ensure, gate: Routes.isSpotAllowedForState,
    forState: Economy.forState, forGroup: Economy.forGroup, npcs: Data.npcs, rewards: Data.npcRewards };
const BuffPolicy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const originalBuffPrice = BuffPolicy.priceFor;
const spots = [
    { id: 'peer', minLevel: 20, maxLevel: 20, avgLevel: 20, density: 10,
        center: { locX: 0, locY: 0 }, tagsAuthoritative: true, tags: [], npcEntries: [] },
    { id: 'lower', minLevel: 10, maxLevel: 10, avgLevel: 10, density: 10,
        center: { locX: 0, locY: 0 }, tagsAuthoritative: true, tags: [], npcEntries: [] }
];
const row = (adena, shots = 0) => ({ kills: 100, exp: 100, adena, loot: 0, shots, potions: 0, deaths: 0 });
let gates = 0, builds = 0;
const state = { characterId: 990130, level: 20, adena: 0, spotId: 'peer', phase: 'cold', activity: 'hunting',
    loc: { locX: 0, locY: 0 }, inventory: {}, vitals: { hp: 100, mp: 100, maxMp: 100 },
    stats: { classId: 0, role: 'dps', wishFocus: ['power:1:7', 0, 5000], money: [1000, .001, 0, 5000],
        partyRequest: { priority: 'required', spotId: 'peer', reason: 'gear_acquisition' } } };
const peer = { ...state, characterId: 990131 };
try {
    Table.value = (id, role, level, shots) => id === 'lower' ? row(shots ? 650 : 600, shots ? 200 : 0)
        : row(shots ? 1200 : 300, shots ? 900 : 0);
    Table.rankedIncome = (role, level, costs, gap, shots) => spots.map(spot => ({ ...Table.value(spot.id, role, level, shots), spotId: spot.id }));
    Hunt.huntIncome = () => ({ perHour: 1000, expPerHour: 100 });
    Hunt.sampledRows = () => [];
    Hunt.consumablePrices = () => ({ shots: 1, potions: 10 });
    Profiles.ensure = () => spots;
    Routes.isSpotAllowedForState = () => { gates++; return true; };
    Economy.forState = Economy.forGroup = () => { builds++; throw Error('admission built a wish network'); };
    const selected = Route.select(state, { spots, timestamp: at, required: true });
    assert.equal(selected.spot.id, 'lower'); assert.equal(selected.row.useShots, false,
        'lower uncharged net income is compared before committing to the first charged route');
    const prepared = Income.prepare([state, peer], { spots, timestamp: at });
    const decision = Goals.decide(state, [peer], { prepared, roll: 0 });
    assert.equal(decision.accept, false, 'required request and maximum sociability cannot bypass the funding comparison');
    assert.deepEqual(Goals.formingMembers([state, peer], { clanGoalKey: 'clan-kit' }), [state, peer]);
    assert.equal(Income.compare({ ...state, stats: { ...state.stats, clanId: 1 } }, [peer], { prepared }), null);
    const heldObjective = { spotId: 'peer', objectiveKey: 'held' };
    const pending = Goals.joint({ startedAt: at - Income.REVIEW_MS, spotId: 'peer',
        stats: { objective: heldObjective } }, [state, peer], { timestamp: at,
        context: { routePending: true } });
    assert.equal(pending.objective, heldObjective, 'a pending travel quote retains the native objective');
    assert.equal(pending.lastIncomeReviewAt, at, 'a pending travel quote does not block personal income review');
    assert.equal(pending.incomeReviews.length, 2);
    assert.equal(builds, 0);
    const provider = { ...peer, level: 20, adena: 100000, spotId: 'lower',
        stats: { classId: 15, role: 'healer' } };
    provider.stats.coldCombat = Profile.legacySnapshot(provider, Profile.skillRecordsFromTree(15, 20), at);
    BuffPolicy.priceFor = () => 1;
    const buyer = { ...state, adena: 100000, spotId: 'lower' };
    const paid = Income.soloRoute(buyer, spots, at, [provider]);
    assert.equal(paid.source, 'paid_buff', 'a real useful buff at a profitable quoted price is a solo alternative');
    assert(paid.income > Income.soloRoute(buyer, spots, at).income);
    BuffPolicy.priceFor = () => 100000;
    assert.equal(Income.soloRoute(buyer, spots, at, [provider]).source, 'solo_route',
        'an unaffordable buff is not invented as a free solo advantage');
    BuffPolicy.priceFor = originalBuffPrice;

    const durations = [];
    for (let i = 0; i < 200; i++) {
        const start = performance.now();
        Goals.decide(state, [peer], { prepared });
        durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    assert(gates <= 202 * Income.MAX_SOLO_CHECKS + 1, 'exact safety calls remain bounded per admission');
    console.log(`PASS personal admission: no wish builds; warm p95=${durations[190].toFixed(3)}ms, max=${durations[199].toFixed(3)}ms`);

    // Native expected yields, including server rate/deep-blue handling. Only
    // ownership changes between solo, random/turn and funded item escrow.
    Data.npcs = [{ selfId: 990130, template: { level: 20 } }];
    Data.npcRewards = [{ selfId: 990130, rewards: [{ overall: 100,
        items: [{ selfId: 1, chance: 100, min: 1, max: 1 }] }] }];
    const spot = { ...spots[0], npcEntries: [{ selfId: 990130, count: 1 }] };
    const goal = { npcId: 990130, itemId: 1, spotId: 'peer' };
    const alone = Income.itemHours(state, spot, 100, goal, [state]);
    assert(alone > 0);
    assert.equal(Income.itemHours(state, spot, 100, goal, [state, peer]), alone * 2);
    assert.equal(Income.itemHours(state, spot, 100, goal, [state, peer], {
        help: { status: 'proposed', payerId: state.characterId, itemId: 1 } }), alone * 2);
    assert.equal(Income.itemHours(state, spot, 100, goal, [state, peer], {
        help: { status: 'funded', payerId: state.characterId, itemId: 1 } }), alone);
    const itemSpots = [spot, spots[1]];
    const itemState = { ...state, stats: { ...state.stats, partyRequest: goal,
        equipmentPlan: { next: { ...goal, amount: 1 } } } };
    const itemPrepared = Income.prepare([itemState, peer], { spots: itemSpots, timestamp: at });
    assert.equal(Income.soloRoute(itemState, itemSpots, at).spotId, 'lower');
    assert(Income.soloItemRouteHours(itemState, itemSpots, goal, at) > 0);
    const direct = Income.compare(itemState, [peer], { prepared: itemPrepared });
    assert(direct.soloHours < 5000 / 600, 'a safe direct solo drop at a different camp is considered');
    const component = { ...itemState, stats: { ...itemState.stats, wishFocus: ['power:2:7', 0, 5000] } };
    const ingredient = Income.compare(component, [peer], { prepared: itemPrepared });
    assert.equal(ingredient.soloHours, 5000 / ingredient.soloIncome, 'a component is not the final gear completion time');
    assert.equal(ingredient.accept, false);
} finally {
    Table.value = original.value; Table.rankedIncome = original.ranked;
    Hunt.huntIncome = original.hunt; Hunt.sampledRows = original.samples; Hunt.consumablePrices = original.costs;
    Profiles.ensure = original.ensure; Routes.isSpotAllowedForState = original.gate;
    Economy.forState = original.forState; Economy.forGroup = original.forGroup;
    Data.npcs = original.npcs; Data.npcRewards = original.rewards;
    BuffPolicy.priceFor = originalBuffPrice;
}

let sampled = state;
for (let i = 0; i < 3; i++) sampled = { ...sampled, stats: { ...sampled.stats,
    huntEfficiency: Hunt.record(sampled, { spotId: 'lower', timestamp: at, cycleMs: 60000, adena: 100, exp: 10, kills: 1 }) } };
sampled = { ...sampled, activity: 'grouped', party: { partyId: 'group' } };
for (let i = 0; i < 3; i++) sampled = { ...sampled, stats: { ...sampled.stats,
    huntEfficiency: Hunt.record(sampled, { spotId: 'peer', timestamp: at, cycleMs: 60000, adena: 50, exp: 20, kills: 2,
        partyRoster: Income.rosterKey([state, peer]) }) } };
assert.equal(Hunt.sampledRows(sampled, at, 'solo').length, 1, 'joining does not erase the personal solo comparison');
assert.equal(Hunt.sampledRows(sampled, at, 'party').length, 1);
assert.equal(Hunt.buffPurchaseCost({ stats: { huntClock: { at: at - 1 }, lastBuffServicePurchase: { at, price: 100 } } }, at), 100);
assert.equal(Hunt.buffPurchaseCost({ stats: { huntClock: { at }, lastBuffServicePurchase: { at, price: 100 } } }, at), 0);
assert(Match.damageRate([{ pAtk: 100, atkSpd: 300, role: 'dps', skills: [], equipment: {} }])
    < Match.damageRate([{ pAtk: 120, atkSpd: 300, role: 'dps', skills: [], equipment: {} }]),
    'buff evaluation uses the same native attack envelope as survival');
console.log('PASS solo/party clocks, equipment ETA, fees, random loot, consumables, clan exclusion and sample retention');
