const FailureLog = require('../../../FailureLog');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const GatekeeperTeleports = invoke('GameServer/World/C4GatekeeperTeleports');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const NpcObjectIndex = require('../../World/NpcObjectIndex');

const MAX_TOWN_DISTANCE = 7500;
const EMPTY = Object.freeze([]);
const ROLES = Object.freeze({
    SELLER: 'seller',
    GENERIC_MERCHANT: 'generic_merchant',
    WAREHOUSE: 'warehouse',
    GATEKEEPER: 'gatekeeper'
});

const GENERIC_MERCHANT_TITLES = Object.freeze(new Set([
    'Trader',
    'Grocer',
    'Weapons Trader',
    'Armor Trader',
    'Jeweler',
    'Magic Trader'
]));

let cachedSpawns = null;
let cachedSpawnsLength = null;
let cachedRows = EMPTY;
let cachedByRoleTown = Object.freeze({});
// The rows by role, built with cachedRows: inputs DataCache.npcSpawns (identity, length).
let cachedByRole = Object.freeze({});

function distance(first, second) {
    return Math.hypot(
        Number(first?.locX || 0) - Number(second?.locX || 0),
        Number(first?.locY || 0) - Number(second?.locY || 0)
    );
}

function rolesFor(npcSelfId, title, sellerIds, gatekeeperIds) {
    const roles = [];
    if (sellerIds.has(npcSelfId)) {
        roles.push(ROLES.SELLER);
        if (GENERIC_MERCHANT_TITLES.has(title)) roles.push(ROLES.GENERIC_MERCHANT);
    }
    if (/^Warehouse (Keeper|Chief|Freightman)$/i.test(title)) roles.push(ROLES.WAREHOUSE);
    if (gatekeeperIds.has(npcSelfId)) roles.push(ROLES.GATEKEEPER);
    return roles;
}

function build() {
    const spawns = DataCache.npcSpawns;
    if (!Array.isArray(spawns) || !spawns.length) {
        cachedSpawns = spawns;
        cachedSpawnsLength = spawns?.length;
        cachedRows = EMPTY;
        cachedByRoleTown = Object.freeze({});
        cachedByRole = Object.freeze({});
        return;
    }
    if (cachedSpawns === spawns && cachedSpawnsLength === spawns.length) return;

    const sellerIds = new Set((NpcShopBuyLists.npcIds?.() || []).map(Number));
    const gatekeeperIds = new Set(Object.keys(GatekeeperTeleports.lists || {}).map(Number));
    const rows = [];
    const seen = new Set();

    spawns.forEach((zone) => {
        (zone?.spawns || []).forEach((spawn) => {
            const npcSelfId = Number(spawn?.selfId || 0);
            const template = ItemTemplateIndex.find(DataCache.npcs, npcSelfId)?.template || {};
            const title = String(template.title || spawn.title || '');
            const roles = rolesFor(npcSelfId, title, sellerIds, gatekeeperIds);
            if (!roles.length) return;

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
                    name: template.name || spawn.name || `NPC ${npcSelfId}`,
                    title,
                    roles: Object.freeze(roles),
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

    const byRoleTown = {};
    Object.values(ROLES).forEach((role) => { byRoleTown[role] = {}; });
    rows.forEach((row) => row.roles.forEach((role) => {
        if (!byRoleTown[role][row.town]) byRoleTown[role][row.town] = [];
        byRoleTown[role][row.town].push(row);
    }));
    Object.values(byRoleTown).forEach((byTown) => Object.keys(byTown)
        .forEach((town) => Object.freeze(byTown[town])));

    cachedSpawns = spawns;
    cachedSpawnsLength = spawns.length;
    cachedRows = Object.freeze(rows);
    cachedByRoleTown = Object.freeze(Object.fromEntries(Object.entries(byRoleTown)
        .map(([role, byTown]) => [role, Object.freeze(byTown)])));
    cachedByRole = Object.freeze(Object.fromEntries(Object.entries(cachedByRoleTown)
        .map(([role, byTown]) => [role, Object.freeze(Object.values(byTown).flat())])));
}

function rows(role = null) {
    build();
    if (!role) return cachedRows;
    return cachedByRole[String(role)] || EMPTY;
}

function rowsForTown(town, role) {
    build();
    return cachedByRoleTown[String(role)]?.[String(town || '')] || EMPTY;
}

function candidates(role, town, options = {}) {
    const selfId = Number(options.selfId || 0);
    const from = options.from || null;
    const excludedNpcSelfIds = new Set((options.excludedNpcSelfIds || []).map(Number));
    return rowsForTown(town, role)
        .filter((row) => !excludedNpcSelfIds.has(Number(row.npcSelfId)))
        .filter((row) => ![ROLES.SELLER, ROLES.GENERIC_MERCHANT].includes(role) || !selfId || !!NpcShopBuyLists.rowForNpc(row.npcSelfId, selfId))
        .sort((left, right) => (from ? distance(left, from) - distance(right, from) : 0)
            || Number(left.npcSelfId) - Number(right.npcSelfId));
}

// The row's live NPC: the nearest of its template to the row's place, the
// first spawned on a tie (NpcObjectIndex.nearestOfTemplate); options.worldSpawns
// stands in for the world's spawn list.
function targetFromRow(row, role, options = {}) {
    if (!row) return null;
    let world = Array.isArray(options.worldSpawns) ? { npc: { spawns: options.worldSpawns } } : null;
    if (!world) {
        try {
            world = invoke('GameServer/World/World');
        } catch (error) {
            FailureLog.note('town.spawns', error);
            world = null;
        }
    }
    const actor = NpcObjectIndex.nearestOfTemplate(world, row.npcSelfId, Number(row.locX || 0), Number(row.locY || 0));
    const actorHead = Number(actor?.fetchHead?.());
    return {
        actorId: Number(actor?.fetchId?.() || 0) || null,
        npcSelfId: Number(row.npcSelfId),
        name: actor?.fetchName?.() || row.name,
        title: actor?.fetchTitle?.() || row.title,
        serviceRole: role,
        locX: Number(actor?.fetchLocX?.() ?? row.locX),
        locY: Number(actor?.fetchLocY?.() ?? row.locY),
        locZ: Number(actor?.fetchLocZ?.() ?? row.locZ),
        head: Number.isFinite(actorHead) ? ((actorHead % 65536) + 65536) % 65536 : row.head,
        town: row.town
    };
}

function targetFor(role, town, options = {}) {
    return targetFromRow(candidates(role, town, options)[0] || null, role, options);
}

function targetForNpc(role, town, npcSelfId, options = {}) {
    const from = options.from || null;
    const row = rowsForTown(town, role)
        .filter((candidate) => Number(candidate.npcSelfId) === Number(npcSelfId))
        .sort((left, right) => (from ? distance(left, from) - distance(right, from) : 0))[0] || null;
    return targetFromRow(row, role, options);
}

function targetNear(role, from, options = {}) {
    const maxDistance = Number(options.maxDistance || MAX_TOWN_DISTANCE);
    const selfId = Number(options.selfId || 0);
    const excludedNpcSelfIds = new Set((options.excludedNpcSelfIds || []).map(Number));
    const row = rows(role)
        .filter((candidate) => !excludedNpcSelfIds.has(Number(candidate.npcSelfId)))
        .filter((candidate) => ![ROLES.SELLER, ROLES.GENERIC_MERCHANT].includes(role) || !selfId || !!NpcShopBuyLists.rowForNpc(candidate.npcSelfId, selfId))
        .filter((candidate) => distance(candidate, from) <= maxDistance)
        .sort((left, right) => distance(left, from) - distance(right, from))[0] || null;
    return targetFromRow(row, role, options);
}

module.exports = {
    GENERIC_MERCHANT_TITLES,
    MAX_TOWN_DISTANCE,
    ROLES,
    candidates,
    rows,
    rowsForTown,
    targetFor,
    targetForNpc,
    targetFromRow,
    targetNear
};
