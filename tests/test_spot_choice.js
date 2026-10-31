'use strict';
// A solo bot's spot choice (EquipmentIncomeRoute.select, T156): it weighs what
// a spot gives in exp and in money by its own money price, in an hour that does
// not depend on the spot it stands on, keeps its best income as its hour, prices
// a far spot by the trip it makes (not a run across the world), and takes its
// next best when other bots fill the best one.
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const { SpotOccupancyIndex } = invoke('GameServer/Bot/Population/SpotOccupancyIndex');
const started = 1791335800000;

// Gludin's fields, a level 10 fighter: own samples decide the spots.
const at = (id, locX, locY = 150000) => ({ id, avgLevel: 10, minLevel: 10, maxLevel: 10, density: 10,
    tagsAuthoritative: true, tags: ['starter'], npcEntries: [], center: { locX, locY, locZ: 0 } });
function hunter(characterId, spots, samples, money) {
    const inventory = {};
    for (const entry of Gear.planFor({ classId: 0, level: 10 }).items) {
        const old = inventory[entry.selfId];
        const equippedSlots = [...(old?.equippedSlots || []), entry.slot];
        inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
            equipped: true, equippedCount: equippedSlots.length, equippedSlots };
    }
    let state = { characterId, level: 10, adena: 1000, phase: 'cold', activity: 'hunting', currentRegion: 'Gludin',
        spotId: spots[0].id, loc: spots[0].center, timing: {}, vitals: { hp: 500, maxHp: 500, mp: 300, maxMp: 300 },
        persona: { traits: { caution: 0.5 }, understanding: 1 },
        stats: { classId: 0, huntEfficiency: [], ...(money ? { money } : {}) }, inventory };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(0, 10), started);
    // Samples of an hour: exp and income as shares of the role's best hour.
    const role = Table.roleFor(state), bestIncome = Table.best(role, 10, true, 'income');
    const hourExp = Table.best(role, 10, true, 'exp').exp, hourAdena = bestIncome.adena + bestIncome.loot;
    for (let n = 0; n < 3; n++) for (const [spotId, exp, adena] of samples) {
        state = { ...state, stats: { ...state.stats, huntEfficiency: Hunt.record(state, { spotId, timestamp: started,
            cycleMs: 3600000, adena: adena * hourAdena, costs: 0, loot: 0, exp: exp * hourExp, kills: 100 }) } };
    }
    return state;
}
const search = (state, spots) => Route.select(state, { spots, timestamp: started, required: true });
const chosen = (state, spots) => search(state, spots)?.spot.id;

// The same two spots, a spot rich in exp and one rich in money: a bot at the
// price of its hour takes the exp, a bot short of money the money. Its hour
// stays what it could earn.
{
    const spots = [at('levels', -80000), at('earns', -79000)];
    const samples = [['levels', 1, 0.3], ['earns', 0.3, 0.8]];
    const hour = 10000;
    const atFloor = hunter(990301, spots, samples, [hour, 1 / hour, 0, 0]);
    const found = search(atFloor, spots);
    assert.equal(found.spot.id, 'levels', 'money at its hour: the exp pays');
    assert(found.earning > found.row.income * 2, 'the hour is the earner\'s, not the pick\'s');
    assert.equal(chosen(hunter(990302, spots, samples, [hour, 20 / hour, 0, 900000]), spots), 'earns', 'dear money: the money pays');
}

// The answer does not depend on which of the two the bot stands on, or on the
// hour that spot gave it: two spots must not each look better from the other.
{
    const spots = [at('levels', -80000), at('earns', -79000)];
    const samples = [['levels', 1, 0.3], ['earns', 0.3, 0.8]];
    for (const [standing, hour] of [[0, 3000], [1, 8000]]) {
        const state = { ...hunter(990305, spots, samples, [hour, 1 / hour, 0, 0]), spotId: spots[standing].id, loc: spots[standing].center };
        assert.equal(chosen(state, spots), 'levels', `from ${spots[standing].id}`);
    }
}

// A far spot a gatekeeper reaches is priced by that trip, not by a run across
// the world: it beats a poorer spot next door. On foot it would not.
{
    const honest = Config.coldHonestTravel;
    Config.coldHonestTravel = true;
    try {
        // Near Dion, 90000 from Gludin; a Gludin neighbour pays 3/4 of it.
        const spots = [at('home', -80000), at('next', -79000), at('far', 15664, 142979)];
        const samples = [['home', 0.5, 0.15], ['next', 0.75, 0.225], ['far', 1, 0.3]];
        const state = hunter(990303, spots, samples, [36000, 1 / 36000, 0, 0]);
        assert.equal(chosen(state, spots), 'far', 'the trip by gatekeeper is short');
        const onFoot = { ...state, stats: { ...state.stats, karma: 100 } };
        assert.equal(chosen(onFoot, spots), 'next', 'a bot with karma walks there');
    } finally { Config.coldHonestTravel = honest; }
}

// The best spot is full of other bots: the next best, and no refused trip.
{
    const spots = [at('home', -80000), at('next', -79000), at('best', -78000)];
    const samples = [['home', 0.5, 0.15], ['next', 0.75, 0.225], ['best', 1, 0.3]];
    const state = hunter(990304, spots, samples, [36000, 1 / 36000, 0, 0]);
    assert.equal(chosen(state, spots), 'best', 'an empty world: the best spot');
    const index = new SpotOccupancyIndex();
    for (let n = 0; n < 9; n++) index.update({ characterId: 990400 + n, spotId: 'best', activity: 'hunting' });
    Spots.useOccupancy(() => index);
    try {
        assert.equal(chosen(state, spots), 'next', 'nine bots fill it');
        assert.equal(chosen({ ...state, spotId: 'best', loc: spots[2].center }, spots), 'best', 'a bot on it keeps its own place');
    } finally { Spots.useOccupancy(null); }
}

console.log('PASS spot choice: exp and money by the own price, one answer from any spot, the hour, the real trip, the room');
