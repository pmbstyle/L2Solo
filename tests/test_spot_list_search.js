'use strict';
// The leveling search (SpotSearch.leveling) reads the game table's spot list for
// the bot's role and level and takes a spot it may hunt whose level fits: the
// first such, or the bot's favourite among those within the habit band of its
// value; no search reads the crowd. The real table; a catalogue of its own spots
// built from its authored reward rows (no World in a test); one level 29 mage.
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
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Search = invoke('GameServer/Bot/AI/SpotSearch');

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

// The list's order, read by hand: the spots the bot may hunt there, with their values.
const valueOf = new Map(IncomeRoute.spotList(state, { level }).values(true).map(row => [row.spotId, row.value]));
const listed = [...valueOf.keys()]
    .map(id => Index.spotById(profiles, id))
    .filter(spot => spot && !spot.raidBoss && Routes.isSpotAllowedForState(spot, state, options));
const first = listed.find(spot => SpotService.isSuitable(spot, level));
// The spots a search may take: suitable, listed after none better excluded, within the habit band of the best one's value.
const band = (excluded = new Set()) => {
    const fitting = listed.filter(spot => !excluded.has(String(spot.id)) && SpotService.isSuitable(spot, level));
    return fitting.filter(spot => valueOf.get(spot.id) >= valueOf.get(fitting[0].id) * (1 - Search.HABIT_BAND)).map(spot => spot.id);
};
assert(first && listed.length > 1, 'fixture: the mage may hunt several listed spots');
const scored = Routes.bestSpot(profiles.filter(spot => !spot.raidBoss
    && spot.minLevel <= level + 4 && spot.maxLevel >= level - 4
    && Routes.isSpotAllowedForState(spot, state, options)), state, options)?.spot;
assert(scored && scored.id !== first.id, 'fixture: the old score would pick another spot');

const chosen = Spots.findForState(state, options);
assert(band().includes(chosen?.id), 'the search takes an allowed, level-fitting spot of the table list within the band of the first');
assert.equal(Spots.findForState(state, options)?.id, chosen.id, 'and keeps it at the next search');
const route = Routes.routeMatchFor(Index.spotById(profiles, chosen.id), state, options).route;
assert.equal(chosen.route?.id ?? null, route?.id ?? null, 'the chosen spot carries its own guide route');

const avoided = new Set([String(chosen.id)]);
const next = Spots.findForState(state, { ...options, excludedSpotIds: avoided });
assert(next && next.id !== chosen.id && band(avoided).includes(next.id), 'an avoided spot is skipped: the band of the next ones');
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
        IncomeRoute.spotList = () => ({ spoiler: () => null, values: () => [{ spotId: 'cur', value: 2 }, { spotId: 'other', value: 1 }] });
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
// No search reads the room (the crowd is met at arrival, SpotContest): on thin spots
// (density 2: none fits) the ground allows, at the bot's own level, a crowded spot is
// chosen as an empty one, solo, for a party and for a party waiter.
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
        const search = (catalogue, ids) => {
            Spots.cache = catalogue;
            IncomeRoute.spotList = () => ({ spoiler: () => null, values: () => ids.map(spotId => ({ spotId, value: 1 })) });
            return { matchupProfiles: [mage], timestamp: at, profiles: catalogue };
        };
        const listed = [thin('a'), thin('b', 3), thin('c')];
        // Spot 'a' holds its room, 'c' all but two places.
        for (let i = 0; i < Routes.roomForSpot(listed[0]); i++) {
            LifeState.acceptLifecycleRow({ characterId: 990900 + i, accountName: `bot_${990900 + i}`,
                characterName: `Crowd${i}`, level: 25, phase: 'cold', activity: 'hunting', spotId: 'a',
                statsJson: '{}', inventorySummary: '{}' });
        }
        for (let i = 0; i < Routes.roomForSpot(listed[2]) - 2; i++) {
            LifeState.acceptLifecycleRow({ characterId: 990960 + i, accountName: `bot_${990960 + i}`,
                characterName: `Camp${i}`, level: 25, phase: 'cold', activity: 'hunting', spotId: 'c',
                statsJson: '{}', inventorySummary: '{}' });
        }
        assert.equal(Spots.findForState(bot, search(listed, ['a']))?.id, 'a', 'a full spot is chosen: met at arrival');
        const member = characterId => ({ ...bot, characterId });
        assert.equal(Spots.findForState(member(990980), { ...search(listed, ['c']), mode: 'party',
            capacityStates: [member(990980), member(990981), member(990982)] })?.id, 'c',
        'a party of 3 takes a spot with 2 free places: met as one unit at its arrival');
        const safeFallback = GearPlanner.safeFallbackForPlan;
        try {
            GearPlanner.safeFallbackForPlan = () => ({ spotId: 'a', npcId: 321 });
            search(listed, ['a']);
            // No class in the stats: no matchup profile refuses a spot.
            assert.equal(PartyWaitFallback.spotFor({ ...bot, stats: { role: 'nuker', deaths: 0 } }, { status: 'active' }, listed,
                { excludedSpotIds: new Set(), timestamp: at })?.spot?.id, 'a', 'a full planned fallback is taken');
        } finally { GearPlanner.safeFallbackForPlan = safeFallback; }
    } finally {
        IncomeRoute.spotList = saved.spotList; Ground.evaluate = saved.evaluate; Spots.cache = saved.cache;
    }
}
console.log('spot list search tests passed');
