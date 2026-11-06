'use strict';
// A held exp/income hunting decision names spot X. Its own trip to X and
// its arrival there raise nothing: in the held decision's verdict and in the
// far step's round check (DecisionSections.events with the step's leaf).
// When X has no room, the route sends the bot to another spot Y: that detour
// stands in for X (the pair leaf X, ground Y) while the bot stays on Y. A
// flight (death pressure) and an X the bot avoids (a backoff) are no stand-in:
// the held decision refuses them. A far bot's own move is no event anywhere
// (Reaction, own_move): a material hunt's detour and a spot change without a
// trip raise nothing in its round and keep its decision.
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
    const PveEncounter = invoke('GameServer/Bot/Population/ColdPveEncounter');
    const { beginHuntingTrip } = invoke('GameServer/Bot/Population/HuntingTravel');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const Situations = invoke('GameServer/Bot/Situations');
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
    // Its survival potions over their line at every field here: the kit's line reads the table at the
    // spot the bot stands on (EquipmentIncomeRoute.spotUseOf), and the pulls below are about the trip.
    const potion = invoke('GameServer/Bot/AI/HealingPotionStock').purchasePotionFor({ level: 35 }).selfId;
    inventory[potion] = { selfId: potion, amount: 20 };
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
    // round(before, after) = the situations a far step's round raises with the
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
        const round = (before, after) => Situations.detect(before, after, { leaf })
            .filter(name => Situations.hears(name, Situations.place(after, before)));
        assert.equal(verdict(published), true, 'fixture: the published decision holds');
        const routed = standing(published, X);
        const route = BotRoute.trip({}, routed, leaf, { spots, timestamp: T, hasRoom: room(X) });
        assert(route?.needed, 'fixture: a trip');
        // A wanted trip waits for the engaged fight only; a flight off unsafe ground does not.
        const fighting = at => ({ ...routed, stats: { ...routed.stats, pveEncounter: PveEncounter.save(null, 'fight', {}, 100, at, {}) } });
        assert.equal(PveEncounter.holdsTrip(fighting(T), route, T), true, 'a pending fight holds the trip');
        assert.equal(PveEncounter.holdsTrip(fighting(T - 3600000), route, T), false, 'a stale record holds no trip');
        assert.equal(PveEncounter.holdsTrip(fighting(T), { ...route, reason: 'unsafe_ground_evacuation' }, T), false,
            'the unsafe-ground flight is not held');
        assert.deepEqual(BotRoute.trip({}, fighting(T), leaf, { spots, timestamp: T, hasRoom: room(X) })?.spotId, route.spotId,
            'the trip is still searched, for the step after the fight');
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
        // (only that monster brings it in): the route names no stand-in, yet a
        // far bot's own trip and its arrival are its own (Reaction, own_move).
        const material = { ...leaf, itemId: 1864, amount: 5 };
        const materialRoute = BotRoute.trip({}, routed, material, { spots, timestamp: T, hasRoom: full(X) });
        assert(materialRoute?.needed && String(materialRoute.spotId) !== String(X), 'fixture: the material hunt detours too');
        const materialTrip = beginHuntingTrip(routed, materialRoute, T);
        const materialArrived = { ...materialTrip, ...Resolver.resolveSolo({ state: materialTrip,
            timestamp: materialTrip.stats.travel.arrivalAt }).patch };
        assert.equal(Sections.occupationPlanned(materialTrip, material), true, 'a far material hunt\'s detour trip is no event');
        assert.equal(Sections.occupationPlanned(materialArrived, material), true, 'nor its detour arrival');
        assert.equal(Sections.occupationPlanned({ ...materialTrip, phase: 'hot' }, material), false, 'near a player the detour trip is an event');
        // The bot stands on another spot with no trip there (a pull, a
        // teleport): far from a player its own ground is no event either.
        const other = spots.find(spot => spot.raidBoss !== true && spot.center
            && ![String(X), String(route.spotId)].includes(String(spot.id)));
        const moved = spotAt(arrived, other.id);
        assert.equal(verdict(moved), true, 'a far spot change without a trip keeps the decision');
        assert.deepEqual(round(arrived, moved), [], 'and raises nothing in the round');
        assert.deepEqual(round({ ...arrived, phase: 'hot' }, { ...moved, phase: 'hot' }), ['moved_by_world'],
            'near a player a spot change without a trip is an occupation event');
        // A round there (the far step's projection), then back on the
        // stand-in ground without the detour (a party arrival, a fallback
        // spot): far from a player that return raises nothing either.
        const there = await Life.prepareResolve(moved, Resolver.resolveSolo({ state: moved, timestamp: T + 1000 }),
            { timestamp: T + 1000, persist: false, projectClassProgression: true, moneyEscrowFor: () => 0 });
        assert(there, 'fixture: the round projects');
        const back = { ...spotAt(there, route.spotId), activity: 'hunting' };
        assert(!round(there, back).includes('moved_by_world'), 'a far return to the stand-in ground raises nothing');
    }
    console.log('PASS exp hunting detour keeps / a far material hunt, a move off the stand-in and a return to it raise nothing');

    {
        // X has room but the bot avoids it (a backoff marked after the
        // decision): the searched trip elsewhere is no stand-in for X.
        const { X, routed, route, traveling, arrived, verdict, round } = detour(990104, { room: () => () => true,
            standing: (state, X) => { const at = pulled(state); return { ...at, stats: { ...at.stats, spotBackoffs: [backoff(X)] } }; } });
        assert(String(route.spotId) !== String(X), 'fixture: X avoided, the route leads elsewhere');
        assert.equal(verdict(arrived), false, 'the arrival away from an avoided X refuses the decision');
        // Its round raises nothing far from a player: the verdict is what refuses.
        assert.deepEqual(round(routed, traveling), [], 'the far trip away from an avoided X raises nothing in the round');
        assert.deepEqual(round(arrived, arrived), [], 'nor a far round away from it');
    }
    console.log('PASS an arrival away from an avoided spot refuses the decision');

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
        assert.equal(verdict(arrived), true, 'a far flight\'s arrival is its own ground: the decision stands');
    }
    console.log('PASS a death-pressure flight is an event');

    {
        // A trip start keeps its spot verdicts on the bot's kernel record
        // (BotRoute heldVerdict) while what they read stands: the spot, the
        // bot's side (kit and level, shot kind, servitor), the recovery's
        // target level. Exclusion marks are read at every ask; the crowd is no
        // input. A kept verdict answers as a fresh one, also after each input
        // changes; `judged`: did the ask judge the ground and matchup again.
        const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
        const SpotService = invoke('GameServer/Bot/AI/SpotService');
        const ShotStock = invoke('GameServer/Inventory/ShotStock');
        const stubbed = { ready: LevelingRoutes.readySpotReaderFor, allowed: LevelingRoutes.isSpotAllowedForState };
        let judged = 0;
        LevelingRoutes.readySpotReaderFor = (...args) => { judged++; return stubbed.ready(...args); };
        LevelingRoutes.isSpotAllowedForState = (...args) => { judged++; return stubbed.allowed(...args); };
        try {
            const owner = {};
            const leafAt = (state, id, at, record) => BotRoute.leafChoice(state, { activity: 'hunting', spotId: id },
                { spots, timestamp: at, owner: record });
            const ask = (state, id, at = T) => {
                const before = judged;
                const held = leafAt(state, id, at, owner), fresh = (judged - before) > 0;
                assert.deepEqual(held, leafAt(state, id, at, null), `the kept verdict at ${id} answers as a fresh one`);
                return { spotId: held?.spotId ?? null, judged: fresh };
            };
            const bot = { ...spotAt(base, '-5_16'), characterId: 990105, stats: { ...base.stats, stepCount: 1 } };
            const with_ = stats => ({ ...bot, stats: { ...bot.stats, ...stats } });
            assert.deepEqual(ask(bot, '-5_16'), { spotId: '-5_16', judged: true }, 'fixture: the leaf\'s own spot fits');
            assert.deepEqual(ask({ ...bot }, '-5_16', T + 60000), { spotId: '-5_16', judged: false },
                'a later step with the same inputs keeps the verdict');
            assert.deepEqual(ask({ ...bot, level: 36 }, '-5_16'), { spotId: '-5_16', judged: true }, 'a level up judges again');
            ask(bot, '-5_16');
            const marked = with_({ spotBackoffs: [{ spotId: '-5_16', untilStep: 3 }] });
            assert.deepEqual(ask(marked, '-5_16'), { spotId: null, judged: false }, 'a mark on the spot refuses it at once');
            assert.deepEqual(ask({ ...marked, stats: { ...marked.stats, stepCount: 3 } }, '-5_16'), { spotId: '-5_16', judged: false },
                'its expiry admits it again on the kept verdict');
            assert.deepEqual(ask(with_({ huntingRecovery: { levelPenalty: 4, cleanWins: 0, resumeExp: 0 } }), '-5_16').judged, true,
                'a recovery penalty (the matchup\'s target level) judges again');
            const plan = ShotStock.combatPlanForState(bot);
            const shots = { ...bot, inventory: { ...bot.inventory, [plan.selfId]: { selfId: plan.selfId, amount: 5000 } } };
            ask(bot, '-5_16');
            assert.equal(ask(shots, '-5_16').judged, true, 'a loaded shot judges again');
            const naked = { ...bot, inventory: {} };
            assert.deepEqual(ask(naked, '-5_16'), { spotId: null, judged: true }, 'without its gear the matchup refuses the spot');
            assert.deepEqual(ask({ ...naked }, '-5_16', T + 60000), { spotId: null, judged: false }, 'the refusal is kept too');
            assert.deepEqual(ask(bot, '-5_16'), { spotId: '-5_16', judged: true }, 'gear worn again judges it again');
            // The ground the bot stands on (a trip under a leaf that is no hunt):
            // kept the same way.
            const standing = state => SpotService.standingSpot(state, spots);
            const shop = { activity: 'shopping' };
            const groundAt = (state, at = T) => {
                const before = judged;
                assert.equal(BotRoute.trip(owner, state, shop, { spots, currentSpot: standing(state), timestamp: at }), null,
                    'fixture: safe ground, the occupation owns the step');
                return judged - before > 0;
            };
            assert.equal(groundAt(bot), true, 'the first trip start judges the ground');
            assert.equal(groundAt({ ...bot }, T + 60000), false, 'the next one keeps it');
            assert.equal(groundAt({ ...bot, level: 36 }), true, 'a level up judges it again');
        } finally {
            LevelingRoutes.readySpotReaderFor = stubbed.ready;
            LevelingRoutes.isSpotAllowedForState = stubbed.allowed;
        }
    }
    console.log('PASS a trip start keeps its spot verdicts while their inputs stand');
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
