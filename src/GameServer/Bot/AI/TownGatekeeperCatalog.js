const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');

const ROLE = TownServiceCatalog.ROLES.GATEKEEPER;

function rows() {
    return TownServiceCatalog.rows(ROLE);
}

function targetNear(from, options = {}) {
    return TownServiceCatalog.targetNear(ROLE, from, options);
}

function targetForTown(townName, options = {}) {
    return TownServiceCatalog.targetFor(ROLE, townName, options);
}

module.exports = {
    MAX_TOWN_DISTANCE: TownServiceCatalog.MAX_TOWN_DISTANCE,
    rows,
    targetForTown,
    targetNear
};
