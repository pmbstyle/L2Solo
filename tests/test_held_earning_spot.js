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
const Party = invoke('GameServer/Bot/Population/PartyProgressComparison');
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
            refillReserve: 0, firstUnfundedPrice: 0 }) } };
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
        // A build its own situation woke (the shots under their line) reads the held answer, with no search.
        const supply = raised(priced, 'stock_low:shots');
        const rebuilt = count(() => Economy.forState(supply, deps(301)));
        assert.equal(rebuilt.searches, 0, 'a build woken by its own sections reads the held answer');
        assert.equal(rebuilt.result.hunt.spotId, 'rich');
        assert.equal(rebuilt.result.statsPacket.earning, undefined, 'and publishes no new answer');
    }

    // Its situations: each heard where it stands wakes one search, which may move it.
    const turned = sampled(held, 'poor');
    {
        const atWork = raised(turned, 'grade_changed');
        const waiting = count(() => Economy.forState(atWork, deps(2)));
        assert.equal(waiting.searches, 0, 'a new grade at work waits');
        const rested = raised(turned, 'grade_changed', { stop: Situations.REST });
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
    for (const name of ['died', 'spot_empty', 'spot_dangerous', 'party_left']) {
        const woken = raised(turned, name);
        const read = count(() => Economy.forState(woken, deps(7)));
        assert.equal(read.searches, 1, `${name} wakes one search`);
        assert.equal(published(woken, read.result).stats.earning.spotId, 'poor', `${name}: the bot moves to the better spot`);
    }
    // Woken alone (a contest lost, the recovery lifted), the decision is taken alone: one search, no build
    // (its new answer wakes none; the hunting leaf reads the answer's spot).
    {
        const lost = raised(turned, 'contest_lost');
        assert.equal(Situations.woken(lost.stats, 'build'), false, 'fixture: the build sleeps');
        const alone = count(() => Economy.decideEarning(lost, deps(7)));
        assert.equal(alone.searches, 1, 'one search');
        assert.equal(alone.result.earning.spotId, 'poor', 'the bot moves to the better spot');
        const after = { ...lost, stats: { ...lost.stats, ...alone.result } };
        assert.equal(Situations.woken(after.stats, 'earning_spot'), false, 'its bit cleared');
        assert.equal(Situations.woken(after.stats, 'build'), false, 'and no build woken');
        assert.equal(count(() => Economy.decideEarning(after, deps(8))).result, null, 'nothing left to take');
    }
    // Survival drinks (situations.md A5): a spot that needs them of the bot (the table's bot drinks there and this
    // bot's HP margin does not carry a fight) is skipped by a bot that cannot drink (its potions under their line
    // and its money above the refill short of an hour of them); a funded bot stays and buys them. Low potions
    // wake no search (a bot buys them): a broke bot moves on at its next death or dangerous spot.
    {
        const Table = invoke('GameServer/Bot/AI/SpotValueTable'), native = { value: Table.value, cycle: Table.cycle };
        Table.value = (id, ...rest) => id === 'rich' ? { ...(native.value(id, ...rest) || {}), potions: 2 } : native.value(id, ...rest);
        Table.cycle = (id, ...rest) => id === 'rich' ? { ...(native.cycle(id, ...rest) || {}), taken: 1000, pull: 1 } : native.cycle(id, ...rest);
        try {
            const rates = Packet.kitRates({ shotId: 0, shotUse: 0, shotBenefit: 0, shotsCanRestock: false, potionId: 1060,
                potionUse: 2, potionRestUse: 0, potionBenefit: 0.1, scrollHours: 0, outingHours: 1, gapHorizonHours: 0 });
            // It stands on its held spot: the line is its answer's use there (EquipmentIncomeRoute.spotUseOf).
            const kit = (adena, reserve, name = 'died') => ({ ...raised(held, name), adena, spotId: 'rich',
                inventory: { ...held.inventory, 57: { selfId: 57, amount: adena } },
                stats: { ...raised(held, name).stats, kitRates: rates, earning: { ...held.stats.earning, potionsPerHour: 2 },
                    money: Packet.money({ hourAdena: 1000, moneyPrice: 0.001, refillReserve: reserve, firstUnfundedPrice: 0 }) } });
            assert.equal(count(() => Economy.forState(kit(10, 0, 'stock_low:potions'), deps(8))).searches, 0, 'low potions wake no search');
            const broke = count(() => Economy.forState(kit(10, 0), deps(8)));
            assert.equal(broke.searches, 1, 'a death wakes it');
            assert.equal(published(held, broke.result).stats.earning.spotId, 'poor', 'a broke bot moves to a spot that needs no drinks');
            const funded = count(() => Economy.forState(kit(1000000, 0), deps(9)));
            const answer = published(held, funded.result).stats.earning;
            assert.deepEqual([answer.spotId, answer.drinks], ['rich', true], 'a funded bot stays where it drinks, and its answer says so');
        } finally { Table.value = native.value; Table.cycle = native.cycle; }
    }
    // Its own stay disappoints its answer (situations.md Q2): weighed at a rest, once a stay, after enough kills.
    {
        // The bot believes the spot pays 1300 an hour (its persona's bias); unbiased it pays 1000.
        const answer = { spotId: 'rich', income: 1300, expected: 1000, error: 0.2 };
        const stay = (kills, net, judged = false, spotId = 'rich') => ({ spotId, kills, net, ms: 3600000, judged });
        assert.equal(Hunt.disappoints(stay(Hunt.STAY_KILLS, 1000), answer), false, 'hunting at the spot\'s true rate never trips it');
        assert.equal(Hunt.disappoints(stay(Hunt.STAY_KILLS, 750), answer), false, 'inside 50 kills\' sampling noise (0.717)');
        assert.equal(Hunt.disappoints(stay(Hunt.STAY_KILLS, 600), answer), true, 'well below the expectation');
        assert.equal(Hunt.disappoints(stay(400, 750), answer), true, 'more kills, a narrower margin (0.9)');
        assert.equal(Hunt.disappoints(stay(Hunt.STAY_KILLS - 1, 0), answer), false, 'too few kills to tell');
        assert.equal(Hunt.disappoints(stay(Hunt.STAY_KILLS, 0, true), answer), false, 'once a stay');
        assert.equal(Hunt.disappoints(stay(Hunt.STAY_KILLS, 0, false, 'poor'), answer), false, 'only on the answer\'s spot');
        // The stay restarts with a new answer, a level up, a town trip; a party round counts into none.
        const round = { debug: { wins: 10, combatMs: 60000, fights: 10, spotId: 'rich' }, materialize: { adena: 100, items: [] },
            nextResolveAt: started + 60000, patch: {} };
        const on = (state) => Hunt.recordRound(state, round, { spotId: 'rich', timestamp: started }).stay;
        const solo = { ...turned, stats: { ...turned.stats, earning: { ...answer, at: 1 }, visitEvery: [5, 2] } };
        const first = on(solo), second = on({ ...solo, stats: { ...solo.stats, stay: { ...first, judged: true } } });
        assert.equal(second.kills, 20, 'one stay counts its rounds');
        assert.equal(second.judged, true, 'and stays judged');
        for (const [what, moved] of [['a new answer', { ...solo.stats, earning: { ...answer, at: 2 } }],
            ['a town trip', { ...solo.stats, visitEvery: [6, 2] }]]) {
            const fresh = on({ ...solo, stats: { ...moved, stay: { ...second } } });
            assert.equal(fresh.kills, 10, `${what} starts a new stay`); assert.equal(fresh.judged, false);
        }
        assert.equal(on({ ...solo, level: solo.level + 1, stats: { ...solo.stats, stay: second } }).kills, 10, 'a level up starts a new stay');
        assert.equal(on({ ...solo, party: { partyId: 'p3' }, stats: { ...solo.stats, stay: second } }), null, 'a party round counts into no solo stay');
        const heard = count(() => Economy.forState(raised(turned, 'spot_disappoints', { stop: Situations.REST }), deps(7)));
        assert.equal(heard.searches, 1, 'a disappointing stay wakes one search at the rest');
    }
    // The body's inputs (situations.md B6, §14). A spot it could not reach, or ground it may not hunt alone, is
    // marked: the search passes it by; a situation raised after it before the search keeps it; the earning
    // decision taken clears it (no clock, never a wake).
    const raisedWith = (state, name, payload) => ({ ...state,
        stats: Situations.raise({ ...state.stats }, name, payload, Situations.place(state), state.characterId) });
    {
        const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
        const failed = raised(raisedWith(turned, 'spot_unreachable', { spotId: 'poor', reason: 'walk_timeout' }), 'died');
        assert(Risk.isMarked(failed.stats, 'poor'), 'a wake raised after the mark keeps it');
        const read = count(() => Economy.forState(failed, deps(15)));
        assert.equal(read.searches, 1, 'spot_unreachable wakes one search');
        assert.equal(read.result.statsPacket.earning.spotId, 'rich', 'which passes the unreachable spot by');
        const after = published(failed, read.result);
        assert.equal(Risk.isMarked(after.stats, 'poor'), false, 'the decision taken clears the mark');
        assert.equal(Economy.forState(raised(after, 'died'), deps(16)).statsPacket.earning.spotId, 'poor',
            'and the next decision may choose the spot again');
        const unsafe = raisedWith(turned, 'spot_dangerous', { spotId: 'poor', reason: 'party_required_hunting_ground' });
        assert.equal(Economy.forState(unsafe, deps(16)).statsPacket.earning.spotId, 'rich', 'unsafe ground is passed by too');
    }
    // A player's command naming a spot is the held answer itself (no search), and takes the bit its move woke.
    {
        const waiting = raised(raised(held, 'moved_by_world'), 'grade_changed', { at: Situations.place(held) });
        const commanded = raisedWith(waiting, 'player_command', { spotId: 'poor', at: time(17) });
        assert.equal(commanded.stats.earning.spotId, 'poor', 'the command is the held answer');
        assert.equal(commanded.stats.earning.earning, held.stats.earning.earning, 'with the bot\'s hour kept');
        assert.equal(Situations.woken(commanded.stats, 'earning_spot'), false, 'it took the decision');
        assert.equal(Number(commanded.stats.waiting) & 0x101, 0, 'a new grade waiting for the stop does not wake it again');
        const read = count(() => Economy.forState(commanded, deps(17)));
        assert.equal(read.searches, 0, 'a command searches nothing');
        assert.equal(read.result.hunt.spotId, 'poor', 'the bot hunts the commanded spot');
    }
    // Karma: appearing or clearing is the decision's situation, and while it lasts the decision takes the
    // karma wash's choice (its own spot, near and eligible) instead of the best earning.
    {
        const red = { ...held, stats: { ...held.stats, karma: 50 } };
        assert(Situations.detect(held, red).includes('karma_changed'), 'karma that appears is a situation');
        const woken = raised(red, 'karma_changed');
        // The fixture's spots lie in Gludin's peace zone, where no karma washes.
        const peace = utils.isInPeaceZone;
        utils.isInPeaceZone = () => false;
        let read, crafter;
        try {
            read = count(() => Economy.forState(woken, deps(18)));
            // A crafter at its station with karma washes it too (no adventurer gate before the wash).
            crafter = Route.search({ ...woken, stats: { ...woken.stats, craftStationId: 7 } },
                { spots, timestamp: time(18), required: true }).route;
        } finally { utils.isInPeaceZone = peace; }
        assert.equal(crafter?.spot.id, 'poor', 'a crafter with karma gets the wash\'s spot');
        assert.equal(read.searches, 1, 'karma_changed wakes one search');
        assert.equal(read.result.statsPacket.earning.spotId, 'poor', 'which takes the wash\'s spot');
        const washing = published(woken, read.result);
        assert(Situations.detect(washing, { ...washing, stats: { ...washing.stats, karma: 0 } }).includes('karma_changed'),
            'and karma that clears');
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
        // B12: the held answer is a leveling bot's hunting spot too. Its build names it (the hot body walks to the
        // card's leaf) while its hour stays its own, and its cold route goes there, the same after a worker restart
        // (the answer is in the mind; no route is kept on the record).
        const answered = published(geared, decided.result);
        const leveling = { ...answered, stats: { ...answered.stats, wishFocus: geared.stats.wishFocus } };
        assert.equal(Route.earnsOnRoute(leveling, false), false, 'fixture: it levels');
        const built = count(() => Economy.basics(leveling, deps(13)));
        assert.equal(built.searches, 0, 'fixture: nothing woken');
        assert.equal(built.result.hunt.spotId, 'rich', 'the build hunts the held spot');
        assert.notEqual(built.result.hunt.source, 'route', 'with the leveling hour');
        const BotRoute = invoke('GameServer/Bot/Population/BotRoute');
        const routeOf = owner => BotRoute.trip(owner, leveling, null, { spots, timestamp: time(13) })?.spotId;
        const Service = invoke('GameServer/Bot/AI/SpotService'), arrive = Service.arrivalPointForState;
        Service.arrivalPointForState = (_state, spot) => ({ ...spot.center }); // no geodata in this worker
        try {
            const owner = {};
            assert.equal(routeOf(owner), 'rich', 'the cold route goes to the held spot');
            assert.equal(owner.route, undefined, 'and keeps no route of its own');
            assert.equal(routeOf({}), 'rich', 'a restarted worker (a fresh record) routes it the same');
            // Ground it may not hunt alone, held as its answer: the route evacuates it (the search's rule),
            // and nothing is kept on the record.
            const unsafe = { ...spots[0], id: 'unsafe', tags: ['party_required'], center: { locX: -78000, locY: 250000, locZ: 0 } };
            const onUnsafe = { ...leveling, spotId: 'unsafe', loc: unsafe.center,
                stats: { ...leveling.stats, earning: { ...leveling.stats.earning, spotId: 'unsafe' } } };
            const evacuating = {};
            const fled = BotRoute.trip(evacuating, onUnsafe, null, { spots: [...spots, unsafe], currentSpot: unsafe, timestamp: time(13) });
            assert(fled?.spotId && fled.spotId !== 'unsafe', 'unsafe held ground: the route evacuates');
            assert.equal(evacuating.route, undefined, 'no held route is kept on the record');
            // A far bot in town whose answer names no spot asks the decision once per answer, then stays.
            const stranded = { ...leveling, spotId: null, loc: { locX: 0, locY: 0, locZ: 0 },
                stats: { ...leveling.stats, earning: { ...leveling.stats.earning, spotId: null, at: 7 } } };
            const record = {}, tripOf = state => BotRoute.trip(record, state, null, { spots, currentSpot: null, timestamp: time(13) });
            assert.equal(tripOf(stranded)?.ask, 'spot_empty', 'it asks once (the step raises spot_empty)');
            assert.equal(tripOf(stranded), null, 'and waits for the answer');
            const before = Situations.counts().raised['earning:no_spot'] || 0;
            const still = { ...stranded, stats: { ...stranded.stats, earning: { ...stranded.stats.earning, at: 8 } } };
            assert.equal(tripOf(still), null, 'an answer to its ask with none either: it stays');
            assert.equal(Situations.counts().raised['earning:no_spot'], before + 1, 'counted');
        } finally { Service.arrivalPointForState = arrive; }
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
        + 'grade at the rest, gear in town, death, empty, dangerous, party left, potions bought; unreachable marks, a command, karma; '
        + 'party member keeps; none held');
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
