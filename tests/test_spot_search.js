'use strict';
// The one solo spot search (SpotSearch.rank): for each goal (the earning decision's income in
// test_held_earning_spot; an item's source and the leveling list here) bots of one band keep their own
// favourite among the spots within the habit band of the best value, pick after pick; a spot the bot's
// marks refuse is never picked; and the habit asks few verdicts (ground and matchup): the best passing
// one, then only the band's candidates rolling above it.
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Search = invoke('GameServer/Bot/AI/SpotSearch');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');

// Two bots of one band whose favourites differ among `ids` (pick(botId) -> spot id).
function twoBots(ids, pick) {
    const picks = new Map();
    for (let id = 993000; id < 993200 && picks.size < ids.length; id++) {
        const spotId = pick(id);
        if (ids.includes(spotId) && !picks.has(spotId)) picks.set(spotId, id);
    }
    assert.deepEqual([...picks.keys()].sort(), [...ids].sort(), 'fixture: bots of one band favour different spots');
    return picks;
}

// An item's source (the gear plan's pick at plan time and at route time): three sources of one item at
// the bot's level, two within the band, one that leaves it.
{
    const level = 30;
    const source = (spotId, expectedYield) => ({ spotId, npcId: 20000 + spotId.length, npcLevel: level, spotLevel: level,
        expectedYield, sourceKind: 'drop', kind: 'drop' });
    const bot = characterId => ({ characterId, level, stats: {} });
    let third = 0.9;
    const sources = () => [source('src-a', 1), source('src-b', 0.95), source('src-c', third)];
    const pick = (characterId, options = {}) => Planner.bestSourceForState(sources(), bot(characterId), options)?.spotId;
    const picks = twoBots(['src-a', 'src-b'], pick);
    third = 0.5;
    for (const [spotId, characterId] of picks) {
        assert.equal(pick(characterId), spotId, 'each keeps its own source after a third leaves the band');
        assert.equal(pick(characterId), spotId, 'and at the next search');
        assert.notEqual(pick(characterId, { excludedSpotIds: new Set([spotId]) }), spotId, 'a marked source in the band is never picked');
    }
    assert.equal(Planner.bestSourceForState(sources(), bot(picks.get('src-b')), { clanCrafting: true })?.spotId, 'src-a',
        'a clan\'s operation takes the best source: no habit');
    // The favourite is counted once per pick the bot takes (the route's or the earning answer: countHabit), never
    // by a check that only asks whether a source exists or a plan-time comparison.
    const Situations = invoke('GameServer/Bot/Situations');
    const habits = () => Situations.counts().raised['spot:habit:other'] || 0;
    const before = habits();
    assert.equal(pick(picks.get('src-b')), 'src-b', 'fixture: its favourite is not the best source');
    assert.equal(habits(), before, 'a check counts no habit');
    assert.equal(pick(picks.get('src-b'), { countHabit: true }), 'src-b');
    assert.equal(habits(), before + 1, 'the pick it takes counts once');
}

// The source pick is by the bot's own value, whatever order the list comes in: the item's source list is
// shared by bots of one level, ranked by the effort of the bot that filled it, and a source one bot must
// fight in a party (its effort raised) another holds alone. Native archer kit; without its armour the
// same archer is weaker.
{
    const inventory = {};
    for (const [id, slots] of [[43, [6]], [50, [9]], [274, [14]], [390, [10]], [412, [11]],
        [847, [1, 2]], [890, [4, 5]], [907, [3]], [1122, [12]]]) {
        inventory[id] = { selfId: id, amount: slots.length, equipped: true, equippedCount: slots.length, equippedSlots: slots, slot: slots[0] };
    }
    const archer = (characterId, kit = inventory) => ({ characterId, level: 31, stats: { classId: 35, role: 'archer' }, inventory: kit });
    const unarmoured = Object.fromEntries(Object.entries(inventory).filter(([id]) => ['274', '847', '890', '907'].includes(id)));
    const strong = Planner.combatReadiness(archer(1)).effectiveLevel, weak = Planner.combatReadiness(archer(1, unarmoured)).effectiveLevel;
    assert(strong > weak, `fixture: armour raises the archer (${weak} -> ${strong})`);
    const easy = { spotId: 'src-easy', npcId: 20001, npcLevel: 25, spotLevel: 25, expectedYield: 1, sourceKind: 'drop', kind: 'drop' };
    const rich = { spotId: 'src-rich', npcId: 20002, spotLevel: (strong + weak) / 2, expectedYield: 1.3, sourceKind: 'drop', kind: 'drop' };
    const order = [easy, rich].sort((a, b) => Planner.sourceEffort(a, archer(1, unarmoured)) - Planner.sourceEffort(b, archer(1, unarmoured)));
    assert.deepEqual(order.map(source => source.spotId), ['src-easy', 'src-rich'], 'fixture: the weaker archer\'s list puts the easy source first');
    for (let characterId = 995000; characterId < 995040; characterId++) {
        assert.equal(Planner.bestSourceForState(order, archer(characterId))?.spotId, 'src-rich',
            `bot ${characterId}: the armoured archer holds the rich source alone and takes it (the easy one is far below its value)`);
    }
}

// The leveling goal (a bot no held answer routes): the game table's list, two suitable camps within the band.
{
    const at = 1800000000000;
    const mage = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
        pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
        equipment: { weaponKind: 'Weapon.Blunt' },
        skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
    const camp = id => ({ id, name: id, minLevel: 29, maxLevel: 29, avgLevel: 29, density: 8, tags: [], tagsAuthoritative: true,
        center: { locX: 50000, locY: 150000, locZ: -3000 }, npcEntries: [{ selfId: 156, count: 8 }], levelCounts: { 29: 8 } });
    const catalogue = [camp('camp-a'), camp('camp-b'), camp('camp-c')];
    let third = 92;
    const list = { spoiler: () => null,
        values: () => [{ spotId: 'camp-a', value: 100 }, { spotId: 'camp-b', value: 96 }, { spotId: 'camp-c', value: third }] };
    const bot = characterId => ({ characterId, level: 29, exp: Number(Data.experience[28]) + 100000, phase: 'cold', activity: 'hunting',
        spotId: null, loc: {}, inventory: {}, timing: {}, vitals: { hp: 592, maxHp: 592, mp: 932, maxMp: 932 },
        stats: { classId: 12, classProgressionClassId: 12, classProgressionLevel: 29, deaths: 0 } });
    const options = { matchupProfiles: [mage], timestamp: at, profiles: catalogue, list };
    assert(catalogue.every(spot => SpotService.isSuitable(spot, 29) && Routes.isSpotAllowedForState(spot, bot(1), options)),
        'fixture: every camp suits and admits the mage');
    const pick = (characterId, extra = {}) => Spots.findForState(bot(characterId), { ...options, ...extra })?.id;
    const picks = twoBots(['camp-a', 'camp-b'], pick);
    third = 50;
    for (const [spotId, characterId] of picks) {
        assert.equal(pick(characterId), spotId, 'each keeps its own camp after a third leaves the band');
        assert.equal(pick(characterId), spotId, 'and at the next search');
        assert.notEqual(pick(characterId, { excludedSpotIds: new Set([spotId]) }), spotId, 'a marked camp in the band is never picked');
    }
}

// The habit's verdicts: ten candidates in the band, the first passes: at most two verdicts asked
// (the best one's and the favourite's), whoever the bot.
{
    const candidates = Array.from({ length: 10 }, (_, at) => ({ spot: { id: `band-${at}` }, value: 100 - at }));
    for (let characterId = 994000; characterId < 994050; characterId++) {
        let asked = 0;
        const { pick } = Search.rank({ characterId }, { candidates, sorted: true, value: candidate => candidate.value },
            { allowed: () => { asked++; return true; }, habit: true });
        assert(pick, 'a pick');
        assert(asked <= 2, `bot ${characterId}: ${asked} verdicts asked for one pick`);
    }
}

// The checks cap (maxChecks): a bot's search that asked its first candidates, none passing, while
// more wait unasked finds none by the cap, counted apart from a search that ran out of candidates.
{
    const Situations = invoke('GameServer/Bot/Situations');
    const capped = () => Situations.counts().raised['spot:search:capped'] || 0;
    const candidates = Array.from({ length: 4 }, (_, at) => ({ spot: { id: `capped-${at}` }, value: 10 - at }));
    const search = (maxChecks, allowed = () => false) => Search.rank({ characterId: 994100 }, { candidates, sorted: true,
        value: candidate => candidate.value }, { allowed, maxChecks, count: true }).pick;
    const before = capped();
    assert.equal(search(2), null, 'none of the two asked passes');
    assert.equal(capped(), before + 1, 'the cap left two unasked: counted');
    assert.equal(search(4), null, 'every candidate asked, none passes');
    assert.equal(search(2, candidate => candidate.spot.id === 'capped-1')?.spot.id, 'capped-1', 'a pick inside the cap');
    assert.equal(capped(), before + 1, 'neither counts the cap');
}

console.log('spot search tests passed');
