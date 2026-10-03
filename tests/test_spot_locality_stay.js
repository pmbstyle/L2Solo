const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
Data.init();

// A level 6 orc mystic on its starter fists (no attack spell before level 7):
// it survives level 1-2 keltirs, not the level 3-4 mobs mixed into the orc
// starter fields (live numbers 2026-10-03: survival 1.21 and 0.89 against 1.5).
const at = 1800000000000;
const mystic = { classId: 49, level: 6, role: 'buffer', maxHp: 194, maxMp: 150,
    pDef: 56, pAtk: 6, mAtk: 6, castSpd: 333, atkSpd: 325, weaponMask: 0,
    equipment: { weaponKind: 'Weapon.DualFist' }, skills: [] };
const state = { characterId: 990108, level: 6, exp: Number(Data.experience[5]) + 1000, sp: 0, adena: 0,
    phase: 'cold', activity: 'hunting', spotId: 'dwarf-keltir', inventory: {}, timing: {},
    loc: { locX: 109648, locY: -174646, locZ: -391 },
    vitals: { hp: 194, maxHp: 194, mp: 150, maxMp: 150 },
    stats: { classId: 49, classProgressionClassId: 49, classProgressionLevel: 6, deaths: 0,
        starterRegion: 'orc', populationWave: 8 } };
const BEARDED_KELTIR = 12082; // level 1
const LONGTAIL_KELTIR = 533; // level 2
const KASHA_WOLF = 475; // level 4
const spot = (id, center, entries) => ({ id, name: id,
    minLevel: Math.min(...entries.map(([, , level]) => level)), maxLevel: Math.max(...entries.map(([, , level]) => level)),
    avgLevel: 2, density: entries.reduce((sum, [, count]) => sum + count, 0),
    tags: ['starter'], tagsAuthoritative: true, center: { ...center, locZ: 0 },
    npcEntries: entries.map(([selfId, count]) => ({ selfId, count })),
    levelCounts: Object.fromEntries(entries.map(([, count, level]) => [level, count])) });
// Two keltir fields in other races' regions, two orc fields: one with wolves
// (fails survival), one with keltirs only (passes). Level 1-2 mobs keep the
// fields inside the level 6 search window (max mob level >= level - 4).
const dwarf = spot('dwarf-keltir', { locX: 109648, locY: -174646 }, [[BEARDED_KELTIR, 20, 1], [LONGTAIL_KELTIR, 2, 2]]);
const darkElf = spot('dark-elf-keltir', { locX: 29715, locY: 7844 }, [[BEARDED_KELTIR, 16, 1], [LONGTAIL_KELTIR, 2, 2]]);
const orcWolves = spot('orc-wolves', { locX: -49570, locY: -115635 }, [[BEARDED_KELTIR, 6, 1], [KASHA_WOLF, 10, 4]]);
const orcKeltir = spot('orc-keltir', { locX: -52000, locY: -112000 }, [[BEARDED_KELTIR, 12, 1], [LONGTAIL_KELTIR, 2, 2]]);
const options = { matchupProfiles: [mystic], occupancy: {}, timestamp: at };
const target = Routes.targetLevelForState(state, options);

const original = Spots.cache;
try {
    Spots.cache = [dwarf, darkElf, orcWolves];
    assert(Routes.isSpotAllowedForState(dwarf, state, options) && Routes.isSpotAllowedForState(darkElf, state, options),
        'fixture: the foreign keltir fields are allowed');
    assert(!Routes.isSpotAllowedForState(orcWolves, state, options), 'fixture: the home field with wolves is not');
    assert(Routes.scoreSpot(dwarf, state, options).localityPenalty > 0
        && Routes.scoreSpot(orcWolves, state, options).localityPenalty === 0, 'fixture: locality penalises the foreign fields');
    assert(SpotService.isSuitable(dwarf, target), 'fixture: level 1 keltirs are in a level 6 hunt band');
    assert.strictEqual(Spots.findForState(state, options)?.id, 'dwarf-keltir',
        'with no allowed home field, locality must not send the bot to another foreign field');
    const planned = { ...state, stats: { ...state.stats,
        equipmentPlan: { status: 'active', strategy: 'market', grade: 'none', target: { selfId: 7, name: "Apprentice's Rod" } } } };
    assert.strictEqual(Spots.findForState(planned, options)?.id, 'dwarf-keltir',
        'an active market plan does not reopen the loop');
    assert.strictEqual(Spots.findForState(state, { ...options, excludedSpotIds: new Set(['dwarf-keltir']) })?.id,
        'dark-elf-keltir', 'a field the bot must leave is still left');
    assert.strictEqual(Spots.findForState({ ...state, spotId: null, loc: {} }, options)?.id, 'dwarf-keltir',
        'an unplaced bot still takes the best allowed field');

    Spots.cache = [dwarf, darkElf, orcWolves, orcKeltir];
    assert(Routes.isSpotAllowedForState(orcKeltir, state, options), 'fixture: the home keltir field is allowed');
    assert.strictEqual(Spots.findForState(state, options)?.id, 'orc-keltir',
        'an allowed home field with room still pulls the bot home (the author\'s locality rule)');
    const full = { 'orc-keltir': { count: 99, reservedCount: 99, capacity: 9, retained: new Set(), reservedKeys: new Set(),
        reservationKeys: new Set(), retainedReservationKeys: new Set() } };
    assert.strictEqual(Spots.findForState(state, { ...options, occupancy: full })?.id, 'dwarf-keltir',
        'a full home field leaves the bot on its current field');
} finally { Spots.cache = original; }

console.log('locality stay tests passed');
