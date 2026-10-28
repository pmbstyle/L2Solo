'use strict';
// ARCH-08-b: a spot search reads the game table's spot list for the bot's
// role and level and takes the first spot it may hunt whose level fits; the
// crowd enters only as the room filter (ROUTE-ROOM: the worker's own index;
// ROUTE-ROOM-4: main's world index for a search on main, a party's counting
// all its members). The real table; a catalogue of its own spots built from
// its authored reward rows (no World in a test); one level 29 mage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
Data.init();
const { SPOT_CELL_SIZE } = invoke('GameServer/World/WorldConstants');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Index = invoke('GameServer/Bot/AI/SpotIndex');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const IncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');

const at = 1800000000000;
const mage = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
    pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
    equipment: { weaponKind: 'Weapon.Blunt' },
    skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
const state = { characterId: 990801, level: 29, adena: 0, phase: 'cold', activity: 'hunting',
    spotId: null, loc: {}, inventory: {}, timing: {},
    vitals: { hp: 592, maxHp: 592, mp: 932, maxMp: 932 },
    stats: { classId: 12, role: 'nuker', deaths: 0 } };
const npcLevel = new Map(Data.npcs.map(npc => [Number(npc.selfId), Number(npc.template?.level || 0)]));
const rows = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/Bots/spot-reward-npcs.json'), 'utf8')).rows;
const profiles = rows.map(([id, entries, adenaMin, adenaMax]) => {
    const [gx, gy] = String(id).split('_').map(Number);
    const levelCounts = {};
    for (const [selfId, count] of entries) {
        const lvl = npcLevel.get(Number(selfId)) || 1;
        levelCounts[lvl] = (levelCounts[lvl] || 0) + count;
    }
    const levels = Object.keys(levelCounts).map(Number);
    const density = entries.reduce((sum, [, count]) => sum + count, 0);
    const avgLevel = Math.round(levels.reduce((sum, lvl) => sum + lvl * levelCounts[lvl], 0) / density);
    return { id: String(id), name: String(id), minLevel: Math.min(...levels), maxLevel: Math.max(...levels),
        avgLevel, density, levelCounts, tags: [],
        center: { locX: (gx + 0.5) * SPOT_CELL_SIZE, locY: (gy + 0.5) * SPOT_CELL_SIZE, locZ: 0 },
        npcEntries: entries.map(([selfId, count]) => ({ selfId, count })), rewards: { adenaMin, adenaMax } };
});
const originalCache = Spots.cache;
Spots.cache = profiles;
const options = { matchupProfiles: [mage], timestamp: at, profiles };
const level = Routes.targetLevelForState(state, options);

// The list's order, read by hand: the first spot the bot may hunt there.
const listed = IncomeRoute.spotList(state, { level }).ids(true)
    .map(id => Index.spotById(profiles, id))
    .filter(spot => spot && !spot.raidBoss && Routes.isSpotAllowedForState(spot, state, options));
const first = listed.find(spot => SpotService.isSuitable(spot, level));
assert(first && listed.length > 1, 'fixture: the mage may hunt several listed spots');
const scored = Routes.bestSpot(profiles.filter(spot => !spot.raidBoss
    && spot.minLevel <= level + 4 && spot.maxLevel >= level - 4
    && Routes.isSpotAllowedForState(spot, state, options)), state, options)?.spot;
assert(scored && scored.id !== first.id, 'fixture: the old score would pick another spot');

const chosen = Spots.findForState(state, options);
assert.equal(chosen?.id, first.id, 'the search takes the first allowed, level-fitting spot of the table list');
const route = Routes.routeMatchFor(first, state, options).route;
assert.equal(chosen.route?.id ?? null, route?.id ?? null, 'the chosen spot carries its own guide route');

const next = listed.find(spot => spot.id !== first.id && SpotService.isSuitable(spot, level));
assert.equal(Spots.findForState(state, { ...options, excludedSpotIds: new Set([String(first.id)]) })?.id, next?.id,
    'an avoided spot is skipped: the next one of the list');
// ROUTE-ROOM: the worker passes its own room filter.
assert.equal(Spots.findForState(state, { ...options, hasRoom: id => String(id) !== String(first.id) })?.id, next?.id,
    'a full spot of the list is skipped: the next one of the list');
assert.equal(Spots.findForState(state, { ...options, hasRoom: () => true })?.id, chosen.id,
    'a filter that finds room everywhere changes nothing');
// ROUTE-ROOM-2: the filter holds for the gear plan's source and the income
// route too: a full one counts as absent, the list walk decides; the bot's
// own spot is never full to it.
{
    const source = listed.find(spot => spot.id !== first.id && spot.id !== next?.id);
    const planning = (spotId = null) => ({ ...state, spotId, stats: { ...state.stats,
        equipmentPlan: { status: 'active', strategy: 'direct_drop', next: { spotId: source.id } } } });
    const noRoomAt = id => other => String(other) !== String(id);
    assert.equal(Spots.findForState(planning(), options)?.id, source.id, 'fixture: the plan\'s source is the pick');
    assert.equal(Spots.findForState(planning(), { ...options, hasRoom: noRoomAt(source.id) })?.id, first.id,
        'a full planned source is skipped: the first spot of the list');
    assert.equal(Spots.findForState(planning(source.id), { ...options, hasRoom: () => false })?.id, source.id,
        'a planned source the bot stands on is taken even when it counts as full');

    // The income route's own pick needs a kit that survives its spots; the
    // naked fixture survives none, so its answer is given here.
    const select = IncomeRoute.select;
    try {
        IncomeRoute.select = () => ({ spot: source });
        assert.equal(Spots.findForState(state, options)?.id, source.id, 'fixture: the income route\'s spot is the pick');
        assert.equal(Spots.findForState(state, { ...options, hasRoom: noRoomAt(source.id) })?.id, first.id,
            'a full income route spot is skipped: the first spot of the list');
    } finally { IncomeRoute.select = select; }
}

// ROUTE-ROOM-4: a market return (GoalExecutor.finishMarketVisit) to the spot
// the bot left goes home while that spot has room; when main's world index
// holds a full spot there, the return goes to another spot the search picks.
{
    const savedCatalogue = SpotService.spots;
    SpotService.spots = profiles;
    try {
        // No class in the stats: no matchup profile refuses a spot, so the
        // search has other spots to offer (the naked mage survives none).
        const shopper = { ...state, activity: 'shopping', currentRegion: 'Giran', adena: 100000,
            inventory: { 57: { selfId: 57, amount: 100000 }, 736: { selfId: 736, amount: 3 } },
            loc: { locX: 83400, locY: 147943, locZ: -3400 }, stats: { role: 'nuker', deaths: 0 } };
        // Home is a spot the shopper may hunt but would not pick first: returning there
        // proves the saved spot is kept, not searched again.
        const head = Spots.findForState({ ...shopper, activity: 'hunting' }, { timestamp: at });
        const homeSpot = head && Spots.findForState({ ...shopper, activity: 'hunting' },
            { timestamp: at, excludedSpotIds: new Set([String(head.id)]) });
        assert(homeSpot && homeSpot.id !== head.id, 'fixture: the classless shopper has two spots of the list');
        const shopping = { ...shopper, stats: { ...shopper.stats, townVisit: { town: 'Giran', completed: true },
            marketReturn: { spotId: homeSpot.id, regionName: homeSpot.name, loc: { ...homeSpot.center } } } };
        const home = GoalExecutor.finishMarketVisit(shopping, at);
        assert.equal(home?.stats.travel.reason, 'return_after_market', 'fixture: the visit ends in a return trip');
        assert.equal(home.stats.travel.spotId, homeSpot.id, 'a saved spot with room: the bot returns home');

        for (let i = 0; i < Routes.roomForSpot(homeSpot); i++) {
            LifeState.acceptLifecycleRow({ characterId: 990950 + i, accountName: `bot_${990950 + i}`,
                characterName: `Home${i}`, level: 29, phase: 'cold', activity: 'hunting', spotId: homeSpot.id,
                statsJson: '{}', inventorySummary: '{}' });
        }
        const elsewhere = GoalExecutor.finishMarketVisit(shopping, at);
        assert.equal(elsewhere?.stats.travel.reason, 'return_after_market', 'a full saved spot: still a return trip');
        assert(Index.spotById(profiles, elsewhere.stats.travel.spotId) && elsewhere.stats.travel.spotId !== homeSpot.id,
            'a full saved spot: the return goes to another spot of the catalogue');

        // No other spot to offer: the bot still goes home, the room is read
        // again at arrival.
        Spots.cache = [homeSpot];
        // The remembered region name differs from the spot's, so the trip shows
        // which of the two the destination was read from.
        const forgetful = { ...shopping, stats: { ...shopping.stats,
            marketReturn: { ...shopping.stats.marketReturn, regionName: 'Remembered ground' } } };
        const alone = GoalExecutor.finishMarketVisit(forgetful, at);
        assert.equal(alone?.stats.travel.reason, 'return_after_market', 'a full saved spot alone: still a return trip');
        assert.equal(alone.stats.travel.spotId, homeSpot.id, 'a full saved spot and no other spot fits: the bot goes home');
        assert.equal(alone.stats.travel.regionName, homeSpot.name, 'the saved spot itself is the destination');
    } finally { SpotService.spots = savedCatalogue; }
}

Spots.cache = originalCache;

// The keep rule holds only a current spot the bot may hunt at its own level.
// A recovery lowers the target level (29 -> 27); the current spot's own
// match reads the ground there, the list walk at the bot's level. Here the
// ground refuses the current spot at 29 and allows it at 27; both spots are
// too thin to fit (density 2), so no spot of the list fits.
{
    const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const Ground = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
    const exp = Number(Data.experience[28]) + 100000;
    const base = { ...state, exp, spotId: 'cur', stats: { ...state.stats, classProgressionClassId: 12,
        classProgressionLevel: 29 } };
    const recovering = { ...base, stats: { ...base.stats,
        huntingRecovery: Risk.recordRecovery(base, { deaths: 1, exp: exp - 100, expBeforeDeath: exp }) } };
    assert.equal(Routes.targetLevelForState(recovering), 27, 'fixture: the recovery lowers the target level');
    const thin = id => ({ id, name: id, minLevel: 25, maxLevel: 25, avgLevel: 25, density: 2, tags: [],
        tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
        npcEntries: [{ selfId: 156, count: 2 }], levelCounts: { 25: 2 } });
    const catalogue = [thin('cur'), thin('other')];
    const saved = { spotList: IncomeRoute.spotList, evaluate: Ground.evaluate, cache: Spots.cache };
    try {
        Spots.cache = catalogue;
        IncomeRoute.spotList = () => ({ spoiler: () => null, ids: () => ['cur', 'other'] });
        Ground.evaluate = (spot, actor, opts = {}) => ({
            allowed: spot.id !== 'cur' || Number(opts.level ?? actor.level) < actor.level });
        const search = { matchupProfiles: [mage], timestamp: at, profiles: catalogue };
        assert(!SpotService.isSuitable(catalogue[0], 27) && !SpotService.isSuitable(catalogue[1], 27),
            'fixture: no listed spot fits');
        assert(Routes.isSpotAllowedForState(catalogue[1], recovering, search), 'fixture: the other spot is allowed');
        assert.equal(Spots.findForState(recovering, search)?.id, 'other',
            'a current spot refused at the bot\'s level is not kept: the first allowed spot of the list');
    } finally {
        IncomeRoute.spotList = saved.spotList; Ground.evaluate = saved.evaluate; Spots.cache = saved.cache;
    }
}
// ROUTE-ROOM: the room filter on thin spots (density 2: none fits) the
// ground allows; the bot's own level, no recovery.
{
    const Ground = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
    const exp = Number(Data.experience[28]) + 100000;
    const bot = { ...state, exp, stats: { ...state.stats, classProgressionClassId: 12, classProgressionLevel: 29 } };
    const thin = (id, density = 2) => ({ id, name: id, minLevel: 25, maxLevel: 25, avgLevel: 25, density, tags: [],
        tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
        npcEntries: [{ selfId: 156, count: density }], levelCounts: { 25: density } });
    const saved = { spotList: IncomeRoute.spotList, evaluate: Ground.evaluate, cache: Spots.cache };
    try {
        Ground.evaluate = () => ({ allowed: true });
        const search = (catalogue, ids, hasRoom) => {
            Spots.cache = catalogue;
            IncomeRoute.spotList = () => ({ spoiler: () => null, ids: () => ids });
            return { matchupProfiles: [mage], timestamp: at, profiles: catalogue, ...(hasRoom ? { hasRoom } : {}) };
        };
        const current = [thin('cur'), thin('other')];
        assert.equal(Spots.findForState({ ...bot, spotId: 'cur' }, search(current, ['other', 'cur'], () => false))?.id,
            'cur', 'the current spot is kept even when it counts as full');

        const listed = [thin('a'), thin('b', 3), thin('c')];
        assert.equal(Spots.findForState(bot, search(listed, ['a']))?.id, 'a',
            'a solo search on main with nobody on the listed spot takes it');
        assert.equal(Spots.findForState(bot, search(listed, ['a'], id => id === 'c'))?.id, 'c',
            'every listed spot full: the near-level fallback skips the full ones too');

        // ROUTE-ROOM-4: a solo search on main reads main's world index (the
        // rows main accepted); spot 'a' holds as many bots as its room.
        for (let i = 0; i < Routes.roomForSpot(listed[0]); i++) {
            LifeState.acceptLifecycleRow({ characterId: 990900 + i, accountName: `bot_${990900 + i}`,
                characterName: `Crowd${i}`, level: 25, phase: 'cold', activity: 'hunting', spotId: 'a',
                statsJson: '{}', inventorySummary: '{}' });
        }
        assert.notEqual(Spots.findForState(bot, search(listed, ['a']))?.id, 'a',
            'a full listed spot is skipped by a solo search on main');
        assert.equal(Spots.findForState({ ...bot, spotId: 'a' }, search(listed, ['a']))?.id, 'a',
            'the bot\'s own spot is never full to it');
        assert.equal(Spots.findForState(bot, search(listed, ['a'], () => true))?.id, 'a',
            'a filter the caller passes is read instead of main\'s index');

        // A party search on main (formation, retreat) counts the whole party
        // (capacityStates) against main's index; its own members standing
        // there are not counted against it. Spot 'c' holds 9: 7 stand there.
        const room = Routes.roomForSpot(listed[2]);
        const crowd = Array.from({ length: room - 2 }, (_, i) => 990960 + i);
        for (const characterId of crowd) {
            LifeState.acceptLifecycleRow({ characterId, accountName: `bot_${characterId}`,
                characterName: `Camp${characterId}`, level: 25, phase: 'cold', activity: 'hunting', spotId: 'c',
                statsJson: '{}', inventorySummary: '{}' });
        }
        const member = characterId => ({ ...bot, characterId });
        const partySearch = members => Spots.findForState(members[0],
            { ...search(listed, ['c']), mode: 'party', capacityStates: members })?.id;
        assert.notEqual(partySearch([member(990980), member(990981), member(990982)]), 'c',
            'a party of 3 is refused at a spot with 2 free places');
        assert.equal(partySearch([member(990980), member(990981)]), 'c', 'a party of 2 fits the 2 free places');
        assert.equal(partySearch([member(990980), member(990981), member(crowd[0])]), 'c',
            'a member standing there is not counted against its own party');
        assert.equal(Spots.findForState(bot, search(listed, ['c']))?.id, 'c', 'a solo bot still takes one free place');
        const index = LifeState.occupancyIndex();
        assert.equal(Spots.roomFilterFor(index, listed, [member(990980), member(990981), member(990982)])('c'), false,
            'the filter: 7 standing + 3 arriving > 9');
        assert.equal(Spots.roomFilterFor(index, listed, [member(crowd[0]), member(crowd[1]), member(990980)])('c'), true,
            'the filter: the party\'s own 2 excluded, 5 + 3 <= 9');
        assert.equal(Spots.roomFilterFor(index, listed, [member(990980)])('c'), true, 'the filter: a solo bot, 7 + 1 <= 9');

        // A party-wait search on main (PartyWaitFallback.spotFor, no filter
        // passed) reads the same index: a full planned spot is no fallback,
        // the level search picks another; one with room is the fallback.
        const safeFallback = GearPlanner.safeFallbackForPlan;
        try {
            const waitingOn = (spotId) => {
                GearPlanner.safeFallbackForPlan = () => ({ spotId, npcId: 321 });
                search(listed, ['a']);
                // No class in the stats: no matchup profile refuses a spot.
                return PartyWaitFallback.spotFor({ ...bot, stats: { role: 'nuker', deaths: 0 } }, { status: 'active' }, listed,
                    { excludedSpotIds: new Set(), timestamp: at })?.spot?.id;
            };
            assert.equal(waitingOn('c'), 'c', 'a planned fallback with room is taken');
            const other = waitingOn('a');
            assert(other && other !== 'a', 'a full planned fallback on main: the level search picks another spot');
        } finally { GearPlanner.safeFallbackForPlan = safeFallback; }
    } finally {
        IncomeRoute.spotList = saved.spotList; Ground.evaluate = saved.evaluate; Spots.cache = saved.cache;
    }
}
console.log('spot list search tests passed');
