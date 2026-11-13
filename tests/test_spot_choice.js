'use strict';
// A solo bot's spot choice (EquipmentIncomeRoute.search, T156): it weighs what
// a spot gives in exp and in money by its own money price, in an hour that does
// not depend on the spot it stands on, keeps its best income as its hour, prices
// a far spot by the trip it makes (not a run across the world), does not read the
// crowd, takes its next best when it has heard in town that the best is held against it, and
// hunts easier ground when no camp of its level takes it.
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
const search = (state, spots) => Route.search(state, { spots, timestamp: started, required: true }).route;
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
// the world: it beats a poorer spot next door. (A bot with karma, which walks,
// takes the karma wash's spot instead: test_held_earning_spot.)
{
    // Near Dion, 90000 from Gludin; a Gludin neighbour pays 3/4 of it.
    const spots = [at('home', -80000), at('next', -79000), at('far', 15664, 142979)];
    const samples = [['home', 0.5, 0.15], ['next', 0.75, 0.225], ['far', 1, 0.3]];
    const state = hunter(990303, spots, samples, [36000, 1 / 36000, 0, 0]);
    assert.equal(chosen(state, spots), 'far', 'the trip by gatekeeper is short');
}

// The best spot is full of other bots: still the best (a C4 player sees the crowd on arrival,
// where a crowded spot turns it away: SpotContest).
{
    const spots = [at('home', -80000), at('next', -79000), at('best', -78000)];
    const samples = [['home', 0.5, 0.15], ['next', 0.75, 0.225], ['best', 1, 0.3]];
    const state = hunter(990304, spots, samples, [36000, 1 / 36000, 0, 0]);
    assert.equal(chosen(state, spots), 'best', 'an empty world: the best spot');
    const index = new SpotOccupancyIndex();
    for (let n = 0; n < 9; n++) index.update({ characterId: 990400 + n, spotId: 'best', activity: 'hunting' });
    Spots.useOccupancy(() => index);
    try {
        assert.equal(chosen(state, spots), 'best', 'nine bots on it: the choice does not read them');
    } finally { Spots.useOccupancy(null); }
}

// A camp held (SpotRecords: five arrivals over its room) is known to a bot by hearsay at its
// town arrival: before it hears, it still goes there (to meet the holder at its arrival); once
// heard, a bot that looks weaker than the holder, or even and more cautious than assertive,
// takes its next best, an assertive even bot still goes; an arrival that finds it at 0.7 of
// its room clears it at once, with no town visit; the bot standing on it keeps it; four
// arrivals hold nothing.
{
    const Records = invoke('GameServer/Bot/Population/SpotRecords');
    const Situations = invoke('GameServer/Bot/Situations');
    const spots = [at('home', -80000), at('next', -79000), at('best', -78000)];
    const samples = [['home', 0.5, 0.15], ['next', 0.75, 0.225], ['best', 1, 0.3]];
    const persona = traits => ({ traits, understanding: 1 });
    const cautious = { ...hunter(990305, spots, samples, [36000, 1 / 36000, 0, 0]), persona: persona({ caution: 0.8, assertiveness: 0.2 }) };
    const assertive = { ...cautious, characterId: 990306, persona: persona({ caution: 0.1, assertiveness: 0.9 }) };
    const holder = grade => ({ members: [{ characterId: 990500, inventory: grade ? { 1: { rank: grade, equippedSlots: [7] }, 2: { rank: grade, equippedSlots: [10] } }
        : cautious.inventory }] });
    const hold = (grade, arrivals = Records.HELD) => { for (let n = 0; n < arrivals; n++) Records.note('best', 1.5, [holder(grade)]); };
    const town = (...bots) => bots.forEach(bot => Records.heard(bot.characterId));
    try {
        Records.clear();
        town(cautious);
        hold('c');
        assert.equal(chosen(cautious, spots), 'best', 'held since its last town visit: it has not heard, it goes there');
        town(cautious);
        const repelled = Situations.counts().raised['spot:repelled'] || 0;
        assert.equal(chosen(cautious, spots), 'next', 'heard in town: held by a C-grade holder, the weaker bot takes its next best');
        assert(Situations.counts().raised['spot:repelled'] > repelled, 'counted');
        town(assertive);
        assert.equal(chosen(assertive, spots), 'next', 'a weaker look is turned away whatever the persona');
        assert.equal(chosen({ ...cautious, spotId: 'best', loc: spots[2].center }, spots), 'best', 'the bot standing on it keeps it');
        Records.note('best', 0.7, [holder('c')]);
        assert.equal(chosen(cautious, spots), 'best', 'an arrival finding it at 0.7 of its room clears it, known at once');
        Records.clear();
        hold(null); town(cautious, assertive);
        assert.equal(chosen(cautious, spots), 'next', 'held by an even look: the cautious bot keeps away');
        assert.equal(chosen(assertive, spots), 'best', 'the assertive one goes');
        Records.clear();
        hold('c', Records.HELD - 1);
        const heard = () => Situations.counts().raised['spot:heard'] || 0, before = heard();
        town(cautious);
        assert.equal(chosen(cautious, spots), 'best', 'four contested arrivals hold nothing');
        assert.equal(heard(), before, 'nothing held is heard: not counted');
        // A far bot hears at its town-arriving step's commit: a refused step heard nothing.
        hold('c', 1);
        Records.heard(cautious.characterId, 'step-1');
        Records.acked([{ characterId: cautious.characterId, ok: false, proposalId: 'step-1' }]);
        assert.equal(chosen(cautious, spots), 'best', 'its town arrival refused: it has not heard');
        Records.heard(cautious.characterId, 'step-2');
        assert.equal(chosen(cautious, spots), 'best', 'not before the ack');
        Records.acked([{ characterId: cautious.characterId, ok: true, proposalId: 'step-2' }]);
        assert.equal(chosen(cautious, spots), 'next', 'committed: heard');
        assert.equal(heard(), before + 1, 'a held record heard: counted');
    } finally { Records.clear(); }
}

// No camp of its window it may take (here: none it knows an hour of): the bot hunts easier
// ground alone, the lower spot closest to its level, past one its marks exclude, with no
// income expected there; with no lower ground either the answer names none.
{
    const low = (id, level, locX) => ({ ...at(id, locX), avgLevel: level, minLevel: level, maxLevel: level });
    const spots = [at('home', -80000), low('grey5', 5, -79000), low('grey2', 2, -78000)];
    const state = hunter(990307, spots, [], [36000, 1 / 36000, 0, 0]);
    const found = search(state, spots);
    assert.equal(found?.spot.id, 'grey5', 'no camp of its level: the closest easier ground');
    assert.equal(found.row.income, 0, 'no income expected there');
    const SpotRisk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const marked = { ...state, stats: { ...state.stats, spotMarks: SpotRisk.withSpotMark(state.stats, 'grey5', 'contest_lost') } };
    assert.equal(chosen(marked, spots), 'grey2', 'a lower spot its marks exclude is no answer');
    assert.equal(search(state, [spots[0]]), null, 'no lower ground: none');
}

console.log('PASS spot choice: exp and money by the own price, one answer from any spot, the hour, the real trip, no crowd, held camps, easier ground');
