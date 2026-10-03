const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
Data.init();

// A level 29 mage that survives level 25-29 mobs (see test_bot_solo_hunt_safety).
const at = 1800000000000;
const mage = { classId: 12, level: 29, role: 'mage', maxHp: 592, maxMp: 932,
    pDef: 243, pAtk: 96, mAtk: 162, castSpd: 194, atkSpd: 263, weaponMask: 8,
    equipment: { weaponKind: 'Weapon.Blunt' },
    skills: [{ selfId: 1230, level: 1, spell: true, passive: false, power: 51, mp: 35, hitTime: 4000 }] };
const state = { characterId: 990107, level: 29, exp: Number(Data.experience[28]) + 100000, sp: 0, adena: 0,
    phase: 'cold', activity: 'hunting', spotId: 'sparse-far', inventory: {}, loc: {}, timing: {},
    vitals: { hp: 592, maxHp: 592, mp: 932, maxMp: 932 },
    stats: { classId: 12, classProgressionClassId: 12, classProgressionLevel: 29, deaths: 0 } };
const spot = (id, level, density) => ({ id, name: id, minLevel: level, maxLevel: level, avgLevel: level,
    density, tags: [], tagsAuthoritative: true, center: { locX: 50000, locY: 150000, locZ: -3000 },
    npcEntries: [{ selfId: 156, count: density }], levelCounts: { [level]: density } });
// Two allowed camps near the bot's level, both too sparse to be suitable;
// the other one scores better (closer level).
const far = spot('sparse-far', 26, 2);
const near = spot('sparse-near', 29, 2);
const fit = spot('fit', 29, 8);
const options = { matchupProfiles: [mage], occupancy: {}, timestamp: at };
const target = Routes.targetLevelForState(state, options);

const original = Spots.cache;
try {
    Spots.cache = [far, near];
    assert(!SpotService.isSuitable(far, target) && !SpotService.isSuitable(near, target), 'fixture: both camps unsuitable');
    assert(Routes.isSpotAllowedForState(far, state, options) && Routes.isSpotAllowedForState(near, state, options),
        'fixture: both camps allowed');
    assert(Routes.scoreSpot(near, state, options).score > Routes.scoreSpot(far, state, options).score,
        'fixture: the other camp scores better');
    assert.strictEqual(Spots.findForState({ ...state, spotId: null }, options)?.id, 'sparse-near',
        'a bot without ground still picks the best allowed camp');
    assert.strictEqual(Spots.findForState(state, options)?.id, 'sparse-far',
        'without a suitable camp, comparable allowed ground must not become a travel loop');
    assert.strictEqual(Spots.findForState(state, { ...options, excludedSpotIds: new Set(['sparse-far']) })?.id,
        'sparse-near', 'a camp the bot must leave is still left');
    const partyState = { ...state, stats: { ...state.stats, routeMode: 'party' } };
    assert.strictEqual(Spots.findForState(partyState, { ...options, mode: 'party' })?.id, 'sparse-near',
        'a party keeps the author\'s search: the stay is a solo rule like the easier-ground fallback');

    Spots.cache = [far, near, fit];
    assert(SpotService.isSuitable(fit, target), 'fixture: suitable camp');
    assert.strictEqual(Spots.findForState(state, options)?.id, 'fit', 'a suitable camp with room still wins');
    const full = { fit: { count: 99, reservedCount: 99, capacity: 9, retained: new Set(), reservedKeys: new Set(),
        reservationKeys: new Set(), retainedReservationKeys: new Set() } };
    assert.strictEqual(Spots.findForState(state, { ...options, occupancy: full })?.id, 'sparse-far',
        'a full suitable camp leaves the bot where it is');
} finally { Spots.cache = original; }

console.log('unsuitable spot stay tests passed');
