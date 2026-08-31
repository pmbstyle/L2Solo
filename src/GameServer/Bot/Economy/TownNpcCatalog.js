const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');

const ROLE = TownServiceCatalog.ROLES.SELLER;

function rows() {
    return TownServiceCatalog.rows(ROLE);
}

function rowsForTown(town) {
    return TownServiceCatalog.rowsForTown(town, ROLE);
}

function sellersByTown() {
    const byTown = {};
    rows().forEach((row) => {
        if (!byTown[row.town]) byTown[row.town] = [];
        if (!byTown[row.town].includes(Number(row.npcSelfId))) byTown[row.town].push(Number(row.npcSelfId));
    });
    return Object.freeze(Object.fromEntries(Object.entries(byTown)
        .map(([town, entries]) => [town, Object.freeze(entries)])));
}

function candidates(town, options = {}) {
    return TownServiceCatalog.candidates(ROLE, town, options);
}

function closestSeller(town, options = {}) {
    return candidates(town, options)[0] || null;
}

function targetFor(town, options = {}) {
    return TownServiceCatalog.targetFor(ROLE, town, options);
}

function targetForNpc(town, npcSelfId, options = {}) {
    return TownServiceCatalog.targetForNpc(ROLE, town, npcSelfId, options);
}

module.exports = {
    MAX_TOWN_DISTANCE: TownServiceCatalog.MAX_TOWN_DISTANCE,
    candidates,
    closestSeller,
    rows,
    rowsForTown,
    sellersByTown,
    targetFor,
    targetForNpc
};
