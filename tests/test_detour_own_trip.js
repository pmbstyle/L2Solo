'use strict';
// A held exp/income hunting decision names spot X. Its own trip to X and
// its arrival there raise nothing: in the held decision's verdict and in the
// far step's round check (DecisionSections.events with the step's leaf).
// When X has no room, the route sends the bot to another spot Y: that detour
// stands in for X (the pair leaf X, ground Y) while the bot stays on Y. A
// material hunt, a flight (death pressure), an X the bot avoids (a backoff)
// and a spot change without a trip (or back) are no stand-in: the move is an event.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detour-own-trip-'));
const oldCwd = process.cwd();
const oldConfig = process.env.L2NODE_CONFIG_FILE;
const oldShared = process.env.L2NODE_SHARED_CONFIG_FILE;
const config = path.join(dir, 'config.ini');
fs.writeFileSync(config, fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8')
    + `\n[Database]\npath=${path.join(dir, 'world.sqlite')}\nhistoryPath=${path.join(dir, 'history.sqlite')}\n`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.chdir(root);
let Economy, generation = null;
const Generation = require('../src/GameServer/Bot/Population/RecomputeGeneration');
async function run() {
    require(path.join(root, 'src/Global'));
    const Data = invoke('GameServer/DataCache'); Data.init();
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
    const { beginHuntingTrip } = invoke('GameServer/Bot/Population/HuntingTravel');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    Economy = invoke('GameServer/Bot/Economy/EconomyContext');
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(() => null, () => true);
    generation = Generation.metadata();
    Generation.configure({ code: '1'.repeat(40), config: '2'.repeat(64) });
    const Board = invoke('GameServer/AfkTrade/BoardIndex').BoardIndex;
    const board = new Board();
    // Native fields of level 30 monsters a level-35 warrior may hunt alone
    // (and 17_13, monster 600, a level-40 field it may not). T43 spawns: the
    // former monsters (711, 485, 79, 344) have no coordinate spawns any more.
    const spots = require('./helpers/wishSectionSpots')([600, 1011, 924, 755, 609]);
    Economy.configure({ board: () => board, spots: () => spots });
    Config.knowledgeErrorsEnabled = false;
    // A warrior in the gear its level plans, so the route finds fields it may hunt.
    const inventory = {};
    for (const row of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 35 }).items) {
        const slots = [...inventory[row.selfId]?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: slots.length, equipped: true, equippedCount: slots.length, equippedSlots: slots };
    }
    const base = { phase: 'cold', activity: 'hunting', level: 35, adena: 50, inventory,
        loc: { locX: 80000, locY: 148000, locZ: -3500 }, currentRegion: 'Giran',
        stats: { classId: 1, exp: Data.experience[34], persona: { traits: { commitment: .5, caution: .5,
            resilience: .5, ambition: .5, empathy: .5, sociability: .5, assertiveness: .5 }, understanding: .8 } },
        timing: {}, vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 } };
    const T = Date.now();

    // One bot, idle on the field X its held decision hunts (-5_16, monster
    // 924), pulled to A (17_13) before the trip (`standing`: the published
    // state moved before it; `room`: the spots with room), the trip, its
    // arrival. verdict(state) = does the held decision hold over that state;
    // round(before, after) = the sections a far step's round raises with the
    // step's leaf (BotLifeState.prepareResolve's check).
    const spotAt = (state, id) => {
        const spot = spots.find(row => String(row.id) === String(id));
        assert(spot?.center, `fixture: spot ${id}`);
        return { ...state, spotId: spot.id, currentRegion: spot.name,
            loc: { locX: spot.center.locX, locY: spot.center.locY, locZ: spot.center.locZ } };
    };
    const pulled = state => ({ ...spotAt(state, '17_13'), activity: 'hunting' });
    const full = X => id => String(id) !== String(X);
    const backoff = id => ({ spotId: id, untilStep: 1e9, startedAt: T, attempts: 1, reason: 'death_pressure' });
    function detour(characterId, { stats = {}, standing = pulled, room = full } = {}) {
        const native = { ...spotAt(base, '-5_16'), activity: 'idle', characterId, stats: { ...base.stats, ...stats } };
        const held = Economy.forState(native, { timestamp: T });
        const leaf = held.network.activity, X = leaf?.spotId;
        assert(leaf?.activity === 'hunting' && String(X) === '-5_16', 'fixture: a hunting decision at the field it stands on');
        const packet = held.statsPacket, published = { ...native, stats: { ...native.stats, ...packet } };
        const proof = held.eventProof();
        const verdict = state => Economy.eventProofHolds(state, proof, { timestamp: T },
            { baseline: packet.wishSections, leaf, timestamp: T });
        const round = (before, after) => Sections.events(before, after, 0, leaf);
        assert.equal(verdict(published), true, 'fixture: the published decision holds');
        const routed = standing(published, X);
        const route = BotRoute.trip({}, routed, leaf, { spots, timestamp: T, hasRoom: room(X) });
        assert(route?.needed, 'fixture: a trip');
        const traveling = beginHuntingTrip(routed, route, T);
        assert(traveling, 'fixture: the trip starts');
        const arrival = Resolver.resolveSolo({ state: traveling, timestamp: traveling.stats.travel.arrivalAt });
        assert(arrival && arrival.patch.activity === 'hunting', 'fixture: the bot arrives to hunt');
        const arrived = { ...traveling, ...arrival.patch };
        Economy.forget(characterId);
        return { leaf, X, routed, route, traveling, arrived, verdict, round };
    }

    {
        // X has room: the leaf's own trip and its first round there.
        const { X, routed, route, traveling, arrived, round } = detour(990103, { room: () => () => true });
        assert.equal(String(route.spotId), String(X), 'fixture: the trip goes to X');
        assert.deepEqual(round(routed, traveling), [], 'the round that starts the trip to X raises nothing');
        assert.deepEqual(round(arrived, arrived), [], 'the first round at X raises nothing');
    }
    console.log('PASS the leaf\'s own trip and arrival raise nothing in the round');

    {
        const { leaf, X, routed, route, traveling, arrived, verdict, round } = detour(990101);
        assert(String(route.spotId) !== String(X), 'fixture: X full, the route leads elsewhere');
        assert.equal(verdict(traveling), true, 'the detour trip keeps the decision');
        assert.equal(verdict(arrived), true, 'the arrival at the stand-in spot keeps the decision');
        assert.deepEqual(round(routed, traveling), [], 'the round that starts the detour raises nothing');
        assert.deepEqual(round(arrived, arrived), [], 'a round on the stand-in spot raises nothing');
        // The same detour under a leaf that hunts a material at its monster
        // (only that monster brings it in): the route names no stand-in, so
        // neither the trip nor its arrival is the leaf's own.
        const material = { ...leaf, itemId: 1864, amount: 5 };
        const materialRoute = BotRoute.trip({}, routed, material, { spots, timestamp: T, hasRoom: full(X) });
        assert(materialRoute?.needed && String(materialRoute.spotId) !== String(X), 'fixture: the material hunt detours too');
        const materialTrip = beginHuntingTrip(routed, materialRoute, T);
        const materialArrived = { ...materialTrip, ...Resolver.resolveSolo({ state: materialTrip,
            timestamp: materialTrip.stats.travel.arrivalAt }).patch };
        assert.equal(Sections.occupationPlanned(materialTrip, material), false, 'a material hunt\'s detour trip is an event');
        assert.equal(Sections.occupationPlanned(materialArrived, material), false, 'a material hunt\'s detour arrival is an event');
        // The bot stands on another spot with no trip there (a pull, a
        // teleport): the stand-in was the ground it reached, not this one.
        const other = spots.find(spot => spot.raidBoss !== true && spot.center
            && ![String(X), String(route.spotId)].includes(String(spot.id)));
        const moved = spotAt(arrived, other.id);
        assert.equal(verdict(moved), false, 'a spot change without a trip refuses the decision');
        assert.deepEqual(round(arrived, moved), ['occupation'], 'a spot change without a trip is an occupation event');
        // A round there (the far step's projection), then back on the
        // stand-in ground without the detour (a party arrival, a fallback
        // spot): that return is a move of its own, an event.
        const there = await Life.prepareResolve(moved, Resolver.resolveSolo({ state: moved, timestamp: T + 1000 }),
            { timestamp: T + 1000, persist: false, projectClassProgression: true, moneyEscrowFor: () => 0 });
        assert(there, 'fixture: the round projects');
        const back = { ...spotAt(there, route.spotId), activity: 'hunting' };
        assert(round(there, back).includes('occupation'), 'a return to the stand-in ground without the detour is an event');
    }
    console.log('PASS exp hunting detour keeps / a material hunt, a move off the stand-in and a return to it are events');

    {
        // X has room but the bot avoids it (a backoff marked after the
        // decision): the searched trip elsewhere is no stand-in for X.
        const { X, routed, route, traveling, arrived, verdict, round } = detour(990104, { room: () => () => true,
            standing: (state, X) => { const at = pulled(state); return { ...at, stats: { ...at.stats, spotBackoffs: [backoff(X)] } }; } });
        assert(String(route.spotId) !== String(X), 'fixture: X avoided, the route leads elsewhere');
        assert.equal(verdict(arrived), false, 'the arrival away from an avoided X refuses the decision');
        assert.deepEqual(round(routed, traveling), ['occupation'], 'the trip away from an avoided X is an event');
        assert.deepEqual(round(arrived, arrived), ['occupation'], 'a round away from an avoided X is an event');
    }
    console.log('PASS a trip away from an avoided spot is an event');

    {
        // A bot that died on spot Z (its death mark, held with the decision)
        // and stands there with X full: its search is a flight, which stays
        // an event.
        const Z = spots.find(spot => spot.raidBoss !== true && spot.center
            && spot.npcEntries?.some(entry => entry.selfId === 1011));
        assert(Z, 'fixture: a ground to flee from');
        const { X, route, traveling, arrived, verdict } = detour(990102, { stats: { spotBackoffs: [backoff(Z.id)] },
            standing: state => ({ ...spotAt(state, Z.id), activity: 'hunting' }) });
        assert(String(route.spotId) !== String(X), 'fixture: X full, the route leads elsewhere');
        assert.equal(route.reason, 'death_pressure_replan', 'fixture: a flight');
        assert.equal(verdict(traveling), false, 'a flight refuses the decision');
        assert.equal(verdict(arrived), false, 'the arrival of a flight refuses the decision');
    }
    console.log('PASS a death-pressure flight is an event');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Economy?.reset();
    invoke('GameServer/Bot/Economy/PersonalWarehouseIndex').useRowSource(null);
    if (generation) Generation.configure(generation);
    process.chdir(oldCwd);
    if (oldConfig === undefined) delete process.env.L2NODE_CONFIG_FILE; else process.env.L2NODE_CONFIG_FILE = oldConfig;
    if (oldShared === undefined) delete process.env.L2NODE_SHARED_CONFIG_FILE; else process.env.L2NODE_SHARED_CONFIG_FILE = oldShared;
    fs.rmSync(dir, { recursive: true, force: true });
});
