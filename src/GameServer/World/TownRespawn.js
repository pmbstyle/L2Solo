// Based on the C4 L2J mapRegions/restartPoints data. Restart regions are
// deliberately geographical, not a straight-line nearest-city calculation.
const TOWNS = {
    aden_town: { name: 'Aden', locX: 146737, locY: 25807, locZ: -2008 },
    de_village: { name: 'Dark Elven Village', locX: 9670, locY: 15537, locZ: -4576 },
    dion_town: { name: 'Dion', locX: 15631, locY: 142885, locZ: -2704 },
    dwarven_village: { name: 'Dwarven Village', locX: 115072, locY: -178176, locZ: -880 },
    elven_village: { name: 'Elven Village', locX: 46926, locY: 51511, locZ: -2976 },
    floran_village: { name: 'Floran Village', locX: 19025, locY: 145245, locZ: -3107 },
    giran_town: { name: 'Giran', locX: 83396, locY: 147904, locZ: -3400 },
    gludin_village: { name: 'Gludin', locX: -80752, locY: 149776, locZ: -3040 },
    gludio_town: { name: 'Gludio', locX: -12736, locY: 122816, locZ: -3112 },
    goddard_town: { name: 'Goddard', locX: 147966, locY: -55228, locZ: -2728 },
    hunters_village: { name: "Hunter's Village", locX: 117129, locY: 76917, locZ: -2688 },
    innadril_town: { name: 'Heine', locX: 111386, locY: 219413, locZ: -3544 },
    orc_village: { name: 'Orc Village', locX: -45264, locY: -112512, locZ: -256 },
    oren_town: { name: 'Oren', locX: 82992, locY: 53171, locZ: -1496 },
    rune_town: { name: 'Rune', locX: 43824, locY: -47664, locZ: -792 },
    ti_village: { name: 'Talking Island', locX: -84108, locY: 244604, locZ: -3728 }
};

// Keep the destination close to the gatekeeper without placing the actor in
// the NPC collision model. This is deliberately fixed rather than randomized.
const GATEKEEPER_RESPAWN_OFFSET = { locX: 50, locY: 0 };

const REGION_GROUPS = {
    aden_town: ['23_18', '24_17', '24_18', '25_17', '25_18', '25_19', '24_19'],
    de_village: ['20_18', '19_18', '19_19', '18_19', '18_18', '18_20', '17_19'],
    dion_town: ['18_10', '20_21', '20_22', '21_21', '21_22'],
    dwarven_village: ['23_10', '23_11', '23_12', '24_10', '24_11', '24_12', '25_10', '25_11', '25_12'],
    elven_village: ['21_19', '21_20', '20_19', '20_20'],
    floran_village: ['20_23'],
    giran_town: ['21_23', '22_21', '22_22', '23_21', '23_22', '24_21', '25_21', '20_24', '21_24', '21_25'],
    gludin_village: ['16_20', '16_21', '16_22', '17_20', '17_21', '17_22', '17_23', '18_22', '18_23', '18_24', '19_24'],
    gludio_town: ['19_20', '18_21', '19_21', '19_22', '19_23', '19_26', '20_26'],
    goddard_town: ['23_16', '24_14', '24_15', '24_16', '25_14', '25_15', '25_16', '26_14'],
    hunters_village: ['20_10', '23_20', '23_19', '24_20', '25_20'],
    innadril_town: ['22_23', '22_24', '22_25', '23_23', '23_24', '23_25', '24_23'],
    orc_village: ['18_14', '19_13', '19_14', '19_15', '19_16', '20_13', '20_14', '20_15', '16_10'],
    oren_town: ['19_10', '21_18', '22_20', '22_19', '22_18', '22_17', '23_17'],
    rune_town: ['21_15', '21_16', '21_17', '22_15', '22_16', '23_15', '16_11', '17_10', '17_11', '19_17', '20_16', '20_17', '19_16', '15_10', '15_11', '15_12'],
    ti_village: ['15_23', '15_24', '15_25', '16_23', '16_24', '16_25', '17_24', '17_25', '18_25']
};

const RESPAWN_ZONES = [
    { group: 'oren_town', points: [[117258, -17696], [111573, -6727], [104357, -204], [98363, -186], [98372, -24720]] },
    { group: 'goddard_town', points: [[97820, -33007], [130600, -33101], [131029, -19205], [114478, -17118], [113183, -18971], [97723, -24594]] },
    { group: 'aden_town', points: [[130704, -21362], [130886, -209], [112747, -173], [108637, -3399], [115372, -13695]] }
];

const CELL_TO_GROUP = Object.fromEntries(
    Object.entries(REGION_GROUPS).flatMap(([group, cells]) => cells.map((cell) => [cell, group]))
);

function isInsidePolygon(locX, locY, points) {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
        const [x, y] = points[index];
        const [previousX, previousY] = points[previous];
        const crosses = (y > locY) !== (previousY > locY);
        if (crosses && locX < ((previousX - x) * (locY - y)) / (previousY - y) + x) {
            inside = !inside;
        }
    }
    return inside;
}

function getRegionGroup(locX, locY) {
    const zone = RESPAWN_ZONES.find((candidate) => isInsidePolygon(locX, locY, candidate.points));
    if (zone) return zone.group;

    const mapX = (locX >> 15) + 20;
    const mapY = (locY >> 15) + 18;
    return CELL_TO_GROUP[`${mapX}_${mapY}`];
}

function getClosestTown(locX, locY) {
    const regionalTown = TOWNS[getRegionGroup(locX, locY)];
    if (regionalTown) return regionalTown;

    return Object.values(TOWNS).reduce((closest, town) => {
        const closestDistance = (closest.locX - locX) ** 2 + (closest.locY - locY) ** 2;
        const townDistance = (town.locX - locX) ** 2 + (town.locY - locY) ** 2;
        return townDistance < closestDistance ? town : closest;
    });
}

function getRespawnCoords(locX, locY) {
    const town = getClosestTown(locX, locY);
    return {
        locX: town.locX + GATEKEEPER_RESPAWN_OFFSET.locX,
        locY: town.locY + GATEKEEPER_RESPAWN_OFFSET.locY,
        locZ: town.locZ
    };
}

module.exports = {
    getClosestTown,
    getRegionGroup,
    getRespawnCoords
};
