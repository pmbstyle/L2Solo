// Offer ranking shared by the main thread and the planning workers.
const TownRespawn = invoke('GameServer/World/TownRespawn');

// Ties are between towns, so an offer is placed at its town; offer rows do
// not need to carry seller coordinates across worker boundaries.
const townsByName = new Map(Object.values(TownRespawn.towns || {}).map((town) => [town.name, town]));

function townDistance(offer, origin) {
    const town = townsByName.get(offer?.town);
    const x = Number(origin?.locX);
    const y = Number(origin?.locY);
    // Life states persist an unknown location as 0,0.
    if (!town || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return Infinity;
    return Math.hypot(town.locX - x, town.locY - y);
}

// NPC prices match across towns, so ranking equal prices by town name sent
// every buyer to the alphabetically first town. Equal prices go to the town
// nearest the buyer instead; a buyer without a location leaves the tie to
// the caller's existing order.
function compareDistance(left, right, origin) {
    const difference = townDistance(left, origin) - townDistance(right, origin);
    return Number.isNaN(difference) ? 0 : difference;
}

function compareOffersForBuyer(left, right, origin) {
    return Number(left.price) - Number(right.price) || compareDistance(left, right, origin);
}

module.exports = { townDistance, compareDistance, compareOffersForBuyer };
