const knowledge = invoke('GameServer/World/Generics/NativeKnowledgeBase');
const Areas = invoke('GameServer/World/WorldAreaCatalog');
const Towns = invoke('GameServer/World/TownRespawn');
const Response = invoke('GameServer/Network/Response');

// Catalog spawn places, not live actors. Dungeon interiors are mapped to their
// known entrance, since their server coordinates can be outside the world map.
function locations(npcId, actor) {
    const unique = new Map();
    for (const spawn of knowledge().npcDetail(npcId)?.spawns || []) {
        for (const point of spawn.mapPoints) {
            const area = Areas.resolve(point);
            const entrance = area?.mapLayer === 'dungeon' && area.mapAnchor;
            const loc = entrance || point;
            const [x, y, z] = [loc.locX, loc.locY, loc.locZ].map(Math.round);
            if (![x, y, z].every((n) => Number.isSafeInteger(n) && Math.abs(n) <= 2000000)) continue;
            const period = ['day', 'night'].includes(spawn.period) ? spawn.period : 'always';
            const kind = entrance ? 'entrance' : point.source === 'zone' ? 'area' : 'point';
            const town = Towns.towns[Towns.getRegionGroup(x, y, z)];
            const name = area?.name || (town ? `${town.name} region` : 'Spawn location');
            const key = `${x}:${y}:${z}:${period}:${kind}`;
            if (!unique.has(key)) unique.set(key, { x, y, z, name, period, kind });
        }
    }
    const ax = Number(actor?.fetchLocX?.()), ay = Number(actor?.fetchLocY?.());
    const distance = (r) => Number.isFinite(ax) && Number.isFinite(ay) ? Math.hypot(r.x - ax, r.y - ay) : 0;
    return [...unique.values()].sort((a, b) => distance(a) - distance(b) || a.name.localeCompare(b.name) || a.x - b.x || a.y - b.y || a.z - b.z || a.period.localeCompare(b.period))
        .map((r, i) => ({ ...r, id: i + 1 }));
}
const key = (r) => `${r.x}:${r.y}:${r.z}`;
function syncDirection(session, target = null) {
    // C4 NCConsole::OnShowRadar: action 1 deletes a point but leaves the
    // overhead-arrow flag enabled. Action 2 clears that flag AND both marker
    // arrays. Replay the authoritative quest set, then the database target
    // last so Track points to it. Do not add an overlapping point twice.
    session.dataSendToMe(Response.radarControl(2, 2, 0, 0, 0));
    const points = new Map();
    for (const coords of session.questWaypoints?.values() || []) points.set(coords.join(':'), coords);
    for (const point of [session.nativeItemsWaypoint, session.playerBoardWaypoint, target]) if (point) {
        points.delete(key(point)); points.set(key(point), [point.x, point.y, point.z]);
    }
    for (const coords of points.values()) session.dataSendToMe(Response.radarControl(0, 1, ...coords));
}
function stop(session) {
    const tracked = session.nativeItemsWaypoint;
    session.nativeItemsWaypoint = null;
    if (tracked) syncDirection(session, session.playerBoardWaypoint);
}
function track(session, place) {
    if (session.nativeItemsWaypoint && key(session.nativeItemsWaypoint) === key(place)) {
        stop(session);
        return;
    }
    session.nativeItemsWaypoint = { x: place.x, y: place.y, z: place.z };
    syncDirection(session, place);
}
module.exports = { locations, stop, track, key, syncDirection };
