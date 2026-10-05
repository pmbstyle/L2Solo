// Pins where the one table of shop places (ShopPlaces, U19) puts a stall, for
// every caller. Phase 1 pinned the eight per-town copies; the user's decisions
// of 2026-10-05 changed these expectations (each marked "changed:" below):
// 40 between stalls in every town, the margin measured from the real edge,
// places filled from the centre outward, craft shops counted in every town,
// a buy store on a full square not opening. The board (step 3.3) removed the
// buy stall: a buy order is an ad with no place on a square.
// PIN_PRINT=1 prints the observed values instead of checking them.
const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeStateCache = require('../src/GameServer/Bot/Population/LifeStateCache');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const BotManager = invoke('GameServer/Bot/BotManager');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');

DataCache.init();

// Ground height without geodata files: a fixed function of x and y. With no
// region loaded, the table keeps every place (no standing check).
GeodataEngine.getHeight = (x, y, z) => z + ((x + y) % 7);
GeodataEngine.hasGeo = () => false;

const point = (loc) => (loc ? [loc.locX, loc.locY, loc.locZ] : null);
const TOWNS = Object.keys(ShopPlaces.PLAZAS);

// The stall area: a 12 x 12 sample over the outline's box widened by 100.
function areaSample(town) {
    const box = ShopPlaces.stallBounds(town);
    const margin = ShopPlaces.PLAZAS[town].margin;
    const area = { minX: box.minX - margin, maxX: box.maxX + margin, minY: box.minY - margin, maxY: box.maxY + margin };
    const rows = [];
    for (let j = 0; j < 12; j++) {
        let row = '';
        for (let i = 0; i < 12; i++) {
            const locX = Math.round(area.minX - 100 + (area.maxX - area.minX + 200) * i / 11);
            const locY = Math.round(area.minY - 100 + (area.maxY - area.minY + 200) * j / 11);
            row += ShopPlaces.isStallArea(town, { locX, locY }) ? '#' : '.';
        }
        rows.push(row);
    }
    return rows;
}

// Six stores in a row take the places nearest the fill centre, then the
// square fills up, and a freed place is the next one given out.
function fillOrder(town) {
    ShopPlaces._resetForTests();
    const placed = [];
    for (let i = 0; i < 6; i++) placed.push(point(ShopPlaces.take(town, `fill:${i}`)));
    let taken = 6;
    while (ShopPlaces.take(town, `fill:${taken}`)) taken++;
    const full = point(ShopPlaces.take(town, 'overflow'));
    ShopPlaces.release('fill:3');
    const reused = point(ShopPlaces.take(town, 'overflow'));
    return { placed, total: ShopPlaces.places(town).length, taken, full, reused };
}

// Each occupant is put on the first place (nearest the centre) through the path
// the server uses; the result shows whether it counts (the store moves on to
// the second place) or not (the store stays on the first).
const SELF = 900;
function occupantCases(town) {
    const other = town === 'Giran' ? 'Gludio' : 'Giran';
    const cases = {
        none: () => {},
        afk_shop: (at) => ShopPlaces.occupy(ShopPlaces.afkOwner(7), town, at),
        // A bot's store on the place grid is a crafter's craft shop (the bots'
        // sale stalls went with the board, step 3.3; board shops: afk_shop).
        crafter_other_town: (at, cache) => cache.set(2, { characterId: 2, activity: 'crafting', stats: { craftShop: { town: other, loc: at } } }),
        crafter_loc_from_state: (at, cache) => cache.set(3, { characterId: 3, activity: 'crafting', loc: at, stats: { craftShop: { town } } }),
        self_crafter: (at, cache) => cache.set(SELF, { characterId: SELF, activity: 'crafting', stats: { craftShop: { town, loc: at } } }),
        // changed: phase 1 counted craft shops only in Giran.
        crafting_same_town: (at, cache) => cache.set(4, { characterId: 4, activity: 'crafting', stats: { craftShop: { town, loc: at } } }),
        hunting_on_point: (at, cache) => cache.set(5, { characterId: 5, activity: 'hunting', loc: at, stats: {} }),
        // new: a store off the grid (a player's shop) blocks the places closer than 40.
        off_grid_shop: (at) => ShopPlaces.occupy(ShopPlaces.afkOwner(8), town, { locX: at.locX + 10, locY: at.locY + 10 }),
        closed_again: (at, cache) => {
            cache.set(6, { characterId: 6, activity: 'crafting', stats: { craftShop: { town, loc: at } } });
            cache.set(6, { characterId: 6, activity: 'hunting', loc: at, stats: {} });
        }
    };
    const out = {};
    for (const [name, put] of Object.entries(cases)) {
        ShopPlaces._resetForTests();
        const at = ShopPlaces.places(town)[0];
        const cache = new LifeStateCache();
        put(at, cache);
        out[name] = point(ListingService.marketLocation({ name: town }, { state: { characterId: SELF, loc: { locX: 1, locY: 2, locZ: 3 } } }));
    }
    return out;
}

// changed: every fixed merchant on the square blocks its neighbouring places,
// also one just outside the stall area (phase 1 counted only those inside).
function staticBlocks(town) {
    ShopPlaces._resetForTests();
    const places = ShopPlaces.places(town);
    return Object.entries(MerchantStoreConfigs)
        .filter(([, store]) => store.town === town)
        .filter(([, store]) => places.some((loc) => Math.hypot(loc.locX - store.locX, loc.locY - store.locY) < ShopPlaces.SPACING))
        .map(([name]) => name);
}

function giranEdgeChecks() {
    // Points around the Giran trading square: the wide square of the two
    // "is on the plaza" checks and the narrow stall area.
    const probes = [
        [80910, 148000], [80911, 148000], [82947, 148000], [82948, 148000], [83750, 148000], [83751, 148000],
        [82000, 147661], [82000, 147662], [82000, 149550], [82000, 149551], [80971, 148000], [80970, 148000]
    ];
    const starter = { username: 'bot_pin_01', name: 'Pin', homeRegion: 'Talking Island', spawnClassId: 0, classId: 0 };
    return probes.map(([locX, locY]) => {
        const loc = { locX, locY, locZ: -3466 };
        const moved = BotManager.recoverStarterSpawn(starter, loc).locX !== undefined;
        const lifeState = LifeState.shouldRecoverOrphanedGiranState({ spotId: 1, activity: 'hunting', loc, stats: {} });
        return `${locX},${locY} starter:${moved ? 'moved' : 'kept'} orphan:${lifeState ? 'moved' : 'kept'} stall:${ShopPlaces.isStallArea('Giran', loc) ? 'yes' : 'no'}`;
    });
}

async function observe() {
    const towns = {};
    for (const town of TOWNS) {
        towns[town] = {
            // changed: in the polygon towns the margin is kept from the real edge.
            area: areaSample(town),
            // changed: places on one 40 grid, given out from the centre outward
            // (phase 1: a random point, 40 apart in Giran and 60 elsewhere).
            fill: fillOrder(town),
            occupants: occupantCases(town),
            staticBlocks: staticBlocks(town)
        };
    }
    ShopPlaces._resetForTests();
    const outsidePlazas = {
        // A town without a captured plaza: its centre, as the cold sell store asks.
        // changed: Oren and Aden have the author's captured squares (2fa4508b);
        // Heine and Gludin have none.
        heineWithCentre: point(ListingService.marketLocation({ name: 'Heine', center: { locX: 82960, locY: 53177, locZ: -1496 } }, { state: { characterId: 1, loc: { locX: 5, locY: 6, locZ: 7 } } })),
        // The AFK shop asks with no centre: the bot's own place.
        heineNoCentre: point(ListingService.marketLocation({ name: 'Heine' }, { state: { characterId: 1, loc: { locX: 5, locY: 6, locZ: 7 } } })),
        // The restored-shop migration passes the shop row as the place.
        restoredShop: point(ListingService.marketLocation({ name: 'Gludin' }, { state: { characterId: 1, loc: { locX: 147450, locY: 26741, locZ: -2204, town: 'Gludin' } } }))
    };
    return {
        towns,
        outsidePlazas,
        // changed: one reason for every caller, naming the town (was giran_plaza_full,
        // market_plaza_full or market_full).
        fullReason: ShopPlaces.fullReason('Dion'),
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
            fill: {
                placed: [
                    [81571, 148602, -3460],
                    [81571, 148642, -3462],
                    [81571, 148562, -3465],
                    [81931, 148962, -3461],
                    [81891, 148962, -3466],
                    [81571, 148682, -3464]
                ],
                total: 1871,
                taken: 1871,
                full: null,
                reused: [81931, 148962, -3461]
            },
            occupants: {
                none: [81571, 148602, -3460],
                afk_shop: [81571, 148642, -3462],
                crafter_other_town: [81571, 148602, -3460],
                crafter_loc_from_state: [81571, 148642, -3462],
                self_crafter: [81571, 148602, -3460],
                crafting_same_town: [81571, 148642, -3462],
                hunting_on_point: [81571, 148602, -3460],
                off_grid_shop: [81571, 148562, -3465],
                closed_again: [81571, 148602, -3460]
            },
            staticBlocks: []
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
            fill: {
                placed: [
                    [-14450, 123200, -3112],
                    [-14450, 123240, -3114],
                    [-14490, 123200, -3117],
                    [-14490, 123240, -3112],
                    [-14410, 123200, -3114],
                    [-14410, 123240, -3116]
                ],
                total: 280,
                taken: 268,
                full: null,
                reused: [-14490, 123240, -3112]
            },
            occupants: {
                none: [-14450, 123200, -3112],
                afk_shop: [-14450, 123240, -3114],
                crafter_other_town: [-14450, 123200, -3112],
                crafter_loc_from_state: [-14450, 123240, -3114],
                self_crafter: [-14450, 123200, -3112],
                crafting_same_town: [-14450, 123240, -3114],
                hunting_on_point: [-14450, 123200, -3112],
                off_grid_shop: [-14490, 123200, -3117],
                closed_again: [-14450, 123200, -3112]
            },
            staticBlocks: ["MeryJane", "RustyAnvil", "SoulLess", "FriendShip", "Musa"]
        },
        Dion: {
            area: [
                "............",
                ".###........",
                "..##........",
                "...##.......",
                "....#.......",
                "....#.......",
                ".....#......",
                "......#.....",
                "......##....",
                "........##..",
                ".........#..",
                "............"
            ],
            fill: {
                placed: [
                    [16950, 144599, -2897],
                    [16910, 144559, -2900],
                    [16910, 144599, -2895],
                    [16950, 144639, -2899],
                    [16910, 144519, -2898],
                    [16910, 144639, -2897]
                ],
                total: 847,
                taken: 840,
                full: null,
                reused: [16950, 144639, -2899]
            },
            occupants: {
                none: [16950, 144599, -2897],
                afk_shop: [16910, 144559, -2900],
                crafter_other_town: [16950, 144599, -2897],
                crafter_loc_from_state: [16910, 144559, -2900],
                self_crafter: [16950, 144599, -2897],
                crafting_same_town: [16910, 144559, -2900],
                hunting_on_point: [16950, 144599, -2897],
                off_grid_shop: [16910, 144559, -2900],
                closed_again: [16950, 144599, -2897]
            },
            staticBlocks: ["CraftStash", "GeAnA", "Reanimator"]
        },
        "Talking Island": {
            area: [
                "............",
                "............",
                "..#.........",
                "..##........",
                "...##.......",
                "....####....",
                ".....####...",
                "......####..",
                ".......###..",
                "........##..",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [-84639, 244315, -3724],
                    [-84639, 244275, -3729],
                    [-84679, 244315, -3729],
                    [-84679, 244275, -3727],
                    [-84599, 244315, -3726],
                    [-84599, 244275, -3724]
                ],
                total: 292,
                taken: 284,
                full: null,
                reused: [-84679, 244275, -3727]
            },
            occupants: {
                none: [-84639, 244315, -3724],
                afk_shop: [-84639, 244275, -3729],
                crafter_other_town: [-84639, 244315, -3724],
                crafter_loc_from_state: [-84639, 244275, -3729],
                self_crafter: [-84639, 244315, -3724],
                crafting_same_town: [-84639, 244275, -3729],
                hunting_on_point: [-84639, 244315, -3724],
                off_grid_shop: [-84639, 244275, -3729],
                closed_again: [-84639, 244315, -3724]
            },
            staticBlocks: ["IslandMats", "TomRiddle", "4manda", "Pingu"]
        },
        "Elven Village": {
            area: [
                "............",
                "............",
                ".....####...",
                "....#####...",
                "...#######..",
                "...######...",
                "...#####....",
                "...#####....",
                "..#####.....",
                "....##......",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [46605, 49638, -3060],
                    [46605, 49678, -3055],
                    [46645, 49638, -3055],
                    [46645, 49678, -3057],
                    [46565, 49638, -3058],
                    [46565, 49678, -3060]
                ],
                total: 432,
                taken: 426,
                full: null,
                reused: [46645, 49678, -3057]
            },
            occupants: {
                none: [46605, 49638, -3060],
                afk_shop: [46605, 49678, -3055],
                crafter_other_town: [46605, 49638, -3060],
                crafter_loc_from_state: [46605, 49678, -3055],
                self_crafter: [46605, 49638, -3060],
                crafting_same_town: [46605, 49678, -3055],
                hunting_on_point: [46605, 49638, -3060],
                off_grid_shop: [46645, 49678, -3057],
                closed_again: [46605, 49638, -3060]
            },
            staticBlocks: ["Seduza", "CursedMan"]
        },
        "Dark Elven Village": {
            area: [
                "............",
                "............",
                "........#...",
                ".....#####..",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "..#####.....",
                "...#........",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [12687, 16576, -4582],
                    [12687, 16536, -4580],
                    [12727, 16576, -4584],
                    [12727, 16536, -4582],
                    [12647, 16576, -4580],
                    [12647, 16536, -4585]
                ],
                total: 325,
                taken: 319,
                full: null,
                reused: [12727, 16536, -4582]
            },
            occupants: {
                none: [12687, 16576, -4582],
                afk_shop: [12687, 16536, -4580],
                crafter_other_town: [12687, 16576, -4582],
                crafter_loc_from_state: [12687, 16536, -4580],
                self_crafter: [12687, 16576, -4582],
                crafting_same_town: [12687, 16536, -4580],
                hunting_on_point: [12687, 16576, -4582],
                off_grid_shop: [12687, 16536, -4580],
                closed_again: [12687, 16576, -4582]
            },
            staticBlocks: ["Kayser", "ShillienLoot"]
        },
        "Orc Village": {
            area: [
                "............",
                "............",
                "..########..",
                "..#######...",
                "..######....",
                "..#####.....",
                "..#####.....",
                "..####......",
                "..###.......",
                "..#.........",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [-44724, -112440, -240],
                    [-44724, -112480, -245],
                    [-44684, -112440, -242],
                    [-44684, -112480, -240],
                    [-44764, -112440, -245],
                    [-44764, -112480, -243]
                ],
                total: 414,
                taken: 408,
                full: null,
                reused: [-44684, -112480, -240]
            },
            occupants: {
                none: [-44724, -112440, -240],
                afk_shop: [-44724, -112480, -245],
                crafter_other_town: [-44724, -112440, -240],
                crafter_loc_from_state: [-44724, -112480, -245],
                self_crafter: [-44724, -112440, -240],
                crafting_same_town: [-44724, -112480, -245],
                hunting_on_point: [-44724, -112440, -240],
                off_grid_shop: [-44724, -112480, -245],
                closed_again: [-44724, -112440, -240]
            },
            staticBlocks: ["PedingBear", "TuskCollector"]
        },
        "Dwarven Village": {
            area: [
                "............",
                "............",
                "....#####...",
                "...######...",
                "...######...",
                "...#####....",
                "...#####....",
                "...####.....",
                "...####.....",
                "..###.......",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [115434, -178666, -921],
                    [115434, -178706, -926],
                    [115474, -178666, -923],
                    [115394, -178666, -926],
                    [115434, -178626, -923],
                    [115474, -178706, -921]
                ],
                total: 323,
                taken: 316,
                full: null,
                reused: [115394, -178666, -926]
            },
            occupants: {
                none: [115434, -178666, -921],
                afk_shop: [115434, -178706, -926],
                crafter_other_town: [115434, -178666, -921],
                crafter_loc_from_state: [115434, -178706, -926],
                self_crafter: [115434, -178666, -921],
                crafting_same_town: [115434, -178706, -926],
                hunting_on_point: [115434, -178666, -921],
                off_grid_shop: [115434, -178706, -926],
                closed_again: [115434, -178666, -921]
            },
            staticBlocks: ["MineSupplies", "Angel"]
        },
        // new: the author's five captured squares (2fa4508b).
        Oren: {
            area: [
                "............",
                "............",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                ".....#####..",
                ".....#####..",
                ".....#####..",
                ".....#####..",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [82400, 53660, -1495],
                    [82360, 53660, -1493],
                    [82400, 53620, -1493],
                    [82400, 53700, -1490],
                    [82440, 53660, -1490],
                    [82360, 53620, -1491]
                ],
                total: 448,
                taken: 438,
                full: null,
                reused: [82400, 53700, -1490]
            },
            occupants: {
                none: [82400, 53660, -1495],
                afk_shop: [82360, 53660, -1493],
                crafter_other_town: [82400, 53660, -1495],
                crafter_loc_from_state: [82360, 53660, -1493],
                self_crafter: [82400, 53660, -1495],
                crafting_same_town: [82360, 53660, -1493],
                hunting_on_point: [82400, 53660, -1495],
                off_grid_shop: [82360, 53660, -1493],
                closed_again: [82400, 53660, -1495]
            },
            staticBlocks: ["StayTun3d", "BarterKing", "Puffy", "NastyDream"]
        },
        "Hunter's Village": {
            area: [
                "............",
                "............",
                "....##......",
                "...####.....",
                "..######....",
                "..#######...",
                "..########..",
                "..#######...",
                "...####.....",
                "....##......",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [116605, 76152, -2712],
                    [116605, 76192, -2714],
                    [116565, 76152, -2717],
                    [116565, 76192, -2712],
                    [116645, 76152, -2714],
                    [116645, 76192, -2716]
                ],
                total: 616,
                taken: 616,
                full: null,
                reused: [116565, 76192, -2712]
            },
            occupants: {
                none: [116605, 76152, -2712],
                afk_shop: [116605, 76192, -2714],
                crafter_other_town: [116605, 76152, -2712],
                crafter_loc_from_state: [116605, 76192, -2714],
                self_crafter: [116605, 76152, -2712],
                crafting_same_town: [116605, 76192, -2714],
                hunting_on_point: [116605, 76152, -2712],
                off_grid_shop: [116565, 76152, -2717],
                closed_again: [116605, 76152, -2712]
            },
            staticBlocks: []
        },
        Aden: {
            area: [
                "............",
                "............",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "..########..",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [147467, 26969, -2202],
                    [147467, 26929, -2200],
                    [147427, 26969, -2200],
                    [147427, 26929, -2205],
                    [147507, 26969, -2204],
                    [147507, 26929, -2202]
                ],
                total: 495,
                taken: 495,
                full: null,
                reused: [147427, 26929, -2205]
            },
            occupants: {
                none: [147467, 26969, -2202],
                afk_shop: [147467, 26929, -2200],
                crafter_other_town: [147467, 26969, -2202],
                crafter_loc_from_state: [147467, 26929, -2200],
                self_crafter: [147467, 26969, -2202],
                crafting_same_town: [147467, 26929, -2200],
                hunting_on_point: [147467, 26969, -2202],
                off_grid_shop: [147467, 26929, -2200],
                closed_again: [147467, 26969, -2202]
            },
            staticBlocks: []
        },
        Rune: {
            area: [
                "............",
                "............",
                "............",
                "..#########.",
                "..#########.",
                "..#########.",
                "..#########.",
                ".##########.",
                "....#######.",
                "............",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [44183, -48017, -802],
                    [44143, -48017, -800],
                    [44183, -48057, -800],
                    [44143, -48057, -798],
                    [44183, -47977, -797],
                    [44143, -47977, -802]
                ],
                total: 412,
                taken: 412,
                full: null,
                reused: [44143, -48057, -798]
            },
            occupants: {
                none: [44183, -48017, -802],
                afk_shop: [44143, -48017, -800],
                crafter_other_town: [44183, -48017, -802],
                crafter_loc_from_state: [44143, -48017, -800],
                self_crafter: [44183, -48017, -802],
                crafting_same_town: [44143, -48017, -800],
                hunting_on_point: [44183, -48017, -802],
                off_grid_shop: [44143, -48017, -800],
                closed_again: [44183, -48017, -802]
            },
            staticBlocks: []
        },
        Goddard: {
            area: [
                "............",
                "............",
                ".....##.....",
                "....####....",
                "...######...",
                "..###..###..",
                "..##....##..",
                ".###....##..",
                ".........##.",
                "..........#.",
                "............",
                "............"
            ],
            fill: {
                placed: [
                    [147759, -56129, -2781],
                    [147719, -56129, -2779],
                    [147799, -56129, -2776],
                    [147679, -56129, -2777],
                    [147759, -56169, -2779],
                    [147719, -56169, -2777]
                ],
                total: 453,
                taken: 453,
                full: null,
                reused: [147679, -56129, -2777]
            },
            occupants: {
                none: [147759, -56129, -2781],
                afk_shop: [147719, -56129, -2779],
                crafter_other_town: [147759, -56129, -2781],
                crafter_loc_from_state: [147719, -56129, -2779],
                self_crafter: [147759, -56129, -2781],
                crafting_same_town: [147719, -56129, -2779],
                hunting_on_point: [147759, -56129, -2781],
                off_grid_shop: [147719, -56129, -2779],
                closed_again: [147759, -56129, -2781]
            },
            staticBlocks: []
        }
    },
    outsidePlazas: { heineWithCentre: [82960, 53177, -1496], heineNoCentre: [5, 6, 7], restoredShop: [147450, 26741, -2204] },
    fullReason: "plaza_full:Dion",
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

// A store's place is freed on every path a store ends: the life state leaves
// the market, the cache drops or clears it, a failed AFK publish is undone.
function releaseChecks() {
    const AfkTradeService = invoke('GameServer/AfkTrade/AfkTradeService');
    ShopPlaces._resetForTests();
    const total = ShopPlaces.freeCount('Gludio');
    const cache = new LifeStateCache();
    const store = (id) => ({ characterId: id, activity: 'crafting', stats: { craftShop: { town: 'Gludio', loc: ShopPlaces.take('Gludio', ShopPlaces.stateOwner(id)) } } });
    cache.set(11, store(11));
    cache.set(12, store(12));
    cache.set(13, store(13));
    assert.strictEqual(ShopPlaces.freeCount('Gludio'), total - 3, 'three stores hold three places');
    cache.delete(11);
    assert.strictEqual(ShopPlaces.freeCount('Gludio'), total - 2, 'a dropped life state frees its place');
    cache.clear();
    assert.strictEqual(ShopPlaces.freeCount('Gludio'), total, 'a cleared cache frees every life-state place');
    ShopPlaces.take('Gludio', ShopPlaces.afkOwner(21));
    AfkTradeService.restorePlace(21);
    assert.strictEqual(ShopPlaces.freeCount('Gludio'), total, 'a failed AFK publish without a standing shop frees the reserved place');
    ShopPlaces._resetForTests();
}

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
    // The physical buy stall is gone (step 3.3): a bot's buy order is a board
    // ad with no place on a square.
    for (const key of ['outsidePlazas', 'fullReason', 'giranEdges', 'craftStations']) {
        assert.deepStrictEqual(plain[key], EXPECTED[key], key);
    }
    releaseChecks();
    console.log('Shop place pinning checks passed');
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
