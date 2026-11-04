'use strict';
// Decision 10-30: a bot keeps its earning spot. A held build with a valid event
// proof: inside the window nothing searches, on any path; the window's end and
// a goal change that can change the answer (the focus into or out of gear and
// resale) ask one search on any path, the same answer renews in place, a new one
// rebuilds; a search that found nothing is kept like a route.
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
const Sources = invoke('GameServer/Bot/Population/ColdOccupationSources');
const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
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
// complete: a working kit; else one earring short, so a search runs whatever the goal.
// Near a player, where every read hears a change at once (far: Reaction, below).
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
    const state = { characterId, level: 10, adena: 1000000, phase: 'hot', activity: 'hunting', currentRegion: 'Gludin',
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
    // The published build, its own focus read: one search at the next decision
    // point if that focus turned the economic hunt, then held.
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

    // A goal change searches inside the window only when it opens or closes the
    // search: the focus turned into or out of gear and resale (the economic
    // hunt). A focus moved on the same side, by the bot's own build or an outside
    // write, or main's goal revision keeps the held answer: the bot keeps its spot.
    {
        // The hold was searched for the native focus, a gear one.
        const { state } = heldBot(990204);
        const turned = sampled(state, 'poor');
        const focused = key => ({ ...turned, stats: { ...turned.stats, wishFocus: [key, 1, 1000000] } });
        for (const [minute, key] of [[1, 'power:300:14'], [2, 'resale:300']]) {
            const kept = count(() => Economy.basics(focused(key), deps(minute)));
            assert.equal(kept.searches, 0, `a ${key} focus does not search`);
            assert.equal(kept.result.hunt.spotId, 'rich', 'and the bot keeps its spot');
        }
        const left = count(() => Economy.forState(focused('stock:1060'), deps(3)));
        assert(left.searches >= 1, 'a focus off gear and resale searches');
        assert.equal(left.result.hunt.spotId, 'poor', 'and the bot leaves a spot chosen for the old focus');
    }
    {
        // A kit gap opens the search whatever the focus: the hold of a stock focus.
        const native = sampled(fighter(990205), 'rich');
        const focused = (state, key) => ({ ...state, stats: { ...state.stats, wishFocus: [key, 1, 1000000] } });
        assert.equal(Economy.forState(focused(native, 'stock:1060'), deps(0)).hunt.spotId, 'rich', 'fixture: held for a stock focus');
        const turned = sampled(native, 'poor');
        const kept = count(() => Economy.basics(focused(turned, 'stock:1061'), deps(1)));
        assert.equal(kept.searches, 0, 'another focus off gear and resale does not search');
        assert.equal(kept.result.hunt.spotId, 'rich', 'and the bot keeps its spot');
        const into = count(() => Economy.basics(focused(turned, 'power:300:14'), deps(2)));
        assert.equal(into.searches, 1, 'a focus into gear searches');
        assert.equal(into.result.hunt.spotId, 'poor', 'and finds the better spot');
    }
    {
        const goal = { goalRevision: 7 };
        const { built, state } = settled(990206, goal);
        assert.equal(count(() => Economy.forState(state, deps(1, goal))).searches, 0, 'the same goal revision holds');
        const moved = count(() => Economy.forState(state, deps(1, { goalRevision: 8 })));
        assert.equal(moved.searches, 0, 'a new goal revision does not search');
        assert.equal(moved.result.plan, built.plan, 'and the held build stands');
    }

    // The money weight the search valued spots with (SpotEconomics.moneyWeight:
    // the packet's hour times its money price) is the goal's other input: a
    // move inside the bot's own income error keeps the hold, one beyond it
    // searches once. With knowledge errors off (the baseline's error 0) the
    // error a learned bot keeps stands in: the weight moves on every build.
    {
        const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
        const Learning = invoke('GameServer/Bot/AI/KnowledgeLearning');
        const { state } = heldBot(990260);
        const [hour] = state.stats.money;
        assert(state.stats.wishSections.incomeError > Learning.INCOME_ERROR_FLOOR && hour > 0,
            'fixture: the bot has an income error above the floor and an hour');
        const base = Economics.moneyWeight(state), money = Math.max(1, hour * state.stats.money[1]);
        const power = money * (1 - base) / base;
        const weighed = (weight, incomeError) => ({ ...state, stats: { ...state.stats,
            wishSections: { ...state.stats.wishSections, incomeError },
            money: [hour, weight * power / (1 - weight) / hour, ...state.stats.money.slice(2)] } });
        for (const [minute, incomeError, error] of [[31, state.stats.wishSections.incomeError, state.stats.wishSections.incomeError],
            [64, 0, Learning.INCOME_ERROR_FLOOR]]) {
            // A search past the window holds the weight this state reads.
            assert.equal(count(() => Economy.basics(weighed(base, incomeError), deps(minute))).searches, 1, 'fixture: the window\'s search');
            const up = base * (1 + 2 * error) < 0.99;
            const small = base * (1 + (up ? 1 : -1) * error / 2), large = base * (1 + (up ? 1 : -1) * 2 * error);
            assert(Math.abs(Economics.moneyWeight(weighed(large, incomeError)) - large) < 1e-9 && large * power / (1 - large) >= 1,
                'fixture: the packet carries the weight');
            const kept = count(() => Economy.basics(weighed(small, incomeError), deps(minute + 1)));
            assert.equal(kept.searches, 0, `a weight move inside the error (${error}) does not search`);
            assert.equal(kept.result.hunt.spotId, 'rich', 'and the bot keeps its spot');
            assert.equal(count(() => Economy.basics(weighed(large, incomeError), deps(minute + 2))).searches, 1, 'a move beyond it searches');
            assert.equal(count(() => Economy.basics(weighed(large, incomeError), deps(minute + 3))).searches, 0, 'once');
        }
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
        // At work the bot finishes where it stands; its rest hears the better spot.
        const at = activity => Card.refusal({ ...turned, phase: 'cold', activity }, accepted, deps(45));
        assert.notEqual(at('hunting'), 'events:income_moved', 'a hunt does not hear it');
        assert.equal(at('resting'), 'events:income_moved', 'its rest does');
        // A job that is no hunt ends first: the same rest on a craft does not hear it.
        const proof = built.eventProof(), resting = { ...turned, phase: 'cold', activity: 'resting' };
        const heardOn = leaf => {
            const options = { baseline: resting.stats.wishSections, leaf, collect: true };
            const first = Economy.heldBuildVerdict(resting, proof, deps(45), options);
            return Economy.heldBuildVerdict(resting, { ...proof, activity: first.leaf }, deps(45), options).reason;
        };
        assert.equal(heardOn({ activity: 'hunting', spotId: 'poor' }), 'income_moved', 'fixture: a hunter hears it');
        assert.notEqual(heardOn({ activity: 'crafting', recipeId: 1 }), 'income_moved', 'a crafter finishes');
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
    // A moved hold inside the found answer's window: a far hunter's builds read
    // that answer, so a second build of the same moment searches nothing and
    // serves what the first one left.
    {
        const { state } = settled(990211);
        const turned = sampled(state, 'poor');
        assert.equal(Economy.basics(turned, deps(31)).hunt.spotId, 'poor', 'fixture: a read moved the hold');
        const hunting = { ...turned, phase: 'cold', activity: 'hunting' };
        const first = Economy.forState(hunting, deps(40));
        const again = count(() => Economy.forState(hunting, deps(41)));
        assert.equal(again.searches, 0, 'the second build searches nothing');
        assert.equal(again.result.plan, first.plan, 'and serves the first one\'s build');
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
    // focus off gear and resale): no route. The rebuild keeps that focus: re-weighed, it could
    // flip back and ask the next search, a rebuild per step.
    // Stock nobody sells takes no focus (T178), so this bot needs a seller: the
    // worker's real supply, the towns' NPC shops and the routes to them (main
    // alone builds with an unknown route, and an unknown route is no offer).
    {
        Sources.initialise();
        const supplied = { npcOffersFor: Sources.npcOffersFor, routeRows: Trip.prepared };
        let bot = null;
        for (let id = 990210; !bot && id < 990240; id++) {
            const held = heldBot(id, supplied, { complete: true });
            if (!/^(power:|resale:)/.test(held.state.stats.wishFocus?.[0] ?? 'power:')) bot = held;
        }
        assert(bot, 'fixture: a build that chose a focus outside the band');
        const { state } = bot, focus = state.stats.wishFocus[0];
        const left = count(() => Economy.forState(state, deps(1, supplied)));
        assert(left.searches >= 1, 'the goal change searches');
        assert.notEqual(left.result.hunt.source, 'route', 'the bot leaves the route chosen for the old focus');
        assert.equal(left.result.statsPacket.wishFocus[0], focus, 'the rebuild re-weighs nothing');
        const next = count(() => Economy.forState(published(state, left.result), deps(2, supplied)));
        assert.equal(next.result.plan, left.result.plan, 'the next read serves it');
        assert.equal(next.searches, 0, 'with no search');
    }
    // A far bot in the field needs no bag rows: a read list past its bound leaves it its proof.
    {
        const { built, state } = heldBot(990250);
        const plan = { ...built.plan, quantityInputs: null };
        assert(Economy.captureEventProof({ ...state, phase: 'cold' }, deps(0), { plan }), 'a hunter keeps its proof');
        assert.equal(Economy.captureEventProof(state, deps(0), { plan }), null, 'a bot near a player does not');
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
