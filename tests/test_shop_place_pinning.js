// Pins where the one table of shop places (ShopPlaces, U19) puts a stall, for
// every caller. Phase 1 pinned the eight per-town copies; the user's decisions
// of 2026-10-05 changed these expectations (each marked "changed:" below):
// 40 between stalls in every town, the margin measured from the real edge,
// places filled from the centre outward, craft shops counted in every town,
// a buy store on a full square not opening.
// PIN_PRINT=1 prints the observed values instead of checking them.
const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const LifeStateCache = require('../src/GameServer/Bot/Population/LifeStateCache');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const BuyStoreService = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
const CraftShopService = invoke('GameServer/Bot/Economy/CraftShopService');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const BotTradeChat = invoke('GameServer/Bot/Economy/BotTradeChat');
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
        merchant_same_town: (at, cache) => cache.set(1, { characterId: 1, activity: 'merchant', stats: { marketStore: { town, loc: at } } }),
        merchant_other_town: (at, cache) => cache.set(2, { characterId: 2, activity: 'merchant', stats: { marketStore: { town: other, loc: at } } }),
        merchant_loc_from_state: (at, cache) => cache.set(3, { characterId: 3, activity: 'merchant', loc: at, stats: { marketStore: { town } } }),
        self_merchant: (at, cache) => cache.set(SELF, { characterId: SELF, activity: 'merchant', stats: { marketStore: { town, loc: at } } }),
        // changed: phase 1 counted craft shops only in Giran.
        crafting_same_town: (at, cache) => cache.set(4, { characterId: 4, activity: 'crafting', stats: { craftShop: { town, loc: at } } }),
        hunting_on_point: (at, cache) => cache.set(5, { characterId: 5, activity: 'hunting', loc: at, stats: {} }),
        // new: a store off the grid (a player's shop) blocks the places closer than 40.
        off_grid_shop: (at) => ShopPlaces.occupy(ShopPlaces.afkOwner(8), town, { locX: at.locX + 10, locY: at.locY + 10 }),
        closed_again: (at, cache) => {
            cache.set(6, { characterId: 6, activity: 'merchant', stats: { marketStore: { town, loc: at } } });
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

async function buyStoreCases() {
    const marketLocation = ListingService.marketLocation;
    const upsertState = LifeState.upsertState;
    const indexColdStore = MarketOpportunity.indexColdStore;
    const offer = BotTradeChat.offer;
    const material = DataCache.items.find((item) => item?.template?.kind?.startsWith('Other.Material') && Number(item.template?.price) > 100);
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
        ShopPlaces._resetForTests();
        const oren = await BuyStoreService.open(state, goal, { now: 1000 });
        const giran = await BuyStoreService.open({ ...state, currentRegion: 'Giran' }, goal, { now: 1000 });
        ListingService.marketLocation = () => null;
        // changed: phase 1 opened the store on the bot's own place.
        const full = await BuyStoreService.open({ ...state, currentRegion: 'Giran' }, goal, { now: 1000 });
        return {
            oren: point(oren.state.loc),
            giran: point(giran.state.loc),
            giranStore: point(giran.state.stats.marketStore.loc),
            whenFull: { opened: full.opened, reason: full.reason, loc: point(full.state.loc) }
        };
    } finally {
        ListingService.marketLocation = marketLocation;
        LifeState.upsertState = upsertState;
        MarketOpportunity.indexColdStore = indexColdStore;
        BotTradeChat.offer = offer;
    }
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
        orenWithCentre: point(ListingService.marketLocation({ name: 'Oren', center: { locX: 82960, locY: 53177, locZ: -1496 } }, { state: { characterId: 1, loc: { locX: 5, locY: 6, locZ: 7 } } })),
        // The AFK shop asks with no centre: the bot's own place.
        orenNoCentre: point(ListingService.marketLocation({ name: 'Oren' }, { state: { characterId: 1, loc: { locX: 5, locY: 6, locZ: 7 } } })),
        // The restored-shop migration passes the shop row as the place.
        restoredShop: point(ListingService.marketLocation({ name: 'Aden' }, { state: { characterId: 1, loc: { locX: 147450, locY: 26741, locZ: -2204, town: 'Aden' } } }))
    };
    return {
        towns,
        outsidePlazas,
        // changed: one reason for every caller, naming the town (was giran_plaza_full,
        // market_plaza_full or market_full).
        fullReason: ShopPlaces.fullReason('Dion'),
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
                merchant_same_town: [81571, 148642, -3462],
                merchant_other_town: [81571, 148602, -3460],
                merchant_loc_from_state: [81571, 148642, -3462],
                self_merchant: [81571, 148602, -3460],
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
                merchant_same_town: [-14450, 123240, -3114],
                merchant_other_town: [-14450, 123200, -3112],
                merchant_loc_from_state: [-14450, 123240, -3114],
                self_merchant: [-14450, 123200, -3112],
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
                merchant_same_town: [16910, 144559, -2900],
                merchant_other_town: [16950, 144599, -2897],
                merchant_loc_from_state: [16910, 144559, -2900],
                self_merchant: [16950, 144599, -2897],
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
                merchant_same_town: [-84639, 244275, -3729],
                merchant_other_town: [-84639, 244315, -3724],
                merchant_loc_from_state: [-84639, 244275, -3729],
                self_merchant: [-84639, 244315, -3724],
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
                merchant_same_town: [46605, 49678, -3055],
                merchant_other_town: [46605, 49638, -3060],
                merchant_loc_from_state: [46605, 49678, -3055],
                self_merchant: [46605, 49638, -3060],
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
                merchant_same_town: [12687, 16536, -4580],
                merchant_other_town: [12687, 16576, -4582],
                merchant_loc_from_state: [12687, 16536, -4580],
                self_merchant: [12687, 16576, -4582],
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
                merchant_same_town: [-44724, -112480, -245],
                merchant_other_town: [-44724, -112440, -240],
                merchant_loc_from_state: [-44724, -112480, -245],
                self_merchant: [-44724, -112440, -240],
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
                merchant_same_town: [115434, -178706, -926],
                merchant_other_town: [115434, -178666, -921],
                merchant_loc_from_state: [115434, -178706, -926],
                self_merchant: [115434, -178666, -921],
                crafting_same_town: [115434, -178706, -926],
                hunting_on_point: [115434, -178666, -921],
                off_grid_shop: [115434, -178706, -926],
                closed_again: [115434, -178666, -921]
            },
            staticBlocks: ["MineSupplies", "Angel"]
        }
    },
    outsidePlazas: { orenWithCentre: [82960, 53177, -1496], orenNoCentre: [5, 6, 7], restoredShop: [147450, 26741, -2204] },
    fullReason: "plaza_full:Dion",
    buyStore: {
        oren: [82000, 53000, -1490],
        giran: [81571, 148602, -3460],
        giranStore: [81571, 148602, -3460],
        whenFull: { opened: false, reason: "plaza_full:Giran", loc: [82000, 53000, -1490] }
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

// A store's place is freed on every path a store ends: the life state leaves
// the market, the cache drops or clears it, a failed AFK publish is undone.
function releaseChecks() {
    const AfkTradeService = invoke('GameServer/AfkTrade/AfkTradeService');
    ShopPlaces._resetForTests();
    const total = ShopPlaces.freeCount('Gludio');
    const cache = new LifeStateCache();
    const store = (id) => ({ characterId: id, activity: 'merchant', stats: { marketStore: { town: 'Gludio', loc: ShopPlaces.take('Gludio', ShopPlaces.stateOwner(id)) } } });
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
    for (const key of ['outsidePlazas', 'fullReason', 'buyStore', 'giranEdges', 'craftStations']) {
        assert.deepStrictEqual(plain[key], EXPECTED[key], key);
    }
    releaseChecks();
    console.log('Shop place pinning checks passed');
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
