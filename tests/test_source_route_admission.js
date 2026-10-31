'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const drain = iterator => { let step; do step = iterator.next(); while (!step.done); return step.value; };
const timestamp = 1791825000000;
// The native C-grade kit and source species from the stalled level-55 spoiler,
// without its Chain Gaiters (381): the gargoyle's survival 0.85 sits under the
// solo gate (1.0, T132), the wyrm's 0.11 far under it.
const state = { characterId: 990003, level: 55, spotId: '17_20',
    vitals: { hp: 2500, mp: 700 }, stats: { race: 4, classId: 55,
        coldCombat: { classId: 55, skillSource: 'native', skills: [] } },
    inventory: Object.fromEntries([161, 1149, 354, 631, 2452, 2429, 852, 882, 914].map((id, index) => {
        const item = Data.items.find(item => item.selfId === id);
        return [id, { selfId: id, amount: 1, equipped: true, equippedCount: 1,
            slot: Number(item.etc.slot), rank: item.etc.rank, kind: item.template.kind,
            instances: [{ id: 9900000 + index, amount: 1, equipped: true, slot: Number(item.etc.slot), enchant: 0 }] }];
    })) };
const spot = { id: '17_20', name: 'Thunder Wyrm fields', minLevel: 47, maxLevel: 66,
    avgLevel: 52, capacity: 8, density: 6, levelCounts: { 53: 4, 66: 2 }, tags: [],
    center: { locX: 105073, locY: 121810, locZ: -3531 },
    npcEntries: [{ selfId: 242, level: 53, count: 4 }, { selfId: 707, level: 66, count: 2 }],
    npcSelfIds: [242, 707] };
assert(Planner.soloSafeForSource(state, { npcId: 242, npcLevel: 53 }), 'the individual-source gate admits the gargoyle');
assert.equal(Routes.isSpotAllowedForState(spot, state, { mode: 'solo', timestamp }), false,
    'the native executor refuses the whole spot for this kit');
const facts = options => drain(Planner.sourceFacts(state, 951, 1,
    { spots: [spot], timestamp, spotValue: () => ({ kills: 100, valueHours: 2 }), ...options }));
const gargoyle = facts().find(row => row.npcId === 242 && row.kind === 'drop');
assert(gargoyle, 'the native gargoyle drops C weapon enchant scrolls');
assert.equal(gargoyle.reason, 'route_ineligible', 'an unsafe route cannot become a free enchant-scroll farm');
assert.deepEqual(facts({ readyOnly: true }), [], 'the wish reader receives no unreachable farm');

// A new decision must judge current combat state, while one projection shares
// the same spot verdict across all item sources and builds its profiles once.
const original = { gate: Routes.isSpotAllowedForState, profiles: Matchup.stateProfiles };
let gates = 0, profiles = 0;
try {
    Routes.isSpotAllowedForState = (_spot, _state, options) => {
        gates++; assert.equal(options.mode, 'solo'); assert.equal(options.timestamp, timestamp); return true;
    };
    Matchup.stateProfiles = (...args) => { profiles++; return original.profiles(...args); };
    const routeAllowed = Planner.sourceRouteReader(state, { timestamp, spots: [spot] });
    assert(facts({ routeAllowed }).some(row => row.status === 'ready'), 'an allowed source remains available');
    facts({ routeAllowed });
    assert.equal(gates, 1, 'one spot gate per projection, not per material or NPC');
    assert.equal(profiles, 1, 'one combat profile set per projection');
    const tooLow = { ...spot, id: '8_2', minLevel: 43, maxLevel: 46, avgLevel: 45,
        levelCounts: { 43: 4, 46: 2 } };
    assert.equal(routeAllowed(tooLow), false, 'a safe spot outside the route level band is still refused');
    Routes.isSpotAllowedForState = () => false;
    assert.deepEqual(facts({ readyOnly: true }), [], 'a fresh decision discards the old allowed verdict');
} finally { Routes.isSpotAllowedForState = original.gate; Matchup.stateProfiles = original.profiles; }

// The bot's ground verdict kept with its held build (Planner.sourceGround,
// handed back while no source section moved) still follows what moves no
// section: a lower spot is ground for this bot only while its wish focus is
// an economic hunt, and a spot exclusion refuses it only while the mark lasts.
{
    const nakondas = Data.npcs.find(npc => npc.selfId === 713);
    const low = { id: '8_42', name: 'Nakondas field', minLevel: 42, maxLevel: 42, avgLevel: 42, capacity: 8, density: 6,
        levelCounts: { 42: 6 }, tags: [], center: spot.center,
        npcEntries: [{ selfId: nakondas.selfId, level: 42, count: 6 }], npcSelfIds: [nakondas.selfId] };
    const spots = [spot, low];
    const ground = Planner.sourceGround(spots);
    const allowed = (bot, kept = ground) => Planner.sourceRouteReader(bot, { timestamp, ground: Planner.sourceGround(spots, kept) })(low);
    const economic = { ...state, stats: { ...state.stats, wishFocus: ['power:101:7', 1, 50], stepCount: 10 } };
    assert.equal(allowed(state), false, 'a spot 13 levels below the bot is no ground for an ordinary hunt');
    assert.equal(allowed(economic), true, 'an economic-hunt focus admits it within the held build');
    assert.equal(allowed(state), false, 'the ordinary focus refuses it again');
    assert.equal(allowed(economic), true, 'fixture: allowed before the mark');
    const marked = { ...economic, stats: { ...economic.stats, spotBackoffs: [{ spotId: low.id, untilStep: 12 }] } };
    assert.equal(allowed(marked), false, 'a spot exclusion marked after the build refuses the spot');
    assert.equal(allowed({ ...marked, stats: { ...marked.stats, stepCount: 12 } }), true,
        'the expired mark leaves the spot allowed, with no section moved');
    // Party-only ground: refused to the bot alone, admitted once it joins a
    // party (a relations move, which no longer drops the kept verdict).
    const partyGround = { ...low, id: '8_43', tags: ['party_required'], tagsAuthoritative: true };
    const partySpots = [partyGround], kept = Planner.sourceGround(partySpots);
    const onParty = bot => Planner.sourceRouteReader(bot, { timestamp, ground: Planner.sourceGround(partySpots, kept) })(partyGround);
    assert.equal(onParty(economic), false, 'party-only ground is refused to the bot alone');
    assert.equal(onParty({ ...economic, party: { partyId: 77 } }), true, 'the same ground is admitted in a party');
    assert.equal(onParty(economic), false, 'and refused again after the party');
}
// The kept verdict also follows the bot's solo profiles, which move no
// section: a summon beside it (its live cold summon) and its death (a dead
// bot has no profiles, so no spot is refused for its kit).
{
    const spots = [spot], kept = Planner.sourceGround(spots);
    const allowed = bot => Planner.sourceRouteReader(bot, { timestamp, ground: Planner.sourceGround(spots, kept) })(spot);
    const summon = { active: true, npcId: 12077, skillId: 1111, hp: 5000, maxHp: 5000, pAtk: 3000, pDef: 2000,
        accur: 200, critical: 10, atkSpd: 400, expiresAt: timestamp + 600000 };
    const summoned = { ...state, stats: { ...state.stats, coldCombat: { ...state.stats.coldCombat, summon } } };
    const dead = { ...state, vitals: { ...state.vitals, hp: 0 } };
    assert.equal(allowed(state), false, 'the kit alone is refused on the spot');
    assert.equal(allowed(state), false, 'and still refused while nothing changes');
    assert.equal(allowed(summoned), true, 'a summon beside the bot admits the spot within the held build');
    assert.equal(allowed(summoned), true, 'and keeps it admitted while it lives');
    assert.equal(allowed({ ...summoned, stats: { ...summoned.stats, coldCombat: { ...summoned.stats.coldCombat,
        summon: { ...summon, expiresAt: timestamp - 1 } } } }), false, 'an expired summon leaves the kit alone again');
    assert.equal(allowed(dead), true, 'a dead bot has no profiles, so its kit refuses nothing');
    assert.equal(allowed(state), false, 'alive again, the kit refuses it');
}
console.log('test_source_route_admission: ok');
