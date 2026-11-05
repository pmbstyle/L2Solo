'use strict';
// The earning spot decides on its situations (situations.md §10, step 1): a bot holds the answer of its last search
// (stats.earning, in the mind) and searches again only when a situation that wakes the decision is heard where it
// stands: a level up at its next stop, new gear in town, a death, its spot empty or dangerous, its survival potions
// low, leaving a party; or when it holds no answer. Prices, the crowd at other spots, its money weight, its own
// samples and the spot catalogue are read when it decides and wake nothing. A party member keeps its answer; main
// never searches (it reads the held answer). A search that found nothing holds that too.
const assert = require('node:assert/strict');
const { Worker, isMainThread } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Situations = invoke('GameServer/Bot/Situations');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Party = invoke('GameServer/Bot/Population/PartyIncomeComparison');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const Packet = invoke('GameServer/Bot/Economy/StatsPacket');
const GameTime = invoke('GameServer/World/GameTime');
const started = 1791335800000;
const time = minutes => started + minutes * GameTime.GAME_MINUTE_MS;
invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
const generation = Generation.metadata();
Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });

const spots = ['poor', 'rich'].map((id, at) => ({ id, avgLevel: 10, minLevel: 10, maxLevel: 10,
    density: 10, tagsAuthoritative: true, tags: ['starter'], npcEntries: [],
    center: { locX: -80000 + at * 1000, locY: 250000, locZ: 0 } }));
// Own samples decide the spots: `better` pays more.
function sampled(state, better) {
    let next = { ...state, stats: { ...state.stats, huntEfficiency: [] } };
    for (let n = 0; n < 3; n++) for (const spot of spots) next = { ...next, stats: { ...next.stats,
        huntEfficiency: Hunt.record(next, { spotId: spot.id, timestamp: started, cycleMs: 60000,
            adena: spot.id === better ? 1200 : 750, costs: 100, loot: 0, exp: spot.id === better ? 200 : 100, kills: 10 }) } };
    return next;
}
// A far hunter; complete: its kit whole (no gear required), else one earring short.
function hunter(characterId, { complete = false } = {}) {
    const inventory = {};
    for (const entry of Gear.planFor({ classId: 0, level: 10 }).items) {
        const old = inventory[entry.selfId];
        const equippedSlots = [...(old?.equippedSlots || []), entry.slot];
        inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
            equipped: true, equippedCount: equippedSlots.length, equippedSlots };
    }
    const ear = Object.values(inventory).find(row => row.equippedSlots.includes(2));
    if (!complete) inventory[ear.selfId] = { ...ear, amount: 1, equippedCount: 1, equippedSlots: [1], slot: 1 };
    const state = { characterId, level: 10, adena: 1000000, phase: 'cold', activity: 'hunting', currentRegion: 'Gludin',
        spotId: 'poor', loc: spots[0].center, timing: {}, vitals: { hp: 500, maxHp: 500, mp: 300, maxMp: 300 },
        stats: { classId: 0, wishFocus: ['power:200:14', 1, 1000000] }, inventory };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(0, 10), started);
    return sampled(state, 'rich');
}
// The bot's own step decides (Situations.DOORS step); another's question reads the held plan.
const deps = (minutes, extra = {}) => ({ spots, timestamp: time(minutes), caller: 'step', ...extra });
const published = (state, built) => ({ ...state, stats: { ...state.stats, ...built.statsPacket } });
let searches = 0;
const nativeSearch = Route.search;
Route.search = (...args) => { searches += 1; return nativeSearch(...args); };
function count(read) {
    const before = searches, result = read();
    return { result, searches: searches - before };
}
// A situation raised on the bot where it stands (Situations.raise, as its owner does), then its stop if any.
function raised(state, name, { at = Situations.place(state), stop = null } = {}) {
    const stats = Situations.raise({ ...state.stats }, name, null, at, state.characterId);
    if (stop !== null) Situations.stop(stats, stop, state.characterId);
    return { ...state, stats };
}
const unwoken = () => Object.entries(Situations.counts().unwoken).filter(([key]) => key.startsWith('earning_spot:'));

function onWorker() {
    // No held answer reads as woken: the first build searches once, holds the answer and clears the bit.
    const first = count(() => Economy.forState(hunter(990401), deps(0)));
    assert.equal(first.searches, 1, 'a bot with no held answer searches once');
    assert.equal(first.result.hunt.spotId, 'rich', 'and hunts the better spot');
    assert.equal(first.result.statsPacket.earning.spotId, 'rich', 'its answer is published with the build');
    assert(Number.isFinite(first.result.statsPacket.earning.earning) && first.result.statsPacket.earning.earning > 0, 'with its hour');
    const held = published(hunter(990401), first.result);
    assert.equal(Situations.woken(held.stats, 'earning_spot'), false, 'the search cleared its bit');

    // Nothing wakes it: prices, the crowd elsewhere, the money weight, its samples and the catalogue are read, not heard.
    {
        const turned = sampled(held, 'poor');
        const priced = { ...turned, stats: { ...turned.stats, money: Packet.money({ hourAdena: 99999, moneyPrice: 0.9,
            survivalReserve: 0, firstUnfundedPrice: 0 }) } };
        invoke('GameServer/Bot/AI/SpotValueTable').useSpots([]);
        for (const minute of [1, 30, 300]) {
            const read = count(() => Economy.forState(priced, deps(minute)));
            assert.equal(read.searches, 0, `no situation, no search (${minute} game minutes)`);
            assert.equal(read.result.hunt.spotId, 'rich', 'the bot keeps its spot');
            const basics = count(() => Economy.basics(priced, deps(minute)));
            assert.equal(basics.searches, 0, 'the basics never search');
            assert.equal(basics.result.hunt.spotId, 'rich', 'they read the held spot');
            assert.equal(count(() => Party.soloRoute(priced, spots, time(minute))).result.spotId, 'rich', 'so does the party comparison');
        }
        // A supply build rebuilds the foundation on the held route, with no search.
        const supply = { ...priced, stats: { ...priced.stats, wishDirty: invoke('GameServer/Bot/Economy/DecisionSections').sectionBit('supply') } };
        const rebuilt = count(() => Economy.forState(supply, deps(301)));
        assert.equal(rebuilt.searches, 0, 'a build woken by its own sections reads the held answer');
        assert.equal(rebuilt.result.hunt.spotId, 'rich');
        assert.equal(rebuilt.result.statsPacket.earning, undefined, 'and publishes no new answer');
    }

    // Its situations: each heard where it stands wakes one search, which may move it.
    const turned = sampled(held, 'poor');
    {
        const atWork = raised(turned, 'level_up');
        const waiting = count(() => Economy.forState(atWork, deps(2)));
        assert.equal(waiting.searches, 0, 'a level up at work waits');
        const rested = raised(turned, 'level_up', { stop: Situations.REST });
        const heard = count(() => Economy.forState(rested, deps(3)));
        assert.equal(heard.searches, 1, 'and is heard at the rest');
        assert.equal(heard.result.hunt.spotId, 'poor', 'the search finds the better spot now');
        assert.equal(heard.result.statsPacket.earning.spotId, 'poor');
        const after = published(rested, heard.result);
        assert.equal(count(() => Economy.forState(after, deps(4))).searches, 0, 'the new answer holds');
    }
    {
        const rested = raised(turned, 'gear_changed', { stop: Situations.REST });
        assert.equal(count(() => Economy.forState(rested, deps(5))).searches, 0, 'new gear does not reach a rest');
        const inTown = raised(turned, 'gear_changed', { stop: Situations.OPEN });
        assert.equal(count(() => Economy.forState(inTown, deps(6))).searches, 1, 'it is heard in town');
    }
    for (const name of ['died', 'spot_empty', 'spot_dangerous', 'stock_low:potions', 'party_left']) {
        const woken = raised(turned, name);
        const read = count(() => Economy.forState(woken, deps(7)));
        assert.equal(read.searches, 1, `${name} wakes one search`);
        assert.equal(published(woken, read.result).stats.earning.spotId, 'poor', `${name}: the bot moves to the better spot`);
    }
    // A situation that does not wake it searches nothing.
    for (const name of ['recipe_learned', 'arrived_town', 'goal_failed']) {
        assert.equal(count(() => Economy.forState(raised(turned, name), deps(8))).searches, 0, `${name} does not wake the earning spot`);
    }

    // Every solo adventurer holds its own earning spot, whatever its focus: a whole kit, no spoil, a stock focus.
    // The party comparison's solo side reads it, and a party paying less than that hour is refused.
    {
        const geared = { ...hunter(990404, { complete: true }), stats: { ...hunter(990404, { complete: true }).stats,
            wishFocus: ['stock:1060', 1, 1000000] } };
        assert.equal(Route.earnsOnRoute(geared, invoke('GameServer/Bot/AI/PersonalGearProgression').assess(geared).required), false,
            'fixture: no gear required, no economic focus, no spoil');
        const decided = count(() => Economy.forState(geared, deps(12)));
        assert.equal(decided.searches, 1, 'its earning spot is decided');
        assert.equal(decided.result.statsPacket.earning.spotId, 'rich', 'a real spot, not none');
        const solo = Party.soloRoute(published(geared, decided.result), spots, time(12));
        assert.equal(solo?.spotId, 'rich', 'the solo side reads it');
        assert.equal(Party.evaluate({ solo, party: { income: solo.income * 0.9 } }).accept, false, 'a party paying less is refused');
    }
    // A party member hunts with its party: its foundation does not price the held solo spot.
    {
        const member = { ...held, party: { partyId: 'p2', role: 'member' }, partyId: 'p2', activity: 'grouped' };
        assert.notEqual(Economy.basics(member, deps(13)).hunt.source, 'route', 'the party hunt, not the solo route');
    }
    // An incoming projection waits: its build searches nothing (it publishes nothing).
    {
        const pending = { ...raised(turned, 'died'), incomingPending: true };
        assert.equal(count(() => Economy.forState(pending, deps(14))).searches, 0, 'no search while the projection waits');
    }
    // A party member keeps its answer: the bit waits until it hunts solo again.
    {
        const member = { ...raised(turned, 'died'), party: { partyId: 'p1', role: 'member' }, partyId: 'p1', activity: 'grouped' };
        assert.equal(count(() => Economy.basics(member, deps(9))).searches, 0, 'a party member does not search');
        assert.equal(Situations.woken(member.stats, 'earning_spot'), true, 'its bit waits');
    }

    // A search that found nothing holds that, until a situation.
    {
        const raidOnly = spots.map(spot => ({ ...spot, raidBoss: true }));
        const none = count(() => Economy.forState(raised(turned, 'died'), { spots: raidOnly, timestamp: time(10), caller: 'step' }));
        assert.equal(none.searches, 1, 'fixture: it searched');
        assert.equal(none.result.statsPacket.earning.spotId, null, 'a search with no spot holds none');
        const after = published(raised(turned, 'died'), none.result);
        assert.equal(count(() => Economy.forState(after, { spots: raidOnly, timestamp: time(11), caller: 'step' })).searches, 0, 'and is not repeated');
    }
    assert.deepEqual(unwoken(), [], 'the earning spot is never decided unwoken');
    Economy.reset();
    console.log('PASS earning spot on its situations (worker): held across prices, weight, samples and catalogue; '
        + 'level at the rest, gear in town, death, empty, dangerous, potions, party left; party member keeps; none held');
}

function onMain() {
    // Main never decides: a bot with no answer reads none, one with an answer reads it, whatever woke.
    const fresh = count(() => Economy.forState(hunter(990402), deps(0)));
    assert.equal(fresh.searches, 0, 'main never searches the earning spot');
    assert.equal(fresh.result.statsPacket.earning, undefined, 'and publishes no answer');
    const holding = { ...hunter(990403), stats: { ...hunter(990403).stats,
        earning: Route.answerOf({ spot: spots[1], row: { income: 500, useShots: true }, earning: 600 }, started) } };
    const read = count(() => Economy.basics(raised(holding, 'died'), deps(1)));
    assert.equal(read.searches, 0, 'a woken bot on main reads its held answer');
    assert.equal(read.result.hunt.spotId, 'rich', 'the held spot');
    Economy.reset();
    console.log('PASS earning spot on main: never searched, the held answer read');
}

try { if (isMainThread) onMain(); else onWorker(); } finally { Route.search = nativeSearch; Generation.configure(generation); }
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
}
