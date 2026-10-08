const ServerResponse = invoke('GameServer/Network/Response');

// C4 water-zone bounds for region 18_20 (zones 15022-15024): northwest
// sea, then the horizontal passage and entrance shaft of the necropolis.
// The Altar of Rites is dry land even where its terrain is below sea level.
const ALTAR_REGION_WATER = [
    { minX: -65536, maxX: -55536, minY: 65536, maxY: 75536, minZ: -4810, maxZ: -3810 },
    { minX: -55870, maxX: -54153, minY: 78850, maxY: 79360, minZ: -5438, maxZ: -4862 },
    { minX: -55945, maxX: -55420, minY: 78850, maxY: 79360, minZ: -5438, maxZ: -2960 }
];

// C4 Oren water zones 15089-15093. Low Leto hunting grounds are dry;
// the river and both parts of the Apostate entrance remain underwater.
const OREN_NORTH_WATER = [
    { minX: 84727, maxX: 91727, minY: 32768, maxY: 53768, minZ: -4810, maxZ: -3810 }
];
const OREN_SOUTH_WATER = [
    { minX: 65536, maxX: 98304, minY: 91304, maxY: 98304, minZ: -4802, maxZ: -3802 },
    { minX: 65536, maxX: 70536, minY: 71304, maxY: 91304, minZ: -4802, maxZ: -3802 },
    { minX: 74050, maxX: 74550, minY: 78150, maxY: 78665, minZ: -5822, maxZ: -3340 },
    { minX: 74110, maxX: 75791, minY: 78150, maxY: 78665, minZ: -5822, maxZ: -5245 }
];

function underwaterCheck(session, actor) {
    let mapX = ((actor.fetchLocX() - ((11 - 20) * 32768)) >> 15) + 11;
    let mapY = ((actor.fetchLocY() - ((10 - 18) * 32768)) >> 15) + 10;

    const waterZones = mapX === 18 && mapY === 20 ? ALTAR_REGION_WATER
        : mapX === 22 && mapY === 19 ? OREN_NORTH_WATER
        : mapX === 22 && mapY === 20 ? OREN_SOUTH_WATER : null;
    if (waterZones) {
        const x = actor.fetchLocX(), y = actor.fetchLocY(), z = actor.fetchLocZ();
        const underwater = waterZones.some(zone =>
            x >= zone.minX && x <= zone.maxX && y >= zone.minY && y <= zone.maxY
            && z >= zone.minZ && z <= zone.maxZ
        );
        if (underwater) {
            if (actor.stateWater !== true)
                session.dataSendToMe(ServerResponse.skillDurationBar(86000, 2));
        } else {
            session.dataSendToMe(ServerResponse.skillDurationBar(0, 2));
        }
        actor.stateWater = underwater;
        return;
    }

    if (actor.fetchLocZ() < -3790) {
        if ((mapX === 17 && mapY === 21) || // Northeast Of Orc Barracks
            (mapX === 18 && mapY === 19) || // School Of Dark Arts
            (mapX === 18 && mapY === 23) || // Forgotten Temple
            (mapX === 19 && mapY === 22) || // Ruins Of Despair
            (mapX === 19 && mapY === 23) || // Ruins Of Despair towards Northern Ant Nest
            (mapX === 19 && mapY === 24) || // Southern Ant Nest
            (mapX === 20 && mapY === 18) || // Dark Elven Area
            (mapX === 20 && mapY === 20) || // Elven Fortress
            (mapX === 20 && mapY === 21) || // Cruma Tower
            (mapX === 21 && mapY === 18) || // Sea Of Spores
            (mapX === 21 && mapY === 22) || // Execution Ground
            (mapX === 21 && mapY === 25) || // Elven Ruins
            (mapX === 22 && mapY === 18) || // IVT
            (mapX === 22 && mapY === 21) || // Entrance to DV from Death Pass
            (mapX === 23 && mapY === 17) || // Border Outpost (West)
            (mapX === 23 && mapY === 19) || // Enchanted V.
            (mapX === 23 && mapY === 20) || // Below Hunter's V.
            (mapX === 23 && mapY === 21) || // Deep inside DV
            (mapX === 24 && mapY === 17) || // Blazin Swamp
            (mapX === 24 && mapY === 21) || // Deep inside Anthara's Lair
            (mapX === 25 && mapY === 21) || // Anthara's Nest
            (mapX === 25 && mapY === 12) || // Mithril Mines
            (mapX === 25 && mapY === 19)) { // The Giant's Cave
                actor.stateWater = false;
                session.dataSendToMe(ServerResponse.skillDurationBar(0, 2));
                return;
        }

        let current = actor.fetchLocZ() + 3790;
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(mapX + ' ' + mapY + ' ' + current + ' ' + (current < 0 ? 'Underwater?' : ''));

        if (actor.stateWater === true) {
            return;
        }

        actor.stateWater = true;
        session.dataSendToMe(ServerResponse.skillDurationBar(86000, 2));
    }
    else {
        actor.stateWater = false;
        session.dataSendToMe(ServerResponse.skillDurationBar(0, 2));
    }
}

module.exports = underwaterCheck;
