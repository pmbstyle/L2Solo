const C4SevenSignsDungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');

// Seven Signs dungeons: the area id (bot spot ids carry it, so it never changes)
// and the L2J_Mobius C4 spawn file of its monsters.
const SEVEN_SIGNS_SPAWNS = Object.freeze({
    'Necropolis of Sacrifice': { id: 'necropolis_of_sacrifice', file: 'Catacombs/NecropolisOfSacrifice' },
    'Necropolis of Pilgrims': { id: 'necropolis_of_pilgrims', file: 'Catacombs/NecropolisOfThePilgrims' },
    'Necropolis of Worshipers': { id: 'necropolis_of_worshipers', file: 'Catacombs/NecropolisOfWorship' },
    'Necropolis of Patriots': { id: 'necropolis_of_patriots', file: 'Catacombs/NecropolisOfThePatriots' },
    'Necropolis of Ascetics': { id: 'necropolis_of_ascetics', file: 'Catacombs/NecropolisOfDevotion' },
    'Necropolis of Martyrs': { id: 'necropolis_of_martyrs', file: 'Catacombs/NecropolisOfMartyrdom' },
    'Necropolis of Saints': { id: 'necropolis_of_saints', file: 'Catacombs/NecropolisOfTheSaints' },
    'Necropolis of the Disciples': { id: 'necropolis_of_the_disciples', file: 'Catacombs/NecropolisOfTheDisciples' },
    'Catacomb of the Heretics': { id: 'catacomb_of_the_heretics', file: 'Catacombs/CatacombOfTheHeretic' },
    'Catacomb of the Branded': { id: 'catacomb_of_the_branded', file: 'Catacombs/CatacombOfTheBranded' },
    'Catacomb of the Apostate': { id: 'catacomb_of_the_apostate', file: 'Catacombs/CatacombOfTheApostate' },
    'Catacomb of the Witch': { id: 'catacomb_of_the_witch', file: 'Catacombs/CatacombOfTheWitch' },
    'Catacomb of Dark Omens': { id: 'catacomb_of_dark_omen', file: 'Catacombs/CatacombOfDarkOmens' },
    'Catacomb of the Forbidden Path': { id: 'catacomb_of_the_forbidden_path', file: 'Catacombs/CatacombOfTheForbiddenPath' }
});

// Territory corners and fixed points of each Seven Signs spawn file, each with its Z range.
const SEVEN_SIGNS_POINTS = (() => {
    const groups = require('../../../data/Npcs/Spawns/c4_mobius_monsters.json');
    return Object.freeze(Object.fromEntries(Object.values(SEVEN_SIGNS_SPAWNS).map(({ file }) => {
        const points = groups.filter((group) => group.selfId.startsWith(`mobius:${file}#`)).flatMap((group) => [
            ...group.bounds.map((node) => ({ locX: node.locX, locY: node.locY, minZ: node.minZ, maxZ: node.maxZ })),
            ...group.spawns.flatMap((spawn) => spawn.coords.map((point) => ({
                locX: point.locX, locY: point.locY, minZ: point.locZ, maxZ: point.locZ
            })))
        ]);
        if (points.length === 0) throw new Error(`No Mobius spawns for Seven Signs file ${file}`);
        return [file, points];
    })));
})();

function sevenSignsArea(dungeon) {
    const { id, file } = SEVEN_SIGNS_SPAWNS[dungeon.name];
    const points = SEVEN_SIGNS_POINTS[file];
    const [locX, locY, locZ] = dungeon.outside.spawn;
    const isCatacomb = dungeon.name.startsWith('Catacomb');
    const margin = 300;
    return Object.freeze({
        id,
        name: dungeon.name,
        kind: 'dungeon',
        parentRegion: null,
        mapLayer: 'dungeon',
        mapAnchor: Object.freeze({ locX, locY, locZ }),
        zones: Object.freeze([Object.freeze({
            minX: Math.min(...points.map((point) => point.locX)) - margin,
            maxX: Math.max(...points.map((point) => point.locX)) + margin,
            minY: Math.min(...points.map((point) => point.locY)) - margin,
            maxY: Math.max(...points.map((point) => point.locY)) + margin,
            minZ: Math.min(...points.map((point) => point.minZ)) - 256,
            maxZ: Math.max(...points.map((point) => point.maxZ)) + 256
        })]),
        // LevelingRoutes uses `catacomb` as the shared Seven Signs gameplay
        // category; keep `necropolis` as a more specific subtype.
        tags: Object.freeze(isCatacomb
            ? ['dungeon', 'catacomb']
            : ['dungeon', 'catacomb', 'necropolis']),
        tagsAuthoritative: true
    });
}

const AREAS = Object.freeze([
    Object.freeze({
        id: 'cruma_tower',
        name: 'Cruma Tower',
        kind: 'dungeon',
        parentRegion: 'Dion',
        mapLayer: 'dungeon',
        mapAnchor: Object.freeze({ locX: 17192, locY: 114178, locZ: -3441 }),
        zones: Object.freeze([Object.freeze({
            minX: 10800,
            maxX: 24650,
            minY: 107200,
            maxY: 121050,
            minZ: -12352,
            maxZ: -6320
        })]),
        tags: Object.freeze(['dungeon', 'tower', 'construct', 'party_required']),
        tagsAuthoritative: true,
        spotCapacity: 48
    }),
    Object.freeze({
        id: 'tower_of_insolence',
        name: 'Tower of Insolence',
        kind: 'dungeon',
        parentRegion: 'Aden',
        mapLayer: 'dungeon',
        mapAnchor: Object.freeze({ locX: 121685, locY: 15749, locZ: -4982 }),
        zones: Object.freeze([Object.freeze({
            minX: 111700,
            maxX: 117500,
            minY: 12900,
            maxY: 18950,
            minZ: -4000,
            maxZ: 8250
        })]),
        tags: Object.freeze(['dungeon', 'tower', 'party_required', 'deep_party']),
        tagsAuthoritative: true,
        spotCapacity: 72
    }),
    Object.freeze({
        id: 'antharas_lair',
        name: "Antharas' Lair",
        kind: 'dungeon',
        parentRegion: 'Giran',
        mapLayer: 'dungeon',
        mapAnchor: Object.freeze({ locX: 131355, locY: 114451, locZ: -3719 }),
        zones: Object.freeze([Object.freeze({
            minX: 125700,
            maxX: 155250,
            minY: 106500,
            maxY: 122400,
            minZ: -5800,
            maxZ: -3300
        })]),
        tags: Object.freeze(['dungeon', 'lair', 'dvc', 'party_required', 'deep_party']),
        tagsAuthoritative: true,
        spotCapacity: 72
    }),
    Object.freeze({
        id: 'elven_ruins',
        name: 'Elven Ruins',
        kind: 'dungeon',
        parentRegion: 'Talking Island',
        mapLayer: 'dungeon',
        // C4 gatekeeper destination 1003: the real surface entrance east of
        // the Obelisk of Victory, not the detached underground coordinates.
        mapAnchor: Object.freeze({ locX: -113329, locY: 235327, locZ: -3653 }),
        // C4 stores the Elven Ruins interior in the underground layer of
        // geodata cell 21_25. Its raw X/Y coordinates are not a meaningful
        // position on the surface atlas used by World Observer.
        cell: '21_25',
        belowZ: -3790,
        tags: Object.freeze(['dungeon', 'undead', 'ruins']),
        tagsAuthoritative: true,
        localStarterRegions: Object.freeze(['human']),
        localUntilLevel: 20,
        spotCapacity: 64
    }),
    Object.freeze({
        id: 'mithril_mines',
        name: 'Mithril Mines',
        kind: 'dungeon',
        parentRegion: 'Dwarven Village',
        mapLayer: 'dungeon',
        // C4 gatekeeper destination 419: Entrance to the Mithril Mines.
        mapAnchor: Object.freeze({ locX: 179039, locY: -184080, locZ: -319 }),
        // The Mithril Mines rooms are stored in geodata cell 25_12, partly
        // underneath the real northeast coast. The northern rooms are
        // spatially detached; in the southern overlap Z separates the mine
        // floors from the coastal slope.
        cell: '25_12',
        zones: Object.freeze([
            Object.freeze({ minX: 172500, maxX: 188700, minY: -182000, maxY: -171900 }),
            Object.freeze({ minX: 172500, maxX: 188700, minY: -187300, maxY: -182000, belowZ: -1600 })
        ]),
        tags: Object.freeze(['dungeon', 'undead', 'construct', 'mine']),
        tagsAuthoritative: true,
        localStarterRegions: Object.freeze(['dwarf']),
        localUntilLevel: 20,
        spotCapacity: 48
    }),
    ...C4SevenSignsDungeonTeleports.DUNGEONS.map(sevenSignsArea)
]);

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function mapCell(locX, locY) {
    const x = finite(locX);
    const y = finite(locY);
    if (x === null || y === null) return null;
    return `${(x >> 15) + 20}_${(y >> 15) + 18}`;
}

function matchesZone(zone = {}, loc = {}) {
    const x = finite(loc.locX);
    const y = finite(loc.locY);
    const z = finite(loc.locZ);
    if (x === null || y === null) return false;
    if (zone.minX !== undefined && x < Number(zone.minX)) return false;
    if (zone.maxX !== undefined && x > Number(zone.maxX)) return false;
    if (zone.minY !== undefined && y < Number(zone.minY)) return false;
    if (zone.maxY !== undefined && y > Number(zone.maxY)) return false;
    if (zone.minZ !== undefined && (z === null || z < Number(zone.minZ))) return false;
    if (zone.maxZ !== undefined && (z === null || z > Number(zone.maxZ))) return false;
    if (zone.belowZ !== undefined && (z === null || z >= Number(zone.belowZ))) return false;
    if (zone.aboveZ !== undefined && (z === null || z <= Number(zone.aboveZ))) return false;
    return true;
}

function matches(area, loc = {}) {
    if (!area.cell && !area.zones?.length && area.belowZ === undefined) return false;
    const z = finite(loc.locZ);
    if (area.cell && mapCell(loc.locX, loc.locY) !== area.cell) return false;
    if (area.zones?.length && !area.zones.some((zone) => matchesZone(zone, loc))) return false;
    if (area.belowZ !== undefined && (z === null || z >= Number(area.belowZ))) return false;
    return true;
}

function resolve(loc = {}) {
    return AREAS.find((area) => matches(area, loc)) || null;
}

function publicArea(area) {
    if (!area) return null;
    return {
        id: area.id,
        name: area.name,
        kind: area.kind,
        parentRegion: area.parentRegion || null,
        mapLayer: area.mapLayer || 'surface',
        mapAnchor: area.mapAnchor ? { ...area.mapAnchor } : null
    };
}

function areaForSpot(spot = {}) {
    let fallback = resolve(spot.center);
    if (spot.partitionedAreaId && fallback?.id === spot.partitionedAreaId) return fallback;
    // A 6 km hunting sector can span both the surface and an underground
    // Seven Signs room. The averaged sector center is therefore not always a
    // valid dungeon coordinate. Classification happens once while the spot
    // index is built, so inspect its existing spawn points and conservatively
    // prefer party-only content when any of them belongs to it.
    for (const point of spot.arrivalPoints || []) {
        const area = resolve(point);
        if (!area) continue;
        if (area.tags?.includes('catacomb') || area.tags?.includes('party_required')) return area;
        if (!fallback) fallback = area;
    }
    return fallback;
}

function decorateSpot(spot = {}) {
    const area = areaForSpot(spot);
    if (!area) return spot;
    return {
        ...spot,
        name: area.name,
        area: publicArea(area),
        tags: [...area.tags],
        tagsAuthoritative: area.tagsAuthoritative === true,
        capacity: Number(area.spotCapacity || spot.capacity || 0) || null,
        localStarterRegions: [...(area.localStarterRegions || [])],
        localUntilLevel: Number(area.localUntilLevel || 0) || null
    };
}

function isLocalForState(spot = {}, state = {}) {
    const allowed = spot.localStarterRegions || [];
    const starterRegion = String(state.stats?.starterRegion || '');
    const level = Math.max(1, Number(state.level || 1));
    if (!allowed.length || !starterRegion || level > Number(spot.localUntilLevel || 0)) return true;
    return allowed.includes(starterRegion);
}

module.exports = {
    AREAS,
    mapCell,
    matches,
    resolve,
    publicArea,
    decorateSpot,
    isLocalForState
};
