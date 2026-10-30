const assert = require('assert');

require('../src/Global');
options.default.BotPopulation.developerDiagnostics = true;

// E69: a spot gives back only what its spawns respawn; a cold solo bot kills
// at most its share of it, split by the bots hunting the spot.
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');

// Mobs per hour one spawn gives back: 3600 / its respawn seconds; a minion comes back with its leader.
const leader = { spawnDefinition: { spawn: { respawn: 60, bias: 30 } } };
assert.strictEqual(SpotService.respawnsPerHour(leader), 60);
assert.strictEqual(SpotService.respawnsPerHour({ spawnDefinition: null, minionLeader: leader }), 60);
assert.strictEqual(SpotService.respawnsPerHour({ spawnDefinition: { spawn: { respawn: 0 } } }), 0);
assert.strictEqual(SpotService.respawnsPerHour({}), 0);

// A spot of 2 mobs respawning in 60 s: 120 mobs per hour. Nine hunters, one-minute rounds:
// each bot's share is 120 / 60 / 9 = 0.22 mobs per round.
const gremlins = (extra = {}) => ({ id: 'share_gremlin', name: 'Gremlin field', avgLevel: 1, density: 2, npcSelfIds: [1],
    npcEntries: [{ selfId: 1, count: 2, production: 120 }],
    rewards: { exp: 10, sp: 2, adenaMin: 7, adenaMax: 10 }, mob: { hp: 8, damage: 1 }, ...extra });
const hunter = (stats = {}) => ({ characterId: 72, name: 'ShareHunter', level: 10, levelBand: '10-12', activity: 'hunting',
    vitals: { hp: 99999, maxHp: 99999, mp: 99999, maxMp: 99999 }, stats, party: { role: 'dps' } });
const share = Resolver.soloShareMobs(gremlins(), 60000, 9);
assert(Math.abs(share - 120 / 60 / 9) < 1e-9);
assert.strictEqual(Resolver.soloShareMobs(gremlins({ npcEntries: [{ selfId: 1, count: 2 }] }), 60000, 9), null,
    'a spot without a production table is not shared');
assert.strictEqual(Resolver.soloShareMobs(gremlins({ raidBoss: true }), 60000, 9), null);
// Respawn 0 is missing respawn data, not an empty spot: no cap (the author's behaviour).
assert.strictEqual(Resolver.soloShareMobs(gremlins({ npcEntries: [{ selfId: 1, count: 2, production: 0 }] }), 60000, 9), null,
    'a spot of zero production is not shared');
assert(Math.abs(Resolver.soloShareMobs(gremlins({ npcEntries: [{ selfId: 1, count: 2, production: 0 },
    { selfId: 2, count: 1, production: 60 }] }), 60000, 1) - 1) < 1e-9, 'a mixed spot is shared by its producing spawns');
const zero = Resolver.resolveSolo({ state: hunter(), spot: gremlins({ npcEntries: [{ selfId: 1, count: 2, production: 0 }] }),
    spotHunters: 9, elapsedMs: 60000, rng: () => 0 });
// T106: the walk between the two gremlins (17 s) leaves room for three per minute.
assert(zero.debug.wins >= 2, 'a bot on a zero-production spot still fights');
assert.strictEqual(zero.debug.shareCut, 0);

const before = { ...Metrics.counters };
const first = Resolver.resolveSolo({ state: hunter(), spot: gremlins(), spotHunters: 9, elapsedMs: 60000, rng: () => 0 });
assert.strictEqual(first.debug.wins, 0, 'a crowded bot does not kill above its share');
// T106: the cut counts the fights its walk would have allowed in the minute.
const walkMs = Resolver.soloWalkMs(2, invoke('GameServer/Bot/Population/ColdTrip').RUN_SPEED);
assert.strictEqual(first.debug.shareCut, Math.ceil(60000 / walkMs));
Metrics.recordCombat(first.debug);
assert.strictEqual(Metrics.counters.coldShareBoundResolves - (before.coldShareBoundResolves || 0), 1);
assert.strictEqual(Metrics.counters.coldShareCutFights - (before.coldShareCutFights || 0), Math.ceil(60000 / walkMs));

// The unused part of the share carries to the next round on the same spot, so the bot is not starved.
let state = hunter();
let kills = 0;
for (let round = 0; round < 17; round++) {
    const result = Resolver.resolveSolo({ state, spot: gremlins(), spotHunters: 9, elapsedMs: 60000, rng: () => 0 });
    kills += Number(result.debug.pullMobs || 0);
    state = { ...state, stats: result.patch.stats };
}
assert(kills >= 1, 'the share accumulates to a kill');
assert(kills <= Math.floor(17 * share), `kills ${kills} stay within 17 rounds of share`);

// A pull of 3 begun in one round and won in the next charges the share its 3 kills.
// A lone bot: share 2 mobs per one-minute round. The saved encounter is the
// pull's view (3 mobs, almost dead) as resolveFight saves a timed-out pull.
const PveEncounter = invoke('GameServer/Bot/Population/ColdPveEncounter');
const pullSpot = gremlins({ density: 3, npcEntries: [{ selfId: 1, count: 3, pull: 3, production: 120 }] });
const startedAt = 1_750_000_000_000;
const pullView = { selfId: 1, level: 1, maxHp: 24, pAtk: 1, pAtkRnd: 0, pDef: 1, mDef: 1,
    accur: 1, evasion: 0, critical: 0, atkSpd: 253, mAtk: 1, castSpd: 333, pull: 3 };
const opened = PveEncounter.save(null, PveEncounter.key([hunter()], pullSpot, 0), pullView, 1, startedAt,
    { botReadyAt: 0, mobReadyAt: 0 });
const closed = Resolver.resolveSolo({ state: hunter({ pveEncounter: opened, coldShare: { spotId: pullSpot.id, carry: 0 } }),
    spot: pullSpot, spotHunters: 1, elapsedMs: 60000, rng: () => 0, timestamp: startedAt + 60000 });
assert.strictEqual(closed.debug.wins, 1, 'the continued pull is won');
assert.strictEqual(closed.debug.pulls, 0, 'a continued pull is not counted again');
assert.strictEqual(closed.materialize.exp > 0, true);
assert.strictEqual(closed.patch.stats.coldShare.carry, 2 - 3, 'the share is charged the 3 kills paid, not 1');

// A lone bot on the same spot has the whole spot's production.
const alone = Resolver.resolveSolo({ state: hunter(), spot: gremlins(), spotHunters: 1, elapsedMs: 60000, rng: () => 0 });
assert.strictEqual(alone.debug.wins, 2, 'its share is 2 mobs a minute');
assert(alone.debug.shareCut > 0, 'the walk would allow more');

// The bots that split a spot: the index counts the bots on it and the ones
// on their way there; a gear plan or a party request elsewhere holds no place
// (ARCH-08-c), and a bot in town counts on no spot.
const { SpotOccupancyIndex } = invoke('GameServer/Bot/Population/SpotOccupancyIndex');
const occupancy = new SpotOccupancyIndex();
for (const state of [
    { characterId: 1, activity: 'hunting', spotId: 'A' },
    { characterId: 2, activity: 'hunting', spotId: 'A' },
    { characterId: 3, activity: 'traveling', spotId: 'B', stats: { travel: { spotId: 'A' } } },
    { characterId: 4, activity: 'shopping', spotId: 'A' },
    { characterId: 5, activity: 'hunting', spotId: 'B',
        stats: { equipmentPlan: { status: 'active', next: { spotId: 'A' } }, partyRequest: { status: 'open', spotId: 'A' } } }
]) occupancy.update(state);
assert.strictEqual(occupancy.physicalCount('A'), 3, 'two hunters and one arriving bot split the spot');
assert.strictEqual(occupancy.physicalCount('A', { standingOnly: true }), 2);
assert.strictEqual(occupancy.physicalCount('B'), 1, 'an intent elsewhere holds no place');
assert.deepStrictEqual([...occupancy.spotIds()].sort(), ['A', 'B']);
occupancy.update({ characterId: 1, activity: 'merchant', spotId: 'A' });
assert.strictEqual(occupancy.physicalCount('A'), 2, 'a bot that leaves for town frees its place at once');

console.log('Bot spot share checks passed');
