'use strict';
// Decision 10-30: a bot keeps its earning spot. A held build with a valid event
// proof: inside the window nothing searches, on any path; the window's end and
// a goal change ask one search on any path, the same answer renews in place, a
// new one rebuilds; a search that found nothing is kept like a route.
const assert = require('node:assert/strict');
const { Worker, isMainThread } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Card = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Party = invoke('GameServer/Bot/Population/PartyIncomeComparison');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
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
            adena: spot.id === better ? 1200 : 750, costs: 100, loot: 0, exp: 100, kills: 10 }) } };
    return next;
}
// complete: a working kit; else one earring short, so a search runs whatever the goal.
function fighter(characterId, { complete = false } = {}) {
    const inventory = {};
    for (const entry of Gear.planFor({ classId: 0, level: 10 }).items) {
        const old = inventory[entry.selfId];
        const equippedSlots = [...(old?.equippedSlots || []), entry.slot];
        inventory[entry.selfId] = { ...entry, amount: Number(old?.amount || 0) + 1,
            equipped: true, equippedCount: equippedSlots.length, equippedSlots };
    }
    if (!complete) {
        const ear = Object.values(inventory).find(row => row.equippedSlots.includes(2));
        inventory[ear.selfId] = { ...ear, amount: 1, equippedCount: 1, equippedSlots: [1], slot: 1 };
    }
    const state = { characterId, level: 10, adena: 1000000, phase: 'cold', activity: 'hunting', currentRegion: 'Gludin',
        spotId: 'poor', loc: spots[0].center, timing: {}, vitals: { hp: 500, maxHp: 500, mp: 300, maxMp: 300 },
        stats: { classId: 0, wishFocus: ['power:200:14', 1, 1000000] }, inventory };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(0, 10), started);
    return state;
}
const deps = (minutes, extra = {}) => ({ spots, timestamp: time(minutes), ...extra });
const published = (state, built) => ({ ...state, stats: { ...state.stats, ...built.statsPacket } });
// The held build of a bot that earns at 'rich', published, its proof valid.
function heldBot(characterId, extra = {}, shape = {}) {
    const native = sampled(fighter(characterId, shape), 'rich');
    const built = Economy.forState(native, deps(0, extra));
    assert.equal(built.hunt.spotId, 'rich', 'fixture: it chooses the better spot');
    assert(built.eventProof(), 'fixture: the build has its event proof');
    return { native, built, state: published(native, built) };
}
let searches = 0;
const nativeSelect = Route.select;
Route.select = (...args) => { searches += 1; return nativeSelect(...args); };
// How many searches a read made.
function count(read) {
    const before = searches, result = read();
    return { result, searches: searches - before };
}

function verify() {
    // Own build chose another focus: one search at the next decision point, then held.
    const settled = (characterId, extra) => {
        const { built, state } = heldBot(characterId, extra);
        assert.equal(Economy.forState(state, deps(0, extra)).plan, built.plan,
            'fixture: the verdict on the published build is valid');
        return { built, state };
    };

    // Inside the window nothing searches, on any path, also when another spot turned better.
    {
        const { built, state } = settled(990201);
        const turned = sampled(state, 'poor');
        for (const minute of [1, 15, 29]) {
            const read = count(() => Economy.forState(turned, deps(minute)));
            assert.equal(read.result.plan, built.plan, 'a build inside the window serves the held build');
            assert.equal(read.searches, 0, 'a build inside the window does not search');
            const stock = count(() => Economy.basics(turned, deps(minute)));
            assert.equal(stock.result.hunt.spotId, 'rich', 'the basics read the held spot');
            assert.equal(stock.searches, 0, 'the basics inside the window do not search');
            const party = count(() => Party.soloRoute({ ...turned }, spots, time(minute)));
            assert.equal(party.result.spotId, 'rich', 'the party read takes the held spot');
            assert.equal(party.searches, 0, 'the party read inside the window does not search');
        }
    }

    // An off-card bot past the window: forState alone, no basics.
    {
        const { built, state } = settled(990202);
        const same = count(() => Economy.forState(state, deps(31)));
        assert.equal(same.searches, 1, 'past the window a build searches once');
        assert.equal(same.result.plan, built.plan, 'the same spot renews the hold in place, nothing is rebuilt');
        assert.equal(count(() => Economy.forState(state, deps(32))).searches, 0, 'the renewed window holds');
        const turned = sampled(state, 'poor');
        assert.equal(count(() => Economy.forState(turned, deps(60))).searches, 0, 'until its own end');
        const moved = count(() => Economy.forState(turned, deps(62)));
        assert.notEqual(moved.result.plan, built.plan, 'a better spot rebuilds the build');
        assert.equal(moved.result.hunt.spotId, 'poor', 'on the new spot');
        assert.equal(Economy.incomeMoved(turned), false, 'and the new build holds it');
    }

    // The party read past the window searches for itself and leaves the hold to its owner.
    {
        const { state } = settled(990203);
        const turned = sampled(state, 'poor');
        for (const minute of [31, 300]) {
            const party = count(() => Party.soloRoute({ ...turned }, spots, time(minute)));
            assert.equal(party.result.spotId, 'poor', `the party read at ${minute} game minutes is a fresh one`);
            assert.equal(party.searches, 1, 'one search');
        }
        assert.equal(Economy.incomeMoved(turned), false, 'its search does not move the hold');
    }

    // A goal change searches inside the window: the bot's own build, an outside
    // write of the focus, main's goal revision.
    {
        const { native, state } = heldBot(990204);
        assert.notEqual(state.stats.wishFocus?.[0], native.stats.wishFocus[0], 'fixture: the build chose its own focus');
        const moved = count(() => Economy.forState(sampled(state, 'poor'), deps(1)));
        assert(moved.searches >= 1, 'the build\'s own new focus searches');
        assert.equal(moved.result.hunt.spotId, 'poor', 'and a better spot rebuilds on it');
    }
    {
        const { state } = settled(990205);
        const turned = sampled(state, 'poor');
        const written = { ...turned, stats: { ...turned.stats, wishFocus: ['power:300:14', 1, 1000000] } };
        const moved = count(() => Economy.forState(written, deps(1)));
        assert(moved.searches >= 1, 'a written focus searches');
        assert.equal(moved.result.hunt.spotId, 'poor', 'and the bot leaves a spot chosen for the old focus');
    }
    {
        const goal = { goalRevision: 7 };
        const { built, state } = settled(990206, goal);
        assert.equal(count(() => Economy.forState(state, deps(1, goal))).searches, 0, 'the same goal revision holds');
        const renewed = count(() => Economy.forState(state, deps(1, { goalRevision: 8 })));
        assert.equal(renewed.searches, 1, 'a new goal revision searches');
        assert.equal(renewed.result.plan, built.plan, 'the same spot stays in place');
        assert.equal(count(() => Economy.forState(state, deps(2, { goalRevision: 8 }))).searches, 0, 'once');
    }

    // A moved hold with a valid verdict: found by a read, it refuses the held
    // build and its card once, by one owner.
    {
        const { built, state } = settled(990207);
        const accepted = Card.advisory(built, state, undefined, deps(0));
        assert.equal(Card.refusal(state, accepted, deps(1)), '', 'fixture: the card holds');
        const turned = sampled(state, 'poor');
        assert.equal(Economy.basics(turned, deps(31)).hunt.spotId, 'poor', 'past the window a read finds the better spot');
        const later = count(() => Economy.basics(turned, deps(45)));
        assert.equal(later.result.hunt.spotId, 'poor', 'later reads keep the found spot');
        assert.equal(later.searches, 0, 'with no new search');
        assert.equal(Economy.incomeMoved(turned), true, 'the held build is to be rebuilt on it');
        assert.equal(Card.refusal(turned, accepted, deps(45)), 'events:income_moved', 'its card refuses');
        const rebuilt = Economy.forState(turned, deps(45));
        assert.notEqual(rebuilt.plan, built.plan, 'the build refuses');
        assert.equal(rebuilt.hunt.spotId, 'poor', 'and moves to it');
        assert.equal(Economy.incomeMoved(turned), false);
    }
    // A found spot that is not rebuilt ends like any hold: the window's next
    // search may find the held spot again.
    {
        const { built, state } = settled(990208);
        const turned = sampled(state, 'poor');
        assert.equal(Economy.basics(turned, deps(31)).hunt.spotId, 'poor', 'moved');
        assert.equal(Economy.basics(state, deps(61)).hunt.spotId, 'rich', 'a second search finds the held spot');
        assert.equal(Economy.incomeMoved(state), false, 'and the hold stands again');
        assert.equal(Economy.forState(state, deps(62)).plan, built.plan, 'nothing was rebuilt');
    }

    // A search that found nothing is kept until the window ends, and past it
    // a route found is a move. Raid camps are no earning ground.
    {
        const raids = spots.map(spot => ({ ...spot, raidBoss: true }));
        const none = minute => ({ spots: raids, timestamp: time(minute) });
        const native = sampled(fighter(990209), 'rich');
        const built = Economy.forState(native, none(0));
        const state = published(native, built);
        Economy.forState(state, none(0));
        for (const minute of [1, 29]) {
            assert.equal(count(() => Economy.basics(state, none(minute))).searches, 0, 'a held null is not searched per read');
            assert.equal(count(() => Economy.forState(state, none(minute))).searches, 0, 'nor by a build');
        }
        assert.equal(count(() => Economy.basics(state, none(31))).searches, 1, 'its window ends with one search');
        assert.equal(Economy.incomeMoved(state), false, 'no route again is no move');
        assert.equal(count(() => Economy.forState(state, none(32))).searches, 0, 'a new window');
        assert.equal(count(() => Party.soloRoute({ ...state }, raids, time(33))).searches, 1, 'a held null answers no solo question');
        assert.equal(count(() => Economy.basics(state, deps(62))).searches, 1, 'the next search');
        assert.equal(Economy.incomeMoved(state), true, 'a route found moves the hold');
    }

    // The bot's own build leaves the search's economic band (a complete kit, a
    // stock focus): no route. The rebuild keeps that focus: re-weighed, it could
    // flip back and ask the next search, a rebuild per step.
    {
        let bot = null;
        for (let id = 990210; !bot && id < 990240; id++) {
            const held = heldBot(id, {}, { complete: true });
            if (/^stock:/.test(held.state.stats.wishFocus?.[0])) bot = held;
        }
        assert(bot, 'fixture: a build that chose a stock focus');
        const { state } = bot, focus = state.stats.wishFocus[0];
        const left = count(() => Economy.forState(state, deps(1)));
        assert(left.searches >= 1, 'the goal change searches');
        assert.notEqual(left.result.hunt.source, 'route', 'the bot leaves the route chosen for the old focus');
        assert.equal(left.result.statsPacket.wishFocus[0], focus, 'the rebuild re-weighs nothing');
        const next = count(() => Economy.forState(published(state, left.result), deps(2)));
        assert.equal(next.result.plan, left.result.plan, 'the next read serves it');
        assert.equal(next.searches, 0, 'with no search');
    }
    Economy.reset();
    console.log(`PASS held earning spot: window on every path, goal change, moved hold, held null ${isMainThread ? 'main' : 'worker'}`);
}
try { verify(); } finally { Route.select = nativeSelect; Generation.configure(generation); }
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
}
