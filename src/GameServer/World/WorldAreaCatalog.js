const C4SevenSignsDungeonTeleports = invoke('GameServer/World/C4SevenSignsDungeonTeleports');

const SEVEN_SIGNS_SPAWNS = Object.freeze({
    'Necropolis of Sacrifice': require('../../../data/Npcs/Spawns/c4_necropolis_of_sacrifice.json')[0],
    'Necropolis of Pilgrims': require('../../../data/Npcs/Spawns/c4_necropolis_of_pilgrims.json')[0],
    'Necropolis of Worshipers': require('../../../data/Npcs/Spawns/c4_necropolis_of_worshipers.json')[0],
    'Necropolis of Patriots': require('../../../data/Npcs/Spawns/c4_necropolis_of_patriots.json')[0],
    'Necropolis of Ascetics': require('../../../data/Npcs/Spawns/c4_necropolis_of_ascetics.json')[0],
    'Necropolis of Martyrs': require('../../../data/Npcs/Spawns/c4_necropolis_of_martyrs.json')[0],
    'Necropolis of Saints': require('../../../data/Npcs/Spawns/c4_necropolis_of_saints.json')[0],
    'Necropolis of the Disciples': require('../../../data/Npcs/Spawns/c4_necropolis_of_the_disciples.json')[0],
    'Catacomb of the Heretics': require('../../../data/Npcs/Spawns/c4_catacomb_of_the_heretics.json')[0],
    'Catacomb of the Branded': require('../../../data/Npcs/Spawns/c4_catacomb_of_the_branded.json')[0],
    'Catacomb of the Apostate': require('../../../data/Npcs/Spawns/c4_catacomb_of_the_apostate.json')[0],
    'Catacomb of the Witch': require('../../../data/Npcs/Spawns/c4_catacomb_of_the_witch.json')[0],
    'Catacomb of Dark Omens': require('../../../data/Npcs/Spawns/c4_catacomb_of_dark_omen.json')[0],
    'Catacomb of the Forbidden Path': require('../../../data/Npcs/Spawns/c4_catacomb_of_the_forbidden_path.json')[0]
});

function sevenSignsArea(dungeon) {
    const spawnArea = SEVEN_SIGNS_SPAWNS[dungeon.name];
    const points = spawnArea.spawns.flatMap((spawn) => spawn.coords || []);
    const [locX, locY, locZ] = dungeon.outside.spawn;
    const isCatacomb = dungeon.name.startsWith('Catacomb');
    const margin = 300;
    return Object.freeze({
        id: spawnArea.selfId.replace(/^c4-/, '').replace(/-/g, '_'),
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
            minZ: Math.min(...points.map((point) => point.locZ)) - 256,
            maxZ: Math.max(...points.map((point) => point.locZ)) + 256
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

function decorateSpot(spot = {}) {
    const area = resolve(spot.center);
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
