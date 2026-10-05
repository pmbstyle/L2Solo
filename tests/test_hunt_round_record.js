const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Efficiency = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
Data.init();

// E36/E44: one record of a hunting round (BotHuntEfficiency.recordRound,
// called by BotLifeState.prepareResolve). A round lasts until the bot's next
// round; the hour counts the time off the spot by the bot's own on-spot
// share (uptime only, a hot stint counts neither way); a party member
// records its own share; a bot without rows borrows the band of its
// situation.
const MIN = 60 * 1000;
const start = 1800000000000;
const round = (at, { adena = 600, wins = 2, nextIn = MIN } = {}) => ({
    patch: {}, events: [], nextResolveAt: at + nextIn,
    materialize: { exp: 0, sp: 0, adena, items: [] },
    debug: { fights: wins, wins, combatMs: 20000, spotId: 'field' }
});
function hunt(bot, at, options, startedAt = start - MIN) {
    const recorded = Efficiency.recordRound(bot, round(at, options), { exp: 100, timestamp: at, startedAt });
    return { ...bot, stats: { ...bot.stats, ...recorded } };
}
const base = { characterId: 1, level: 35, stats: { classId: 9 }, inventory: { 1: { selfId: 1, equipped: true } },
    timing: {} };

// A round is the time until the next one: 20 s of combat and a 40 s wait
// make 60 s of hunting, so 600 Adena a round is 36,000 an hour on the spot.
let bot = base;
for (let i = 0; i < 4; i++) bot = hunt(bot, start + i * MIN);
assert.strictEqual(bot.stats.huntEfficiency[0].cycleMs, MIN, 'the round time is the time until the next round');
assert.strictEqual(Efficiency.hourValue(bot, start + 4 * MIN).perHour, 36000, 'only on the spot: the share is whole');
assert.strictEqual(Efficiency.recordRound(base, { ...round(start), debug: { fights: 0, wins: 0 } },
    { timestamp: start }).huntEfficiency, undefined, 'a result without a fight is no hunting round');

// Pauses: after every fourth round the bot spends 4 minutes in town (no
// record). Its hour is its income over all its time: 4 rounds of 60 s in
// 7 minutes of uptime, 36,000 x 4/7 an hour.
let paused = base;
let at = start;
for (let cycle = 0; cycle < 30; cycle++) {
    for (let i = 0; i < 4; i++) { paused = hunt(paused, at); at += MIN; }
    at += 3 * MIN; // the last round's minute passed above; 3 more minutes off the spot
}
const share = Efficiency.onSpotShare(paused);
assert(Math.abs(share - 4 / 7) < 0.01, `on-spot share follows the real time (${share})`);
assert(Math.abs(Efficiency.hourValue(paused, at).perHour - 36000 * 4 / 7) < 400, 'the hour counts the time off the spot');
assert.deepStrictEqual(Efficiency.scores(paused, at), Efficiency.scores(bot, start + 4 * MIN),
    'spot choice keeps on-spot time only');

// Downtime: a gap that spans the server's start counts neither way.
let restarted = hunt(base, start);
restarted = hunt(restarted, start + MIN);
const before = restarted.stats.huntClock;
restarted = hunt(restarted, start + 600 * MIN, {}, start + 500 * MIN);
assert.deepStrictEqual([restarted.stats.huntClock.onSpot, restarted.stats.huntClock.total], [before.onSpot, before.total],
    'a gap across a restart is not time off the spot');
restarted = hunt(restarted, start + 601 * MIN, {}, start + 500 * MIN);
assert(restarted.stats.huntClock.total > before.total, 'the clock goes on after the restart');

// A hot stint (no record near the player) counts neither way either.
let hot = hunt(base, start);
hot = hunt(hot, start + MIN);
const beforeHot = hot.stats.huntClock;
hot = hunt({ ...hot, timing: { lastHotAt: start + 30 * MIN } }, start + 40 * MIN);
assert.deepStrictEqual([hot.stats.huntClock.onSpot, hot.stats.huntClock.total], [beforeHot.onSpot, beforeHot.total],
    'hot time is neutral for the on-spot share');

// Band medians by situation: three solo hunters and two party members of the
// same band; a bot without rows takes the median of its own situation.
Efficiency.resetLevelBands();
const earner = (characterId, party, adena) => {
    let state = { ...base, characterId, party: party ? { partyId: 'p1' } : null };
    for (let i = 0; i < 4; i++) state = hunt(state, start + i * MIN, { adena });
    return state;
};
earner(11, false, 600); earner(12, false, 1200); earner(13, false, 1800);
earner(21, true, 100); earner(22, true, 300);
const later = start + 10 * MIN;
assert.strictEqual(Efficiency.hourValue({ level: 33, stats: {} }, later).perHour, 72000, 'a solo bot: the solo band');
assert.strictEqual(Efficiency.hourValue({ level: 33, stats: {}, party: { partyId: 'x' } }, later).perHour, 18000,
    'a party member: the party band');
assert.strictEqual(Efficiency.hourValue({ level: 33, stats: {} }, later, 'party').perHour, 18000, 'party planning: the party band');
Efficiency.resetLevelBands();
earner(11, false, 600);
assert.strictEqual(Efficiency.hourValue({ level: 33, stats: {}, party: { partyId: 'x' } }, later).perHour, 36000,
    'with no party measured at all a party member borrows the solo band');

// A party member records its own share of the party's round through the
// lifecycle (prepareResolve), in the party situation; the solo death
// recovery stays solo.
async function run() {
    const exp = Number(Data.experience[34]) + 1000;
    const member = { characterId: 990101, level: 35, exp, sp: 0, adena: 0, phase: 'cold', activity: 'grouped',
        spotId: 'field', party: { partyId: 'p9' }, partyId: 'p9', inventory: {}, loc: {}, timing: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 },
        stats: { classId: 1, classProgressionClassId: 1, classProgressionLevel: 35, deaths: 0 } };
    let next = member;
    for (let i = 0; i < 3; i++) {
        next = await Life.prepareResolve({ ...next, party: { partyId: 'p9' }, partyId: 'p9' }, {
            patch: { activity: 'grouped', spotId: 'field' }, events: [],
            materialize: { exp: 500, sp: 0, adena: 250, items: [{ selfId: 57, amount: 50 }] },
            nextResolveAt: start + i * MIN + 50000,
            debug: { partyId: 'p9', fights: 3, wins: 3, aggregate: true, spotId: 'field' }
        }, { timestamp: start + i * MIN, persist: false, projectClassProgression: true });
    }
    const row = next.stats.huntEfficiency[0];
    assert.strictEqual(row.signature.split(':')[3], 'party', 'the party key keeps the row apart');
    assert.deepStrictEqual([row.adena, row.loot, row.kills, row.cycleMs, row.samples], [250, 50, 3, 50000, 3],
        'the member\'s own split, the party\'s kills, the time until its next round');
    assert.strictEqual(next.stats.huntingRecovery, undefined, 'the death recovery record stays solo');
    assert.strictEqual(Efficiency.hourValue(next, start + 3 * MIN).source, 'own', 'a party member has an hour of its own');
    console.log('Hunt round record: time until the next round, on-spot share by uptime, party shares and bands by situation passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
