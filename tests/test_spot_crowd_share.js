'use strict';
// Crowded spots (user 10-29, T106 audit): a bot choosing a spot shares the
// production of the spawns it may fight with the bots already there, as the
// fight does (BackgroundResolver.soloShareMobs): kills at most production
// over the hunters with it, the hour's fields following the kills.
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Occupancy = require('../src/GameServer/Bot/Population/SpotOccupancyIndex');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const offline = require('../data/Bots/spot-reward-npcs.json');

const state = HuntCycle.referenceState(1, 30, { gear: invoke('GameServer/Bot/AI/BotGear'), profile: invoke('GameServer/Bot/Population/ColdCombatProfile') });
const role = Table.roleFor(state);
const spotId = Table.rankedSpotIds(role, 30, { shots: 0, potions: 0 })[0];
const [, entries, adenaMin, adenaMax] = offline.rows.find(row => row[0] === spotId);
// 6 mobs per hour per spawn: a small spot one bot could empty.
const spot = { id: spotId, npcEntries: entries.map(([selfId, count]) => ({ selfId, count, production: count * 6 })), rewards: { adenaMin, adenaMax } };
Table.useSpots([spot]);
// The thread's hunters count (SpotOccupancyIndex.huntersOn): n others plus the bot.
const hunters = n => ({ spotHunters: () => n + 1 });
const near = (actual, expected, message) => assert(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)),
    `${message}: ${actual} != ${expected}`);
try {
    const alone = Economics.create(state, hunters(0))(spot, true);
    const production = Table.production(spotId, role, 30, true);
    assert(alone && production > 0, 'the spot has its row and its production');
    assert(alone.kills <= production + 1e-9, 'one hunter: at most the production');
    const crowd = Economics.create(state, hunters(3))(spot, true);
    const expected = Math.min(alone.kills, production / 4);
    assert(Math.abs(crowd.kills - expected) < 1e-6 * expected, `four hunters share it: ${crowd.kills} vs ${expected}`);
    assert(Math.abs(crowd.exp / crowd.kills - alone.exp / alone.kills) < 1e-6 * alone.exp / alone.kills, 'exp follows the kills');
    assert(crowd.valueHours < alone.valueHours, 'a crowded spot is worth less');
    assert(crowd.crowdFactor < 1, 'the crowd cuts the row');
    // A bot whose own hunts gave twice the table's exp (calibration 2) still
    // keeps at most its share of the production: the crowd is cut once, after
    // the calibration.
    const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
    const Rewards = require('../src/GameServer/Bot/Economy/SpotRewardExpectation');
    const sampled = Table.rankedSpotIds(role, 30, { shots: 0, potions: 0 }).find(id => id !== spotId);
    const sampleBase = Table.value(sampled, role, 30, true, { spoilSkillLevel: Rewards.spoilSkillLevel(state) });
    const now = Date.now();
    const keen = { ...state, stats: { ...state.stats, huntEfficiency: [{ spotId: sampled, signature: Hunt.signature(state),
        samples: 3, at: now, exp: 2 * sampleBase.exp, cycleMs: 3600000, kills: sampleBase.kills, adena: 0, loot: 0, costs: 0 }] } };
    const keenAlone = Economics.create(keen, { timestamp: now, ...hunters(0) })(spot, true);
    near(keenAlone.kills, Math.min(2 * alone.kills, production), 'alone: the calibrated kills');
    const keenCrowd = Economics.create(keen, { timestamp: now, ...hunters(3) })(spot, true);
    near(keenCrowd.kills, Math.min(2 * alone.kills, production / 4), 'four hunters: at most a quarter of the production');
    // A party search: each routed member takes its own share; a member
    // indexed on the spot is among the hunters already.
    const member = (characterId, spotId) => ({ characterId, activity: 'hunting', spotId, level: 30 });
    const party = Economics.create(state, { ...hunters(0), members: [state, member(91, 'elsewhere'), member(92, 'elsewhere')] })(spot, true);
    near(party.kills, Math.min(alone.kills, production / 3), 'a party of three away: three hunters');
    assert(party.kills < alone.kills, 'the party\'s own members crowd the spot');
    const arrived = Economics.create(state, { ...hunters(1), members: [state, member(91, spotId), member(92, 'elsewhere')] })(spot, true);
    near(arrived.kills, Math.min(alone.kills, production / 3), 'one member there already: still three');
    // The route search passes its party (capacityStates) to the same count.
    const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const routed = capacityStates => Routes.scoreSpot(spot, state, { timestamp: Date.now(), capacityStates }).efficiencyAdjustment;
    assert(routed([state, member(91, 'elsewhere'), member(92, 'elsewhere')]) < routed(undefined),
        'a party\'s route search values the spot at its members\' share');
    // One count of hunters (huntersOn): the bot counted once, whether it
    // stands on the spot or weighs a move there; the fight's count without a
    // state is the bots there, at least one.
    const index = new Occupancy.SpotOccupancyIndex();
    const on = (characterId, spotId) => ({ characterId, activity: 'hunting', spotId });
    index.update(on(1, spotId)); index.update(on(2, spotId)); index.update(on(3, 'elsewhere'));
    assert.equal(Occupancy.huntersOn(index, spotId, on(1, spotId)), 2, 'a bot on the spot: itself and the other');
    assert.equal(Occupancy.huntersOn(index, spotId, on(3, 'elsewhere')), 3, 'a bot weighing a move: the two there and itself');
    assert.equal(Occupancy.huntersOn(index, spotId), 2, 'the fight: the bots there');
    assert.equal(Occupancy.huntersOn(index, 'empty'), 1, 'an empty spot: one hunter');
    // The crowd revision (spotVersion): a held reader of the spot's hunters
    // re-reads when a bot joins or leaves it, not when a bot stays.
    const version = index.spotVersion(spotId), elsewhere = index.spotVersion('elsewhere');
    assert(version > 0 && index.spotVersion('empty') === 0, 'a spot with bots has a revision, an untouched one 0');
    index.update({ ...on(1, spotId), vitals: { hp: 10 } });
    assert.equal(index.spotVersion(spotId), version, 'a bot that stays on the spot moves no revision');
    index.update(on(3, spotId));
    const joined = index.spotVersion(spotId);
    assert(joined !== version && index.spotVersion('elsewhere') !== elsewhere, 'a move changes both spots\' revisions');
    index.update({ characterId: 2, activity: 'shopping', spotId });
    assert.notEqual(index.spotVersion(spotId), joined, 'a bot that leaves for town moves it');
    const left = index.spotVersion(spotId);
    index.remove(Occupancy.stateKey(on(3, spotId)));
    assert.notEqual(index.spotVersion(spotId), left, 'a bot removed from the index moves it');
    const removed = index.spotVersion(spotId);
    index.update(on(3, spotId));
    assert(index.spotVersion(spotId) > removed, 'a revision never comes back to an earlier count\'s');
    index.update(on(3, 'elsewhere'));
    index.update(on(2, spotId));
    // A caller that passes no count (EquipmentIncomeRoute, PartyIncomeComparison)
    // reads the thread's occupancy: a cold worker's kernel index once registered.
    index.update(on(4, spotId)); index.update(on(5, spotId));
    SpotProfiles.useOccupancy(() => index);
    assert.equal(SpotProfiles.spotVersion(spotId), index.spotVersion(spotId), 'the thread reader reads the registered index');
    const fromThread = Economics.create(state)(spot, true);
    assert(Math.abs(fromThread.kills - Math.min(alone.kills, production / 5)) < 1e-6 * alone.kills,
        `the thread's four others share it with a caller that passes no count: ${fromThread.kills}`);

    // The earning spot search reads its candidates' hunters when it decides (situations step 1: the crowd wakes
    // nothing, it is read). The bot stands on the band's best table spot, whose spawns its hunters share; its next
    // best it knows by its own samples. With bots joining its spot one by one a search there takes it to the other
    // spot once the share left is worth less.
    {
        const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
        const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
        const now = Date.now();
        Table.useSpots([]);
        const held = Route.spotList(state).ids(true, 30, -15)[0];
        const [, rows, min, max] = offline.rows.find(row => row[0] === held);
        Table.useSpots([{ id: held, npcEntries: rows.map(([selfId, count]) => ({ selfId, count, production: count * 60 })),
            rewards: { adenaMin: min, adenaMax: max } }]);
        const other = Route.spotList(state).ids(true, 30, -15).find(id => id !== held);
        const catalog = [held, other].map((id, at) => ({ id, avgLevel: 30, minLevel: 30, maxLevel: 30, density: 60,
            tagsAuthoritative: true, tags: [], npcEntries: [], center: { locX: -80000 + at * 500, locY: 150000, locZ: 0 } }));
        const crowd = new Occupancy.SpotOccupancyIndex();
        SpotProfiles.useOccupancy(() => crowd);
        let bot = { ...state, characterId: 990777, spotId: held, loc: catalog[0].center, stats: { ...state.stats, huntEfficiency: [] } };
        const own = Economics.create(bot, { timestamp: now })(catalog[0], true);
        assert(own.crowd?.value, 'fixture: the held spot\'s row follows its hunters\' share');
        for (let n = 0; n < 3; n++) bot = { ...bot, stats: { ...bot.stats, huntEfficiency: Hunt.record(bot, { spotId: other, timestamp: now,
            cycleMs: 3600000, exp: 0.6 * own.exp, adena: 0.6 * own.income, loot: 0, costs: 0, kills: 0.6 * own.kills }) } };
        const options = { spots: catalog, timestamp: now, required: true };
        assert.equal(Route.search(bot, options).route?.spot.id, held, 'fixture: alone the bot keeps its spot');
        let next = 992000, crowdedOff = 0;
        for (let n = 1; n <= 200 && !crowdedOff; n++) {
            crowd.update({ characterId: next++, activity: 'hunting', spotId: held });
            if (Route.search(bot, options).route?.spot.id === other) crowdedOff = n;
        }
        assert(crowdedOff > 1, 'the crowd at its spot takes a deciding bot to the other spot, not the first joiner');
    }
} finally {
    SpotProfiles.useOccupancy(null);
    Table.useSpots([]);
}
console.log('PASS spot crowd share');
