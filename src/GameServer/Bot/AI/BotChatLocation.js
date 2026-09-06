const Areas = invoke('GameServer/World/WorldAreaCatalog');
const TownRespawn = invoke('GameServer/World/TownRespawn');

function readableName(value) {
    const name = String(value || '').replace(/\s+/g, ' ').trim();
    const area = Areas.AREAS.find((candidate) => candidate.id === name);
    if (area) return area.name;
    if (TownRespawn.towns[name]) return TownRespawn.towns[name].name;
    if (!name || /_|\bdensity\b|\bloc[XYZ]\b|[+-]?\d+\s*[,;]\s*[+-]?\d+/i.test(name) ||
        /^(?:unknown(?: spot)?|none|null|hunting ground)$/i.test(name)) return '';
    return name;
}

function location(value) {
    if (!value || value.locX == null || value.locY == null) return null;
    const locX = Number(value.locX);
    const locY = Number(value.locY);
    if (!Number.isFinite(locX) || !Number.isFinite(locY)) return null;
    const locZ = value.locZ == null ? undefined : Number(value.locZ);
    return { locX, locY, ...(Number.isFinite(locZ) ? { locZ } : {}) };
}

function landmark(loc) {
    // Use the world's geographical regions, including its dungeon overrides,
    // rather than choosing a city across the sea by straight-line distance.
    const town = TownRespawn.towns[TownRespawn.getRegionGroup(loc.locX, loc.locY, loc.locZ)];
    if (!town) return '';
    const dx = loc.locX - town.locX;
    const dy = loc.locY - town.locY;
    if (Math.hypot(dx, dy) < 3500) return town.name;
    const directions = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
    const direction = directions[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
    return `the area ${direction} of ${town.name}`;
}

function describe({ spot = null, spotId = null, loc = null, region = null } = {}) {
    // A real position takes precedence over an assigned destination. A bot
    // travelling to a spot must not report that it has already arrived there.
    const current = location(loc);
    if (current) return Areas.resolve(current)?.name || landmark(current) || readableName(region) || 'my hunting spot';

    const indexed = spot || (spotId ? invoke('GameServer/Bot/AI/SpotService').findById(spotId) : null);
    const center = location(indexed?.center);
    const area = indexed?.area?.name || (center && Areas.resolve(center)?.name);
    const name = readableName(area) || readableName(indexed?.name);
    if (name) return name;
    if (center) return landmark(center) || readableName(region) || 'my hunting spot';

    const partitionId = String(spotId || indexed?.id || '').split(':')[1];
    const partition = Areas.AREAS.find((candidate) => candidate.id === partitionId);
    if (partition) return partition.name;

    // Spot ids are 6 km simulation cells, not the client's 32 km map tiles.
    // Without an indexed spot, only infer a broad region from the cell center.
    const cell = /^(-?\d+)_(-?\d+)(?::.+)?$/.exec(String(spotId || indexed?.id || ''));
    if (cell) {
        const group = TownRespawn.getRegionGroup((Number(cell[1]) + 0.5) * 6000, (Number(cell[2]) + 0.5) * 6000);
        const town = TownRespawn.towns[group];
        if (town) return `the ${town.name} area`;
    }
    return readableName(region) || 'my hunting spot';
}

function forState(state) {
    return describe({ loc: state?.loc, spotId: state?.spotId, region: state?.currentRegion });
}

module.exports = { describe, forState };
