'use strict';
// The bot-side price anchor of an item (our rule, not C4): what a hunting bot of the
// grade can pay for it, from what an hour of hunting gives it. Pure: the datapack, the
// spot table and the server rates, the same answer on main and on the workers.
//
// A grade's hunt: the spot table's best exp spot (SpotValueTable.best) for each class
// line at each level of the grade's band, the median over the lines per level. Over
// the band, hours = the C4 exp each level needs / its exp an hour (exp rate applied),
// income = adena plus loot at the NPC buy-back an hour (Adena and drop rates applied),
// weighted by those hours, and the datapack price of an hour's shots alike.
//   Shots: an hour of shooting costs SHOT_SHARE of the grade's income; a graded shot
//   is priced at its datapack share of that hour's shots, never below its datapack.
//   Gear: the next grade's kit costs KIT_HOURS x the grade's hours of its income (it
//   buys the kit in the middle of the next band); a C/B/A/S piece is priced at its
//   datapack share of that kit. None and D pieces have no anchor (the NPC sells them).
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const { GRADES, levelForGrade } = require('../AI/GearGradeRule');
const { SHOT_GRADE } = require('./ProductionPolicy');

const SHOT_SHARE = 0.10, KIT_HOURS = 2;
// The grade whose hunt pays for a gear grade.
const PAID_BY = Object.freeze({ c: 'd', b: 'c', a: 'b', s: 'a' });
// A kit's earring and ring are worn twice (paperdoll slots 1-2, 4-5).
const PAIRED_SLOTS = new Set([1, 2, 4, 5]);

function datapack(selfId) {
    return Number(ItemTemplateIndex.find(DataCache.items, Number(selfId))?.template?.price || 0);
}
function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[(sorted.length - 1) >> 1] : 0;
}

// { hours, income, shotCost } of a grade's band, cached on the spot table's revision
// (its file, spot catalogue, rewards and rates) and the datapack.
let huntInputs = null;
const hunts = new Map();
function hunt(grade) {
    const Table = invoke('GameServer/Bot/AI/SpotValueTable');
    const revision = Table.revision();
    if (huntInputs?.revision !== revision || huntInputs.items !== DataCache.items || huntInputs.experience !== DataCache.experience) {
        hunts.clear();
        huntInputs = { revision, items: DataCache.items, experience: DataCache.experience };
    }
    if (hunts.has(grade)) return hunts.get(grade);
    const Shots = invoke('GameServer/Inventory/ShotStock');
    const exp = DataCache.experience, next = GRADES[GRADES.indexOf(grade) + 1];
    const last = next ? levelForGrade(next) - 1 : exp.length - 1;
    let hours = 0, money = 0, shots = 0;
    for (let level = levelForGrade(grade); level <= last; level++) {
        const rows = Table.roles().map(role => [role, Table.best(role, level, true)]).filter(([, row]) => row && row.exp > 0);
        if (!rows.length) continue;
        const spent = (Number(exp[level]) - Number(exp[level - 1])) / median(rows.map(([, row]) => row.exp));
        hours += spent;
        money += spent * median(rows.map(([, row]) => row.adena + row.loot));
        shots += spent * median(rows.map(([role, row]) => row.shots
            * datapack(Shots.planFor({ classId: Table.roleClass(role, level), rank: grade }).selfId)));
    }
    const result = Object.freeze({ hours, income: hours > 0 ? money / hours : 0, shotCost: hours > 0 ? shots / hours : 0 });
    hunts.set(grade, result);
    return result;
}

// The datapack price of a grade's kit: per class of the gear table its top weapon and
// full armour with jewels (data/Bots/hunt/gear.json), the median over the classes.
let kitItems = null;
const kits = new Map();
function kitPrice(grade) {
    if (kitItems !== DataCache.items) { kits.clear(); kitItems = DataCache.items; }
    if (kits.has(grade)) return kits.get(grade);
    const gear = require('../../../../data/Bots/hunt/gear.json');
    const slots = new Map(gear.items.map(row => [row[0], row[3]]));
    const tier = (tiers, name) => tiers.find(([tierName]) => tierName === name)?.[1] || [];
    const price = median(gear.classes.map(entry => [...tier(entry.weaponTiers, `${grade}-top`), ...tier(entry.armourTiers, `${grade}-full`)]
        .reduce((sum, id) => sum + datapack(id) * (PAIRED_SLOTS.has(slots.get(id)) ? 2 : 1), 0)));
    kits.set(grade, price);
    return price;
}

// A C/B/A/S piece's anchor in Adena: its datapack share of KIT_HOURS x the grade
// below's hours of its income; 0 (no anchor) for an item of any other grade.
function anchor(selfId) {
    const grade = String(ItemTemplateIndex.find(DataCache.items, Number(selfId))?.etc?.rank || '').toLowerCase();
    if (!PAID_BY[grade]) return 0;
    const { hours, income } = hunt(PAID_BY[grade]), kit = kitPrice(grade);
    return kit > 0 ? Math.max(1, Math.round(datapack(selfId) * KIT_HOURS * hours * income / kit)) : 0;
}

// A graded shot's anchor in Adena: its datapack share of SHOT_SHARE of its grade's
// hourly income, at least the datapack price (C4's price; above the NPC buy-back, so
// no shot resells at a profit); 0 for a no-grade shot or any other item.
function shotAnchor(selfId) {
    const grade = SHOT_GRADE[Number(selfId)];
    if (!grade) return 0;
    const { income, shotCost } = hunt(grade);
    return Math.max(1, Math.round(datapack(selfId) * Math.max(1, shotCost > 0 ? SHOT_SHARE * income / shotCost : 1)));
}

// Boot, on main and in each cold worker before any bot decides (after the spot catalogue
// is set): every grade's hunt and kit, so no game turn pays their ~1.7 s of spot table reads.
function warmup() {
    for (const grade of new Set(Object.values(SHOT_GRADE))) hunt(grade);
    for (const grade of Object.keys(PAID_BY)) kitPrice(grade);
}

module.exports = { anchor, shotAnchor, warmup, SHOT_SHARE, KIT_HOURS };
