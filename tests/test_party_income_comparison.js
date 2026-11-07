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
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
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

const original = { value: Table.value, ranked: Table.rankedIncome, rankedIds: Table.rankedSpotIds, hunt: Hunt.huntIncome,
    samples: Hunt.sampledRows, costs: Hunt.consumablePrices, ensure: Profiles.ensure, gate: Routes.isSpotAllowedForState, reader: Routes.spotAllowedReaderFor,
    forState: Economy.forState, forGroup: Economy.forGroup, npcs: Data.npcs, rewards: Data.npcRewards,
    rewardValue: Rewards.value };
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
    // These admission fixtures provide synthetic table money, with no native
    // NPC reward catalog. Native money expectations have a separate regression.
    Rewards.value = () => null;
    Table.value = (id, role, level, shots) => id === 'lower' ? row(shots ? 650 : 600, shots ? 200 : 0)
        : row(shots ? 1200 : 300, shots ? 900 : 0);
    Table.rankedIncome = (role, level, costs, gap, shots) => spots.map(spot => ({ ...Table.value(spot.id, role, level, shots), spotId: spot.id }));
    Table.rankedSpotIds = () => spots.map(spot => spot.id);
    Hunt.huntIncome = () => ({ perHour: 1000, expPerHour: 100 });
    Hunt.sampledRows = () => [];
    Hunt.consumablePrices = () => ({ shots: 1, potions: 10 });
    Profiles.ensure = () => spots;
    Routes.isSpotAllowedForState = () => { gates++; return true; };
    Routes.spotAllowedReaderFor = () => () => { gates++; return true; };
    Economy.forState = Economy.forGroup = () => { builds++; throw Error('admission built a wish network'); };
    const selected = Route.select(state, { spots, timestamp: at, required: true });
    assert.equal(selected.spot.id, 'lower'); assert.equal(selected.row.useShots, false,
        'lower uncharged net income is compared before committing to the first charged route');
    const prepared = Income.prepare([state, peer], { spots, timestamp: at });
    const decision = Goals.decide(state, [peer], { prepared, roll: 0 });
    assert.equal(decision.accept, false, 'required request and maximum sociability cannot bypass the funding comparison');
    assert.deepEqual(Goals.formingMembers([state, peer], { clanGoalKey: 'clan-kit' }), [state, peer]);
    // Ordinary farming compares personal returns regardless of clan custody.
    // A concrete clan assignment keeps its separate participation policy.
    for (const clanLevel of [0, 1, 5]) {
        const member = { ...state, clanLevel, stats: { ...state.stats, clanId: 1 } };
        const memberPeer = { ...peer, clanLevel, stats: { ...peer.stats, clanId: 1 } };
        assert.equal(Income.compare(member, [memberPeer], { prepared })?.accept, false);
        assert.equal(Goals.decide(member, [memberPeer], { prepared, roll: 0 }).accept, false,
            'membership and a required request cannot bypass ordinary farm profitability');
        assert.deepEqual(Goals.formingMembers([member, memberPeer], { spotId: 'peer' }), [],
            'ordinary clan-member parties must also beat the safe solo earning route');
        assert.equal(Income.compare(member, [memberPeer], { prepared, objective: { clanGoalKey: 'clan-kit' } }), null);
        assert.deepEqual(Goals.formingMembers([member, memberPeer], { clanGoalKey: 'clan-kit' }), [member, memberPeer]);
        const review = Goals.joint({ startedAt: at - Income.REVIEW_MS, spotId: 'peer', stats: {} },
            [member, memberPeer], { timestamp: at, spots });
        assert.equal(review.incomeReviews?.length, 2,
            'ordinary party income review also runs for members of a clan with a warehouse');
    }
    // The review runs when its inputs move (PartyGoalPolicy.incomeReviewKey), never on the clock.
    const reviewed = Goals.joint({ startedAt: at, spotId: 'peer', memberIds: [state.characterId, peer.characterId], stats: {} },
        [state, peer], { timestamp: at, spots });
    assert(Number.isSafeInteger(reviewed.incomeReviewKey) && reviewed.incomeReviews.length === 2,
        'a party with no reviewed inputs reviews at once, without waiting for the clock');
    const held = { startedAt: at, spotId: 'peer', stats: { lastIncomeReviewAt: at, incomeReviewKey: reviewed.incomeReviewKey,
        incomeReviews: reviewed.incomeReviews } };
    const later = Goals.joint(held, [state, peer], { timestamp: at + 24 * 3600000, spots });
    assert.equal(later.incomeReviews, undefined, 'unchanged inputs are not reviewed again, however long');
    assert.equal(later.lastIncomeReviewAt, undefined);
    const moved = { level: { ...peer, level: 21 }, kit: { ...peer, stats: { ...peer.stats, wishSections: { build: 7 } } },
        observed: { ...peer, stats: { ...peer.stats, wishSections: { sample: 's1:AAAA' } } },
        solo: { ...peer, stats: { ...peer.stats, money: [1500, .001, 0, 5000] } },
        goal: { ...peer, stats: { ...peer.stats, wishFocus: ['power:2:7', 0, 9000] } } };
    for (const [input, changed] of Object.entries(moved)) {
        const review = Goals.joint(held, [state, changed], { timestamp: at + 1, spots });
        assert.equal(review.incomeReviews?.length, 2, `a moved ${input} reviews at once`);
        assert.notEqual(review.incomeReviewKey, reviewed.incomeReviewKey);
    }
    assert.equal(Goals.joint({ ...held, spotId: 'lower' }, [state, peer], { timestamp: at + 1, spots }).incomeReviews?.length, 2,
        'a party moved to another ground (the spot its forecast reads) reviews at once');
    const third = { ...peer, characterId: 990132 };
    assert.equal(Goals.joint(held, [state, peer, third], { timestamp: at + 1, spots }).incomeReviews?.length, 3,
        'a roster change reviews at once');
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

    // A forming verdict is judged once per inputs: the roster asked again on the
    // same members gets the same answer with no comparison; a moved input, or
    // the same members in another order, is judged again.
    {
        const nativePrepare = Income.prepare;
        let judged = 0;
        Income.prepare = (...args) => { judged++; return nativePrepare(...args); };
        try {
            const requested = state.stats.partyRequest;
            const ask = (members, time = at) => Goals.formingVerdict(members, requested, { spots, timestamp: time });
            const fresh = members => Goals.formingMembers(members, requested, { spots, timestamp: at })
                .map(member => member.characterId);
            const rich = { ...state, characterId: 990140, adena: 100000 }, other = { ...peer, characterId: 990141, adena: 100000 };
            const first = ask([rich, other]);
            assert.deepEqual(first.formingAccepted, fresh([rich, other]));
            const once = judged;
            for (const minute of [1, 2, 4]) assert.deepEqual(ask([rich, other], at + minute * 60000), first);
            assert.deepEqual(ask([{ ...rich }, { ...other }], at + 60000), first, 'a fresh copy of each member');
            assert.deepEqual(ask([{ ...rich, adena: 101000 }, other], at + 60000), first,
                'a wallet move inside the bot\'s income error is no change');
            assert.deepEqual(ask([{ ...rich, vitals: { ...rich.vitals, hp: 60, mp: 40 } }, other], at + 60000), first,
                'HP and MP that change no matchup and no buff sale are no change');
            assert.deepEqual(ask([{ ...rich, stats: { ...rich.stats, partyRequest: { ...requested, requestedAt: at, attempts: 2 },
                equipmentPlan: { status: 'active', strategy: 'buy' } } }, other], at + 60000), first,
                'request and plan fields no comparison reads are no change');
            assert.equal(judged, once, 'the same members are not judged again');
            for (const moved of [{ ...rich, level: 21 }, { ...rich, spotId: 'lower' }, { ...rich, adena: 200000 },
                { ...rich, loc: { locX: 5000, locY: 0 } }, { ...rich, vitals: { ...rich.vitals, hp: 0 } },
                { ...rich, stats: { ...rich.stats, wishFocus: ['power:1:7', 0, 9000] } },
                { ...rich, stats: { ...rich.stats, partyRequest: { ...requested, spotId: 'lower' } } }]) {
                const before = judged;
                assert.deepEqual(ask([moved, other]).formingAccepted, fresh([moved, other]));
                assert(judged > before, 'a moved input is judged again');
            }
            const before = judged;
            ask([other, rich]);
            assert(judged > before, 'another order is another roster');
            // A fighter asked out of shots is judged again once it holds them:
            // the fight profiles read the charges it loads, not the planned shot.
            const gear = {};
            for (const entry of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 0, level: 20 }).items) {
                gear[entry.selfId] = { ...entry, amount: 1, equipped: true, equippedCount: 1, equippedSlots: [entry.slot] };
            }
            const armed = { ...rich, inventory: gear };
            const shot = invoke('GameServer/Inventory/ShotStock').combatPlanForState(armed).selfId;
            const stocked = { ...armed, inventory: { ...gear, [shot]: { selfId: shot, amount: 5000 } } };
            assert.notDeepEqual(Sections.shotInputs(stocked, at), Sections.shotInputs(armed, at), 'fixture: the stock loads a shot');
            ask([armed, other]);
            const dry = judged;
            ask([armed, other]);
            assert.equal(judged, dry, 'the same dry fighter is held');
            assert.deepEqual(ask([stocked, other]).formingAccepted, fresh([stocked, other]));
            assert(judged > dry, 'restocked shots are judged again');
            // The second pass prepares a sub-roster, whose own party samples it
            // reads: a member's samples of any roster at the spot move the key.
            const third = { ...peer, characterId: 990142, adena: 100000 };
            const samples = Hunt.sampledRows;
            Hunt.sampledRows = member => member.stats.fixtureRows || [];
            try {
                ask([rich, other, third]);
                const sampledOnce = judged;
                const withRows = { ...rich, stats: { ...rich.stats, fixtureRows: [{ spotId: 'peer', at, samples: 3,
                    partyRoster: Income.rosterKey([rich, other]), exp: 1, cycleMs: 60000, adena: 1, loot: 0, kills: 1 }] } };
                ask([withRows, other, third]);
                assert(judged > sampledOnce, 'samples of a sub-roster are judged again');
            } finally { Hunt.sampledRows = samples; }
        } finally { Income.prepare = nativePrepare; }
        console.log('PASS forming verdict held per its inputs, judged again on a moved input');
    }

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
    const nativeNpcs = Data.npcs, nativeRewards = Data.npcRewards;
    try {
        Data.npcs = [{ ...nativeNpcs[0], selfId: '990130' },
            { selfId: 990130, template: { level: 80 } }];
        Data.npcRewards = [{ ...nativeRewards[0], selfId: '990130' }, { selfId: 990130, rewards: [] }];
        const weighted = { ...spot, npcEntries: [{ selfId: '990130', count: .25 },
            { selfId: 990130, count: .75 }, { selfId: 42, count: 3 },
            { selfId: 990130, count: -9 }, { selfId: 990130, count: 'bad' }] };
        assert.equal(Income.itemHours(state, weighted, 100, goal, [state]), alone * 4,
            'party acquisition keeps first numeric reward/NPC and fractional duplicate weights');
        weighted.npcEntries.push({ selfId: 990130, count: 4 });
        assert.equal(Income.itemHours(state, weighted, 100, goal, [state]), alone * 8 / 5,
            'growing a static composition refreshes the same positive-weight rule');
    } finally { Data.npcs = nativeNpcs; Data.npcRewards = nativeRewards; }
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
    Table.value = original.value; Table.rankedIncome = original.ranked; Table.rankedSpotIds = original.rankedIds;
    Hunt.huntIncome = original.hunt; Hunt.sampledRows = original.samples; Hunt.consumablePrices = original.costs;
    Profiles.ensure = original.ensure; Routes.isSpotAllowedForState = original.gate; Routes.spotAllowedReaderFor = original.reader;
    Economy.forState = original.forState; Economy.forGroup = original.forGroup;
    Data.npcs = original.npcs; Data.npcRewards = original.rewards;
    Rewards.value = original.rewardValue;
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
console.log('PASS solo/party clocks, equipment ETA, fees, random loot, consumables, clan assignment boundary and sample retention');
