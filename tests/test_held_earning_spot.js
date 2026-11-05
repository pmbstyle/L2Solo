'use strict';
// Decision 10-30: a bot keeps its earning spot. A held build with a valid event
// proof: while no input of the search moved nothing searches, on any path,
// however long; an input that moved (a version, the observation bit, a goal
// change that can change the answer: the focus into or out of gear and
// resale, the money weight past the range its answer stands over; the crowd
// past its key; the consumable prices past their ranges) asks one search on
// any path, the same answer renews in place,
// a new one rebuilds; a search that found nothing is kept like a route.
const assert = require('node:assert/strict');
const Packet = require('../src/GameServer/Bot/Economy/StatsPacket');
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
const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
// The spot catalog period turns: the table's revision (the search reads its rows).
const catalogTurned = () => invoke('GameServer/Bot/AI/SpotValueTable').useSpots([]);
// The observation link raised its bit (the bot's own samples moved beyond its error).
const observing = state => ({ ...state, stats: { ...state.stats, wishDirty: Sections.sectionBit('observation') } });

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
let searches = 0, lastSearch = null;
const nativeSelect = Route.select, nativeSearch = Route.search;
Route.select = (...args) => { searches += 1; return nativeSelect(...args); };
Route.search = (state, options) => {
    searches += 1;
    const found = nativeSearch(state, options);
    lastSearch = { options, weights: found.weights };
    return found;
};
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

    // With no input moved nothing searches, on any path, however long, also
    // when another spot turned better (samples moved inside the observation
    // rule raise no bit).
    {
        const { built, state } = settled(990201);
        const turned = sampled(state, 'poor');
        for (const minute of [1, 29, 31, 300]) {
            const read = count(() => Economy.forState(turned, deps(minute)));
            assert.equal(read.result.plan, built.plan, `a build at ${minute} game minutes serves the held build`);
            assert.equal(read.searches, 0, 'a build with nothing moved does not search');
            const stock = count(() => Economy.basics(turned, deps(minute)));
            assert.equal(stock.result.hunt.spotId, 'rich', 'the basics read the held spot');
            assert.equal(stock.searches, 0, 'the basics with nothing moved do not search');
            const party = count(() => Party.soloRoute({ ...turned }, spots, time(minute)));
            assert.equal(party.result.spotId, 'rich', 'the party read takes the held spot');
            assert.equal(party.searches, 0, 'the party read with nothing moved does not search');
        }
    }

    // An off-card bot: forState alone, no basics. A turned catalog searches
    // once: the same spot renews the hold in place. Turned samples are heard
    // by the observation bit: the better spot rebuilds the build.
    {
        const { built, state } = settled(990202);
        catalogTurned();
        const same = count(() => Economy.forState(state, deps(31)));
        assert.equal(same.searches, 1, 'a turned catalog searches once');
        assert.equal(same.result.plan, built.plan, 'the same spot renews the hold in place, nothing is rebuilt');
        assert.equal(count(() => Economy.forState(state, deps(32))).searches, 0, 'the renewed hold holds');
        const turned = sampled(state, 'poor');
        assert.equal(count(() => Economy.forState(turned, deps(300))).searches, 0, 'samples with no observation event keep it');
        const moved = count(() => Economy.forState(observing(turned), deps(301)));
        assert.notEqual(moved.result.plan, built.plan, 'a better spot rebuilds the build');
        assert.equal(moved.searches, 1, 'on the search that moved the hold, not a second one');
        assert.equal(moved.result.hunt.spotId, 'poor', 'on the new spot');
        assert.equal(Economy.heldSpotMoved(turned), false, 'and the new build holds it');
    }

    // A party read whose hold an input moved searches for itself and leaves
    // the hold to its owner. Its own search is kept on what it read (any copy
    // of the bot, however long), searched again when one of those inputs moves.
    {
        const { state } = settled(990203);
        const turned = sampled(state, 'poor');
        catalogTurned();
        const party = count(() => Party.soloRoute({ ...turned }, spots, time(31)));
        assert.equal(party.result.spotId, 'poor', 'the party read of a moved input is a fresh one');
        assert.equal(party.searches, 1, 'one search');
        for (const minute of [32, 300]) {
            const again = count(() => Party.soloRoute({ ...turned }, spots, time(minute)));
            assert.equal(again.result.spotId, 'poor', `a copy of the same bot reads the same answer at ${minute} game minutes`);
            assert.equal(again.searches, 0, 'with no second search');
        }
        // What it keeps of the search answers the comparison as the search's whole route does.
        const whole = { route: nativeSearch(Party.soloState(turned), { spots, timestamp: time(31), required: true, mode: 'solo',
            maxChecks: Party.MAX_SOLO_CHECKS }).route, own: null };
        assert.deepEqual(Party.soloRoute({ ...turned }, spots, time(300)), Party.soloRoute({ ...turned }, spots, time(300), [], whole));
        const other = { ...fighter(990263, { complete: true }), spotId: 'poor' };
        const prepared = Party.prepare([turned, other], { spots, timestamp: time(300) });
        assert.deepEqual(Party.compare({ ...turned }, [other], { prepared }),
            Party.compare({ ...turned }, [other], { prepared, solo: new Map([[Number(turned.characterId), whole]]) }),
            'the kept solo search compares as the whole one');
        const leveled = count(() => Party.soloRoute({ ...turned, level: 11 }, spots, time(302)));
        assert.equal(leveled.searches, 1, 'a moved input searches again');
        assert.equal(Economy.heldSpotMoved(turned), false, 'its search does not move the hold');
    }

    // A held forming verdict reads the solo side's answer, not the search that
    // gave it: the owner's hold renewed to the same spot by an input the verdict
    // does not read keeps it, judged once and the same as a fresh judgement;
    // the hold moved to another spot judges it again.
    {
        const Goals = invoke('GameServer/Bot/Population/PartyGoalPolicy');
        const { built, state: owner } = settled(990261);
        // Both short of their focus' cash: the party's hour buys it sooner.
        const state = { ...owner, adena: 0 };
        const peer = { ...fighter(990262, { complete: true }), adena: 0, spotId: 'rich', loc: spots[1].center };
        const requested = { spotId: 'rich' };
        const nativePrepare = Party.prepare;
        let judged = 0;
        // A party forecast that beats the solo hour, so the verdict accepts.
        Party.prepare = (members, options) => {
            judged += 1;
            const prepared = nativePrepare(members, options);
            for (const member of members) prepared.rows.set(member.characterId,
                { income: 1e9, kills: 100, spotId: 'rich', source: 'table_party', travelHours: 0 });
            return prepared;
        };
        try {
            const ask = (members, minute) => Goals.formingVerdict(members, requested, { spots, timestamp: time(minute) });
            const fresh = (members, minute) => Goals.formingMembers(members, requested, { spots, timestamp: time(minute) })
                .map(member => Number(member.characterId));
            const first = ask([state, peer], 1);
            assert.deepEqual(first.formingAccepted, [990261, 990262], 'fixture: the roster forms');
            const once = judged;
            // A capacity mark on the other spot: an input of the owner's search, not of the verdict.
            const mark = bot => ({ ...bot, stats: { ...bot.stats, capacityBackoffs: [{ spotId: 'poor', untilStep: 5 }] } });
            const marked = mark(state);
            const renewed = count(() => Economy.forState(mark(owner), deps(2)));
            assert.equal(renewed.searches, 1, 'fixture: the owner searches once');
            assert.equal(renewed.result.plan, built.plan, 'fixture: the same spot renews the hold in place');
            const held = ask([marked, peer], 3);
            assert.equal(judged, once, 'the renewed hold keeps the verdict');
            assert.deepEqual(held, first);
            assert.deepEqual(held.formingAccepted, fresh([marked, peer], 3), 'the held verdict is a fresh judgement');
            // Its own samples turned to the other spot (the mark off): the hold moves there.
            const turned = sampled(state, 'poor');
            assert.equal(Economy.forState(observing(sampled(owner, 'poor')), deps(4)).hunt.spotId, 'poor',
                'fixture: the owner\'s hold moved');
            const moved = ask([turned, peer], 5);
            assert(judged > once, 'the solo side\'s new answer judges the verdict again');
            assert.deepEqual(moved.formingAccepted, fresh([turned, peer], 5));
        } finally { Party.prepare = nativePrepare; }
    }

    // A goal change searches only when it opens or closes the
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

    // The money weight (SpotEconomics.moneyWeight: the packet's hour times its
    // money price) enters the search only through each spot's score, a line in
    // the weight: the answer stands over the weights up to the nearest crossing
    // (EquipmentIncomeRoute.search), and the hold searches when the weight
    // leaves them, however far it moved inside. Two spots, one paying exp, the
    // other money: the range ends where their scores cross.
    {
        const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
        const bot = fighter(990260);
        let native = { ...bot, stats: { ...bot.stats, huntEfficiency: [] } };
        for (let n = 0; n < 3; n++) for (const spot of spots) native = { ...native, stats: { ...native.stats,
            huntEfficiency: Hunt.record(native, { spotId: spot.id, timestamp: started, cycleMs: 60000,
                adena: spot.id === 'rich' ? 1500 : 600, costs: 100, loot: 0, exp: spot.id === 'rich' ? 100 : 14000, kills: 10 }) } };
        const built = Economy.forState(native, deps(0));
        assert.equal(built.hunt.spotId, 'poor', 'fixture: at its first weight the bot levels');
        const state = published(native, built), hour = Packet.hourAdena(state.stats.money);
        const base = Economics.moneyWeight(state), money = Math.max(1, hour * Packet.moneyPrice(state.stats.money));
        const power = money * (1 - base) / base;
        const weighed = weight => ({ ...state, stats: { ...state.stats,
            money: [hour, weight * power / (1 - weight) / hour, ...state.stats.money.slice(2)] } });
        const held = count(() => Economy.basics(weighed(0.9), deps(31)));
        assert.equal(held.searches, 1, 'fixture: the weight past its range searches');
        assert.equal(held.result.hunt.spotId, 'rich', 'fixture: a high money weight earns');
        const { low, high } = lastSearch.weights;
        assert(low > base && low < 0.9 && high === 1, 'fixture: the range ends where the spots cross');
        // Tight: the search answers the same anywhere inside, the other spot just past it.
        const inside = low + 1e-12, past = low - 1e-12;
        assert(Economics.moneyWeight(weighed(inside)) >= low && Economics.moneyWeight(weighed(past)) < low,
            'fixture: the packet carries the weight');
        const answer = weight => nativeSelect(weighed(weight), lastSearch.options)?.spot.id;
        for (const weight of [inside, (low + 0.9) / 2, 0.999]) assert.equal(answer(weight), 'rich', `the search keeps its answer at ${weight}`);
        assert.equal(answer(past), 'poor', 'and changes it just past the range');
        // A move inside, wider than the bot's own income error, keeps the hold.
        assert(0.9 - inside > 0.9 * state.stats.wishSections.incomeError, 'fixture: a move beyond the bot\'s income error');
        const kept = count(() => Economy.basics(weighed(inside), deps(32)));
        assert.equal(kept.searches, 0, 'a weight move inside the range does not search');
        assert.equal(kept.result.hunt.spotId, 'rich', 'and the bot keeps its spot');
        const moved = count(() => Economy.basics(weighed(past), deps(33)));
        assert.equal(moved.searches, 1, 'a move just past it searches');
        assert.equal(moved.result.hunt.spotId, 'poor', 'and finds the other spot');
        assert.equal(count(() => Economy.basics(weighed(past), deps(34))).searches, 0, 'once');
    }

    // A supply build (DecisionSections incomeSearch) rebuilds the foundation on
    // the held route: the search reads of the bag only the shot, so a bag move
    // that keeps it searches nothing, and one that changes the shot the fight
    // loads searches.
    {
        const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
        const Shots = invoke('GameServer/Inventory/ShotStock');
        const { built, state } = settled(990270);
        const turned = sampled(state, 'poor');
        const supplied = bag => ({ ...turned, inventory: bag, stats: { ...turned.stats, wishDirty: Sections.sectionBit('supply') } });
        const kept = count(() => Economy.forState(supplied({ ...turned.inventory, 1060: { selfId: 1060, amount: 5 } }), deps(1)));
        assert.notEqual(kept.result.plan, built.plan, 'the supply build rebuilds');
        assert.equal(kept.searches, 0, 'with no search');
        assert.equal(kept.result.hunt.spotId, 'rich', 'on the held spot');
        const shot = Shots.combatPlanForState(turned);
        const loaded = { ...turned.inventory, [shot.selfId]: { selfId: shot.selfId, amount: 5000 } };
        const kind = bag => Matchup.shotKind(Profile.shotSupply({ ...turned, inventory: bag }, time(2)));
        assert.notEqual(kind(loaded), kind(turned.inventory), 'fixture: the shots change what the fight loads');
        const searched = count(() => Economy.forState(supplied(loaded), deps(2)));
        assert(searched.searches >= 1, 'a shot the fight now loads searches');
        assert.equal(searched.result.hunt.spotId, 'poor', 'and finds the better spot');
    }

    // The worker step judges the held build before its build, with an await
    // between (heldWorkshop): a search there that moves the hold is the
    // build's answer at that moment, not one to repeat.
    {
        const { state } = settled(990280);
        const turned = observing(sampled(state, 'poor')), step = deps(31), eventVerdict = {};
        assert.equal(count(() => Economy.heldWorkshop(turned, step, eventVerdict)).searches, 1, 'fixture: the step\'s look searches');
        assert.equal(Economy.heldSpotMoved(turned), true, 'fixture: and moves the hold');
        const built = count(() => Economy.forState(turned, { ...step, eventVerdict }));
        assert.equal(built.searches, 0, 'the build of the same moment takes that answer');
        assert.equal(built.result.hunt.spotId, 'poor', 'and rebuilds on it');
    }

    // A moved hold with a valid verdict: found by a read, it refuses the held
    // build and its card once, by one owner.
    {
        const { built, state } = settled(990207);
        const accepted = Card.advisory(built, state, undefined, deps(0));
        assert.equal(Card.refusal(state, accepted, deps(1)), '', 'fixture: the card holds');
        const turned = sampled(state, 'poor');
        catalogTurned();
        assert.equal(Economy.basics(turned, deps(31)).hunt.spotId, 'poor', 'with an input moved a read finds the better spot');
        const later = count(() => Economy.basics(turned, deps(45)));
        assert.equal(later.result.hunt.spotId, 'poor', 'later reads keep the found spot');
        assert.equal(later.searches, 0, 'with no new search');
        assert.equal(Economy.heldSpotMoved(turned), true, 'the held build is to be rebuilt on it');
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
        assert.equal(Economy.heldSpotMoved(turned), false);
    }
    // A found spot that is not rebuilt ends like any hold: the next search may
    // find the held spot again.
    {
        const { built, state } = settled(990208);
        const turned = sampled(state, 'poor');
        catalogTurned();
        assert.equal(Economy.basics(turned, deps(31)).hunt.spotId, 'poor', 'moved');
        catalogTurned();
        assert.equal(Economy.basics(state, deps(61)).hunt.spotId, 'rich', 'a second search finds the held spot');
        assert.equal(Economy.heldSpotMoved(state), false, 'and the hold stands again');
        assert.equal(Economy.forState(state, deps(62)).plan, built.plan, 'nothing was rebuilt');
    }
    // A moved hold: a far hunter's builds read that answer, so a second build of the same moment searches nothing and
    // serves what the first one left.
    {
        const { state } = settled(990211);
        const turned = sampled(state, 'poor');
        catalogTurned();
        assert.equal(Economy.basics(turned, deps(31)).hunt.spotId, 'poor', 'fixture: a read moved the hold');
        const hunting = { ...turned, phase: 'cold', activity: 'hunting' };
        const first = Economy.forState(hunting, deps(40));
        const again = count(() => Economy.forState(hunting, deps(41)));
        assert.equal(again.searches, 0, 'the second build searches nothing');
        assert.equal(again.result.plan, first.plan, 'and serves the first one\'s build');
    }

    // A search that found nothing is kept like a route, however long; the
    // next search that finds a route is a move. Raid camps are no earning ground.
    {
        const raids = spots.map(spot => ({ ...spot, raidBoss: true }));
        const none = minute => ({ spots: raids, timestamp: time(minute) });
        const native = sampled(fighter(990209), 'rich');
        const built = Economy.forState(native, none(0));
        const state = published(native, built);
        Economy.forState(state, none(0));
        for (const minute of [1, 29, 31, 300]) {
            assert.equal(count(() => Economy.basics(state, none(minute))).searches, 0, 'a held null is not searched per read');
            assert.equal(count(() => Economy.forState(state, none(minute))).searches, 0, 'nor by a build');
        }
        catalogTurned();
        assert.equal(count(() => Economy.basics(state, none(301))).searches, 1, 'a turned catalog searches once');
        assert.equal(Economy.heldSpotMoved(state), false, 'no route again is no move');
        assert.equal(count(() => Economy.forState(state, none(302))).searches, 0, 'and holds it');
        assert.equal(count(() => Party.soloRoute({ ...state }, raids, time(303))).searches, 1, 'a held null answers no solo question');
        catalogTurned();
        assert.equal(count(() => Economy.basics(state, deps(362))).searches, 1, 'the next search');
        assert.equal(Economy.heldSpotMoved(state), true, 'a route found moves the hold');
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
    // The search decides on its key (DecisionSections LINK_INPUTS incomeSearch):
    // moving any one of its inputs makes the next build of the held bot search
    // once, whatever sections the move raised (the samples raised as the step
    // would, with the observation bit). Each
    // input's version is a digest of its value on the state (inputVersions):
    // moving one input moves its version and only the versions derived from it
    // (the samples' signature reads class, level and party; the gear gap reads
    // the worn kit and the adventurer; the crafter flag the craft level; the money
    // weight the packet's hour and price; the karma flip the route key; a
    // crafter's own lines the lines it sells, a shot crafter's supply its bag).
    {
        const Shots = invoke('GameServer/Inventory/ShotStock');
        const stat = (state, more) => ({ ...state, stats: { ...state.stats, ...more } });
        const versions = (state, recipes = null, board = null, mode = null, income = null) => Sections.inputVersions(Sections.stateView(state, recipes),
            state, time(1), { spots, board, mode, income });
        const movedNames = (before, after) => Object.keys(after).filter(name => !Object.is(after[name], before[name])).sort();
        const ear = Object.values(fighter(1, { complete: true }).inventory).find(row => row.equippedSlots.includes(2));
        const worn = state => ({ ...state, inventory: { ...state.inventory,
            [ear.selfId]: { ...ear, amount: 2, equippedCount: 2, equippedSlots: [1, 2] } } });
        const sampledThird = state => stat(state, { huntEfficiency: [0, 1, 2].reduce(rows => Hunt.record(stat(state, { huntEfficiency: rows }),
            { spotId: 'third', timestamp: started, cycleMs: 60000, adena: 500, costs: 100, loot: 0, exp: 50, kills: 10 }), state.stats.huntEfficiency) });
        const raised = state => stat(state, { wishDirty: Sections.sectionMask(Sections.softEvents(state, state.stats.wishSections, { timestamp: time(1) })) });
        const money = (state, hour, price) => { const packet = state.stats.money;
            return stat(state, { money: Packet.money({ hourAdena: Packet.hourAdena(packet) * hour, moneyPrice: Packet.moneyPrice(packet) * price,
                survivalReserve: Packet.survivalReserve(packet), firstUnfundedPrice: Packet.firstUnfundedPrice(packet) }) }); };
        // [input, move, versions it moves, the build's options]
        const rows = [
            ['mode', state => state, ['mode'], { mode: 'party' }],
            ['kit.class', state => stat(state, { classId: 1 }), ['kit.class', 'samples']],
            ['kit.level', state => ({ ...state, level: 11 }), ['kit.level', 'samples']],
            ['kit.worn', worn, ['kit.worn', 'required']],
            ['kit.hennas', state => stat(state, { hennas: [1, 0, 0] }), ['kit.hennas']],
            ['kit.skills', state => stat(state, { coldCombat: { ...state.stats.coldCombat,
                skills: state.stats.coldCombat.skills.map((skill, at) => at ? skill : { ...skill, level: skill.level + 1 }) } }), ['kit.skills']],
            ['kit.capture', state => stat(state, { coldCombat: { ...state.stats.coldCombat, henna: { str: 1 } } }), ['kit.capture']],
            ['party', state => ({ ...state, party: { partyId: 5, role: 'member' } }), ['party', 'samples']],
            ['adventurer', state => stat({ ...state, activity: 'crafting' }, { craftShop: true, generatedIndex: 10001 }), ['adventurer', 'required']],
            ['economic', state => stat(state, { wishFocus: [/^power:/.test(state.stats.wishFocus[0]) ? 'stock:1061' : 'power:300:14', 1, 1000000] }), ['economic']],
            ['required', worn, ['kit.worn', 'required']],
            // A spot the held leaf did not order (its own arrival is no event).
            ['spot', state => ({ ...state, spotId: 'nowhere' }), ['spot']],
            ['samples', state => raised(sampledThird(state)), ['samples']],
            ['exclusions', state => stat(state, { capacityBackoffs: [{ spotId: 'rich', untilStep: 5 }] }), ['exclusions']],
            ['recovery', state => stat(state, { huntingRecovery: { levelPenalty: 2, cleanWins: 0, resumeExp: 0 } }), ['recovery']],
            ['bagShot', state => { const shot = Shots.combatPlanForState(state);
                return { ...state, inventory: { ...state.inventory, [shot.selfId]: { selfId: shot.selfId, amount: 5000 } } }; }, ['bagShot']],
            ['spawns', state => { catalogTurned(); return state; }, ['spawns']]
        ];
        assert.deepEqual(rows.map(row => row[0]).sort(), [...Sections.LINK_INPUTS.incomeSearch.discrete].sort(), 'a row per declared input');
        let id = 990300;
        const GearProgression = invoke('GameServer/Bot/AI/PersonalGearProgression');
        for (const [name, move, , extra] of rows) {
            const { state } = heldBot(++id), moved = move(state);
            assert.equal(count(() => Economy.forState(moved, deps(1, extra))).searches, 1, `a moved ${name} searches the held spot once`);
            assert.equal(lastSearch.options.required, GearProgression.assess(moved).required, `a moved ${name}: the search weighs the bot's gear gap now`);
        }
        // A read with no build (basics) hears a gear gap that opened, and its search weighs it.
        {
            const { state } = heldBot(++id), moved = worn(state);
            assert.notEqual(GearProgression.assess(moved).required, GearProgression.assess(state).required, 'fixture: the gear gap moved');
            assert.equal(count(() => Economy.basics(moved, deps(1))).searches, 1, 'a read searches the held spot once');
            assert.equal(lastSearch.options.required, GearProgression.assess(moved).required, 'and weighs the gap now');
        }
        // inputVersions on a bot out of the economic hunt (a stock focus), so the adventurer moves no goal.
        const base = stat(heldBot(++id).state, { wishFocus: ['stock:1060', 1, 1000000] }), before = versions(base);
        const others = [
            ['craft', state => stat(state, { workshop: { entries: [1] } }), ['craft']],
            ['crafter', state => ({ ...state, craftLevel: 1 }), ['craft', 'crafter']],
            ['route', state => stat(state, { karma: 700 }), ['route', 'route.karma']],
            ['hour', state => money(state, 2, 1), ['hour', 'weight']],
            ['maxMp', state => ({ ...state, vitals: { ...state.vitals, maxMp: 301 } }), ['maxMp']]
        ];
        // The catalog turns for every bot (its own check, last).
        for (const [name, move, moved, extra] of [...rows.filter(row => row[0] !== 'spawns')
            .map(([name, move, moved, extra]) => [name, name === 'samples' ? sampledThird : move, moved, extra]), ...others])
            assert.deepEqual(movedNames(before, versions(move(base), null, null, extra?.mode)), moved.sort(), `moving ${name} moves its version only`);
        assert.deepEqual(movedNames(before, versions(base, [1, 2])), ['recipes'], 'the recipe book moves its version only');
        const lines = rows => ({ ownerLines: () => rows });
        assert.deepEqual(movedNames(before, versions(base, null, lines([{}]))), ['ownLines'], 'own board lines move theirs only');
        assert.deepEqual(movedNames(before, versions(base, null, null, null, ['rich', 900])), ['income'], 'the income answer moves its own');
        // A crafter's own lines: the lines it sells, by item, count and price.
        const crafter = { ...base, craftLevel: 1 }, sell = { storeType: 1, selfId: 1835, count: 10, price: 5 };
        const sold = rows => versions(crafter, null, lines(rows)).ownLines;
        assert.notEqual(sold([sell]), sold([{ ...sell, count: 9 }]), 'a crafter\'s line sold moves its lines');
        assert.equal(sold([sell]), sold([sell, { ...sell, storeType: 3, selfId: 1 }]), 'its buy lines do not');
        // A shot crafter's supply: its shots and potions present or not.
        const shotBook = [20], shot = Shots.planForState(base);
        const supplied = state => versions(state, shotBook).supply;
        assert.equal(versions(base).supply, null, 'no shot recipe, no supply input');
        assert.notEqual(supplied(base), supplied({ ...base, inventory: { ...base.inventory, [shot.selfId]: { selfId: shot.selfId, amount: 1 } } }),
            'a shot crafter\'s shots arriving move its supply');
        assert.deepEqual(movedNames(before, versions({ ...base, stats: { ...base.stats } })), [], 'a copy of the state moves nothing');
        const declared = Object.values(Sections.LINK_INPUTS).flatMap(link => [...link.discrete, ...link.continuous]);
        assert(declared.every(name => Object.hasOwn(before, name)), 'every declared input has a version');
        const covered = new Set([...rows, ...others].map(row => row[0]).concat('recipes', 'ownLines', 'weight', 'income', 'supply'));
        assert.deepEqual(Object.keys(before).filter(name => !covered.has(name) && !name.startsWith('route.')), [],
            'every version is moved here (the route fields: test_economic_trip_marginal)');
        assert.equal(Sections.movedInput('incomeSearch', before, versions(money(base, 1.0001, 1)), 0.01), '', 'a weight drift inside the error keeps');
        assert.equal(Sections.movedInput('incomeSearch', before, versions(money(base, 4, 1)), 0.01), 'weight', 'one beyond it moves');
        catalogTurned();
        assert.deepEqual(movedNames(before, versions(base)), ['spawns'], 'a turned catalog moves its version only');
    }
    // What raises sections the search keys on no input of: the rebuild keeps
    // the held spot with no search (a clan change, a learned recipe, a friend
    // change, the income_moved echo with no moved hold, a spot found
    // unhuntable on the same spot and kit), though another spot turned better.
    // The observation bit alone asks one search.
    {
        const Reaction = invoke('GameServer/Bot/Economy/Reaction');
        const stat = (state, more) => ({ ...state, stats: { ...state.stats, ...more } });
        const raised = (state, link) => stat(state, { wishDirty: Sections.sectionMask(Reaction.sections(link)) });
        const cases = [
            ['a clan change', state => raised({ ...state, clanId: 77 }, 'relations')],
            ['a learned recipe', state => raised(stat(state, { recipes: [5] }), 'recipes')],
            ['a friend change', state => raised(stat(state, { relations: [{ targetId: 990999, affinity: 1 }] }), 'relations')],
            ['the income_moved echo', state => raised(state, 'income_moved')],
            ['unhuntable on the same spot', state => raised(state, 'unhuntable')]
        ];
        let id = 990340;
        for (const [what, move] of cases) {
            const { built, state } = settled(++id);
            const read = count(() => Economy.forState(move(sampled(state, 'poor')), deps(1)));
            assert.notEqual(read.result.plan, built.plan, `fixture: ${what} rebuilds`);
            assert.equal(read.searches, 0, `${what} does not search`);
            assert.equal(read.result.hunt.spotId, 'rich', `${what} keeps the held spot`);
        }
        const { state } = settled(++id);
        const observed = count(() => Economy.forState(stat(sampled(state, 'poor'), { wishDirty: Sections.sectionBit('observation') }), deps(1)));
        assert.equal(observed.searches, 1, 'the observation bit searches once');
        assert.equal(observed.result.hunt.spotId, 'poor', 'on the new samples');
    }
    // The crowd (decision links step 3): the held answer stands on its
    // candidates' hunters (the crowd key), with no window. The bot stands on
    // 'poor' and holds 'rich', which holds nine bots: others joining it short
    // of that, or crowding a spot the answer does not need, keep the hold with
    // no search, on every path; the one that fills it searches once and the
    // bot takes the other spot; one leaving opens it again: one search, back.
    {
        const { SpotOccupancyIndex } = invoke('GameServer/Bot/Population/SpotOccupancyIndex');
        const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
        const index = new SpotOccupancyIndex();
        let next = 991000;
        const join = (n, spotId) => { for (let i = 0; i < n; i++) index.update({ characterId: next++, activity: 'hunting', spotId }); };
        Spots.useOccupancy(() => index);
        try {
            const { built, state } = settled(990290);
            join(8, 'rich'); join(5, 'poor');
            for (const minute of [1, 300]) {
                const read = count(() => Economy.forState(state, deps(minute)));
                assert.equal(read.searches, 0, `a crowd inside its key does not search (${minute} game minutes)`);
                assert.equal(read.result.plan, built.plan, 'and the held build stands');
                const stock = count(() => Economy.basics(state, deps(minute)));
                assert.equal(stock.searches, 0, 'the basics neither');
                assert.equal(stock.result.hunt.spotId, 'rich', 'on the held spot');
            }
            join(1, 'rich');
            const full = count(() => Economy.forState(state, deps(301)));
            assert.equal(full.searches, 1, 'the bot that fills the held spot searches once');
            assert.equal(full.result.hunt.spotId, 'poor', 'and the bot takes the other spot');
            assert.equal(count(() => Economy.forState(state, deps(302))).searches, 0, 'once');
            index.remove(String(next - 1));
            const freed = count(() => Economy.forState(state, deps(303)));
            assert.equal(freed.searches, 1, 'a place freed on the better spot searches once');
            assert.equal(freed.result.hunt.spotId, 'rich', 'and the bot goes back');
        } finally { Spots.useOccupancy(null); }
    }
    // The consumable prices (decision links step 3): a table spot's costs are
    // its shots and potions at the bot's own price beliefs, a line in each
    // price, so the held answer stands over the prices around the ones it read
    // (the ranges of its stands) and a read replays it at the prices now. A
    // deal of another item in the shot's or the potion's market counter moves
    // every such belief a little: no search, on every path. A shot price past
    // the range searches once: short of the crossing the same spot renews in
    // place, past it the bot moves. Whatever the hold keeps, a fresh search at
    // the prices of that read gives the same answer.
    {
        const Table = invoke('GameServer/Bot/AI/SpotValueTable');
        const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
        const FirstPrice = invoke('GameServer/Bot/Economy/FirstPrice');
        const Shots = invoke('GameServer/Inventory/ShotStock');
        const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
        const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
        Counters.reset();
        Table.useSpots([]);
        const probe = fighter(990510);
        const shotId = Shots.planForState(probe).selfId, potionId = Potions.purchasePotionFor(probe).selfId;
        // Another item of each one's counter, with a first price (the counter's index reads it).
        const kin = id => Data.items.map(item => item.selfId).find(other => other !== id && Counters.counterOf(other) === Counters.counterOf(id)
            && FirstPrice.cachedFirstPrice(other, { timestamp: time(0) }) > 0);
        const shotKin = kin(shotId), potionKin = kin(potionId);
        assert(shotKin && potionKin, 'fixture: another item in the shot\'s and the potion\'s counter');
        const firstOf = id => FirstPrice.cachedFirstPrice(id, { timestamp: time(0) });
        // A first deal at its first price opens each counter's index at zero: the beliefs as before.
        for (const id of [shotKin, potionKin]) Counters.deal(id, firstOf(id), 1, time(0));
        // The band's best charged table spot, where the bot stands, and one its samples know.
        const [tableId, otherId] = Route.spotList(probe).ids(true, 10, -15);
        const ground = [tableId, otherId].map((id, at) => ({ id, avgLevel: 10, minLevel: 10, maxLevel: 10, density: 10,
            tagsAuthoritative: true, tags: ['starter'], npcEntries: [], center: { locX: -80000 + at * 1000, locY: 250000, locZ: 0 } }));
        let native = { ...fighter(990511), spotId: tableId, loc: ground[0].center };
        const own = Economics.create(native, { timestamp: started })(ground[0], true);
        assert(own?.shotUnits > 0, 'fixture: the table spot pays for its shots');
        for (let n = 0; n < 3; n++) native = { ...native, stats: { ...native.stats, huntEfficiency: Hunt.record(native, { spotId: otherId,
            timestamp: started, cycleMs: 3600000, exp: 0.2 * own.exp, adena: 0.2 * own.income, loot: 0, costs: 0, kills: 0.6 * own.kills }) } };
        const on = minute => ({ spots: ground, timestamp: time(minute) });
        const built = Economy.forState(native, on(0));
        assert.equal(built.hunt.spotId, tableId, 'fixture: the bot earns at its table spot');
        const state = published(native, built);
        assert.equal(count(() => Economy.forState(state, on(1))).searches, 0, 'fixture: the hold stands');
        const answerOf = route => route ? `${route.spot.id}|${route.row.useShots}` : null;
        // A read of the hold: its answer and searches, the prices it read and a fresh search at them.
        const read = (minute, path = 'basics') => {
            const before = searches;
            const result = path === 'basics' ? Economy.basics(state, on(minute)) : Economy.forState(state, on(minute));
            const price = path === 'basics' ? result.price : Economy.basics(state, on(minute)).price;
            const prices = [price(shotId), price(potionId)];
            const fresh = nativeSelect(state, { spots: ground, timestamp: time(minute), required: true,
                price: id => Number(id) === shotId ? prices[0] : Number(id) === potionId ? prices[1] : price(id) });
            return { spotId: result.hunt.spotId, searches: searches - before, prices, fresh: answerOf(fresh), plan: result.plan,
                perHour: result.hunt.perHour, freshPerHour: fresh ? fresh.earning * Hunt.onSpotShare(state) : null };
        };
        const held = read(2);
        assert.equal(held.searches, 0, 'fixture: nothing moved');
        assert.equal(held.fresh, `${tableId}|true`, 'fixture: a fresh search agrees');
        // Deals of other items in both counters: each belief moves a little.
        for (const [id, at] of [[shotKin, 3], [potionKin, 4]]) {
            Counters.deal(id, 1.2 * firstOf(id), 1, time(at));
            const quiet = read(at);
            assert.notDeepEqual(quiet.prices, held.prices, `fixture: a deal in the ${id === shotKin ? 'shot' : 'potion'} counter moves the bot's beliefs`);
            assert.equal(quiet.searches, 0, 'a deal of another item in the counter does not search');
            assert.equal(quiet.spotId, tableId, 'and the bot keeps its spot');
            assert.equal(quiet.fresh, `${tableId}|true`, 'as a fresh search at those prices does');
            const build = read(at, 'build');
            assert.equal(build.searches, 0, 'nor does a build');
            assert.equal(build.plan, built.plan, 'which serves the held build');
        }
        // The shot's own deals move its belief further, cheap shots first, then
        // dear ones: a read searches when the price leaves the range the hold
        // stands on, once, and always agrees with a fresh search at its prices,
        // a kept read on its earning too (its numbers at the prices now).
        const walk = (factor, from, done) => {
            for (let minute = from; minute < from + 40; minute++) {
                Counters.deal(shotId, factor * firstOf(shotId), 1, time(minute));
                const next = read(minute);
                assert(next.searches <= 1, 'one search at most');
                assert.equal(next.spotId, next.fresh?.split('|')[0], `the hold agrees with a fresh search at shot ${next.prices[0]}`);
                assert.equal(next.perHour, next.freshPerHour, `and on its earning at shot ${next.prices[0]}`);
                if (done(next)) return next;
            }
            return null;
        };
        let cheapSearches = 0;
        assert.equal(walk(0.3, 10, next => { cheapSearches += next.searches; return false; }), null, 'cheap shots keep the table spot');
        assert.equal(cheapSearches, 0, 'with no search: the moves stay inside the hull, the earner the replay finds');
        assert.equal(Economy.heldSpotMoved(state), false, 'in place');
        const moved = walk(4, 60, next => next.spotId !== tableId);
        assert(moved, 'dear enough shots move the bot off its table spot');
        assert.equal(moved.searches, 1, 'on one search');
        assert.equal(moved.spotId, otherId, 'to the spot its samples know');
        Counters.reset();
    }
    // The crowd and the bot's own arrival on table spots (decision links
    // step 3): the key replays the pick at the counts now and finds there
    // which spot sets its earning, so a crowd on a candidate other than the
    // pick keeps the hold with no search, also one that closes the spot that
    // set the earning; the bot's arrival at its held spot, its own output
    // (only its walks move), replays from there with no search. Every kept
    // read agrees with a fresh search at its inputs: the spot, its charge,
    // the earning and the spot's row.
    {
        const { SpotOccupancyIndex } = invoke('GameServer/Bot/Population/SpotOccupancyIndex');
        const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
        const Table = invoke('GameServer/Bot/AI/SpotValueTable');
        const Economics = invoke('GameServer/Bot/Economy/SpotEconomics');
        const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
        const index = new SpotOccupancyIndex();
        let next = 993000;
        const join = (n, spotId) => { for (let i = 0; i < n; i++) index.update({ characterId: next++, activity: 'hunting', spotId }); };
        Spots.useOccupancy(() => index);
        try {
            Table.useSpots([]);
            const ids = Route.spotList(fighter(990530)).ids(true, 10, -15).slice(0, 4);
            const ground = ids.map((id, at) => ({ id, avgLevel: 10, minLevel: 10, maxLevel: 10, density: 10, tagsAuthoritative: true,
                tags: ['starter'], npcEntries: [], center: { locX: -80000 + at * 1500, locY: 250000, locZ: 0 } }));
            const on = minute => ({ spots: ground, timestamp: time(minute) });
            const agrees = (state, minute, what) => {
                const read = count(() => Economy.basics(state, on(minute)));
                const fresh = nativeSearch(state, { spots: ground, timestamp: time(minute), required: true, price: read.result.price }).route;
                assert.equal(read.searches, 0, `${what}: no search`);
                assert.equal(read.result.hunt.spotId, fresh.spot.id, `${what}: the fresh search's spot`);
                assert.equal(read.result.hunt.useShots, fresh.row.useShots, `${what}: its charge`);
                assert.equal(read.result.hunt.perHour, fresh.earning * Hunt.onSpotShare(state), `${what}: its earning`);
                assert.equal(read.result.hunt.perKill, fresh.row.kills > 0 ? fresh.row.income / fresh.row.kills : 0, `${what}: its row`);
                return read.result.hunt;
            };
            const holding = (characterId, at) => {
                const native = { ...fighter(characterId), spotId: ids[at], loc: ground[at].center };
                const state = published(native, Economy.forState(native, on(0)));
                assert.equal(count(() => Economy.forState(state, on(1))).searches, 0, 'fixture: the hold stands');
                return state;
            };
            // On its pick: the spot paying most besides it sets the earning.
            let state = null, pick = null;
            for (let at = 0; at < ids.length; at++) {
                state = holding(990531 + at * 10, at);
                pick = agrees(state, 2, 'fixture: the held read');
                if (pick.spotId === state.spotId) break;
            }
            assert.equal(pick.spotId, state.spotId, 'fixture: the bot earns where it stands');
            const rows = ground.flatMap(spot => [true, false].map(shots => ({ spot, row: Economics.create(state, { timestamp: time(2) })(spot, shots) })));
            const richest = rows.filter(({ spot, row }) => spot.id !== pick.spotId && row?.income > 0).sort((a, b) => b.row.income - a.row.income)[0];
            assert(richest?.row.income * Hunt.onSpotShare(state) === pick.perHour, 'fixture: another spot sets the earning');
            const quiet = ids.find(id => id !== pick.spotId && id !== richest.spot.id);
            join(1, quiet);
            agrees(state, 3, 'one hunter on a candidate other than the pick');
            join(Routes.roomForSpot(richest.spot), richest.spot.id);
            const closed = agrees(state, 4, 'a crowd that closes the spot setting the earning');
            assert(closed.perHour < pick.perHour, 'another spot sets it now');
            assert.equal(Economy.heldSpotMoved(state), false, 'the hold stands in place');
            // Off its pick: it arrives there.
            let away = null, held = null;
            for (let n = 0; n < ids.length; n++) {
                away = holding(990632 + n * 10, n);
                held = agrees(away, 2, 'fixture: the held read');
                if (held.spotId !== away.spotId) break;
            }
            const at = ids.indexOf(held.spotId), from = ids.indexOf(away.spotId);
            assert.notEqual(at, from, 'fixture: the bot earns at a spot it does not stand on');
            const arrived = { ...away, spotId: ids[at], loc: ground[at].center };
            assert.equal(agrees(arrived, 3, 'the bot\'s arrival at its held spot').spotId, held.spotId, 'it keeps the spot');
            join(1, quiet === ids[at] ? ids[0] : quiet);
            agrees(arrived, 4, 'a crowd after the arrival');
            const elsewhere = ids.find((id, n) => n !== from && n !== at);
            const moved = count(() => Economy.basics({ ...away, spotId: elsewhere, loc: ground[ids.indexOf(elsewhere)].center }, on(5)));
            assert.equal(moved.searches, 1, 'a move to another spot searches');
        } finally { Spots.useOccupancy(null); Table.useSpots([]); }
    }
    // The death recovery's level penalty caps the spawns the search's matchup
    // admits (LevelingRoutes.safetyOptions' maxTargetLevel): held below the
    // better spot's level-10 spawns, the bot earns at the other one. Its clean
    // wins lift the penalty (SpotRiskPolicy.recordRecovery): the step raises it
    // (also far at work), the next build searches once and takes the better
    // spot; the party comparison's own solo search hears it the same way.
    {
        const Data = invoke('GameServer/DataCache');
        const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
        const Targets = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy');
        const recovering = (state, recovery) => ({ ...state, stats: { ...state.stats, huntingRecovery: recovery } });
        const penalized = state => recovering(state, { levelPenalty: 2, cleanWins: 0, resumeExp: 0 });
        const on = minute => ({ spots: guarded, timestamp: time(minute) });
        // A level-10 spawn the bot hunts alone: the better spot is its only ground.
        let guarded = null;
        for (const npc of Data.npcs) {
            if (Number(npc.template?.level) !== 10 || npc.template?.kind !== 'Monster' || !Targets.canHunt(npc)) continue;
            const ground = [spots[0], { ...spots[1], npcSelfIds: [npc.selfId], npcEntries: [{ selfId: npc.selfId, count: 10 }] }];
            const probe = sampled(fighter(990420), 'rich');
            if (nativeSelect(probe, { spots: ground, timestamp: time(0) })?.spot.id === 'rich'
                && nativeSelect(penalized(probe), { spots: ground, timestamp: time(0) })?.spot.id === 'poor') { guarded = ground; break; }
        }
        assert(guarded, 'fixture: a level-10 spawn the penalty refuses and the bot otherwise hunts');
        const native = penalized(sampled(fighter(990421), 'rich'));
        const built = Economy.forState(native, on(0));
        assert.equal(built.hunt.spotId, 'poor', 'fixture: under the penalty the bot earns at the other spot');
        const state = published(native, built);
        assert.equal(count(() => Economy.forState(state, on(1))).searches, 0, 'fixture: the hold stands');
        const lifted = recovering(state, Risk.recordRecovery(state, { wins: 12, exp: Number(state.exp) || 0 }));
        assert.equal(lifted.stats.huntingRecovery.levelPenalty, 0, 'fixture: twelve clean wins lift it');
        const raised = Sections.events(state, lifted);
        assert(raised.includes('occupation'), 'the step that lifts it raises the bot\'s ground');
        const far = state => ({ ...state, phase: 'cold' });
        assert(Sections.events(far(state), far(lifted)).includes('occupation'), 'also far at work');
        const heard = { ...lifted, stats: { ...lifted.stats, wishDirty: Sections.sectionMask(raised) } };
        const read = count(() => Economy.forState(heard, on(2)));
        assert.equal(read.searches, 1, 'the lifted penalty searches once');
        assert.equal(read.result.hunt.spotId, 'rich', 'and the bot takes the better spot');
        // The party comparison's own solo search (no held build for it).
        const solo = penalized(sampled(fighter(990422), 'rich'));
        const first = count(() => Party.soloRoute({ ...solo }, guarded, time(3)));
        assert.equal(first.result.spotId, 'poor', 'fixture: the solo side under the penalty');
        assert.equal(count(() => Party.soloRoute({ ...solo }, guarded, time(4))).searches, 0, 'fixture: kept');
        const again = count(() => Party.soloRoute(recovering(solo, { levelPenalty: 0, cleanWins: 0, resumeExp: 0 }), guarded, time(5)));
        assert.equal(again.searches, 1, 'the lifted penalty searches the solo side again');
        assert.equal(again.result.spotId, 'rich', 'on the better spot');
    }
    // The link counts (developerDiagnostics): a read with nothing moved keeps,
    // however late; a turned catalog, a level up and a risk mark search by
    // their input.
    {
        const Config = invoke('GameServer/Bot/Population/PopulationConfig');
        const counts = () => invoke('GameServer/Bot/Economy/EconomyDiagnostics').metrics().counts || {};
        const diagnosticsBefore = Config.developerDiagnostics;
        Config.developerDiagnostics = true;
        try {
            const before = counts(), delta = key => (counts()[key] || 0) - (before[key] || 0);
            const { state } = heldBot(990330);
            Economy.forState(state, deps(1));
            Economy.forState(state, deps(300));
            assert.equal(delta('link:incomeSearch:kept:quiet'), 2, 'a read with nothing moved keeps');
            catalogTurned();
            Economy.forState(state, deps(301));
            assert.equal(delta('link:incomeSearch:rebuilt:spawns'), 1, 'a turned catalog searches by its input');
            const levelled = { ...state, level: 11 }, rebuilt = Economy.forState(levelled, deps(32));
            assert.equal(delta('link:incomeSearch:rebuilt:kit.level'), 1, 'a level up searches by its input');
            const marked = { ...published(levelled, rebuilt), stats: { ...published(levelled, rebuilt).stats,
                capacityBackoffs: [{ spotId: 'poor', untilStep: 5 }] } };
            const searched = count(() => { Economy.forState(marked, deps(33)); Economy.forState(marked, deps(34)); });
            assert.equal(searched.searches, 1, 'a mark on a spot the held leaf does not hunt searches once');
            assert.equal(delta('link:incomeSearch:rebuilt:exclusions'), 1, 'by its input');
            assert.equal(Economy.linkStats().incomeSearch.maskOnly, undefined, 'no mask split for a link on its key');
            assert(Economy.incomeHoldStats().event.exclusions >= 1, 'the worker\'s incomeHold line counts it');
        } finally { Config.developerDiagnostics = diagnosticsBefore; }
    }
    // A far bot in the field needs no bag rows: a read list past its bound leaves it its proof.
    {
        const { built, state } = heldBot(990250);
        const plan = { ...built.plan, quantityInputs: null };
        assert(Economy.captureEventProof({ ...state, phase: 'cold' }, deps(0), { plan }), 'a hunter keeps its proof');
        assert.equal(Economy.captureEventProof(state, deps(0), { plan }), null, 'a bot near a player does not');
    }
    Economy.reset();
    console.log(`PASS held earning spot: no time window, inputs on every path, goal change, crowd, recovery, moved hold, held null ${isMainThread ? 'main' : 'worker'}`);
}
try { verify(); } finally { Route.select = nativeSelect; Route.search = nativeSearch; Generation.configure(generation); }
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
}
