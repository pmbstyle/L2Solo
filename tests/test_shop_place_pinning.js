// Pins where every current copy of the shop-place code puts a stall (U19), before
// the copies are joined into one table. Each section is one copy or one caller.
// PIN_PRINT=1 prints the observed values instead of checking them.
const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const AfkTradeService = invoke('GameServer/AfkTrade/AfkTradeService');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotTradeChat = invoke('GameServer/Bot/Economy/BotTradeChat');
const BotManager = invoke('GameServer/Bot/BotManager');

DataCache.init();

// Ground height without geodata files: a fixed function of x and y.
GeodataEngine.getHeight = (x, y, z) => z + ((x + y) % 7);

function seeded(seed) {
    let value = seed;
    return () => {
        value = (value * 1103515245 + 12345) % 2147483648;
        return value / 2147483648;
    };
}

const point = (loc) => (loc ? [loc.locX, loc.locY, loc.locZ] : null);

const TOWNS = [
    { name: 'Giran', area: ListingService.GIRAN_MARKET_PLAZA.outer, choose: ListingService.chooseGiranPlazaStall, isStall: ListingService.isGiranPlazaStallLocation },
    { name: 'Gludio', area: ListingService.GLUDIO_D_MARKET_PLAZA.outer, choose: ListingService.chooseGludioDMarketStall, isStall: ListingService.isGludioDMarketStallLocation },
    { name: 'Dion', area: ListingService.DION_D_MARKET_PLAZA.bounds, choose: ListingService.chooseDionDMarketStall, isStall: ListingService.isDionDMarketStallLocation },
    { name: 'Talking Island', area: ListingService.TALKING_ISLAND_NO_GRADE_PLAZA.bounds, choose: ListingService.chooseTalkingIslandNoGradeStall, isStall: ListingService.isTalkingIslandNoGradeStallLocation },
    { name: 'Elven Village', area: ListingService.ELVEN_VILLAGE_NO_GRADE_PLAZA.bounds, choose: ListingService.chooseElvenVillageNoGradeStall, isStall: ListingService.isElvenVillageNoGradeStallLocation },
    { name: 'Dark Elven Village', area: ListingService.DARK_ELVEN_VILLAGE_NO_GRADE_PLAZA.bounds, choose: ListingService.chooseDarkElvenVillageNoGradeStall, isStall: ListingService.isDarkElvenVillageNoGradeStallLocation },
    { name: 'Orc Village', area: ListingService.ORC_VILLAGE_NO_GRADE_PLAZA.bounds, choose: ListingService.chooseOrcVillageNoGradeStall, isStall: ListingService.isOrcVillageNoGradeStallLocation },
    { name: 'Dwarven Village', area: ListingService.DWARVEN_VILLAGE_NO_GRADE_PLAZA.bounds, choose: ListingService.chooseDwarvenVillageNoGradeStall, isStall: ListingService.isDwarvenVillageNoGradeStallLocation }
];

// The area as each predicate sees it: a 12 x 12 sample over the bounds widened by
// 100, one character per point.
function areaSample(isStall, area) {
    const rows = [];
    for (let j = 0; j < 12; j++) {
        let row = '';
        for (let i = 0; i < 12; i++) {
            const locX = Math.round(area.minX - 100 + (area.maxX - area.minX + 200) * i / 11);
            const locY = Math.round(area.minY - 100 + (area.maxY - area.minY + 200) * j / 11);
            row += isStall({ locX, locY }) ? '#' : '.';
        }
        rows.push(row);
    }
    return rows;
}

// Six stalls in a row, each new one seeing the ones before it, then the overflow
// grid (every random try lands on an occupied point).
function chooseSequence(town) {
    const random = seeded(17);
    const occupied = [];
    const placed = [];
    for (let i = 0; i < 6; i++) {
        const loc = town.choose(random, occupied);
        placed.push(point(loc));
        if (loc) occupied.push(loc);
    }
    const first = town.choose(() => 0.37, []);
    const overflow = town.choose(() => 0.37, first ? [first] : []);
    return { placed, first: point(first), overflow: point(overflow) };
}

// marketLocation reads three sources of taken places. Every random try lands on one
// point; a stub occupant is put there and the result shows whether that occupant
// counts (the result moves away) or not (the stall stays on the point).
function withSources(states, afk, fn) {
    const calls = { allStates: [], afk: [] };
    const allStates = LifeState.allStates;
    const activeLocations = AfkTradeService.activeLocations;
    LifeState.allStates = (limit) => { calls.allStates.push(limit); return states; };
    AfkTradeService.activeLocations = (town, characterId) => { calls.afk.push([town, characterId]); return afk; };
    try {
        return { result: fn(), calls };
    } finally {
        LifeState.allStates = allStates;
        AfkTradeService.activeLocations = activeLocations;
    }
}

function withRandom(random, fn) {
    const original = Math.random;
    Math.random = random;
    try {
        return fn();
    } finally {
        Math.random = original;
    }
}

const SELF = 900;
function occupantCases(town) {
    const probe = town.choose(() => 0.43, []);
    const at = { ...probe };
    const other = town.name === 'Giran' ? 'Gludio' : 'Giran';
    const cases = {
        none: [[], []],
        afk_shop: [[], [at]],
        merchant_same_town: [[{ characterId: 1, activity: 'merchant', stats: { marketStore: { town: town.name, loc: at } } }], []],
        merchant_other_town: [[{ characterId: 2, activity: 'merchant', stats: { marketStore: { town: other, loc: at } } }], []],
        merchant_loc_from_state: [[{ characterId: 3, activity: 'merchant', loc: at, stats: { marketStore: { town: town.name } } }], []],
        self_merchant: [[{ characterId: SELF, activity: 'merchant', stats: { marketStore: { town: town.name, loc: at } } }], []],
        crafting_same_town: [[{ characterId: 4, activity: 'crafting', stats: { craftShop: { town: town.name, loc: at } } }], []],
        hunting_on_point: [[{ characterId: 5, activity: 'hunting', loc: at, stats: {} }], []]
    };
    const out = { probe: point(probe) };
    let calls = null;
    for (const [name, [states, afk]] of Object.entries(cases)) {
        const observed = withSources(states, afk, () => withRandom(() => 0.43,
            () => ListingService.marketLocation({ name: town.name }, { state: { characterId: SELF, loc: { locX: 1, locY: 2, locZ: 3 } } })));
        out[name] = point(observed.result);
        calls = observed.calls;
    }
    out.calls = calls;
    return out;
}

// A plaza with every overflow-grid point taken has no place left.
function fullPlaza(town) {
    const spacing = town.name === 'Giran' ? ListingService.GIRAN_STALL_MIN_DISTANCE : 60;
    const taken = [];
    for (let locX = town.area.minX; locX <= town.area.maxX + spacing; locX += spacing) {
        for (let locY = town.area.minY; locY <= town.area.maxY + spacing; locY += spacing) taken.push({ locX, locY, locZ: 0 });
    }
    return point(withSources([], taken, () => withRandom(seeded(5),
        () => ListingService.marketLocation({ name: town.name }, { state: { characterId: SELF } }))).result);
}

async function buyStoreCases() {
    const marketLocation = ListingService.marketLocation;
    const upsertState = LifeState.upsertState;
    const indexColdStore = MarketOpportunity.indexColdStore;
    const offer = BotTradeChat.offer;
    const material = DataCache.items.find((item) => item?.template?.kind?.startsWith('Other.Material') && Number(item.template?.price) > 100);
    const seen = [];
    LifeState.upsertState = (state) => Promise.resolve(state);
    MarketOpportunity.indexColdStore = () => {};
    BotTradeChat.offer = () => {};
    const state = {
        characterId: 77,
        name: 'Buyer',
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Oren',
        adena: 10000000,
        loc: { locX: 82000, locY: 53000, locZ: -1490 },
        inventory: {},
        stats: {},
        timing: {}
    };
    const goal = { type: 'buy_craft_material', target: { itemId: material.selfId, amount: 1, adena: material.template.price * 2 }, plan: {} };
    try {
        ListingService.marketLocation = (town, options) => { seen.push([town, options.state.characterId]); return { locX: 1, locY: 2, locZ: 3 }; };
        const placed = await BuyStoreService.open(state, goal, { now: 1000 });
        ListingService.marketLocation = () => null;
        const full = await BuyStoreService.open(state, goal, { now: 1000 });
        return {
            town: placed.state.stats.marketStore.town,
            placed: point(placed.state.loc),
            storePlaced: point(placed.state.stats.marketStore.loc),
            whenFull: point(full.state.loc),
            storeWhenFull: point(full.state.stats.marketStore.loc),
            asked: seen
        };
    } finally {
        ListingService.marketLocation = marketLocation;
        LifeState.upsertState = upsertState;
        MarketOpportunity.indexColdStore = indexColdStore;
        BotTradeChat.offer = offer;
    }
}

function giranEdgeChecks() {
    // Points around the Giran trading square: the wide rectangle of the two
    // "is on the plaza" copies and the narrow one of the stall copy.
    const probes = [
        [80910, 148000], [80911, 148000], [82947, 148000], [82948, 148000], [83750, 148000], [83751, 148000],
        [82000, 147661], [82000, 147662], [82000, 149550], [82000, 149551], [80971, 148000], [80970, 148000]
    ];
    const starter = { username: 'bot_pin_01', name: 'Pin', homeRegion: 'Talking Island', spawnClassId: 0, classId: 0 };
    return probes.map(([locX, locY]) => {
        const loc = { locX, locY, locZ: -3466 };
        const moved = BotManager.recoverStarterSpawn(starter, loc).locX !== undefined;
        const lifeState = LifeState.shouldRecoverOrphanedGiranState({ spotId: 1, activity: 'hunting', loc, stats: {} });
        return `${locX},${locY} starter:${moved ? 'moved' : 'kept'} orphan:${lifeState ? 'moved' : 'kept'} stall:${ListingService.isGiranPlazaStallLocation(loc) ? 'yes' : 'no'}`;
    });
}

async function observe() {
    const towns = {};
    for (const town of TOWNS) {
        towns[town.name] = {
            area: areaSample(town.isStall, town.area),
            sequence: chooseSequence(town),
            occupants: occupantCases(town),
            full: fullPlaza(town),
            staticStalls: ListingService.staticMerchantStalls(town.name, town.isStall).map(point)
        };
    }
    const outsidePlazas = {
        // A town without a captured plaza: its centre, as the cold sell store asks.
        orenWithCentre: point(ListingService.marketLocation({ name: 'Oren', center: { locX: 82960, locY: 53177, locZ: -1496 } }, { state: { characterId: 1, loc: { locX: 5, locY: 6, locZ: 7 } } })),
        // The AFK shop asks with no centre: the bot's own place.
        orenNoCentre: point(ListingService.marketLocation({ name: 'Oren' }, { state: { characterId: 1, loc: { locX: 5, locY: 6, locZ: 7 } } })),
        // The restored-shop migration passes the shop row as the place.
        restoredShop: point(ListingService.marketLocation({ name: 'Aden' }, { state: { characterId: 1, loc: { locX: 147450, locY: 26741, locZ: -2204, town: 'Aden' } } }))
    };
    return {
        towns,
        outsidePlazas,
        buyStore: await buyStoreCases(),
        giranEdges: giranEdgeChecks(),
        craftStations: CraftShopService.CraftStations.map((station) => `${station.id} ${station.loc.locX},${station.loc.locY},${station.loc.locZ}`)
    };
}

const EXPECTED = {
    towns: {
        Giran: {
            area: [
                "............",
                ".##########.",
                ".##########.",
                ".##########.",
                ".###....###.",
                ".###....###.",
                ".###....###.",
                ".###....###.",
                ".##########.",
                ".##########.",
                ".##########.",
                "............"
            ],
            sequence: {
                placed: [[82381, 148615, -3466], [81393, 147806, -3466], [82635, 148407, -3466], [82219, 149068, -3466], [81128, 149340, -3466], [81440, 149447, -3466]],
                first: [80971, 147722, -3466],
                overflow: [80971, 147762, -3466]
            },
            occupants: {
                probe: [80971, 147722, -3466],
                none: [80971, 147722, -3466],
                afk_shop: [80971, 147762, -3466],
                merchant_same_town: [80971, 147762, -3466],
                merchant_other_town: [80971, 147722, -3466],
                merchant_loc_from_state: [80971, 147762, -3466],
                self_merchant: [80971, 147722, -3466],
                crafting_same_town: [80971, 147762, -3466],
                hunting_on_point: [80971, 147722, -3466],
                calls: { allStates: [2000], afk: [["Giran", 900]] }
            },
            full: null,
            staticStalls: []
        },
        Gludio: {
            area: [
                "............",
                "............",
                "...######...",
                "...######...",
                "...######...",
                "...######...",
                "...######...",
                "...######...",
                "...######...",
                "...######...",
                "............",
                "............"
            ],
            sequence: {
                placed: [[-14363, 123226, -3117], [-14564, 122731, -3117], [-14311, 123099, -3117], [-14396, 123502, -3117], [-14618, 123668, -3117], [-14555, 123734, -3117]],
                first: [-14506, 123080, -3117],
                overflow: [-14650, 122680, -3117]
            },
            occupants: {
                probe: [-14482, 123144, -3117],
                none: [-14482, 123144, -3117],
                afk_shop: [-14650, 122680, -3117],
                merchant_same_town: [-14650, 122680, -3117],
                merchant_other_town: [-14482, 123144, -3117],
                merchant_loc_from_state: [-14650, 122680, -3117],
                self_merchant: [-14482, 123144, -3117],
                crafting_same_town: [-14482, 123144, -3117],
                hunting_on_point: [-14482, 123144, -3117],
                calls: { allStates: [2000], afk: [["Gludio", 900]] }
            },
            full: null,
            staticStalls: [[-14590, 123650, -3117], [-14370, 123650, -3117], [-14590, 123360, -3117], [-14370, 123360, -3117], [-14480, 123730, -3117]]
        },
        Dion: {
            area: [
                "............",
                ".###........",
                "..##........",
                "...##.......",
                "...##.......",
                "....##......",
                ".....#......",
                ".....##.....",
                "......##....",
                ".......###..",
                ".........#..",
                "............"
            ],
            sequence: {
                placed: [[16264, 143188, -2894], [17505, 145428, -2899], [17578, 145411, -2899], [17437, 145318, -2895], [17679, 145343, -2894], [16773, 144498, -2895]],
                first: [16695, 144200, -2900],
                overflow: [15630, 143099, -2896]
            },
            occupants: {
                probe: [16868, 144388, -2896],
                none: [16868, 144388, -2896],
                afk_shop: [15630, 143099, -2896],
                merchant_same_town: [15630, 143099, -2896],
                merchant_other_town: [16868, 144388, -2896],
                merchant_loc_from_state: [15630, 143099, -2896],
                self_merchant: [16868, 144388, -2896],
                crafting_same_town: [16868, 144388, -2896],
                hunting_on_point: [16868, 144388, -2896],
                calls: { allStates: [2000], afk: [["Dion", 900]] }
            },
            full: null,
            staticStalls: [[15814, 143129, -2707], [15860, 143100, -2707], [15725, 143055, -2707], [15910, 143200, -2707]]
        },
        "Talking Island": {
            area: [
                "............",
                "............",
                ".###........",
                "..##........",
                "...##.##....",
                "....#####...",
                ".....####...",
                "......####..",
                ".......####.",
                "........##..",
                "............",
                "............"
            ],
            sequence: {
                placed: [[-84395, 244286, -3730], [-84515, 244637, -3730], [-84420, 244351, -3730], [-84339, 244902, -3730], [-84429, 244600, -3730], [-84875, 244231, -3730]],
                first: [-84914, 244101, -3730],
                overflow: [-85439, 243715, -3730]
            },
            occupants: {
                probe: [-84829, 244183, -3730],
                none: [-84829, 244183, -3730],
                afk_shop: [-85439, 243715, -3730],
                merchant_same_town: [-85439, 243715, -3730],
                merchant_other_town: [-84829, 244183, -3730],
                merchant_loc_from_state: [-85439, 243715, -3730],
                self_merchant: [-84829, 244183, -3730],
                crafting_same_town: [-84829, 244183, -3730],
                hunting_on_point: [-84829, 244183, -3730],
                calls: { allStates: [2000], afk: [["Talking Island", 900]] }
            },
            full: null,
            staticStalls: [[-84168, 244729, -3730], [-84230, 244835, -3730], [-84120, 244760, -3730], [-84062, 244688, -3730], [-84250, 244680, -3730]]
        },
        "Elven Village": {
            area: [
                "............",
                ".......##...",
                "...######...",
                "...#######..",
                "...#######..",
                "..########..",
                "..#######...",
                "..######....",
                "..######....",
                "...####.....",
                ".....#......",
                "............"
            ],
            sequence: {
                placed: [[46801, 49700, -3060], [46894, 49500, -3060], [46742, 50138, -3060], [46571, 49148, -3060], [46794, 49202, -3060], [46683, 49109, -3060]],
                first: [46544, 49470, -3060],
                overflow: [46285, 49858, -3060]
            },
            occupants: {
                probe: [46586, 49572, -3060],
                none: [46586, 49572, -3060],
                afk_shop: [46285, 49858, -3060],
                merchant_same_town: [46285, 49858, -3060],
                merchant_other_town: [46586, 49572, -3060],
                merchant_loc_from_state: [46285, 49858, -3060],
                self_merchant: [46586, 49572, -3060],
                crafting_same_town: [46586, 49572, -3060],
                hunting_on_point: [46586, 49572, -3060],
                calls: { allStates: [2000], afk: [["Elven Village", 900]] }
            },
            full: null,
            staticStalls: [[46480, 49720, -3060], [46720, 49720, -3060]]
        },
        "Dark Elven Village": {
            area: [
                "............",
                "............",
                "......####..",
                "...#######..",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "..#######...",
                "..####......",
                "............",
                "............"
            ],
            sequence: {
                placed: [[12950, 16565, -4585], [13091, 16474, -4585], [12860, 16762, -4585], [12254, 16881, -4585], [12427, 16927, -4585], [12601, 16316, -4585]],
                first: [12561, 16461, -4585],
                overflow: [12167, 16356, -4585]
            },
            occupants: {
                probe: [12625, 16507, -4585],
                none: [12625, 16507, -4585],
                afk_shop: [12167, 16356, -4585],
                merchant_same_town: [12167, 16356, -4585],
                merchant_other_town: [12625, 16507, -4585],
                merchant_loc_from_state: [12167, 16356, -4585],
                self_merchant: [12625, 16507, -4585],
                crafting_same_town: [12625, 16507, -4585],
                hunting_on_point: [12625, 16507, -4585],
                calls: { allStates: [2000], afk: [["Dark Elven Village", 900]] }
            },
            full: null,
            staticStalls: [[12520, 16580, -4585], [12820, 16580, -4585]]
        },
        "Orc Village": {
            area: [
                "............",
                "............",
                "..########..",
                "..#######...",
                "..#######...",
                "..######....",
                "..#####.....",
                "..####......",
                "..####......",
                "..##........",
                "............",
                "............"
            ],
            sequence: {
                placed: [[-44881, -112757, -240], [-45059, -111982, -240], [-44641, -112637, -240], [-44231, -112608, -240], [-44434, -112657, -240], [-45005, -112457, -240]],
                first: [-44689, -112469, -240],
                overflow: [-45164, -112799, -240]
            },
            occupants: {
                probe: [-44612, -112415, -240],
                none: [-44612, -112415, -240],
                afk_shop: [-45164, -112799, -240],
                merchant_same_town: [-45164, -112799, -240],
                merchant_other_town: [-44612, -112415, -240],
                merchant_loc_from_state: [-45164, -112799, -240],
                self_merchant: [-44612, -112415, -240],
                crafting_same_town: [-44612, -112415, -240],
                hunting_on_point: [-44612, -112415, -240],
                calls: { allStates: [2000], afk: [["Orc Village", 900]] }
            },
            full: null,
            staticStalls: [[-44840, -112390, -240], [-44480, -112390, -240]]
        },
        "Dwarven Village": {
            area: [
                "............",
                "............",
                "...#######..",
                "...#######..",
                "...######...",
                "..#######...",
                "..######....",
                "..######....",
                "..#####.....",
                "..#####.....",
                "............",
                "............"
            ],
            sequence: {
                placed: [[115641, -178610, -920], [115300, -179240, -920], [115729, -178772, -920], [115585, -178257, -920], [115208, -178045, -920], [115424, -179056, -920]],
                first: [115399, -178796, -920],
                overflow: [115154, -178466, -920]
            },
            occupants: {
                probe: [115439, -178713, -920],
                none: [115439, -178713, -920],
                afk_shop: [115154, -178466, -920],
                merchant_same_town: [115154, -178466, -920],
                merchant_other_town: [115439, -178713, -920],
                merchant_loc_from_state: [115154, -178466, -920],
                self_merchant: [115439, -178713, -920],
                crafting_same_town: [115439, -178713, -920],
                hunting_on_point: [115439, -178713, -920],
                calls: { allStates: [2000], afk: [["Dwarven Village", 900]] }
            },
            full: null,
            staticStalls: [[115330, -178520, -920], [115620, -178520, -920]]
        }
    },
    outsidePlazas: {
        orenWithCentre: [82960, 53177, -1496],
        orenNoCentre: [5, 6, 7],
        restoredShop: [147450, 26741, -2204]
    },
    buyStore: {
        town: "Oren",
        placed: [1, 2, 3],
        storePlaced: [1, 2, 3],
        whenFull: [82000, 53000, -1490],
        storeWhenFull: [82000, 53000, -1490],
        asked: [[{ name:"Oren", center: { locX: 82000, locY: 53000, locZ: -1490 }}, 77]]
    },
    giranEdges: [
        "80910,148000 starter:kept orphan:kept stall:no",
        "80911,148000 starter:moved orphan:moved stall:no",
        "82947,148000 starter:moved orphan:moved stall:no",
        "82948,148000 starter:moved orphan:moved stall:no",
        "83750,148000 starter:moved orphan:moved stall:no",
        "83751,148000 starter:kept orphan:kept stall:no",
        "82000,147661 starter:kept orphan:kept stall:no",
        "82000,147662 starter:moved orphan:moved stall:no",
        "82000,149550 starter:moved orphan:moved stall:no",
        "82000,149551 starter:kept orphan:kept stall:no",
        "80971,148000 starter:moved orphan:moved stall:yes",
        "80970,148000 starter:moved orphan:moved stall:no"
    ],
    craftStations: [
        "d_heavy 80971,147722,-3466",
        "d_robe 81209,147722,-3466",
        "d_light 81446,147722,-3466",
        "d_weapons 81684,147722,-3466",
        "d_jewelry 81922,147722,-3466",
        "c_heavy 82159,147722,-3466",
        "c_robe 82397,147722,-3466",
        "c_light 82635,147722,-3466",
        "c_weapons_top 82887,148420,-3466",
        "c_jewelry 82887,148658,-3466",
        "b_heavy 82887,148896,-3466",
        "b_robe 82887,149133,-3466",
        "b_light 82887,149371,-3466",
        "b_weapons 82768,149490,-3466",
        "b_jewelry 82530,149490,-3466",
        "a_heavy 82293,149490,-3466",
        "a_robe 82055,149490,-3466",
        "a_light 81817,149490,-3466",
        "a_weapons 81580,149490,-3466",
        "a_jewelry 81342,149490,-3466",
        "a_heavy_elite 81104,149490,-3466",
        "s_heavy 80971,149386,-3466",
        "s_robe 80971,149148,-3466",
        "s_light 80971,148910,-3466",
        "s_weapons 80971,148673,-3466",
        "s_jewelry 80971,148435,-3466",
        "resource_core 80971,148197,-3466",
        "resource_master 80971,147960,-3466",
        "c_weapons_entry 82872,147722,-3466",
        "c_weapons_mid 82887,147945,-3466",
        "c_weapons_late 82887,148183,-3466"
    ]
};

observe().then((actual) => {
    if (process.env.PIN_PRINT) {
        console.log(JSON.stringify(actual, null, 1));
        return;
    }
    const plain = JSON.parse(JSON.stringify(actual));
    for (const name of Object.keys(EXPECTED.towns)) {
        for (const key of Object.keys(EXPECTED.towns[name])) {
            assert.deepStrictEqual(plain.towns[name][key], EXPECTED.towns[name][key], `${name} ${key}`);
        }
    }
    for (const key of ['outsidePlazas', 'buyStore', 'giranEdges', 'craftStations']) {
        assert.deepStrictEqual(plain[key], EXPECTED[key], key);
    }
    console.log('Shop place pinning checks passed');
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
