const catalog = require('../../../data/ClanHalls/catalog.json');
const DAY = 86400000;
const WEEK = 7 * DAY;
const AUCTION_DURATION = DAY;
const functions = {
    hp: {
        fees: {
            20: 700,
            40: 800,
            80: 1000,
            100: 1167,
            120: 1500,
            140: 1750,
            160: 2000,
            180: 2250,
            200: 2500,
            220: 3250,
            240: 3750,
            260: 4250,
            300: 5167
        },
        levels: {
            1: [40, 100, 160],
            2: [80, 140, 200, 260],
            3: [80, 120, 180, 240, 300]
        }
    },
    mp: {
        fees: { 5: 2000, 10: 3750, 15: 6500, 25: 11250, 30: 13750, 40: 20000 },
        levels: { 1: [5, 15, 25], 2: [5, 15, 30], 3: [5, 15, 30, 40] }
    },
    exp: {
        fees: { 5: 3000, 10: 6000, 15: 9000, 25: 15000, 30: 18000, 35: 21000, 40: 23334, 50: 30000 },
        levels: { 1: [5, 15, 30], 2: [5, 15, 25, 40], 3: [15, 25, 35, 50] }
    },
    support: {
        fees: { 1: 2500, 2: 5000, 3: 7000, 4: 11000, 5: 21000, 6: 36000, 7: 37000, 8: 52000 },
        levels: { 1: [1, 2, 4], 2: [3, 4, 5], 3: [3, 5, 7, 8] }
    }
};
const integer = (value) => Math.max(0, Math.floor(Number(value) || 0));
function definition(id) {
    return catalog.halls.find((h) => h.id === Number(id));
}
function fee(hall, kind, level) {
    if (!Object.hasOwn(functions, kind)) return null;
    if (Number(level) === 0) return 0;
    return functions[kind]?.levels[hall.grade]?.includes(Number(level)) ? functions[kind].fees[level] : null;
}
function dailyCost(hall, upgrades = {}) {
    return Object.entries(upgrades).reduce((sum, [kind, level]) => sum + (fee(hall, kind, level) || 0), 0);
}
function reserve(hall, upgrades = {}) {
    return hall.weeklyRent * 2 + dailyCost(hall, upgrades) * 14;
}
function bidAmount(minimum, rng = Math.random) {
    const roll = Math.max(0, Math.min(1, Number(rng()) || 0));
    return integer(minimum) + Math.ceil((integer(minimum) * (500 + Math.floor(roll * 1000))) / 10000);
}
function inside(hall, actor) {
    const b = hall.bounds;
    const x = actor.fetchLocX?.(),
        y = actor.fetchLocY?.(),
        z = actor.fetchLocZ?.();
    return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;
}
// Separate from clan.state.goal: a residence never changes assignments or level quests.
// Below level 2 all clan money is the next level's fund. From level 2 only a
// planned progression purchase is protected; a market plan holds its actual
// quoted price. There is no fixed Blood Mark price reserve.
function progressionReserve(clan, goal) {
    if (Number(clan.level) < 2) return Infinity;
    const progression = goal?.type === 'level' || goal?.type === 'item';
    const planned =
        progression && goal.status !== 'completed'
            ? Math.max(
                  integer(goal.budget),
                  integer(goal.target?.maxPrice),
                  integer(goal.plan?.maxPrice),
                  integer(goal.plan?.market?.price)
              )
            : 0;
    return planned;
}
// The clan money no clan spending may touch: only autonomous bot clans hold one.
function protectedReserve(clan, mode, goal) {
    return mode === 'autonomous' ? progressionReserve(clan, goal) : 0;
}
// Clan Adena in warehouse rows that clan spending may use.
function freeAdena(rows, clan, mode, goal) {
    const available = (rows || []).filter((row) => Number(row.selfId) === 57)
        .reduce((sum, row) => sum + Math.max(0, integer(row.amount) - integer(row.reservedAmount)), 0);
    return Math.max(0, available - protectedReserve(clan, mode, goal));
}
function desired(hall, members) {
    const magic = members.some((m) =>
        [
            10, 11, 12, 13, 14, 15, 16, 17, 18, 25, 26, 27, 28, 29, 30, 31, 38, 39, 40, 41, 42, 43, 44, 49, 50, 51, 52,
            94, 95, 96, 97, 98, 103, 104, 105, 110, 111, 112, 115, 116
        ].includes(Number(m.classId))
    );
    const average = members.reduce((s, m) => s + Number(m.level || 1), 0) / Math.max(1, members.length);
    const step = average >= 60 ? 2 : average >= 40 ? 1 : 0;
    const pick = (kind) =>
        functions[kind].levels[hall.grade][Math.min(step, functions[kind].levels[hall.grade].length - 1)];
    // Established A-grade clans benefit from Haste/Acumen/Empower at support tier 8.
    // Recovery functions still follow their own moderate level targets.
    const support = hall.grade === 3 && average >= 60 ? 8 : pick('support');
    return { support, hp: pick('hp'), ...(magic ? { mp: pick('mp') } : {}) };
}
function target(lots, members, rng = Math.random) {
    const regions = new Set(members.map((m) => String(m.currentRegion || '').toLowerCase()));
    const ranked = [...lots]
        .filter((h) => !h.ownerId)
        .sort((a, b) => {
            const cost = (h) => h.minimumBid * (regions.has(h.town.toLowerCase()) ? 0.85 : 1);
            return cost(a) - cost(b) || a.id - b.id;
        });
    if (!ranked.length) return null;
    const comparable = ranked.filter((h) => h.minimumBid === ranked[0].minimumBid && h.town === ranked[0].town);
    return comparable[Math.min(comparable.length - 1, Math.floor(Math.max(0, Number(rng()) || 0) * comparable.length))];
}
module.exports = {
    DAY,
    WEEK,
    AUCTION_DURATION,
    catalog,
    functions,
    integer,
    definition,
    fee,
    dailyCost,
    reserve,
    bidAmount,
    inside,
    progressionReserve,
    protectedReserve,
    freeAdena,
    desired,
    target
};
