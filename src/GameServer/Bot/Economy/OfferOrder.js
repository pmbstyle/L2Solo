// The order in which a buyer considers sell offers. Used by the main thread
// and the planning workers, so it reads only the static town table.
const { towns } = require('../../World/TownRespawn');

const townByName = new Map(Object.values(towns).map((town) => [town.name, town]));

// Distance from the buyer to the offer's town; Infinity when either is unknown.
function townDistance(offer, origin) {
    const town = townByName.get(offer?.town);
    const x = Number(origin?.locX);
    const y = Number(origin?.locY);
    // Life states persist an unknown location as 0,0.
    if (!town || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return Infinity;
    return Math.hypot(town.locX - x, town.locY - y);
}

// Towns with the same tax sell an NPC item at the same price. Such a tie
// goes to the town nearest the buyer; equal distances, or a buyer without a
// location, keep the caller's order.
function compareDistance(left, right, origin) {
    const leftDistance = townDistance(left, origin);
    const rightDistance = townDistance(right, origin);
    if (leftDistance === rightDistance) return 0;
    return leftDistance < rightDistance ? -1 : 1;
}

module.exports = { compareDistance, townDistance };
