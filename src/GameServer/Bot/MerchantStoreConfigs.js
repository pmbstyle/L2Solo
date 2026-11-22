const BUY_CAP = 999999;

const s = (selfId, priceRate, count) => ({ selfId, priceRate, count });
// A buy line names only the item and the count: every buy line pays the one
// buy line price (StaticMerchantPricing.buyLinePrice).
const b = (selfId, count = BUY_CAP) => ({ selfId, count });
// Resource sellers carry raw and refined stock; permanent resource buyers
// take raw materials only. Crafted intermediates need actual market demand,
// otherwise their guaranteed payouts displace shot production.
// The active Adena rate is applied by StaticMerchantPricing.configuredPrice.
const RESOURCE_SELL_RATE = 1.20;
const rs = (selfId, count) => s(selfId, RESOURCE_SELL_RATE, count);

const SHOT_IDS_BY_GRADE = [
    [1835, 2509, 3947], // No Grade: Soulshot, Spiritshot, Blessed Spiritshot
    [1463, 2510, 3948], // D
    [1464, 2511, 3949], // C
    [1465, 2512, 3950], // B
    [1466, 2513, 3951], // A
    [1467, 2514, 3952]  // S
];
const shotsForGrade = (grade) => (SHOT_IDS_BY_GRADE[grade] || SHOT_IDS_BY_GRADE[0])
    .map((selfId) => s(selfId, 1, BUY_CAP));

// The gear reserve: our choice, not C4 (C4 town NPCs sell gear up to D, e.g.
// the Giran weapon traders). The grade's shot store also sells bots every
// C/B/A weapon and armour piece their gear planner can target (a named
// template with a price and an acquisition source; never a grand boss's jewel,
// which C4 drops from its boss alone), never in the player's
// window (TradeService.nativeStoreItems): the player keeps C4's stores. Each
// piece has a crafter row and, in the towns whose station traders stock its grade, a
// trader row (our rule: the suppliers, SupplierRoles, stand for a C4 market's
// players). The crafter row sells to the crafter and spoiler lines (classId 54-57,
// ProductionPolicy.allowsFixed reads buyerClasses), the trader row to the station
// traders only (buyerRole), both at COST_RATE x the item's bot-side price anchor
// (StaticMerchantPricing.configuredPrice: a reserve row's npcRate x PriceAnchor.anchor);
// they resell it on the board (CrafterStock) at most at the anchor. Both are
// consignment rows: a supplier takes them only as its resale stock, never as its own
// purchase (ProductionPolicy.allowsFixed), so it buys its own gear on the board as
// any bot does.
const { ROLES, COST_RATE } = require('./Economy/SupplierRoles');
const SUPPLIER_CLASSES = Object.freeze([...ROLES.spoiler.classes, ...ROLES.crafter.classes]);
const reserveGear = (ids) => ids.map((selfId) => ({ selfId, npcRate: COST_RATE, count: BUY_CAP,
    reserve: true, consignment: true, buyerClasses: SUPPLIER_CLASSES }));
const traderGear = (ids) => ids.map((selfId) => ({ selfId, npcRate: COST_RATE, count: BUY_CAP,
    reserve: true, consignment: true, buyerRole: 'trader' }));
const RESERVE_GEAR_C = [
    60, 62, 64, 71, 72, 73, 74, 75, 76, 77, 84, 89, 94, 95,
    96, 103, 107, 119, 131, 133, 134, 135, 145, 160, 161, 162, 173, 174,
    191, 192, 193, 194, 195, 196, 197, 199, 200, 201, 202, 203, 204, 205,
    206, 226, 227, 228, 231, 232, 233, 242, 263, 265, 266, 281, 282, 283,
    285, 286, 298, 299, 301, 302, 303, 325, 326, 354, 355, 356, 381, 382,
    397, 398, 399, 400, 401, 418, 419, 420, 439, 440, 441, 442, 471, 472,
    473, 500, 517, 608, 631, 632, 852, 853, 854, 855, 883, 884, 885, 886,
    915, 916, 917, 1126, 1149, 2387, 2413, 2414, 2429, 2430, 2431, 2432, 2433, 2434,
    2435, 2436, 2437, 2438, 2452, 2453, 2454, 2455, 2456, 2457, 2458, 2459, 2460, 2461,
    2462, 2463, 2495, 2496, 2497, 2502, 2503, 2523, 2524, 2531, 2532, 2538, 2539, 2544,
    2545, 2549, 2550, 2551, 2552, 2553, 2554, 2555, 2556, 2557, 2558, 2559, 2560, 2561,
    2562, 2563, 2564, 2565, 2572, 2573, 2574, 2575, 2582, 2583, 2584, 2591, 2592, 2599,
    4233, 5286
];
const RESERVE_GEAR_B = [
    78, 79, 91, 92, 97, 110, 142, 148, 171, 175, 210, 229, 234, 243,
    267, 268, 284, 287, 300, 357, 358, 383, 503, 554, 600, 601, 612, 633,
    673, 856, 864, 887, 895, 918, 926, 2376, 2379, 2380, 2381, 2384, 2388, 2390,
    2391, 2392, 2397, 2398, 2399, 2402, 2403, 2404, 2406, 2415, 2416, 2417, 2439, 2464,
    2475, 2487, 2566, 2568, 2569, 2570, 2571, 2576, 2578, 2579, 2580, 2581, 2585, 2587,
    2588, 2589, 2590, 2593, 2595, 2596, 2597, 2598, 2600, 2601, 2602, 2603, 2604, 2606,
    2608, 2609, 2610, 2611, 2617, 2618, 2619, 2620, 2621, 2622, 2623, 2624, 2625, 2626,
    5710, 5711, 5712, 5714, 5715, 5716, 5718, 5719, 5720, 5722, 5723, 5724, 5726, 5727,
    5728, 5730, 5731, 5732, 5734, 5735, 5736, 5738, 5739, 5740
];
const RESERVE_GEAR_A = [
    80, 81, 98, 150, 151, 164, 212, 213, 235, 236, 269, 270, 288, 289,
    305, 365, 374, 388, 512, 547, 641, 862, 871, 893, 902, 924, 933, 2382,
    2383, 2385, 2389, 2393, 2394, 2395, 2400, 2405, 2407, 2408, 2409, 2418, 2419, 2498,
    2500, 2504, 5233, 5287, 5288, 5289, 5290, 5291, 5292, 5293, 5294, 5295, 5296, 5297,
    5298, 5301, 5304, 5305, 5308, 5311, 5312, 5313, 5314, 5315, 5316, 5317, 5318, 5319,
    5320, 5323, 5326, 5329, 5705, 5706, 5765, 5766, 5767, 5768, 5769, 5770, 5771, 5772,
    5773, 5774, 5775, 5776, 5777, 5778, 5779, 5780, 5781, 5782, 5783, 5784, 5785, 5786,
    5787, 5788, 6323, 6324, 6325, 6326, 6327, 6328
];
// The reference kits' C/B/A pieces with no acquisition source (BotGear wears them;
// the source rule above leaves them out): the reserve sells every kit piece.
const RESERVE_KIT_C = [499, 1120];
const RESERVE_KIT_B = [104, 106, 117, 209, 404, 421, 610, 860, 891, 922];
const RESERVE_KIT_A = [304, 868, 899, 930];
const RESERVE_IDS = Object.freeze({
    C: [...RESERVE_GEAR_C, ...RESERVE_KIT_C], B: [...RESERVE_GEAR_B, ...RESERVE_KIT_B], A: [...RESERVE_GEAR_A, ...RESERVE_KIT_A] });
// Every C, B and A crafter row, sold in each grade's shot store (Giran, Oren, Aden):
// a crafter or spoiler restocks any grade it stocks in whichever of them it stands.
const RESERVE_GEAR = Object.freeze(reserveGear([...RESERVE_IDS.C, ...RESERVE_IDS.B, ...RESERVE_IDS.A]));
// A town's trader rows: every reserve piece of the grades its station traders stock.
const traderReserve = (town) => require('./Economy/SupplierRoles').traderGrades(town)
    .flatMap((grade) => traderGear(RESERVE_IDS[grade]));
// The grade's Scroll: Enchant Weapon (C4EnchantScrolls; C4 sells it nowhere: drop,
// spoil and raid bosses only). The reserve sells it to the spoiler line only at
// SCROLL_MARKUP x the board's median deal price (FixedShotOffers), SCROLL_RATE x the
// datapack price before the board has deals, (Scavenger 54, Bounty Hunter 55: ProductionPolicy.allowsFixed
// reads buyerClasses), hourlyStock scrolls a game hour (FixedShotOffers.take).
// Our rule: the spoiler stocks the board with them (ColdSafeEnchantService.scrollRestock)
// and sells them at the board's price like any item: it always pays more than it gets
// back, the markup is money leaving the world through the spoilers.
const SCROLL_RATE = 3.4, SCROLL_MARKUP = 1.2;
const enchantReserve = (selfId, hourlyStock) => ({ selfId, npcRate: SCROLL_RATE, count: BUY_CAP, reserve: true,
    buyerClasses: Object.freeze([54, 55]), hourlyStock, boardMarkup: SCROLL_MARKUP });

module.exports = {
    // Talking Island
    "IslandMats": {
        title: "Local mats",
        town: "Talking Island",
        storeType: 1,
        locX: -84168, locY: 244729, locZ: -3730,
        items: [
            rs(1864, 5000), rs(1865, 4000), rs(1866, 3500),
            rs(1867, 4500), rs(1868, 5000), rs(1869, 3500),
            s(1060, 0.78, 250), s(736, 0.75, 150), s(1835, 0.70, 30000)
        ]
    },
    "TomRiddle": {
        title: "Starter gear",
        town: "Talking Island",
        storeType: 1,
        locX: -84230, locY: 244835, locZ: -3730,
        items: [
            s(14, 0.66, 6), s(9, 0.65, 4), s(22, 0.72, 12),
            s(29, 0.72, 12), s(37, 0.70, 10), s(49, 0.70, 10),
            s(2006, 0.62, 60), s(2007, 0.62, 60), s(1796, 0.60, 25)
        ]
    },
    "4manda": {
        title: "Buy starter mats",
        town: "Talking Island",
        storeType: 3,
        locX: -84120, locY: 244760, locZ: -3730,
        items: [
            b(1864), b(1865), b(1866), b(1867),
            b(1868), b(1869), b(1870), b(1871),
            b(1872), b(17)
        ]
    },
    "Addicted": {
        title: "Buy island drops",
        town: "Talking Island",
        storeType: 3,
        locX: -84062, locY: 244688, locZ: -3730,
        items: [
            b(1121), b(1119), b(1122), b(1129),
            b(112), b(116), b(118), b(19),
            b(42), b(2006), b(2007), b(1788)
        ]
    },

    // Gludio
    "MeryJane": {
        title: "D mats and gear",
        town: "Gludio",
        storeType: 1,
        locX: -14590, locY: 123650, locZ: -3117,
        items: [
            rs(1867, 5000), rs(1869, 5000), rs(1870, 4000),
            rs(1871, 4000), rs(1872, 5000), rs(1873, 2500),
            rs(1880, 1200), s(15, 0.64, 5), s(216, 0.66, 7)
        ]
    },
    "RustyAnvil": {
        title: "Gludio stock",
        town: "Gludio",
        storeType: 1,
        locX: -14370, locY: 123650, locZ: -3117,
        items: [
            s(22, 0.68, 20), s(24, 0.68, 10), s(31, 0.68, 10),
            s(38, 0.72, 12), s(50, 0.72, 12), s(43, 0.70, 10),
            s(1921, 0.62, 150), s(1922, 0.62, 120), s(1923, 0.62, 120)
        ]
    },
    "SoulLess": {
        title: "Buy D mats",
        town: "Gludio",
        storeType: 3,
        locX: -14590, locY: 123360, locZ: -3117,
        items: [
            b(1867), b(1868), b(1869), b(1870),
            b(1871), b(1872), b(1873), b(1341)
        ]
    },
    "FriendShip": {
        title: "Buy plains drops",
        town: "Gludio",
        storeType: 3,
        locX: -14370, locY: 123360, locZ: -3117,
        items: [
            b(1921), b(1922), b(1923), b(1924),
            b(1925), b(2011), b(2012), b(2013),
            b(1792), b(1793), b(1794), b(1798)
        ]
    },

    // Dion
    "CraftStash": {
        title: "C craft stock",
        town: "Dion",
        storeType: 1,
        locX: 15814, locY: 143129, locZ: -2707,
        items: [
            rs(1873, 3500), rs(1879, 2500), rs(1880, 2500),
            rs(1881, 2200), rs(1882, 3000), rs(1883, 800),
            rs(1884, 3000), s(272, 0.62, 4), s(219, 0.63, 5)
        ]
    },
    "Mayan": {
        title: "Dion gear parts",
        town: "Dion",
        storeType: 1,
        locX: 15910, locY: 143025, locZ: -2707,
        items: [
            s(58, 0.65, 6), s(59, 0.65, 6), s(61, 0.68, 10),
            s(63, 0.68, 10), s(103, 0.68, 6), rs(1882, 3000),
            s(2143, 0.64, 100), s(2144, 0.64, 100), s(2139, 0.64, 80)
        ]
    },
    "GeAnA": {
        title: "Buy silver nuggets",
        town: "Dion",
        storeType: 3,
        locX: 15860, locY: 143100, locZ: -2707,
        items: [b(1873)]
    },
    "Sunday": {
        title: "Buy Dion drops",
        town: "Dion",
        storeType: 3,
        locX: 15725, locY: 143055, locZ: -2707,
        items: [
            b(2015), b(2009), b(2150), b(2252),
            b(2253), b(2254), b(956), b(955),
            b(37), b(49), b(44), b(102)
        ]
    },

    // Giran
    "RareSupplier": {
        title: "C/B materials",
        town: "Giran",
        storeType: 1,
        locX: 83550, locY: 148093, locZ: -3406,
        items: [
            rs(1881, 2500), rs(1882, 3500), rs(1883, 1200),
            rs(1885, 1500), rs(1887, 800), rs(1888, 800),
            rs(1889, 1400), s(78, 0.61, 2), s(91, 0.62, 3)
        ]
    },
    "Haldise": {
        title: "Giran gear",
        town: "Giran",
        storeType: 1,
        locX: 83445, locY: 148170, locZ: -3406,
        items: [
            s(60, 0.62, 4), s(62, 0.66, 8), s(64, 0.66, 8),
            s(119, 0.66, 6), s(117, 0.66, 8), s(845, 0.68, 8),
            s(877, 0.68, 10), s(908, 0.68, 6), s(1539, 0.76, 500)
        ]
    },
    "Veteranas": {
        title: "Buy Giran drops",
        town: "Giran",
        storeType: 3,
        locX: 83385, locY: 148035, locZ: -3406,
        items: [
            b(2140), b(2142), b(2143), b(2144),
            b(2173), b(2174), b(2175), b(956),
            b(955), b(219), b(272), b(309)
        ]
    },

    // Oren
    "StayTun3d": {
        title: "B/A materials",
        town: "Oren",
        storeType: 1,
        locX: 82600, locY: 53400, locZ: -1488,
        items: [
            rs(1885, 2500), rs(1886, 600), rs(1887, 1200),
            rs(1888, 1200), rs(1889, 2200), rs(1890, 700),
            rs(1893, 450), rs(1894, 1400), s(80, 0.60, 2)
        ]
    },
    "BarterKing": {
        title: "Oren gear",
        town: "Oren",
        storeType: 1,
        locX: 82700, locY: 53400, locZ: -1488,
        items: [
            s(79, 0.60, 3), s(97, 0.60, 3), s(98, 0.60, 2),
            s(442, 0.61, 3), s(473, 0.61, 3), s(603, 0.62, 5),
            s(2463, 0.62, 5), s(856, 0.64, 6), s(887, 0.64, 8)
        ]
    },
    "Puffy": {
        title: "Buy ore and stones",
        town: "Oren",
        storeType: 3,
        locX: 82800, locY: 53400, locZ: -1488,
        items: [
            b(1874), b(1875)
        ]
    },
    "NastyDream": {
        title: "Buy Oren drops",
        town: "Oren",
        storeType: 3,
        locX: 82900, locY: 53400, locZ: -1488,
        items: [
            b(1830), b(1343), b(1539), b(91),
            b(212), b(284), b(79), b(97),
            b(856), b(887), b(918)
        ]
    },

    // Heine market around dagger's captured plaza position (111380, 219034).
    // Together with Lina, four stalls sit 140 units from the center.
    "HarborTrader": {
        title: "B/A materials",
        town: "Heine",
        storeType: 1,
        locX: 111240, locY: 219034, locZ: -3536,
        items: [
            rs(1885, 2500), rs(1886, 600), rs(1887, 1200),
            rs(1888, 1200), rs(1889, 2200), rs(1890, 700),
            rs(1893, 450), rs(1894, 1400), s(80, 0.60, 2)
        ]
    },
    "RadSkin": {
        title: "Heine gear",
        town: "Heine",
        storeType: 1,
        locX: 111380, locY: 218894, locZ: -3536,
        items: [
            s(79, 0.60, 3), s(97, 0.60, 3), s(98, 0.60, 2),
            s(442, 0.61, 3), s(473, 0.61, 3), s(603, 0.62, 5),
            s(2463, 0.62, 5), s(856, 0.64, 6), s(887, 0.64, 8)
        ]
    },
    "MissaSic": {
        title: "Buy mats and drops",
        town: "Heine",
        storeType: 3,
        locX: 111520, locY: 219034, locZ: -3536,
        items: [
            b(1874), b(1875),
            b(1830), b(1343), b(1539),
            b(91), b(212), b(284),
            b(79), b(97), b(856), b(887), b(918)
        ]
    },

    // Starter-village liquidity. These stores complement the dedicated shot
    // sellers below: each racial starting market gets useful no-grade stock
    // and a local material/drop buyer instead of routing every bag to TI.
    "Seduza": {
        title: "Elven field gear",
        town: "Elven Village",
        storeType: 1,
        locX: 46480, locY: 49720, locZ: -3060,
        items: [
            s(8, 0.68, 8), s(14, 0.68, 8), s(22, 0.72, 16),
            s(29, 0.72, 16), s(37, 0.70, 12), s(49, 0.70, 12),
            rs(1864, 1800), rs(1865, 1800), rs(1867, 1400)
        ]
    },
    "CursedMan": {
        title: "Buy forest drops",
        town: "Elven Village",
        storeType: 3,
        locX: 46720, locY: 49720, locZ: -3060,
        items: [
            b(1864), b(1865), b(1866), b(1867),
            b(1868), b(1869), b(1870), b(1871),
            b(1119), b(1121), b(1122), b(1129)
        ]
    },
    "Kayser": {
        title: "Dark forest gear",
        town: "Dark Elven Village",
        storeType: 1,
        locX: 12520, locY: 16580, locZ: -4585,
        items: [
            s(12, 0.68, 8), s(3, 0.68, 6), s(22, 0.72, 16),
            s(29, 0.72, 16), s(37, 0.70, 12), s(49, 0.70, 12),
            rs(1864, 1800), rs(1866, 1600), rs(1868, 1600)
        ]
    },
    "ShillienLoot": {
        title: "Buy swamp drops",
        town: "Dark Elven Village",
        storeType: 3,
        locX: 12820, locY: 16580, locZ: -4585,
        items: [
            b(1864), b(1865), b(1866), b(1867),
            b(1868), b(1869), b(1870), b(1872),
            b(945), b(946), b(907), b(989)
        ]
    },
    "PedingBear": {
        title: "Plateau gear",
        town: "Orc Village",
        storeType: 1,
        locX: -44840, locY: -112390, locZ: -240,
        items: [
            s(5, 0.68, 8), s(254, 0.68, 8), s(20, 0.70, 14),
            s(22, 0.72, 16), s(29, 0.72, 16), s(37, 0.70, 12),
            rs(1864, 1800), rs(1868, 1600), rs(1869, 1600)
        ]
    },
    "TuskCollector": {
        title: "Buy plateau drops",
        town: "Orc Village",
        storeType: 3,
        locX: -44480, locY: -112390, locZ: -240,
        items: [
            b(1864), b(1865), b(1866), b(1867),
            b(1868), b(1869), b(1870), b(1872),
            b(1510), b(2371), b(67), b(154)
        ]
    },
    "MineSupplies": {
        title: "Mining supplies",
        town: "Dwarven Village",
        storeType: 1,
        locX: 115330, locY: -178520, locZ: -920,
        items: [
            s(152, 0.68, 8), s(154, 0.66, 6), s(20, 0.70, 14),
            s(22, 0.72, 16), s(29, 0.72, 16), s(49, 0.70, 12),
            rs(1864, 1800), rs(1866, 1600), rs(1869, 1600)
        ]
    },
    "Angel": {
        title: "Buy mine drops",
        town: "Dwarven Village",
        storeType: 3,
        locX: 115620, locY: -178520, locZ: -920,
        items: [
            b(1864), b(1865), b(1866), b(1867),
            b(1868), b(1869), b(1870), b(1872),
            b(1511), b(152), b(154), b(2006)
        ]
    },

    // Dedicated shot stores sell every player shot type at the town's exact
    // progression grade. They deliberately do not carry lower grades. They sell
    // to players only: a bot's graded shots come from the crafters (CrafterStock).
    "Pingu": {
        title: "Shots: No Grade",
        town: "Talking Island",
        storeType: 1,
        locX: -84250, locY: 244680, locZ: -3730,
        items: shotsForGrade(0)
    },
    "Kent8": {
        title: "Shots: No Grade",
        town: "Elven Village",
        storeType: 1,
        locX: 47166, locY: 51511, locZ: -2992,
        items: shotsForGrade(0)
    },
    "FakinMachine": {
        title: "Shots: No Grade",
        town: "Dark Elven Village",
        storeType: 1,
        locX: 9550, locY: 15717, locZ: -4568,
        items: shotsForGrade(0)
    },
    "Mochito": {
        title: "Shots: No Grade",
        town: "Orc Village",
        storeType: 1,
        locX: -45264, locY: -112292, locZ: -240,
        items: shotsForGrade(0)
    },
    "DubDub": {
        title: "Shots: No Grade",
        town: "Dwarven Village",
        storeType: 1,
        locX: 115072, locY: -177956, locZ: -880,
        items: shotsForGrade(0)
    },
    "J3dSanta": {
        title: "Shots: D Grade",
        town: "Gludin",
        storeType: 1,
        locX: -80620, locY: 150020, locZ: -3040,
        items: [...shotsForGrade(1), ...traderReserve("Gludin")]
    },
    "Musa": {
        title: "Shots: D Grade",
        town: "Gludio",
        storeType: 1,
        locX: -14480, locY: 123730, locZ: -3117,
        items: [...shotsForGrade(1), ...traderReserve("Gludio")]
    },
    "Reanimator": {
        title: "Shots: D Grade",
        town: "Dion",
        storeType: 1,
        locX: 15910, locY: 143200, locZ: -2707,
        items: [...shotsForGrade(1), ...traderReserve("Dion")]
    },
    "Squeesh": {
        title: "Shots: C Grade",
        town: "Giran",
        storeType: 1,
        locX: 83600, locY: 148300, locZ: -3406,
        items: [...shotsForGrade(2), ...RESERVE_GEAR, ...traderReserve("Giran"), enchantReserve(951, 20)]
    },
    "M3tLa": {
        title: "Shots: B Grade",
        town: "Oren",
        storeType: 1,
        locX: 83000, locY: 53400, locZ: -1488,
        items: [...shotsForGrade(3), ...RESERVE_GEAR, ...traderReserve("Oren"), enchantReserve(947, 10)]
    },
    "Petec": {
        title: "Shots: B Grade",
        town: "Hunter's Village",
        storeType: 1,
        locX: 117129, locY: 77137, locZ: -2696,
        items: [...shotsForGrade(3), ...traderReserve("Hunter's Village")]
    },
    "Original91": {
        title: "Shots: B Grade",
        town: "Heine",
        storeType: 1,
        locX: 111380, locY: 219174, locZ: -3536,
        items: [...shotsForGrade(3), ...traderReserve("Heine")]
    },
    "Lowfiles": {
        title: "Shots: A Grade",
        town: "Aden",
        storeType: 1,
        locX: 146497, locY: 25807, locZ: -2008,
        items: [...shotsForGrade(4), ...RESERVE_GEAR, ...traderReserve("Aden"), enchantReserve(729, 5)]
    },
    "TinWh1skey": {
        title: "Shots: S Grade",
        town: "Goddard",
        storeType: 1,
        locX: 148050, locY: -55340, locZ: -2728,
        items: [...shotsForGrade(5), ...traderReserve("Goddard")]
    },
    "Ora": {
        title: "Shots: S Grade",
        town: "Rune",
        storeType: 1,
        locX: 43950, locY: -47720, locZ: -792,
        items: [...shotsForGrade(5), ...traderReserve("Rune")]
    }
};
