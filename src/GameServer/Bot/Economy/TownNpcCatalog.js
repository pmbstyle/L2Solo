const DataCache = invoke('GameServer/DataCache');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const TownRespawn = invoke('GameServer/World/TownRespawn');

const MAX_TOWN_DISTANCE = 7500;
const EMPTY = Object.freeze([]);

let cachedSpawns = null;
let cachedRows = EMPTY;
let cachedByTown = Object.freeze({});

function distance(first, second) {
    return Math.hypot(
        Number(first?.locX || 0) - Number(second?.locX || 0),
        Number(first?.locY || 0) - Number(second?.locY || 0)
    );
}

function npcName(selfId, fallback = null) {
    return (DataCache.npcs || []).find((npc) => Number(npc.selfId) === Number(selfId))?.template?.name
        || fallback
        || `NPC ${selfId}`;
}

function build() {
    const spawns = DataCache.npcSpawns;
    if (!Array.isArray(spawns) || !spawns.length) {
        cachedSpawns = spawns;
        cachedRows = EMPTY;
        cachedByTown = Object.freeze({});
        return;
    }
    if (cachedSpawns === spawns) return;

    const shopNpcIds = new Set((NpcShopBuyLists.npcIds?.() || []).map(Number));
    const rows = [];
    const seen = new Set();

    spawns.forEach((zone) => {
        (zone?.spawns || []).forEach((spawn) => {
            const npcSelfId = Number(spawn?.selfId || 0);
            if (!shopNpcIds.has(npcSelfId)) return;
            (spawn.coords || []).forEach((coords) => {
                const locX = Number(coords?.locX);
                const locY = Number(coords?.locY);
                const locZ = Number(coords?.locZ);
                const head = Number(coords?.head);
                if (![locX, locY, locZ].every(Number.isFinite)) return;
                const town = TownRespawn.getClosestTown(locX, locY, locZ);
                if (!town || distance(coords, town) > MAX_TOWN_DISTANCE) return;
                const key = `${town.name}:${npcSelfId}:${locX}:${locY}:${locZ}`;
                if (seen.has(key)) return;
                seen.add(key);
                rows.push(Object.freeze({
                    town: town.name,
                    npcSelfId,
                    name: npcName(npcSelfId, spawn.name),
                    locX,
                    locY,
                    locZ,
                    head: Number.isFinite(head) ? ((head % 65536) + 65536) % 65536 : null
                }));
            });
        });
    });

    rows.sort((left, right) => String(left.town).localeCompare(String(right.town))
        || Number(left.npcSelfId) - Number(right.npcSelfId)
        || Number(left.locX) - Number(right.locX)
        || Number(left.locY) - Number(right.locY));

    const byTown = {};
    rows.forEach((row) => {
        if (!byTown[row.town]) byTown[row.town] = [];
        byTown[row.town].push(row);
    });
    Object.keys(byTown).forEach((town) => Object.freeze(byTown[town]));

    cachedSpawns = spawns;
    cachedRows = Object.freeze(rows);
    cachedByTown = Object.freeze(byTown);
}

function rows() {
    build();
    return cachedRows;
}

function rowsForTown(town) {
    build();
    return cachedByTown[String(town || '')] || EMPTY;
}

function sellersByTown() {
    build();
    return Object.freeze(Object.fromEntries(Object.entries(cachedByTown).map(([town, entries]) => [
        town,
        Object.freeze([...new Set(entries.map((entry) => Number(entry.npcSelfId)))])
    ])));
}

function candidates(town, options = {}) {
    const selfId = Number(options.selfId || 0);
    const from = options.from || null;
    const excludedNpcSelfIds = new Set((options.excludedNpcSelfIds || []).map(Number));
    return rowsForTown(town)
        .filter((row) => !excludedNpcSelfIds.has(Number(row.npcSelfId)))
        .filter((row) => !selfId || NpcShopBuyLists.fetchForNpc(row.npcSelfId)
            .some((item) => Number(item.selfId) === selfId))
        .sort((left, right) => (from ? distance(left, from) - distance(right, from) : 0)
            || Number(left.npcSelfId) - Number(right.npcSelfId));
}

function closestSeller(town, options = {}) {
    return candidates(town, options)[0] || null;
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

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX ?? 0),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY ?? 0),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ ?? 0)
    };
}

function targetFor(town, options = {}) {
    return targetFromRow(closestSeller(town, options), options);
}

function targetForNpc(town, npcSelfId, options = {}) {
    const from = options.from || null;
    const row = rowsForTown(town)
        .filter((candidate) => Number(candidate.npcSelfId) === Number(npcSelfId))
        .sort((left, right) => (from ? distance(left, from) - distance(right, from) : 0))[0] || null;
    return targetFromRow(row, options);
}

module.exports = {
    MAX_TOWN_DISTANCE,
    candidates,
    closestSeller,
    rows,
    rowsForTown,
    sellersByTown,
    targetFor,
    targetForNpc
};
