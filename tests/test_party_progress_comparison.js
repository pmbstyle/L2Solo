'use strict';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Income = invoke('GameServer/Bot/Population/PartyProgressComparison');
const Goals = invoke('GameServer/Bot/Population/PartyGoalPolicy');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const at = 1791648945955;
// Hours to the next level decide (remaining exp over exp per hour); income only for a saver.
const level = { remaining: 1000, solo: { exp: 100, income: 1000 }, party: { exp: 150, income: 200 } };
assert.equal(Income.evaluate(level).accept, true, 'a party that levels sooner wins although it earns less');
assert.equal(Income.evaluate(level).reason, 'party_sooner');
assert.equal(Income.evaluate({ ...level, party: { exp: 80, income: 5000 } }).reason, 'solo_sooner',
    'a party that earns more but levels slower does not, for a bot saving for nothing');
assert.equal(Income.evaluate({ ...level, party: { exp: 80, income: 200 }, solo: { exp: 100, riskHours: 1, income: 1000 } }).accept, true,
    'deaths add time: the exp a death takes and the way back');
assert.equal(Income.evaluate({ ...level, party: { exp: 120 }, lean: 1.4 }).accept, false, 'a loner needs a party clearly sooner');
assert.equal(Income.evaluate({ ...level, party: { exp: 80 }, lean: .7 }).accept, true, 'a social bot takes a somewhat slower party');
assert.equal(Income.evaluate({ ...level, cash: 50000, spendable: 0 }).reason, 'solo_sooner',
    'a bot saving for its piece adds the hours its income funds it in: the party\'s low income outweighs its exp');
assert.equal(Income.evaluate({ ...level, solo: null }).reason, 'goal_requires_party');
assert.equal(Income.evaluate({ ...level, party: null }).reason, 'progress_unknown');
assert.equal(Income.evaluate({ ...level, fee: 100 }).reason, 'help_fee_unfunded');
assert.equal(Income.evaluate({ ...level, remaining: 0 }).accept, false, 'no level ahead and nothing to save for: the solo hunt earns more');
// At the level cap a bot weighs what it still gains: the party that earns more wins, the time its deaths take counted.
const capped = { remaining: 0, solo: { exp: 0, income: 1000 }, party: { exp: 0, income: 1500 } };
assert.equal(Income.evaluate(capped).reason, 'party_sooner', 'a capped bot parties where it earns more');
assert.equal(Income.evaluate({ ...capped, party: { exp: 0, income: 1500, riskHours: .6 } }).accept, false,
    'a capped bot\'s party earning more but dying more is not sooner');
assert.equal(Income.evaluate({ ...capped, solo: { exp: 0, income: 2000 } }).accept, false, 'nor one that earns less');
assert.equal(Income.levelHours({ exp: 100, riskHours: .25 }, 1000), 12.5);
const base = { cash: 5000, spendable: 0, solo: { exp: 100, income: 1000 }, party: { exp: 100, income: 200 }, remaining: 1000 };
assert.equal(Income.evaluate(base).accept, false, 'a saver at equal exp: the lower personal margin funds the piece later');
assert.equal(Income.evaluate({ ...base, party: { exp: 100, income: 3000 }, fee: 100, spendable: 100, assemblyHours: .1 }).accept, true);
assert.equal(Income.evaluate({ ...base, solo: null }).reason, 'goal_requires_party');
assert.equal(Income.evaluate({ ...base, party: { exp: 100, income: 0 }, partyItemHours: .1 }).accept, true,
    'the piece dropping in the party at once counts though the party earns nothing');
assert.equal(Income.evaluate({ ...base, fee: 100, party: { exp: 100, income: 3000 } }).reason, 'help_fee_unfunded');
assert.equal(Income.evaluate({ ...base, partyItemHours: .1 }).reason, 'party_sooner',
    'receiving the actual gear sooner can beat saving cash despite a smaller cash margin');
assert.equal(Income.evaluate({ ...base, party: { exp: 100, income: 1000 }, rewardFee: 4000, deliveryHours: 2 }).partyHours, 12,
    'a helper payment becomes purchase cash after delivery, never at invitation time');
for (const multiplier of [1, 10, 50]) assert.equal(Income.evaluate({ ...base,
    solo: { exp: 100, income: 1000 * multiplier }, party: { exp: 100, income: 200 * multiplier } }).accept, false);

const original = { value: Table.value, cycle: Table.cycle, ranked: Table.rankedIncome, rankedIds: Table.rankedSpotIds, hunt: Hunt.huntIncome,
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
    stats: { classId: 0, role: 'dps', wishFocus: ['power:1:7', 0, 5000], wishSections: { affordAt: { at: 5000, kind: 'focus' } }, money: [1000, .001, 0, 5000],
        partyRequest: { priority: 'required', spotId: 'peer', reason: 'gear_acquisition' } } };
const peer = { ...state, characterId: 990131 };
try {
    // These admission fixtures provide synthetic table money, with no native
    // NPC reward catalog. Native money expectations have a separate regression.
    Rewards.value = () => null;
    Table.value = (id, role, level, shots) => id === 'lower' ? row(shots ? 650 : 600, shots ? 200 : 0)
        : row(shots ? 1200 : 300, shots ? 900 : 0);
    // A kill: 24 s of fight, 12 s of walk, no rest (the rows' 100 kills an hour).
    Table.cycle = () => ({ kph: 100, fight: 24, rest: 0, cap: 1000 });
    Table.rankedIncome = (role, level, costs, gap, shots) => spots.map(spot => ({ ...Table.value(spot.id, role, level, shots), spotId: spot.id }));
    Table.rankedSpotIds = () => spots.map(spot => spot.id);
    Hunt.huntIncome = () => ({ perHour: 1000, expPerHour: 100 });
    Hunt.sampledRows = () => [];
    Hunt.consumablePrices = () => ({ shots: 1, potions: 10 });
    Profiles.ensure = () => spots;
    Routes.isSpotAllowedForState = () => { gates++; return true; };
    Routes.spotAllowedReaderFor = () => () => { gates++; return true; };
    Economy.forState = Economy.forGroup = () => { builds++; throw Error('admission built a wish network'); };
    const selected = Route.search(state, { spots, timestamp: at, required: true }).route;
    assert.equal(selected.spot.id, 'lower'); assert.equal(selected.row.useShots, false,
        'lower uncharged net income is compared before committing to the first charged route');
    // The solo side reads the bot's held earning answer: what its own search found (the stats are shared with peer).
    state.stats.earning = Route.answerOf(selected, at);
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
        const review = Goals.joint({ startedAt: at - 5 * 60000, spotId: 'peer', stats: {} },
            [member, memberPeer], { timestamp: at, spots });
        assert.equal(review.progressReviews?.length, 2,
            'ordinary party income review also runs for members of a clan with a warehouse');
    }
    // The review runs when its inputs move (PartyGoalPolicy.progressReviewKey), never on the clock.
    const reviewed = Goals.joint({ startedAt: at, spotId: 'peer', memberIds: [state.characterId, peer.characterId], stats: {} },
        [state, peer], { timestamp: at, spots });
    assert(Number.isSafeInteger(reviewed.progressReviewKey) && reviewed.progressReviews.length === 2,
        'a party with no reviewed inputs reviews at once, without waiting for the clock');
    const held = { startedAt: at, spotId: 'peer', stats: { lastProgressReviewAt: at, progressReviewKey: reviewed.progressReviewKey,
        progressReviews: reviewed.progressReviews } };
    const later = Goals.joint(held, [state, peer], { timestamp: at + 24 * 3600000, spots });
    assert.equal(later.progressReviews, undefined, 'unchanged inputs are not reviewed again, however long');
    assert.equal(later.lastProgressReviewAt, undefined);
    const moved = { level: { ...peer, level: 21 }, kit: { ...peer, stats: { ...peer.stats, wishSections: { build: 7 } } },
        observed: { ...peer, stats: { ...peer.stats, wishSections: { sample: 's1:AAAA' } } },
        solo: { ...peer, stats: { ...peer.stats, money: [1500, .001, 0, 5000] } },
        goal: { ...peer, stats: { ...peer.stats, wishFocus: ['power:2:7', 0, 9000] } },
        saving: { ...peer, stats: { ...peer.stats, wishSections: { affordAt: { at: 9000, kind: 'focus' } } } } };
    for (const [input, changed] of Object.entries(moved)) {
        const review = Goals.joint(held, [state, changed], { timestamp: at + 1, spots });
        assert.equal(review.progressReviews?.length, 2, `a moved ${input} reviews at once`);
        assert.notEqual(review.progressReviewKey, reviewed.progressReviewKey);
    }
    assert.equal(Goals.joint({ ...held, spotId: 'lower' }, [state, peer], { timestamp: at + 1, spots }).progressReviews?.length, 2,
        'a party moved to another ground (the spot its forecast reads) reviews at once');
    const third = { ...peer, characterId: 990132 };
    assert.equal(Goals.joint(held, [state, peer, third], { timestamp: at + 1, spots }).progressReviews?.length, 3,
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
    assert.equal(gates, 1, 'an admission asks no safety gate: the solo side reads the held answer (the one is the fixture\'s search)');
    // A candidate holding no earning answer has no solo side: forming skips it this round (its spot decides first).
    const unanswered = { ...peer, characterId: 990133, stats: { ...peer.stats } };
    delete unanswered.stats.earning;
    assert(invoke('GameServer/Bot/AI/PersonalGearProgression').adventurer(unanswered), 'fixture: an economic candidate');
    const judged = [];
    Goals.formingMembers([state, unanswered], { spotId: 'peer' }, { onReview: member => judged.push(member.characterId) });
    assert.deepEqual(judged, [state.characterId], 'a candidate with no held earning answer skips the round, unjudged');
    // A candidate whose own stay would leave at once (karma: its wash is a solo hunt)
    // is not taken: forming builds no party to dissolve.
    const washing = { ...peer, characterId: 990134, stats: { ...peer.stats, karma: 120 } };
    const washReviews = [];
    Goals.formingMembers([state, washing], { spotId: 'peer' }, { onReview: member => washReviews.push(member.characterId) });
    assert(!washReviews.includes(washing.characterId), 'a member that would leave at once is not judged into a roster');
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
    // At its level's end (no exp left to the next level): the piece's hours alone.
    const itemState = { ...state, exp: Data.experience[20], stats: { ...state.stats, partyRequest: goal,
        equipmentPlan: { next: { ...goal, amount: 1 } } } };
    const itemPrepared = Income.prepare([itemState, peer], { spots: itemSpots, timestamp: at });
    assert.equal(Income.soloRoute(itemState, itemSpots, at).spotId, 'lower');
    assert(Income.soloItemRouteHours(itemState, itemSpots, goal, at) > 0);
    const direct = Income.compare(itemState, [peer], { prepared: itemPrepared });
    assert(direct.soloHours < 5000 / 600, 'a safe direct solo drop at a different camp is considered');
    const component = { ...itemState, stats: { ...itemState.stats, wishFocus: ['power:2:7', 0, 5000], wishSections: { affordAt: { at: 5000, kind: 'focus' } } } };
    const ingredient = Income.compare(component, [peer], { prepared: itemPrepared });
    assert.equal(ingredient.soloHours, 5000 / ingredient.soloIncome, 'a component is not the final gear completion time');
    assert.equal(ingredient.accept, false);
} finally {
    Table.value = original.value; Table.cycle = original.cycle; Table.rankedIncome = original.ranked; Table.rankedSpotIds = original.rankedIds;
    Hunt.huntIncome = original.hunt; Hunt.sampledRows = original.samples; Hunt.consumablePrices = original.costs;
    Profiles.ensure = original.ensure; Routes.isSpotAllowedForState = original.gate; Routes.spotAllowedReaderFor = original.reader;
    Economy.forState = original.forState; Economy.forGroup = original.forGroup;
    Data.npcs = original.npcs; Data.npcRewards = original.rewards;
    Rewards.value = original.rewardValue;
    BuffPolicy.priceFor = originalBuffPrice;
}

// A party's hour (prepare): its kills by the cold party round's terms (one walk a kill,
// the fight at the members' damage together, the rest it sits together); each kill's
// exp at the party's top level times the C4 party bonus, split by squared level (L2J
// Lisvus L2Party); a healer removes the others' rest and deaths.
{
    const saved = { value: Table.value, cycle: Table.cycle, samples: Hunt.sampledRows, costs: Hunt.consumablePrices,
        rewards: Rewards.value, ensure: Profiles.ensure, hunt: Hunt.huntIncome };
    try {
        Rewards.value = () => null; Hunt.sampledRows = () => []; Hunt.consumablePrices = () => ({ shots: 1, potions: 10 });
        Profiles.ensure = () => spots;
        const fighter = { characterId: 990140, level: 20, spotId: 'peer', activity: 'hunting', loc: { locX: 0, locY: 0 },
            inventory: {}, vitals: { hp: 100, mp: 100, maxMp: 100 }, stats: { classId: 0 } };
        const other = { ...fighter, characterId: 990141 }, cleric = { ...fighter, characterId: 990142, stats: { classId: 15 } };
        Table.value = () => ({ kills: 100, exp: 1000, adena: 100, loot: 0, shots: 0, potions: 0, deaths: 1 });
        // A kill alone: 36 s, 12 of fight, 12 of rest, 12 of walk; the cleric's rest (its own mana) 4 s.
        const healerRole = Table.roleFor(cleric);
        Table.cycle = (spotId, role) => ({ kph: 100, fight: 12, rest: role === healerRole ? 4 : 12, cap: 1000 });
        const objective = { spotId: 'peer' };
        const alone = Income.prepare([fighter], { spots, timestamp: at, objective }).rows.get(990140);
        assert.equal(alone.kills, 100, 'a party of one kills as its own row');
        const pair = Income.prepare([fighter, other], { spots, timestamp: at, objective }).rows.get(990140);
        // Two fighters: 12 s of walk, 6 of fight, 6 of rest a kill: 150 kills, 10 exp a kill x 1.3 (two members), half each.
        assert.equal(pair.kills, 150, 'two damage dealers kill faster than one, by their damage together');
        assert.equal(pair.exp, 975);
        assert(Math.abs(pair.deaths - .75) < 1e-9, 'its deaths per kill over its share of the party\'s kills');
        const healed = Income.prepare([fighter, cleric], { spots, timestamp: at, objective }).rows.get(990140);
        // The fighter rests none; the party sits for the cleric's 4 s scaled to the 6 s fight: 2 s. 20 s a kill: 180 kills.
        assert.equal(healed.kills, 180, 'a healer\'s party rests less');
        assert(healed.exp > pair.exp, 'a healer\'s party levels its fighter sooner');
        assert.equal(healed.deaths, 0, 'a healed fighter does not die of what it takes');
        const lower = Income.prepare([fighter, { ...other, level: 10 }], { spots, timestamp: at, objective }).rows;
        assert(lower.get(990140).exp > 4 * lower.get(990141).exp, 'the exp splits by squared level');
        // Its own party's deaths there, once it has fought: a healed fighter that dies is not counted deathless.
        const party = { partyId: 'p1', memberIds: [990140, 990142], stats: { partySpotRisk: { partyId: 'p1', rosterKey: '990140,990142',
            spotRisk: { spotId: 'peer', windowFights: 10, windowDeaths: 2 } } } };
        const lived = Income.prepare([fighter, cleric], { spots, timestamp: at, objective, party }).rows.get(990140);
        assert(Math.abs(lived.deaths - 18) < 1e-9, 'its share of the deaths its party had a fight, at the party\'s kills');
        // The party shares the spot's spawns as a solo hunter does: its kills are cut to its share.
        Table.value = () => ({ kills: 100, exp: 1000, adena: 100, loot: 0, shots: 0, potions: 0, deaths: 1, production: 60 });
        assert.equal(Income.prepare([fighter, other], { spots, timestamp: at, objective }).rows.get(990140).kills, 120,
            'a party kills no more than the spawns give back to its share of the spot');
        // One reader values both sides: a party of one on its earning spot takes as long as its solo hunt,
        // its deaths at its time on the spot on both sides.
        Table.value = () => ({ kills: 100, exp: 1000, adena: 100, loot: 0, shots: 0, potions: 0, deaths: 1 });
        Hunt.huntIncome = () => ({ perHour: 1000, expPerHour: 1000 });
        const hunter = { ...fighter, characterId: 990150, stats: { classId: 0, huntClock: { total: 2, onSpot: 1 },
            earning: { spotId: 'peer', at, earning: 1000, shots: true } } };
        const own = Income.compare(hunter, [], { party: { spotId: 'peer' }, objective });
        assert(own.soloHours > 0 && Math.abs(own.partyHours - own.soloHours) < 1e-9 * own.soloHours,
            `a party of one is valued as its solo row (${own.soloHours} vs ${own.partyHours})`);
    } finally {
        Table.value = saved.value; Table.cycle = saved.cycle; Hunt.sampledRows = saved.samples;
        Hunt.consumablePrices = saved.costs; Rewards.value = saved.rewards; Profiles.ensure = saved.ensure; Hunt.huntIncome = saved.hunt;
    }
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
