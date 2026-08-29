const DataCache = invoke('GameServer/DataCache');
const GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const MAX_TOWN_DISTANCE = 7500;
const EMPTY = Object.freeze([]);

let cachedSpawns = null;
let cachedRows = EMPTY;

function distance(first, second) {
    return Math.hypot(
        Number(first?.locX || 0) - Number(second?.locX || 0),
        Number(first?.locY || 0) - Number(second?.locY || 0)
    );
}

function npcTemplate(selfId) {
    return (DataCache.npcs || []).find((npc) => Number(npc.selfId) === Number(selfId)) || null;
}

function build() {
    const spawns = DataCache.npcSpawns;
    if (!Array.isArray(spawns) || !spawns.length) {
        cachedSpawns = spawns;
        cachedRows = EMPTY;
        return;
    }
    if (cachedSpawns === spawns) return;

    // Only NPCs with a real C4 city teleport list are valid town exits. This
    // deliberately excludes castle doors, dungeon teleporters and rescue NPCs.
    const gatekeeperIds = new Set(Object.keys(GatekeeperTeleports.lists || {}).map(Number));
    const rows = [];
    const seen = new Set();

    spawns.forEach((zone) => {
        (zone?.spawns || []).forEach((spawn) => {
            const npcSelfId = Number(spawn?.selfId || 0);
            if (!gatekeeperIds.has(npcSelfId)) return;
            const template = npcTemplate(npcSelfId);
            (spawn.coords || []).forEach((coords) => {
                const locX = Number(coords?.locX);
                const locY = Number(coords?.locY);
                const locZ = Number(coords?.locZ);
                const head = Number(coords?.head);
                if (![locX, locY, locZ].every(Number.isFinite)) return;
                const town = TownRespawn.getClosestTown(locX, locY, locZ);
                if (!town || distance(coords, town) > MAX_TOWN_DISTANCE) return;
                const key = `${npcSelfId}:${locX}:${locY}:${locZ}`;
                if (seen.has(key)) return;
                seen.add(key);
                rows.push(Object.freeze({
                    town: town.name,
                    npcSelfId,
                    name: template?.template?.name || spawn.name || `Gatekeeper ${npcSelfId}`,
                    locX,
                    locY,
                    locZ,
                    head: Number.isFinite(head) ? ((head % 65536) + 65536) % 65536 : null
                }));
            });
        });
    });

    rows.sort((left, right) => String(left.town).localeCompare(String(right.town))
        || Number(left.npcSelfId) - Number(right.npcSelfId));
    cachedSpawns = spawns;
    cachedRows = Object.freeze(rows);
}

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function rows() {
    build();
    return cachedRows;
}

function targetFromRow(row, options = {}) {
    if (!row) return null;
    let worldSpawns = options.worldSpawns;
    if (!Array.isArray(worldSpawns)) {
        try {
            worldSpawns = invoke('GameServer/World/World').npc?.spawns || [];
        } catch (_) {
            worldSpawns = [];
        }
    }
    const actor = worldSpawns
        .filter((candidate) => Number(candidate.fetchSelfId?.() || 0) === Number(row.npcSelfId))
        .sort((left, right) => distance(pointOf(left), row) - distance(pointOf(right), row))[0] || null;
    const actorHead = Number(actor?.fetchHead?.());
    return {
        actorId: Number(actor?.fetchId?.() || 0) || null,
        npcSelfId: Number(row.npcSelfId),
        name: actor?.fetchName?.() || row.name,
        locX: Number(actor?.fetchLocX?.() ?? row.locX),
        locY: Number(actor?.fetchLocY?.() ?? row.locY),
        locZ: Number(actor?.fetchLocZ?.() ?? row.locZ),
        head: Number.isFinite(actorHead) ? ((actorHead % 65536) + 65536) % 65536 : row.head,
        town: row.town
    };
}

function targetNear(from, options = {}) {
    const maxDistance = Number(options.maxDistance || MAX_TOWN_DISTANCE);
    const row = rows()
        .filter((candidate) => distance(candidate, from) <= maxDistance)
        .sort((left, right) => distance(left, from) - distance(right, from))[0] || null;
    return targetFromRow(row, options);
}

function targetForTown(townName, options = {}) {
    const from = options.from || null;
    const matching = rows().filter((candidate) => candidate.town === townName);
    const row = from
        ? matching.sort((left, right) => distance(left, from) - distance(right, from))[0] || null
        : matching[0] || null;
    return targetFromRow(row, options);
}

module.exports = {
    MAX_TOWN_DISTANCE,
    rows,
    targetFromRow,
    targetForTown,
    targetNear
};
