const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const BotWarehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const { marketStoreTitle } = invoke('GameServer/Bot/Economy/MarketStoreTitle');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const MarketTownPolicy = invoke('GameServer/Bot/Economy/MarketTownPolicy');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');

const DEFAULT_LISTING_MS = 20 * 60 * 1000;
const SELL_RETRY_DELAY_MS = 30 * 60 * 1000;
const MARKET_TOWN_ROUTING_VERSION = 4;
// Captured in-game from the Giran trading square. The inner rectangle is the
// central column: it is walkable around, but a private store cannot sit there.
const GIRAN_MARKET_PLAZA = Object.freeze({
    outer: Object.freeze({ minX: 80911, maxX: 82947, minY: 147662, maxY: 149550 }),
    column: Object.freeze({ minX: 81667, maxX: 82174, minY: 148354, maxY: 148857 }),
    locZ: -3466
});
const GIRAN_STALL_EDGE_PADDING = 60;
const GIRAN_COLUMN_CLEARANCE = 80;
const GIRAN_STALL_MIN_DISTANCE = 40;
// Captured from the Gludio D-grade trading square. Dynamic stalls use its
// north, level ground; the south edge changes elevation and stays clear for
// the fixed perimeter traders.
const GLUDIO_D_MARKET_PLAZA = Object.freeze({
    outer: Object.freeze({ minX: -14710, maxX: -14200, minY: 122620, maxY: 123820 }),
    locZ: -3117
});
const GLUDIO_D_STALL_EDGE_PADDING = 60;
const GLUDIO_D_STALL_MIN_DISTANCE = 60;
const DION_D_MARKET_PLAZA = Object.freeze({
    boundary: Object.freeze([
        [15575, 143050], [16665, 144618], [17082, 145399], [18101, 146231],
        [18564, 145810], [17813, 145422], [17129, 144877], [16364, 142984]
    ]),
    bounds: Object.freeze({ minX: 15575, maxX: 18564, minY: 142984, maxY: 146231 }),
    locZ: -2900
});
const DION_D_STALL_EDGE_PADDING = 55;
const DION_D_STALL_MIN_DISTANCE = 60;
const TALKING_ISLAND_NO_GRADE_PLAZA = Object.freeze({
    boundary: Object.freeze([
        [-84242, 245018], [-83965, 244591], [-84553, 243951],
        [-84801, 244105], [-85256, 243540], [-85494, 243762]
    ]),
    bounds: Object.freeze({ minX: -85494, maxX: -83965, minY: 243540, maxY: 245018 }),
    locZ: -3730
});
const TALKING_ISLAND_STALL_EDGE_PADDING = 55;
const TALKING_ISLAND_STALL_MIN_DISTANCE = 60;
const ELVEN_VILLAGE_NO_GRADE_PLAZA = Object.freeze({
    boundary: Object.freeze([
        [46644, 50600], [47041, 49427], [46867, 48783],
        [46384, 49055], [46230, 50247]
    ]),
    bounds: Object.freeze({ minX: 46230, maxX: 47041, minY: 48783, maxY: 50600 }),
    locZ: -3060
});
const ELVEN_VILLAGE_STALL_EDGE_PADDING = 55;
const ELVEN_VILLAGE_STALL_MIN_DISTANCE = 60;
const DARK_ELVEN_VILLAGE_NO_GRADE_PLAZA = Object.freeze({
    boundary: Object.freeze([
        [12112, 16364], [13160, 16121], [13286, 16756], [12230, 17001]
    ]),
    bounds: Object.freeze({ minX: 12112, maxX: 13286, minY: 16121, maxY: 17001 }),
    locZ: -4585
});
const DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING = 55;
const DARK_ELVEN_VILLAGE_STALL_MIN_DISTANCE = 60;
const ORC_VILLAGE_NO_GRADE_PLAZA = Object.freeze({
    boundary: Object.freeze([
        [-45219, -112854], [-45219, -111851], [-44647, -111993], [-43825, -112855]
    ]),
    bounds: Object.freeze({ minX: -45219, maxX: -43825, minY: -112854, maxY: -111851 }),
    locZ: -240
});
const ORC_VILLAGE_STALL_EDGE_PADDING = 55;
const ORC_VILLAGE_STALL_MIN_DISTANCE = 60;
const DWARVEN_VILLAGE_NO_GRADE_PLAZA = Object.freeze({
    boundary: Object.freeze([
        [115570, -178085], [115871, -179190], [115235, -179361], [115099, -177873]
    ]),
    bounds: Object.freeze({ minX: 115099, maxX: 115871, minY: -179361, maxY: -177873 }),
    locZ: -920
});
const DWARVEN_VILLAGE_STALL_EDGE_PADDING = 55;
const DWARVEN_VILLAGE_STALL_MIN_DISTANCE = 60;

function marketTown(name) {
    return TownPathfinder.towns.find((town) => town.name === name)
        || MarketTownPolicy.marketTown(name)
        || TownPathfinder.towns.find((town) => town.name === 'Giran')
        || null;
}

const targetMarketTownName = MarketTownPolicy.targetTownForItems;

function isInRect(loc, rect) {
    return Number(loc?.locX) >= rect.minX && Number(loc?.locX) <= rect.maxX
        && Number(loc?.locY) >= rect.minY && Number(loc?.locY) <= rect.maxY;
}

function isInsidePolygon(loc, boundary = []) {
    const x = Number(loc?.locX);
    const y = Number(loc?.locY);
    return boundary.reduce((inside, point, index) => {
        const previous = boundary[(index + boundary.length - 1) % boundary.length];
        const [xi, yi] = point;
        const [xj, yj] = previous;
        return ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi) / (yj - yi)) + xi) ? !inside : inside;
    }, false);
}

function isGiranPlazaStallLocation(loc) {
    const { outer, column } = GIRAN_MARKET_PLAZA;
    const safeOuter = {
        minX: outer.minX + GIRAN_STALL_EDGE_PADDING,
        maxX: outer.maxX - GIRAN_STALL_EDGE_PADDING,
        minY: outer.minY + GIRAN_STALL_EDGE_PADDING,
        maxY: outer.maxY - GIRAN_STALL_EDGE_PADDING
    };
    const blockedColumn = {
        minX: column.minX - GIRAN_COLUMN_CLEARANCE,
        maxX: column.maxX + GIRAN_COLUMN_CLEARANCE,
        minY: column.minY - GIRAN_COLUMN_CLEARANCE,
        maxY: column.maxY + GIRAN_COLUMN_CLEARANCE
    };
    return isInRect(loc, safeOuter) && !isInRect(loc, blockedColumn);
}

function distance2d(a, b) {
    const dx = Number(a?.locX || 0) - Number(b?.locX || 0);
    const dy = Number(a?.locY || 0) - Number(b?.locY || 0);
    return Math.sqrt(dx * dx + dy * dy);
}

function staticMerchantStalls(townName, isValidStall) {
    return Object.values(MerchantStoreConfigs)
        .filter((store) => store.town === townName)
        .map((store) => ({ locX: store.locX, locY: store.locY, locZ: store.locZ }))
        .filter(isValidStall);
}

function isFreeGiranPlazaStall(loc, occupied) {
    return isGiranPlazaStallLocation(loc)
        && !occupied.some((other) => distance2d(loc, other) < GIRAN_STALL_MIN_DISTANCE);
}

function occupiedGiranPlazaStalls(characterId) {
    return [
        ...staticMerchantStalls('Giran', isGiranPlazaStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && (
                (state.activity === 'merchant' && state.stats?.marketStore?.town === 'Giran')
                || (state.activity === 'crafting' && state.stats?.craftShop?.town === 'Giran')
            )
            && isGiranPlazaStallLocation(state.stats.marketStore?.loc || state.stats.craftShop?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.stats.craftShop?.loc || state.loc)
    ];
}

function isGludioDMarketStallLocation(loc) {
    const { outer } = GLUDIO_D_MARKET_PLAZA;
    return isInRect(loc, {
        minX: outer.minX + GLUDIO_D_STALL_EDGE_PADDING,
        maxX: outer.maxX - GLUDIO_D_STALL_EDGE_PADDING,
        minY: outer.minY + GLUDIO_D_STALL_EDGE_PADDING,
        maxY: outer.maxY - GLUDIO_D_STALL_EDGE_PADDING
    });
}

function occupiedGludioDStalls(characterId) {
    return [
        ...staticMerchantStalls('Gludio', isGludioDMarketStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Gludio'
            && isGludioDMarketStallLocation(state.stats.marketStore?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function chooseGludioDMarketStall(random = Math.random, occupied = []) {
    const { outer, locZ } = GLUDIO_D_MARKET_PLAZA;
    const minX = outer.minX + GLUDIO_D_STALL_EDGE_PADDING;
    const maxX = outer.maxX - GLUDIO_D_STALL_EDGE_PADDING;
    const minY = outer.minY + GLUDIO_D_STALL_EDGE_PADDING;
    const maxY = outer.maxY - GLUDIO_D_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = {
            locX: Math.round(minX + random() * (maxX - minX)),
            locY: Math.round(minY + random() * (maxY - minY)),
            locZ
        };
        if (isGludioDMarketStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < GLUDIO_D_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += GLUDIO_D_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += GLUDIO_D_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (!occupied.some((other) => distance2d(loc, other) < GLUDIO_D_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function isDionDMarketStallLocation(loc) {
    const { bounds, boundary } = DION_D_MARKET_PLAZA;
    return isInRect(loc, {
        minX: bounds.minX + DION_D_STALL_EDGE_PADDING,
        maxX: bounds.maxX - DION_D_STALL_EDGE_PADDING,
        minY: bounds.minY + DION_D_STALL_EDGE_PADDING,
        maxY: bounds.maxY - DION_D_STALL_EDGE_PADDING
    }) && isInsidePolygon(loc, boundary);
}

function occupiedDionDStalls(characterId) {
    return [
        ...staticMerchantStalls('Dion', isDionDMarketStallLocation),
        ...LifeState.allStates(2000)
            .filter((state) => Number(state.characterId) !== Number(characterId)
                && state.activity === 'merchant'
                && state.stats?.marketStore?.town === 'Dion'
                && isDionDMarketStallLocation(state.stats.marketStore?.loc || state.loc))
            .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function dionGroundLocation(locX, locY) {
    return { locX, locY, locZ: GeodataEngine.getHeight(locX, locY, DION_D_MARKET_PLAZA.locZ) };
}

function chooseDionDMarketStall(random = Math.random, occupied = []) {
    const { bounds } = DION_D_MARKET_PLAZA;
    const minX = bounds.minX + DION_D_STALL_EDGE_PADDING;
    const maxX = bounds.maxX - DION_D_STALL_EDGE_PADDING;
    const minY = bounds.minY + DION_D_STALL_EDGE_PADDING;
    const maxY = bounds.maxY - DION_D_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 128; attempt++) {
        const loc = dionGroundLocation(
            Math.round(minX + random() * (maxX - minX)),
            Math.round(minY + random() * (maxY - minY))
        );
        if (isDionDMarketStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < DION_D_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += DION_D_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += DION_D_STALL_MIN_DISTANCE) {
            const loc = dionGroundLocation(locX, locY);
            if (isDionDMarketStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < DION_D_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function isTalkingIslandNoGradeStallLocation(loc) {
    const { bounds, boundary } = TALKING_ISLAND_NO_GRADE_PLAZA;
    return isInRect(loc, {
        minX: bounds.minX + TALKING_ISLAND_STALL_EDGE_PADDING,
        maxX: bounds.maxX - TALKING_ISLAND_STALL_EDGE_PADDING,
        minY: bounds.minY + TALKING_ISLAND_STALL_EDGE_PADDING,
        maxY: bounds.maxY - TALKING_ISLAND_STALL_EDGE_PADDING
    }) && isInsidePolygon(loc, boundary);
}

function occupiedTalkingIslandNoGradeStalls(characterId) {
    return [
        ...staticMerchantStalls('Talking Island', isTalkingIslandNoGradeStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Talking Island'
            && isTalkingIslandNoGradeStallLocation(state.stats.marketStore?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function chooseTalkingIslandNoGradeStall(random = Math.random, occupied = []) {
    const { bounds, locZ } = TALKING_ISLAND_NO_GRADE_PLAZA;
    const minX = bounds.minX + TALKING_ISLAND_STALL_EDGE_PADDING;
    const maxX = bounds.maxX - TALKING_ISLAND_STALL_EDGE_PADDING;
    const minY = bounds.minY + TALKING_ISLAND_STALL_EDGE_PADDING;
    const maxY = bounds.maxY - TALKING_ISLAND_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = { locX: Math.round(minX + random() * (maxX - minX)), locY: Math.round(minY + random() * (maxY - minY)), locZ };
        if (isTalkingIslandNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < TALKING_ISLAND_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += TALKING_ISLAND_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += TALKING_ISLAND_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isTalkingIslandNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < TALKING_ISLAND_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function isElvenVillageNoGradeStallLocation(loc) {
    const { bounds, boundary } = ELVEN_VILLAGE_NO_GRADE_PLAZA;
    return isInRect(loc, {
        minX: bounds.minX + ELVEN_VILLAGE_STALL_EDGE_PADDING,
        maxX: bounds.maxX - ELVEN_VILLAGE_STALL_EDGE_PADDING,
        minY: bounds.minY + ELVEN_VILLAGE_STALL_EDGE_PADDING,
        maxY: bounds.maxY - ELVEN_VILLAGE_STALL_EDGE_PADDING
    }) && isInsidePolygon(loc, boundary);
}

function occupiedElvenVillageNoGradeStalls(characterId) {
    return [
        ...staticMerchantStalls('Elven Village', isElvenVillageNoGradeStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Elven Village'
            && isElvenVillageNoGradeStallLocation(state.stats.marketStore?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function chooseElvenVillageNoGradeStall(random = Math.random, occupied = []) {
    const { bounds, locZ } = ELVEN_VILLAGE_NO_GRADE_PLAZA;
    const minX = bounds.minX + ELVEN_VILLAGE_STALL_EDGE_PADDING;
    const maxX = bounds.maxX - ELVEN_VILLAGE_STALL_EDGE_PADDING;
    const minY = bounds.minY + ELVEN_VILLAGE_STALL_EDGE_PADDING;
    const maxY = bounds.maxY - ELVEN_VILLAGE_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = { locX: Math.round(minX + random() * (maxX - minX)), locY: Math.round(minY + random() * (maxY - minY)), locZ };
        if (isElvenVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < ELVEN_VILLAGE_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += ELVEN_VILLAGE_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += ELVEN_VILLAGE_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isElvenVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < ELVEN_VILLAGE_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function isDarkElvenVillageNoGradeStallLocation(loc) {
    const { bounds, boundary } = DARK_ELVEN_VILLAGE_NO_GRADE_PLAZA;
    return isInRect(loc, {
        minX: bounds.minX + DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING,
        maxX: bounds.maxX - DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING,
        minY: bounds.minY + DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING,
        maxY: bounds.maxY - DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING
    }) && isInsidePolygon(loc, boundary);
}

function occupiedDarkElvenVillageNoGradeStalls(characterId) {
    return [
        ...staticMerchantStalls('Dark Elven Village', isDarkElvenVillageNoGradeStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Dark Elven Village'
            && isDarkElvenVillageNoGradeStallLocation(state.stats.marketStore?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function chooseDarkElvenVillageNoGradeStall(random = Math.random, occupied = []) {
    const { bounds, locZ } = DARK_ELVEN_VILLAGE_NO_GRADE_PLAZA;
    const minX = bounds.minX + DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING;
    const maxX = bounds.maxX - DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING;
    const minY = bounds.minY + DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING;
    const maxY = bounds.maxY - DARK_ELVEN_VILLAGE_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = { locX: Math.round(minX + random() * (maxX - minX)), locY: Math.round(minY + random() * (maxY - minY)), locZ };
        if (isDarkElvenVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < DARK_ELVEN_VILLAGE_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += DARK_ELVEN_VILLAGE_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += DARK_ELVEN_VILLAGE_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isDarkElvenVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < DARK_ELVEN_VILLAGE_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function isOrcVillageNoGradeStallLocation(loc) {
    const { bounds, boundary } = ORC_VILLAGE_NO_GRADE_PLAZA;
    return isInRect(loc, {
        minX: bounds.minX + ORC_VILLAGE_STALL_EDGE_PADDING,
        maxX: bounds.maxX - ORC_VILLAGE_STALL_EDGE_PADDING,
        minY: bounds.minY + ORC_VILLAGE_STALL_EDGE_PADDING,
        maxY: bounds.maxY - ORC_VILLAGE_STALL_EDGE_PADDING
    }) && isInsidePolygon(loc, boundary);
}

function occupiedOrcVillageNoGradeStalls(characterId) {
    return [
        ...staticMerchantStalls('Orc Village', isOrcVillageNoGradeStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Orc Village'
            && isOrcVillageNoGradeStallLocation(state.stats.marketStore?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function chooseOrcVillageNoGradeStall(random = Math.random, occupied = []) {
    const { bounds, locZ } = ORC_VILLAGE_NO_GRADE_PLAZA;
    const minX = bounds.minX + ORC_VILLAGE_STALL_EDGE_PADDING;
    const maxX = bounds.maxX - ORC_VILLAGE_STALL_EDGE_PADDING;
    const minY = bounds.minY + ORC_VILLAGE_STALL_EDGE_PADDING;
    const maxY = bounds.maxY - ORC_VILLAGE_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = { locX: Math.round(minX + random() * (maxX - minX)), locY: Math.round(minY + random() * (maxY - minY)), locZ };
        if (isOrcVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < ORC_VILLAGE_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += ORC_VILLAGE_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += ORC_VILLAGE_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isOrcVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < ORC_VILLAGE_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function isDwarvenVillageNoGradeStallLocation(loc) {
    const { bounds, boundary } = DWARVEN_VILLAGE_NO_GRADE_PLAZA;
    return isInRect(loc, {
        minX: bounds.minX + DWARVEN_VILLAGE_STALL_EDGE_PADDING,
        maxX: bounds.maxX - DWARVEN_VILLAGE_STALL_EDGE_PADDING,
        minY: bounds.minY + DWARVEN_VILLAGE_STALL_EDGE_PADDING,
        maxY: bounds.maxY - DWARVEN_VILLAGE_STALL_EDGE_PADDING
    }) && isInsidePolygon(loc, boundary);
}

function occupiedDwarvenVillageNoGradeStalls(characterId) {
    return [
        ...staticMerchantStalls('Dwarven Village', isDwarvenVillageNoGradeStallLocation),
        ...LifeState.allStates(2000)
        .filter((state) => Number(state.characterId) !== Number(characterId)
            && state.activity === 'merchant'
            && state.stats?.marketStore?.town === 'Dwarven Village'
            && isDwarvenVillageNoGradeStallLocation(state.stats.marketStore?.loc || state.loc))
        .map((state) => state.stats.marketStore?.loc || state.loc)
    ];
}

function chooseDwarvenVillageNoGradeStall(random = Math.random, occupied = []) {
    const { bounds, locZ } = DWARVEN_VILLAGE_NO_GRADE_PLAZA;
    const minX = bounds.minX + DWARVEN_VILLAGE_STALL_EDGE_PADDING;
    const maxX = bounds.maxX - DWARVEN_VILLAGE_STALL_EDGE_PADDING;
    const minY = bounds.minY + DWARVEN_VILLAGE_STALL_EDGE_PADDING;
    const maxY = bounds.maxY - DWARVEN_VILLAGE_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = { locX: Math.round(minX + random() * (maxX - minX)), locY: Math.round(minY + random() * (maxY - minY)), locZ };
        if (isDwarvenVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < DWARVEN_VILLAGE_STALL_MIN_DISTANCE)) return loc;
    }
    for (let locX = minX; locX <= maxX; locX += DWARVEN_VILLAGE_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += DWARVEN_VILLAGE_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isDwarvenVillageNoGradeStallLocation(loc) && !occupied.some((other) => distance2d(loc, other) < DWARVEN_VILLAGE_STALL_MIN_DISTANCE)) return loc;
        }
    }
    return null;
}

function chooseGiranPlazaStall(random = Math.random, occupied = []) {
    const { outer, locZ } = GIRAN_MARKET_PLAZA;
    const minX = outer.minX + GIRAN_STALL_EDGE_PADDING;
    const maxX = outer.maxX - GIRAN_STALL_EDGE_PADDING;
    const minY = outer.minY + GIRAN_STALL_EDGE_PADDING;
    const maxY = outer.maxY - GIRAN_STALL_EDGE_PADDING;
    for (let attempt = 0; attempt < 96; attempt++) {
        const loc = {
            locX: Math.round(minX + random() * (maxX - minX)),
            locY: Math.round(minY + random() * (maxY - minY)),
            locZ
        };
        if (isFreeGiranPlazaStall(loc, occupied)) return loc;
    }

    // A deterministic grid is the overflow path: it keeps a dense, readable
    // market rather than allowing two stores to occupy one stall.
    for (let locX = minX; locX <= maxX; locX += GIRAN_STALL_MIN_DISTANCE) {
        for (let locY = minY; locY <= maxY; locY += GIRAN_STALL_MIN_DISTANCE) {
            const loc = { locX, locY, locZ };
            if (isFreeGiranPlazaStall(loc, occupied)) return loc;
        }
    }
    return null;
}

function marketLocation(town, options) {
    if (town?.name === 'Giran') return chooseGiranPlazaStall(options.random, occupiedGiranPlazaStalls(options.state?.characterId));
    if (town?.name === 'Gludio') return chooseGludioDMarketStall(options.random, occupiedGludioDStalls(options.state?.characterId));
    if (town?.name === 'Dion') return chooseDionDMarketStall(options.random, occupiedDionDStalls(options.state?.characterId));
    if (town?.name === 'Talking Island') return chooseTalkingIslandNoGradeStall(options.random, occupiedTalkingIslandNoGradeStalls(options.state?.characterId));
    if (town?.name === 'Elven Village') return chooseElvenVillageNoGradeStall(options.random, occupiedElvenVillageNoGradeStalls(options.state?.characterId));
    if (town?.name === 'Dark Elven Village') return chooseDarkElvenVillageNoGradeStall(options.random, occupiedDarkElvenVillageNoGradeStalls(options.state?.characterId));
    if (town?.name === 'Orc Village') return chooseOrcVillageNoGradeStall(options.random, occupiedOrcVillageNoGradeStalls(options.state?.characterId));
    if (town?.name === 'Dwarven Village') return chooseDwarvenVillageNoGradeStall(options.random, occupiedDwarvenVillageNoGradeStalls(options.state?.characterId));
    return town?.center ? { ...town.center } : { ...(options.state?.loc || {}) };
}

function open(state, options = {}) {
    if (!state || state.phase === 'hot' || state.activity !== 'shopping') {
        return Promise.resolve({ state, listed: false, reason: 'not_shopping' });
    }
    const items = ItemDisposition.saleCandidates(state, options);
    if (!items.length) return Promise.resolve({ state, listed: false, reason: 'nothing_to_sell' });

    const timestamp = Number(options.now) || Date.now();
    const town = marketTown(options.town || targetMarketTownName(state, items));
    const storeLoc = marketLocation(town, { ...options, state });
    if (!storeLoc) return Promise.resolve({ state, listed: false, reason: 'giran_plaza_full' });
    const nextState = {
        ...state,
        activity: 'merchant',
        currentRegion: town?.name || state.currentRegion,
        // A private store has a stall, not a roaming route. Persist the plaza
        // coordinate so cold ticks and hot materialization use the same spot.
        loc: storeLoc,
        stats: {
            ...(state.stats || {}),
            marketStore: {
                id: `${state.characterId}:${timestamp}`,
                storeType: 1,
                sellerCharacterId: Number(state.characterId),
                sellerName: state.name,
                title: options.title || marketStoreTitle(items),
                autoTitle: !options.title,
                marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION,
                town: town?.name || options.town || state.currentRegion,
                loc: storeLoc,
                items,
                openedAt: timestamp,
                expiresAt: timestamp + (Number(options.durationMs) || DEFAULT_LISTING_MS)
            }
        },
        timing: {
            ...(state.timing || {}),
            activityStartedAt: timestamp,
            nextResolveAt: timestamp + 60000
        }
    };
    return LifeState.upsertState(nextState, 'cold_market_listing').then((saved) => {
        if (saved) MarketOpportunity.indexColdStore(saved);
        return {
            state: saved || state,
            listed: !!saved,
            itemCount: items.length
        };
    });
}

function resolve(state, timestamp = Date.now()) {
    const store = state?.stats?.marketStore;
    if (!state || state.activity !== 'merchant' || !store) return Promise.resolve({ state, closed: false });
    const hasStock = (store.items || []).some((item) => Number(item.count) > 0);
    const isActive = hasStock && Number(store.expiresAt || 0) > timestamp;
    if (isActive) {
        const targetTownName = targetMarketTownName(state, store.items || []);
        if (store.town !== targetTownName) {
            const town = marketTown(targetTownName);
            const loc = marketLocation(town, { state });
            if (!loc) return Promise.resolve({ state, closed: false, reason: 'market_plaza_full' });
            const relocated = {
                ...state,
                currentRegion: town.name,
                loc,
                stats: {
                    ...(state.stats || {}),
                    marketStore: { ...store, marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION, town: town.name, loc }
                }
            };
            return LifeState.upsertState(relocated, 'cold_market_town_rebalanced').then((saved) => {
                if (saved) MarketOpportunity.indexColdStore(saved);
                return { state: saved || relocated, closed: false, relocated: true };
            });
        }
        MarketOpportunity.indexColdStore(state);
        return Promise.resolve({ state, closed: false });
    }

    const nextState = {
        ...state,
        activity: 'shopping',
        stats: {
            ...(state.stats || {}),
            marketStore: null,
            marketSellRetryAfter: hasStock ? timestamp + SELL_RETRY_DELAY_MS : null,
            marketPricing: hasStock ? (store.items || []).reduce((pricing, item) => {
                if (Number(item.count || 0) <= 0) return pricing;
                const previous = Number(pricing[item.selfId]?.percent || 100);
                pricing[item.selfId] = { percent: Math.max(50, previous - 5), lastAdjustedAt: timestamp };
                return pricing;
            }, { ...(state.stats?.marketPricing || {}) }) : state.stats?.marketPricing || {}
        },
        timing: { ...(state.timing || {}), nextResolveAt: timestamp + 30000 }
    };
    MarketOpportunity.removeColdStore(state.characterId);
    return (hasStock ? BotWarehouse.depositCold(nextState) : Promise.resolve({ state: nextState, count: 0 }))
        .then((warehouse) => {
            const storedState = warehouse.state || nextState;
            const liquidated = hasStock ? ItemDisposition.npcLiquidationCandidates(storedState) : [];
            return LifeState.applyNpcLiquidation(storedState, liquidated).then((liquidatedState) => ({
                state: liquidatedState || storedState,
                warehouseCount: warehouse.count || 0,
                liquidated
            }));
        })
        .then(({ state: liquidatedState, warehouseCount, liquidated }) => LifeState.upsertState(liquidatedState, hasStock ? 'cold_market_expired' : 'cold_market_sold_out')
            .then((saved) => ({
                state: saved || liquidatedState,
                closed: true,
                reason: hasStock ? 'expired' : 'sold_out',
                warehouseCount,
                liquidatedCount: liquidated.reduce((sum, item) => sum + Number(item.count || 0), 0)
            })));
}

// Stores created before town-based routing all lived in Giran.  Move that
// bounded legacy set outside the normal cold-resolve queue, which prioritises
// finite travel transitions and may otherwise starve passive merchant states.
function legacyMarketTownCandidates(states = [], limit = 10) {
    const safeLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    return states
        .filter((state) => state.phase === 'cold' && state.activity === 'merchant')
        .filter((state) => state.stats?.marketStore)
        .filter((state) => Number(state.stats.marketStore.marketTownRoutingVersion || 0) < MARKET_TOWN_ROUTING_VERSION)
        .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0))
        .slice(0, safeLimit);
}

function migrateLegacyMarketTowns(limit = 10) {
    return LifeState.legacyMarketTownCandidates(limit, MARKET_TOWN_ROUTING_VERSION).then((states) => {
        const candidates = legacyMarketTownCandidates(states, limit);
        return candidates.reduce((chain, state) => chain.then((migrated) => {
        const store = state.stats.marketStore;
        const targetTownName = targetMarketTownName(state, store.items || []);
        if (store.town === targetTownName) {
            const checked = {
                ...state,
                stats: {
                    ...(state.stats || {}),
                    marketStore: { ...store, marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION }
                }
            };
            return LifeState.upsertState(checked, 'cold_market_town_migration_checked').then((saved) => {
                migrated.push({ state: saved || checked, relocated: false });
                return migrated;
            });
        }

        const town = marketTown(targetTownName);
        const loc = marketLocation(town, { state });
        if (!loc) return migrated;
        const relocated = {
            ...state,
            currentRegion: town.name,
            loc,
            stats: {
                ...(state.stats || {}),
                marketStore: { ...store, marketTownRoutingVersion: MARKET_TOWN_ROUTING_VERSION, town: town.name, loc }
            }
        };
        return LifeState.upsertState(relocated, 'cold_market_town_rebalanced').then((saved) => {
            const resolved = saved || relocated;
            MarketOpportunity.indexColdStore(resolved);
            migrated.push({ state: resolved, relocated: true });
            return migrated;
        });
        }), Promise.resolve([]));
    });
}

function expireStaleMarketStores(limit = 10, timestamp = Date.now()) {
    return LifeState.expiredMarketStoreCandidates(limit, timestamp).then((states) => states.reduce((chain, state) => (
        chain.then((expired) => resolve(state, timestamp).then((result) => {
            if (result.closed) expired.push(result);
            return expired;
        }))
    ), Promise.resolve([])));
}

function reconcileInventory(state) {
    const store = state?.stats?.marketStore;
    if (!state || state.activity !== 'merchant' || !store) return Promise.resolve({ state, reconciled: false });

    const items = ItemDisposition.saleCandidates(state);
    if (items.length) {
        const nextState = {
            ...state,
            stats: {
                ...(state.stats || {}),
                marketStore: {
                    ...store,
                    items,
                    // Existing listings predate inventory-backed titles; they
                    // are upgraded on their next cold-state reconciliation.
                    title: store.autoTitle === false ? store.title : marketStoreTitle(items)
                }
            }
        };
        return LifeState.upsertState(nextState, 'cold_market_inventory_reconciled').then((saved) => {
            if (saved) MarketOpportunity.indexColdStore(saved);
            return { state: saved || nextState, reconciled: true, closed: false };
        });
    }

    const nextState = {
        ...state,
        activity: 'shopping',
        stats: { ...(state.stats || {}), marketStore: null },
        timing: { ...(state.timing || {}), nextResolveAt: Date.now() + 30000 }
    };
    MarketOpportunity.removeColdStore(state.characterId);
    return LifeState.upsertState(nextState, 'cold_market_inventory_empty').then((saved) => ({
        state: saved || nextState,
        reconciled: true,
        closed: true,
        reason: 'inventory_empty'
    }));
}

function settle(offer, qty = 1) {
    if (offer?.sourceType !== 'cold_store') return Promise.resolve(null);
    const seller = LifeState.snapshot(offer.sourceId) || offer.sellerState;
    if (!seller) return Promise.resolve(null);
    return LifeState.applyMarketSale(seller, offer, qty).then((saved) => {
        if (saved) MarketOpportunity.indexColdStore(saved);
        return saved;
    });
}

module.exports = {
    DEFAULT_LISTING_MS,
    SELL_RETRY_DELAY_MS,
    MARKET_TOWN_ROUTING_VERSION,
    GIRAN_MARKET_PLAZA,
    GIRAN_STALL_MIN_DISTANCE,
    GLUDIO_D_MARKET_PLAZA,
    GLUDIO_D_STALL_MIN_DISTANCE,
    DION_D_MARKET_PLAZA,
    DION_D_STALL_MIN_DISTANCE,
    TALKING_ISLAND_NO_GRADE_PLAZA,
    TALKING_ISLAND_STALL_MIN_DISTANCE,
    ELVEN_VILLAGE_NO_GRADE_PLAZA,
    ELVEN_VILLAGE_STALL_MIN_DISTANCE,
    DARK_ELVEN_VILLAGE_NO_GRADE_PLAZA,
    DARK_ELVEN_VILLAGE_STALL_MIN_DISTANCE,
    ORC_VILLAGE_NO_GRADE_PLAZA,
    ORC_VILLAGE_STALL_MIN_DISTANCE,
    DWARVEN_VILLAGE_NO_GRADE_PLAZA,
    DWARVEN_VILLAGE_STALL_MIN_DISTANCE,
    marketStoreTitle,
    staticMerchantStalls,
    targetMarketTownName,
    legacyMarketTownCandidates,
    migrateLegacyMarketTowns,
    expireStaleMarketStores,
    chooseGiranPlazaStall,
    chooseGludioDMarketStall,
    chooseDionDMarketStall,
    chooseTalkingIslandNoGradeStall,
    chooseElvenVillageNoGradeStall,
    chooseDarkElvenVillageNoGradeStall,
    chooseOrcVillageNoGradeStall,
    chooseDwarvenVillageNoGradeStall,
    isGiranPlazaStallLocation,
    isGludioDMarketStallLocation,
    isDionDMarketStallLocation,
    isTalkingIslandNoGradeStallLocation,
    isElvenVillageNoGradeStallLocation,
    isDarkElvenVillageNoGradeStallLocation,
    isOrcVillageNoGradeStallLocation,
    isDwarvenVillageNoGradeStallLocation,
    open,
    reconcileInventory,
    resolve,
    settle
};
