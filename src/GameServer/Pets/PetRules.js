const data = require('../../../data/Pets/c4-stats.json');
const rows = new Map(data.rows.map(row => [`${row.npcId}:${row.level}`, Object.freeze(row)]));
const TYPES = {
    2375: { npcId: 12077, level: 15, food: [2515], category: 'wolf', name: 'Wolf' },
    3500: { npcId: 12311, level: 35, food: [4038], category: 'hatchling', name: 'Hatchling of Wind' },
    3501: { npcId: 12312, level: 35, food: [4038], category: 'hatchling', name: 'Hatchling of Star' },
    3502: { npcId: 12313, level: 35, food: [4038], category: 'hatchling', name: 'Hatchling of Twilight' },
    4422: { npcId: 12526, level: 55, food: [5169, 5168], category: 'strider', name: 'Strider of Wind' },
    4423: { npcId: 12527, level: 55, food: [5169, 5168], category: 'strider', name: 'Strider of Star' },
    4424: { npcId: 12528, level: 55, food: [5169, 5168], category: 'strider', name: 'Strider of Twilight' },
    6648: { npcId: 12780, level: 25, food: [7582], category: 'baby', name: 'Baby Buffalo', ownerShare: 0.1 },
    6649: { npcId: 12782, level: 26, food: [7582], category: 'baby', name: 'Baby Cougar', ownerShare: 0.1 },
    6650: { npcId: 12781, level: 24, food: [7582], category: 'baby', name: 'Baby Kookaburra', ownerShare: 0.1 },
    4425: { npcId: 12564, level: 1, food: [2515], category: 'wolf', name: 'Sin Eater', ownerShare: 1 }
};
// Explicit emulator policies for details not independently established as retail.
const POLICY = Object.freeze({ maxLevel: 80, corpseMs: 20 * 60 * 1000, autoFeed: 0.55,
    hungerSpeed: 0.5, starvationGraceMs: 60 * 1000, rewardRadius: 2500, inventorySlots: 80, inventoryWeight: 30000 });
const clamp = (n, min, max) => Math.max(min, Math.min(max, Number.isFinite(Number(n)) ? Number(n) : min));
function stats(npcId, level) { return rows.get(`${npcId}:${level}`); }
function levelFor(npcId, exp) {
    let level = 1;
    while (level < POLICY.maxLevel && exp >= stats(npcId, level + 1).exp) level++;
    return level;
}
function normalize(itemId, saved = {}, ownerLevel = 1) {
    const type = TYPES[itemId];
    if (!type) return null;
    const initial = itemId === 4425 ? clamp(ownerLevel, 1, POLICY.maxLevel) : type.level;
    const legacyLevel = Math.floor(clamp(saved.level ?? initial, 1, POLICY.maxLevel));
    const exp = Math.floor(clamp(saved.exp ?? stats(type.npcId, legacyLevel).exp, 0, stats(type.npcId, 81).exp - 1));
    const level = levelFor(type.npcId, exp);
    const row = stats(type.npcId, level);
    const dead = saved.dead === true || saved.hp === 0;
    return { version: 1, npcId: type.npcId, exp, sp: Math.floor(clamp(saved.sp ?? 0, 0, 2147483647)), level,
        name: typeof saved.name === 'string' ? saved.name.slice(0, 16) : '',
        hp: dead ? 0 : clamp(saved.hp ?? row.maxHp, 1, row.maxHp), mp: clamp(saved.mp ?? row.maxMp, 0, row.maxMp),
        currentFeed: clamp(saved.currentFeed ?? row.maxFeed, 0, row.maxFeed),
        dead, deadUntil: dead ? Number(saved.deadUntil) || Date.now() + POLICY.corpseMs : 0,
        lostExp: Math.max(0, Number(saved.lostExp) || 0), starvingSince: Math.max(0, Number(saved.starvingSince) || 0),
        inventory: Array.isArray(saved.inventory) ? saved.inventory : [], expired: saved.expired === true };
}
function levelPenalty(petLevel, mobLevel) {
    const diff = petLevel - mobLevel;
    return diff > 8 ? 0 : diff > 5 ? 1 - diff / 10 : 1;
}
function deathLoss(npcId, level) {
    return Math.round((stats(npcId, level + 1).exp - stats(npcId, level).exp) * (6.5 - 0.07 * level) / 100);
}
function skillLevel(level) { return Math.max(1, Math.floor(level / 10) + (level >= 70 ? Math.floor((level - 65) / 10) : 0)); }
function typeForNpc(npcId) { return Object.values(TYPES).find(type => type.npcId === Number(npcId)); }
module.exports = { TYPES, POLICY, stats, normalize, levelFor, levelPenalty, deathLoss, skillLevel, typeForNpc, clamp };
