'use strict';
// The suppliers (our rule, standing for the real players' market of a C4 server):
// crafters, spoilers and station traders take C/B/A gear from the hidden reserve on
// consignment and resell it to the other bots on the board, on one path
// (CrafterStock), at one cost (COST_RATE x the item's price anchor, PriceAnchor.anchor)
// and one ask rule. A role differs in how much it supplies and what else it sells:
// - share: its part of the crafter's supply volume (CrafterStock PIECES_PER_HOUR pace,
//   its STOCK_HOURS hold and OWED_PIECES owed pieces).
// - gate: which pieces it stocks: 'craft' (a recipe its Create Item level reaches),
//   'wear' (a grade its level wears, GearGradeRule), 'none' (C4 trade needs no level).
// - shots: it stocks the graded shots it crafts; bids: it posts material bids.
// A spoiler's other line, the enchant scroll row, stays its own (ColdSafeEnchantService).
const COST_RATE = 0.6;
const ROLES = Object.freeze({
    crafter: Object.freeze({ classes: Object.freeze([56, 57]), share: 1, gate: 'craft', shots: true, bids: true }),
    spoiler: Object.freeze({ classes: Object.freeze([54, 55]), share: 0.75, gate: 'wear', shots: false, bids: false }),
    trader: Object.freeze({ classes: null, share: 0.5, gate: 'none', shots: false, bids: false })
});

// Station traders: a few bots per town that stand in their town with a private store
// and never hunt; their intake stands for the drops the town's hunters bring to market.
// Hubs by grade as C4's markets ran: Giran B/A, Dion and Gludin C; other towns one
// trader of their hunters' grade. A town's trader rows sell every reserve piece of its grades.
const TRADER_TOWNS = Object.freeze({
    Giran: Object.freeze({ count: 3, grades: Object.freeze(['B', 'A']) }),
    Dion: Object.freeze({ count: 3, grades: Object.freeze(['C']) }),
    Gludin: Object.freeze({ count: 3, grades: Object.freeze(['C']) }),
    Gludio: Object.freeze({ count: 1, grades: Object.freeze(['C']) }),
    Oren: Object.freeze({ count: 1, grades: Object.freeze(['B']) }),
    "Hunter's Village": Object.freeze({ count: 1, grades: Object.freeze(['B']) }),
    Heine: Object.freeze({ count: 1, grades: Object.freeze(['B']) }),
    Aden: Object.freeze({ count: 1, grades: Object.freeze(['A']) }),
    Goddard: Object.freeze({ count: 1, grades: Object.freeze(['A']) }),
    Rune: Object.freeze({ count: 1, grades: Object.freeze(['A']) })
});

// The trader seats in a fixed order: [{ slot, town }], slot 0.. (the durable identity
// of a trader's account, as a craft station's slot is).
const SEATS = Object.freeze(Object.entries(TRADER_TOWNS)
    .flatMap(([town, { count }]) => Array.from({ length: count }, () => town))
    .map((town, slot) => Object.freeze({ slot, town })));

// A station trader: a bot seeded on a seat (stats.stationTrader: { slot, town }).
function isStationTrader(state) {
    return !!state?.stats?.stationTrader;
}

// A bot's supplier role ('trader', 'crafter', 'spoiler'), else null.
function roleOf(state) {
    if (isStationTrader(state)) return 'trader';
    const classId = Number(invoke('GameServer/Bot/AI/BotRoles').classIdOf(state));
    return ROLES.crafter.classes.includes(classId) ? 'crafter' : ROLES.spoiler.classes.includes(classId) ? 'spoiler' : null;
}

// The grades a town's traders stock (none: no trader there).
function traderGrades(town) {
    return TRADER_TOWNS[town]?.grades || [];
}

// The store town of a crafter or spoiler (maintainer's rule 11-21: suppliers sit where
// the bots they serve come to shop, around a trade hub per grade as C4's markets ran:
// Dion for D, Giran for C and above). Its grade group is the top grade it serves
// (gradeGroupOf); HUB_SHARE of a group's suppliers sit in its hub (a quarter of D's, half
// of C+'s), the rest split across the shop towns in proportion to the town arrivals of
// that group's bots (TownArrivals; the hub's own arrivals count in that split too; no
// arrival yet: all in the hub). A supplier's seat is a fixed point in [0, 1) by its
// characterId (the golden-ratio spread), read against the towns' cumulative shares, so a
// shift of the shares moves only the suppliers at a boundary. Decided at its restock
// (ColdMarketService.crafterStock) and held in stats.storeTown until the next one. A
// station trader keeps its seat.
const HUB_SHARE = Object.freeze({ d: 0.25, 'c+': 0.5 });
const HUBS = Object.freeze({ d: 'Dion', 'c+': 'Giran' });
const SEAT_STEP = (Math.sqrt(5) - 1) / 2;

// The grade group a supplier serves, else null: a crafter the top grade of the graded
// shots its Create Item level reaches, a spoiler the grade its level wears.
function gradeGroupOf(state) {
    const role = roleOf(state), Arrivals = require('./TownArrivals');
    if (role === 'spoiler') return Arrivals.gradeGroup(invoke('GameServer/Bot/AI/GearGradeRule').gradeForLevel(state?.level));
    if (role !== 'crafter') return null;
    const level = Number(invoke('GameServer/Bot/Economy/CraftEligibility').craftLevelFor(state)) || 0;
    const Recipes = invoke('GameServer/Items/C4RecipeItems'), Counters = invoke('GameServer/Bot/Economy/MarketCounters');
    let group = null;
    for (const id of require('./ProductionPolicy').GRADED_SHOTS) {
        const recipeLevel = Number(Recipes.resolveByProductId(id)?.level || 0);
        if (!(recipeLevel > 0) || recipeLevel > level) continue;
        const next = Arrivals.gradeGroup(Counters.gradeOf(id));
        if (next === 'c+') return next;
        group ||= next;
    }
    return group;
}
// The seat's town: arrivals a Map town -> arrivals of the group, towns the shop towns.
function seatTown(group, seat, arrivals, towns) {
    const hub = HUBS[group], hubShare = HUB_SHARE[group];
    let total = 0;
    for (const town of towns) total += Math.max(0, Number(arrivals.get(town)) || 0);
    if (!(total > 0)) return hub;
    const share = town => (1 - hubShare) * Math.max(0, Number(arrivals.get(town)) || 0) / total;
    let reached = hubShare + share(hub);
    if (seat < reached) return hub;
    for (const town of towns) {
        if (town === hub) continue;
        reached += share(town);
        if (seat < reached) return town;
    }
    return hub;
}
// A crafter's or spoiler's store town now, else null (no grade served, or no supplier).
function storeTown(state, arrivals = group => require('./TownArrivals').arrivals(group)) {
    if (isStationTrader(state)) return null;
    const group = gradeGroupOf(state);
    if (!group) return null;
    const seat = (Math.abs(Number(state?.characterId) || 0) * SEAT_STEP) % 1;
    return seatTown(group, seat, arrivals(group), invoke('GameServer/Bot/Economy/ShopPlaces').SHOP_TOWNS);
}

module.exports = { COST_RATE, ROLES, TRADER_TOWNS, SEATS, HUB_SHARE, HUBS, isStationTrader, roleOf, traderGrades, gradeGroupOf, seatTown, storeTown };
